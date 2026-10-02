import { describe, expect, it, vi } from 'vitest';
import { z } from 'zod';
import { AudacityPipe } from '../src/pipe.js';
import { CommandFailed, Ops, validateExportFile } from '../src/ops.js';
import { parseActiveProjects } from '../src/app.js';
import { parseMacro, safePreference, registerControlTools } from '../src/controls.js';
import { formatLabels, parseLabelsFile, timestamp } from '../src/labels.js';
import { catalogueCommand, formatCommand, parseInfoJson } from '../src/format.js';
import { COMMAND_IDS, EFFECT_IDS, MENU_IDS, describeCommand } from '../src/catalogue.js';
import type { ToolRegistrar } from '../src/tools.js';

describe('catalogue boundaries', () => {
  it('accepts verified underscore ids, hyphens and quoted spaced keys', () => {
    expect(formatCommand('Align_EndToEnd')).toBe('Align_EndToEnd:');
    expect(catalogueCommand('NoiseGate', { 'STEREO-LINK': 'LinkStereo', 'GATE-FREQ': 0 })).toContain('STEREO-LINK=LinkStereo');
    expect(catalogueCommand('FindClipping', { 'Duty Cycle Start': 3 })).toBe('FindClipping: "Duty Cycle Start"=3');
  });
  it.each(['New', 'Save', 'ManageMacros', 'About', 'TrackGain', 'Resample', 'RepeatLastEffect', 'ShareAudioTB', 'Record1stChoice', 'Record2ndChoice'])('excludes unsafe menu %s', (command) => {
    expect(MENU_IDS).not.toContain(command);
  });
  it.each(['MeasureRms', 'ClickRemoval', 'Repair', 'Drag', 'OpenProject2', 'SaveProject2', 'SaveCopy', 'NyquistPrompt', 'SetPreference'])('excludes generic unsafe command %s', (command) => {
    expect(COMMAND_IDS).not.toContain(command);
  });
  it('effects do not contain lifecycle/getter/track setters, and discovery exposes only declared parameters', () => {
    expect(EFFECT_IDS).not.toContain('SetTrack'); expect(EFFECT_IDS).not.toContain('GetPreference');
    expect(describeCommand('NoiseReduction')?.params).toEqual([]);
    expect(() => catalogueCommand('NoiseReduction', { Reduction: 6 })).toThrow();
    expect(describeCommand('SetEnvelope')?.params?.map((p) => p.key)).toEqual(['Time', 'Value', 'Delete']);
  });
  it.each(['SetTrack', 'SetTrackStatus', 'SetTrackAudio', 'SetTrackVisuals', 'SetClip', 'SetEnvelope'].flatMap((command) =>
    ['Track', 'TrackCount', 'Channel', 'ChannelCount'].map((parameter) => ({ command, parameter }))))('refuses ignored native $command.$parameter scope before pipe transport', ({ command, parameter }) => {
    const transport = vi.fn(); const ops = new Ops(new AudacityPipe(undefined, 10, transport));
    const params = { [parameter]: 1 };
    expect(describeCommand(command)?.params?.map((param) => param.key)).not.toContain(parameter);
    expect(() => catalogueCommand(command, params)).toThrow();
    expect(() => ops.command(command, params)).toThrow();
    expect(() => ops.run(command, params)).toThrow();
    expect(transport).not.toHaveBeenCalled();
  });
  it('preserves raw Windows paths containing JSON escape letters and valid escaped paths', () => {
    expect(parseInfoJson(String.raw`[{"file":"C:\new\test\rms.ny"}]`)).toEqual([{ file: String.raw`C:\new\test\rms.ny` }]);
    expect(parseInfoJson(JSON.stringify([{ file: String.raw`C:\new\test.wav`, name: 'line\nnext' }]))).toEqual([{ file: String.raw`C:\new\test.wav`, name: 'line\nnext' }]);
  });
  it.each(['out.xyz', 'out.aup3', 'out.aiff', '', 'wav'])('refuses unsupported export %s before Audacity', (file) => {
    expect(() => validateExportFile(file)).toThrow();
  });
  it('keeps Audacity error text verbatim', async () => {
    const pipe = new AudacityPipe(undefined, 10, async () => ({ ok: false, body: 'Cannot paste into a label track.', status: 'Failed!' }));
    await expect(new Ops(pipe).run('Paste')).rejects.toThrow('Cannot paste into a label track.');
  });
  it('refuses command bypasses before pipe transport', async () => {
    const transport = vi.fn(); const ops = new Ops(new AudacityPipe(undefined, 10, transport));
    expect(() => ops.command('SaveProject2', { Filename: 'exists.aup3' })).toThrow();
    expect(() => ops.command('NoiseGate', { MODE: 'Analyze' })).toThrow('dialog');
    expect(() => ops.command('SampleDataExport', {})).toThrow('MESSAGES');
    expect(transport).not.toHaveBeenCalled();
  });
});

describe('safe saved macros and preferences', () => {
  it('parses explicit types and default Fade Ends macro', () => {
    expect(parseMacro('Select:Start="0" End="1"\nFadeIn:Use_Preset="<Current Settings>"\nSelect:Start="0" End="1" RelativeTo="ProjectEnd"\nFadeOut:\n')).toEqual([
      { command: 'Select', params: { Start: 0, End: 1 } }, { command: 'FadeIn', params: {} },
      { command: 'Select', params: { Start: 0, End: 1, RelativeTo: 'ProjectEnd' } }, { command: 'FadeOut', params: {} },
    ]);
    expect(parseMacro('Amplify:Ratio="0.5" AllowClipping="0"')[0]?.params).toEqual({ Ratio: 0.5, AllowClipping: false });
    expect(parseMacro('SelectTracks:Track=1 TrackCount=2 Mode=Set')[0]?.params).toEqual({ Track: 1, TrackCount: 2, Mode: 'Set' });
  });
  it.each(['SetTrack', 'SetTrackStatus', 'SetTrackAudio', 'SetTrackVisuals', 'SetClip', 'SetEnvelope'].flatMap((command) =>
    ['Track', 'TrackCount', 'Channel', 'ChannelCount'].map((parameter) => ({ command, parameter }))))('rejects undeclared $command.$parameter scope in saved macros', ({ command, parameter }) => {
    expect(() => parseMacro(`${command}:${parameter}=1`)).toThrow();
  });
  it('translates an export only with a known explicit destination', () => {
    expect(parseMacro('ExportMP3:', 'out.mp3')).toEqual([{ command: 'Export2', params: { Filename: 'out.mp3', NumChannels: 2 } }]);
    expect(() => parseMacro('ExportMP3:')).toThrow('outputTo');
    expect(() => parseMacro('ExportMP3:', 'out.wav')).toThrow('.mp3');
  });
  it.each(['New:', 'Preferences:', 'Record1stChoice:', 'Record2ndChoice:', 'Drag:', 'MeasureRms:', 'Repair:', 'ClickRemoval:Threshold=200 Width=20', 'SaveProject2:Filename=x', 'Amplify:Ratio="bogus"', 'Amplify:Bogus=1', 'Amplify:Use_Preset="<Current Settings>"', 'Undo:Param=1', 'Amplify:Ratio=1 Ratio=2', 'No colon', ''])('rejects unsafe/incomplete macro %j', (macro) => {
    expect(() => parseMacro(macro)).toThrow();
  });
  it('restricts preferences to numeric supported sample rates and one/two record channels', () => {
    expect(safePreference('/SamplingRate/DefaultProjectSampleRate', 48000)).toBe('48000');
    expect(safePreference('/AudioIO/RecordChannels', 1)).toBe('1');
    expect(() => safePreference('/Module/mod-script-pipe', 0)).toThrow('writable');
    expect(() => safePreference('/SamplingRate/DefaultProjectSampleRate', '48000')).toThrow();
    expect(() => safePreference('/AudioIO/RecordChannels', 32)).toThrow();
  });
  it('reads only the recovery section and preserves project paths', () => {
    expect(parseActiveProjects('[Other]\n1=ignored\n[ActiveProjects]\n1=C:\\\\projects\\\\x.aup3\n2=/tmp/a.aup3\n[Window]\n1=no')).toEqual(['C:\\projects\\x.aup3', '/tmp/a.aup3']);
    expect(parseActiveProjects('[ActiveProjects]\n1=last.aup3')).toEqual(['last.aup3']);
    expect(parseActiveProjects('[ActiveProjects]\n[Window]\nX=1')).toEqual([]);
  });
});

describe('label file contracts', () => {
  it('rounds timestamps through minute/hour carry', () => {
    expect(timestamp(59.9999)).toBe('00:01:00.000');
    expect(timestamp(3600.125, ',')).toBe('01:00:00,125');
  });
  it('strictly imports TSV and JSON with positive time ordering', () => {
    expect(parseLabelsFile('0\t1\tFirst\r\n2\t2\tPoint\n', 'tsv')).toHaveLength(2);
    expect(() => parseLabelsFile('1\t0\tbackward', 'tsv')).toThrow();
    expect(() => parseLabelsFile('x\t2\tbad', 'tsv')).toThrow();
    expect(() => parseLabelsFile('[{"start":0,"text":"x","typo":1}]', 'json')).toThrow();
  });
  it.each(['tsv', 'json', 'srt', 'vtt', 'chapters', 'cue', 'podlove', 'ffmetadata'] as const)('formats %s labels with sorted ranges', (format) => {
    const output = formatLabels([{ start: 2, text: 'Second' }, { start: 0, text: 'First' }], format, 3);
    expect(output.indexOf('First')).toBeLessThan(output.indexOf('Second'));
    if (format === 'srt') expect(output).toContain('00:00:00,000 --> 00:00:02,000');
    if (format === 'vtt') expect(output).toMatch(/^WEBVTT/);
    if (format === 'ffmetadata') expect(output).toContain('TIMEBASE=1/1000');
  });
  it('escapes ffmetadata titles and refuses an end-less subtitle', () => {
    expect(formatLabels([{ start: 0, end: 1, text: 'A=B;#C' }], 'ffmetadata', 2)).toContain('title=A\\=B\\;\\#C');
    expect(() => formatLabels([{ start: 1, text: 'end' }], 'srt', 1)).toThrow('positive end');
  });
});

describe('transport state', () => {
  it('preserves recording mode through pause/resume and rejects ignored arguments', async () => {
    const handlers = new Map<string, (args: unknown) => Promise<unknown>>();
    const register: ToolRegistrar = (name, _description, shape, handler) => {
      handlers.set(name, (args) => handler(z.object(shape).strict().parse(args)));
    };
    const ops = { run: vi.fn(async () => ''), record: vi.fn(async () => ''), command: vi.fn(async () => '0'), info: vi.fn(async () => ({ Start: 0, End: 1 })), select: vi.fn() } as unknown as Ops;
    registerControlTools(register, ops);
    const call = handlers.get('audacity_transport')!;
    await expect(call({ action: 'record', end: 2 })).rejects.toThrow('not end');
    expect(ops.run).not.toHaveBeenCalled();
    await call({ action: 'record' });
    expect(await call({ action: 'pause' })).toMatchObject({ state: 'paused' });
    expect(await call({ action: 'resume' })).toMatchObject({ state: 'recording' });
    await call({ action: 'stop' });
    await expect(call({ action: 'resume' })).rejects.toThrow('not paused');
  });
});

function recordingFixture(preferNew = '0', inputChannels = '2', targetChannels = 2, targetKind = 'wave') {
  const handlers = new Map<string, (args: unknown) => Promise<unknown>>();
  const register: ToolRegistrar = (name, _description, shape, handler) => {
    handlers.set(name, (args) => handler(z.object(shape).strict().parse(args)));
  };
  let selection = { Start: 0.5, End: 2 };
  const ops = {
    run: vi.fn(async (_command: string) => ''), record: vi.fn(async (_command: string) => ''),
    command: vi.fn(async (command: string, params: Record<string, unknown>) => {
      if (command === 'SelectTime') selection = { Start: Number(params.Start), End: Number(params.End) };
      return params.Name === '/AudioIO/RecordChannels' ? inputChannels : preferNew;
    }),
    trackIndex: vi.fn(async () => 1),
    tracks: vi.fn(async () => [
      { name: 'Unselected distractor', kind: 'wave', channels: 1, start: 0, end: 10 },
      { name: 'Target', kind: targetKind, channels: targetChannels, start: 0, end: 3 },
    ]),
    info: vi.fn(async () => selection), select: vi.fn(async (scope: { start: number; end: number; track: number }) => {
      selection = { Start: scope.start, End: scope.end }; return {};
    }),
  };
  registerControlTools(register, ops as unknown as Ops);
  return { ops, call: handlers.get('audacity_transport')! };
}

describe('recording modal preflight', () => {
  it('requires an explicit append target before accessing native preferences or mutating selection', async () => {
    const { call, ops } = recordingFixture();
    await expect(call({ action: 'record', newTrack: false })).rejects.toThrow('explicit audio track');
    expect(ops.command).not.toHaveBeenCalled(); expect(ops.run).not.toHaveBeenCalled();
    expect(ops.select).not.toHaveBeenCalled(); expect(ops.record).not.toHaveBeenCalled();
  });
  it.each([['2', 1], ['1', 2], ['4', 2], ['unknown', 2]] as const)('refuses input channels %s with target channels %i before mutation', async (inputChannels, targetChannels) => {
    const { call, ops } = recordingFixture('0', inputChannels, targetChannels);
    await expect(call({ action: 'record', newTrack: false, track: 1 })).rejects.toThrow(/channels/);
    expect(ops.run).not.toHaveBeenCalled(); expect(ops.select).not.toHaveBeenCalled(); expect(ops.record).not.toHaveBeenCalled();
  });
  it('refuses a label recording target before querying preferences or mutating selection', async () => {
    const { call, ops } = recordingFixture('0', '2', 2, 'label');
    await expect(call({ action: 'record', newTrack: false, track: 1 })).rejects.toThrow('audio track');
    expect(ops.command).not.toHaveBeenCalled(); expect(ops.run).not.toHaveBeenCalled(); expect(ops.record).not.toHaveBeenCalled();
  });
  it.each([
    { newTrack: false, preferNew: '0', command: 'Record1stChoice' },
    { newTrack: false, preferNew: '1', command: 'Record2ndChoice' },
    { newTrack: true, preferNew: '0', command: 'Record2ndChoice' },
    { newTrack: true, preferNew: '1', command: 'Record1stChoice' },
  ])('respects preference $preferNew for newTrack=$newTrack and replaces a time range with a cursor', async ({ newTrack, preferNew, command }) => {
    const { call, ops } = recordingFixture(preferNew);
    const result = await call({ action: 'record', newTrack, track: 1, start: 1 }) as { state: string; positionSeconds: number };
    expect(ops.select).toHaveBeenCalledWith({ track: 1, start: 1, end: 1 });
    expect(ops.record).toHaveBeenCalledExactlyOnceWith(command);
    expect(ops.run).toHaveBeenCalledExactlyOnceWith('Stop');
    expect(result.state).toBe('recording'); expect(result.positionSeconds).toBeGreaterThanOrEqual(newTrack ? 1 : 3);
    expect(result.positionSeconds).toBeLessThan((newTrack ? 1 : 3) + 0.1);
  });
  it('clears track selection before untargeted new recording to avoid mixed-rate selected tracks', async () => {
    const { call, ops } = recordingFixture();
    await call({ action: 'record' });
    expect(ops.run.mock.calls).toEqual([['Stop'], ['SelectNone']]);
    expect(ops.command).toHaveBeenCalledWith('SelectTime', { Start: 0.5, End: 0.5, RelativeTo: 'ProjectStart' });
    expect(ops.trackIndex).not.toHaveBeenCalled(); expect(ops.select).not.toHaveBeenCalled();
    expect(ops.record).toHaveBeenCalledExactlyOnceWith('Record2ndChoice');
    expect(ops.run.mock.invocationCallOrder[1]).toBeLessThan(ops.record.mock.invocationCallOrder[0]!);
  });
  it('uses the native false default only for an absent preference with an empty Failed reply', async () => {
    const { call, ops } = recordingFixture();
    ops.command.mockRejectedValueOnce(new CommandFailed('GetPreference', { ok: false, body: '', status: 'Failed!' }));
    await call({ action: 'record' });
    expect(ops.record).toHaveBeenCalledExactlyOnceWith('Record2ndChoice');
  });
  it('preserves a native preference error and leaves selection untouched', async () => {
    const { call, ops } = recordingFixture();
    ops.command.mockRejectedValueOnce(new CommandFailed('GetPreference', { ok: false, body: 'The native preference is unavailable.', status: 'Failed!' }));
    await expect(call({ action: 'record' })).rejects.toThrow('The native preference is unavailable.');
    expect(ops.run).not.toHaveBeenCalled(); expect(ops.select).not.toHaveBeenCalled(); expect(ops.record).not.toHaveBeenCalled();
  });
  it.each(['True', 'false', '2', ''])('rejects malformed recording preference %j before any mutation', async (preference) => {
    const { call, ops } = recordingFixture(preference);
    await expect(call({ action: 'record' })).rejects.toThrow('expected 0 or 1');
    expect(ops.run).not.toHaveBeenCalled(); expect(ops.select).not.toHaveBeenCalled(); expect(ops.record).not.toHaveBeenCalled();
  });
});
