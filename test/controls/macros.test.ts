import { describe, expect, it, vi } from 'vitest';
import { parseMacro, registerMacroTool } from '../../src/controls/macros.js';
import type { Ops } from '../../src/ops.js';
import { toolRecorder } from '../helpers/tool-recorder.js';

const files = vi.hoisted(() => ({ readdir: vi.fn(), readFile: vi.fn() }));
vi.mock('node:fs/promises', async (original) => ({
  ...(await original<typeof import('node:fs/promises')>()),
  readdir: files.readdir,
  readFile: files.readFile,
}));
vi.mock('../../src/app-config.js', () => ({ configPath: () => '/fixture/audacity.cfg' }));

describe('safe saved macros', () => {
  it('parses explicit types and default Fade Ends macro', () => {
    expect(
      parseMacro(
        'Select:Start="0" End="1"\nFadeIn:Use_Preset="<Current Settings>"\nSelect:Start="0" End="1" RelativeTo="ProjectEnd"\nFadeOut:\n',
      ),
    ).toEqual([
      { command: 'Select', params: { Start: 0, End: 1 } },
      { command: 'FadeIn', params: {} },
      { command: 'Select', params: { Start: 0, End: 1, RelativeTo: 'ProjectEnd' } },
      { command: 'FadeOut', params: {} },
    ]);
    expect(parseMacro('Amplify:Ratio="0.5" AllowClipping="1"')[0]?.params).toEqual({ Ratio: 0.5, AllowClipping: true });
    expect(parseMacro('SelectTracks:Track=1 TrackCount=2 Mode=Set')[0]?.params).toEqual({
      Track: 1,
      TrackCount: 2,
      Mode: 'Set',
    });
  });
  it.each(
    ['SetTrack', 'SetTrackStatus', 'SetTrackAudio', 'SetTrackVisuals', 'SetClip', 'SetEnvelope'].flatMap((command) =>
      ['Track', 'TrackCount', 'Channel', 'ChannelCount'].map((parameter) => ({ command, parameter })),
    ),
  )('rejects undeclared $command.$parameter scope in saved macros', ({ command, parameter }) => {
    expect(() => parseMacro(`${command}:${parameter}=1`)).toThrow();
  });
  it('translates an export only with a known explicit destination', () => {
    expect(parseMacro('ExportMP3:', 'out.mp3')).toEqual([
      { command: 'Export2', params: { Filename: 'out.mp3', NumChannels: 2 } },
    ]);
    expect(() => parseMacro('ExportMP3:')).toThrow('outputTo');
    expect(() => parseMacro('ExportMP3:', 'out.wav')).toThrow('.mp3');
  });
  it.each([
    'New:',
    'Preferences:',
    'Record1stChoice:',
    'Record2ndChoice:',
    'Drag:',
    'MeasureRms:',
    'Repair:',
    'ClickRemoval:Threshold=200 Width=20',
    'SaveProject2:Filename=x',
    'Amplify:Ratio="bogus"',
    'Amplify:Bogus=1',
    'Amplify:Use_Preset="<Current Settings>"',
    'Undo:Param=1',
    'Amplify:Ratio=1 Ratio=2',
    'No colon',
    '',
  ])('rejects unsafe/incomplete macro %j', (macro) => {
    expect(() => parseMacro(macro)).toThrow();
  });
});

describe('label macro preflight', () => {
  function fixture(labelCommand: string, preference = '1') {
    files.readdir.mockResolvedValue(['Example.txt']);
    files.readFile.mockResolvedValue(`Invert:\n${labelCommand}:`);
    const ops = {
      pipe: { send: vi.fn(async () => ({ ok: true, body: preference, status: 'OK' })) },
      tracks: vi.fn(async () => [{ name: 'Voice', kind: 'wave', start: 0, end: 1, selected: 1 }]),
      info: vi.fn(async () => ({ Start: 0, End: 1 })),
      command: vi.fn(async () => ''),
      run: vi.fn(async () => ''),
    };
    const recorder = toolRecorder();
    registerMacroTool(recorder.register, ops as unknown as Ops);
    return { ...recorder, ops };
  }

  it.each(['AddLabel', 'AddLabelPlaying'])('refuses a later %s before an earlier audio edit', async (command) => {
    const { call, ops } = fixture(command);
    await expect(call('audacity_macros', { action: 'apply', name: 'Example' })).rejects.toThrow(
      /DialogForNameNewLabel/,
    );
    expect(ops.command).not.toHaveBeenCalled();
    expect(ops.run).not.toHaveBeenCalled();
  });

  it('keeps dry-run label macros static without reading native preferences', async () => {
    const { call, ops } = fixture('AddLabel');
    expect(await call('audacity_macros', { action: 'apply', name: 'Example', dryRun: true })).toMatchObject({
      dryRun: true,
      steps: [{ command: 'Invert' }, { command: 'AddLabel' }],
    });
    expect(ops.pipe.send).not.toHaveBeenCalled();
    expect(ops.command).not.toHaveBeenCalled();
    expect(ops.run).not.toHaveBeenCalled();
  });

  it('applies a label macro when native naming dialogs are disabled', async () => {
    const { call, ops } = fixture('AddLabel', '0');
    expect(await call('audacity_macros', { action: 'apply', name: 'Example' })).toMatchObject({ completed: 2 });
    expect(ops.pipe.send).toHaveBeenCalledWith('GetPreference: Name=/GUI/DialogForNameNewLabel');
    expect(ops.command).toHaveBeenCalledExactlyOnceWith('Invert', {}, 600_000);
    expect(ops.run).toHaveBeenCalledExactlyOnceWith('AddLabel', {}, 600_000);
  });
});
