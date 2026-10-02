import { describe, expect, it, vi } from 'vitest';
import { z } from 'zod';
import { AudacityPipe } from '../src/pipe.js';
import { Ops, validateExportFile } from '../src/ops.js';
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
  it.each(['New', 'Save', 'ManageMacros', 'About', 'TrackGain', 'Resample', 'RepeatLastEffect'])('excludes unsafe menu %s', (command) => {
    expect(MENU_IDS).not.toContain(command);
  });
  it.each(['MeasureRms', 'ClickRemoval', 'Repair', 'Drag', 'OpenProject2', 'SaveProject2', 'SaveCopy', 'NyquistPrompt', 'SetPreference'])('excludes generic unsafe command %s', (command) => {
    expect(COMMAND_IDS).not.toContain(command);
  });
  it('effects do not contain lifecycle/getter/track setters, and discovery includes verified scope', () => {
    expect(EFFECT_IDS).not.toContain('SetTrack'); expect(EFFECT_IDS).not.toContain('GetPreference');
    expect(describeCommand('NoiseReduction')?.params).toEqual([]);
    expect(() => catalogueCommand('NoiseReduction', { Reduction: 6 })).toThrow();
    expect(describeCommand('SetEnvelope')?.params?.map((p) => p.key)).toContain('Track');
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
  });
  it('translates an export only with a known explicit destination', () => {
    expect(parseMacro('ExportMP3:', 'out.mp3')).toEqual([{ command: 'Export2', params: { Filename: 'out.mp3', NumChannels: 2 } }]);
    expect(() => parseMacro('ExportMP3:')).toThrow('outputTo');
    expect(() => parseMacro('ExportMP3:', 'out.wav')).toThrow('.mp3');
  });
  it.each(['New:', 'Preferences:', 'Drag:', 'MeasureRms:', 'Repair:', 'ClickRemoval:Threshold=200 Width=20', 'SaveProject2:Filename=x', 'Amplify:Ratio="bogus"', 'Amplify:Bogus=1', 'Amplify:Use_Preset="<Current Settings>"', 'Undo:Param=1', 'Amplify:Ratio=1 Ratio=2', 'No colon', ''])('rejects unsafe/incomplete macro %j', (macro) => {
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
    const ops = { run: vi.fn(async () => ''), info: vi.fn(async () => ({ Start: 0, End: 1 })), select: vi.fn() } as unknown as Ops;
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
