import { describe, expect, it, vi } from 'vitest';
import { COMMAND_IDS, describeCommand, EFFECT_IDS, MENU_IDS } from '../src/catalogue.js';
import { catalogueCommand, formatCommand, parseInfoJson } from '../src/format.js';
import { Ops, validateExportFile } from '../src/ops.js';
import { AudacityPipe } from '../src/pipe.js';

describe('catalogue boundaries', () => {
  it('accepts verified underscore ids, hyphens and quoted spaced keys', () => {
    expect(formatCommand('Align_EndToEnd')).toBe('Align_EndToEnd:');
    expect(catalogueCommand('NoiseGate', { 'STEREO-LINK': 'LinkStereo', 'GATE-FREQ': 0 })).toContain(
      'STEREO-LINK=LinkStereo',
    );
    expect(catalogueCommand('FindClipping', { 'Duty Cycle Start': 3 })).toBe('FindClipping: "Duty Cycle Start"=3');
  });
  it.each([
    'New',
    'Save',
    'ManageMacros',
    'About',
    'TrackGain',
    'Resample',
    'RepeatLastEffect',
    'ShareAudioTB',
    'Record1stChoice',
    'Record2ndChoice',
    'RegularIntervalLabels',
  ])('excludes unsafe menu %s', (command) => {
    expect(MENU_IDS).not.toContain(command);
  });
  it.each([
    'MeasureRms',
    'ClickRemoval',
    'Repair',
    'SpectralEditMultiTool',
    'SpectralEditParametricEq',
    'SpectralEditShelves',
    'SpectralDelete',
    'LabelSounds',
    'RegularIntervalLabels',
    'Drag',
    'OpenProject2',
    'SaveProject2',
    'SaveCopy',
    'NyquistPrompt',
    'SetPreference',
  ])('excludes generic unsafe command %s', (command) => {
    expect(COMMAND_IDS).not.toContain(command);
  });
  it('effects do not contain lifecycle/getter/track setters, and discovery exposes only declared parameters', () => {
    expect(EFFECT_IDS).not.toContain('SetTrack');
    expect(EFFECT_IDS).not.toContain('GetPreference');
    expect(EFFECT_IDS).not.toContain('RegularIntervalLabels');
    expect(describeCommand('NoiseReduction')?.params).toEqual([]);
    expect(() => catalogueCommand('NoiseReduction', { Reduction: 6 })).toThrow();
    expect(describeCommand('SetEnvelope')?.params?.map((p) => p.key)).toEqual(['Time', 'Value', 'Delete']);
  });
  it.each(
    ['SetTrack', 'SetTrackStatus', 'SetTrackAudio', 'SetTrackVisuals', 'SetClip', 'SetEnvelope'].flatMap((command) =>
      ['Track', 'TrackCount', 'Channel', 'ChannelCount'].map((parameter) => ({ command, parameter })),
    ),
  )('refuses ignored native $command.$parameter scope before pipe transport', ({ command, parameter }) => {
    const transport = vi.fn();
    const ops = new Ops(new AudacityPipe(undefined, 10, transport));
    const params = { [parameter]: 1 };
    expect(describeCommand(command)?.params?.map((param) => param.key)).not.toContain(parameter);
    expect(() => catalogueCommand(command, params)).toThrow();
    expect(() => ops.command(command, params)).toThrow();
    expect(() => ops.run(command, params)).toThrow();
    expect(transport).not.toHaveBeenCalled();
  });
  it('preserves raw Windows paths containing JSON escape letters and valid escaped paths', () => {
    expect(parseInfoJson(String.raw`[{"file":"C:\new\test\rms.ny"}]`)).toEqual([
      { file: String.raw`C:\new\test\rms.ny` },
    ]);
    expect(parseInfoJson(JSON.stringify([{ file: String.raw`C:\new\test.wav`, name: 'line\nnext' }]))).toEqual([
      { file: String.raw`C:\new\test.wav`, name: 'line\nnext' },
    ]);
  });
  it.each([
    ['SetTrack', 'Volume', -37],
    ['SetTrackAudio', 'Volume', 37],
    ['SetTrack', 'Pan', -101],
    ['SetTrackAudio', 'Pan', 101],
    ['SetTrackVisuals', 'Height', 43],
    ['SetTrack', 'Height', 2001],
    ['SetTrackVisuals', 'VZoomHigh', 2.1],
    ['SetTrack', 'VZoomLow', -2.1],
    ['SetEnvelope', 'Time', -1],
    ['SetEnvelope', 'Value', -0.1],
    ['SetEnvelope', 'Value', 2.1],
    ['SetClip', 'At', -1],
    ['SetClip', 'Start', -5.1],
  ] as const)('refuses native numeric bound violation %s.%s=%s before transport', (command, key, value) => {
    const transport = vi.fn();
    const ops = new Ops(new AudacityPipe(undefined, 10, transport));
    expect(() => ops.command(command, { [key]: value })).toThrow();
    expect(() => ops.run(command, { [key]: value })).toThrow();
    expect(transport).not.toHaveBeenCalled();
  });
  it('describes verified native bounds and retains intentional negative native clip starts', () => {
    expect(describeCommand('SetTrackAudio')?.params?.find((param) => param.key === 'Pan')).toMatchObject({
      minimum: -100,
      maximum: 100,
    });
    expect(catalogueCommand('SetClip', { At: 1, Start: -5 })).toBe('SetClip: At=1 Start=-5');
  });
  it.each(['out.xyz', 'out.aup3', 'out.aiff', '', 'wav'])('refuses unsupported export %s before Audacity', (file) => {
    expect(() => validateExportFile(file)).toThrow();
  });
  it('keeps Audacity error text verbatim', async () => {
    const pipe = new AudacityPipe(undefined, 10, async () => ({
      ok: false,
      body: 'Cannot paste into a label track.',
      status: 'Failed!',
    }));
    await expect(new Ops(pipe).run('Paste')).rejects.toThrow('Cannot paste into a label track.');
  });
  it('refuses command bypasses before pipe transport', async () => {
    const transport = vi.fn();
    const ops = new Ops(new AudacityPipe(undefined, 10, transport));
    expect(() => ops.command('SaveProject2', { Filename: 'exists.aup3' })).toThrow();
    expect(() => ops.command('NoiseGate', { MODE: 'Analyze' })).toThrow('dialog');
    expect(() => ops.command('SampleDataExport', {})).toThrow('MESSAGES');
    expect(transport).not.toHaveBeenCalled();
  });
});
