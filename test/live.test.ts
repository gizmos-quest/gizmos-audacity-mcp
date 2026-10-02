// Real stdio MCP integration against Audacity 3.7.x. Only AUDACITY_LIVE=1
// enables process or pipe access. User projects are backed up persistently;
// every test edit happens in the hidden, disposable test project.
import { describe, expect, it, beforeAll, afterAll, beforeEach } from 'vitest';
import { Client } from '@modelcontextprotocol/client';
import { StdioClientTransport } from '@modelcontextprotocol/client/stdio';
import { spawnSync } from 'node:child_process';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, statSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve, sep } from 'node:path';
import { fileURLToPath } from 'node:url';
import { AudacityPipe, AudacityNeedsRecovery, AudacityTimeout } from '../src/pipe.js';
import { audacityExe, audacityProcesses, configPath, isRunning, recoveryEntries } from '../src/app.js';
import { selectionTimes } from '../src/analysis.js';

const live = process.env.AUDACITY_LIVE === '1';
const root = fileURLToPath(new URL('..', import.meta.url));
const testTimeout = 120_000;
type Track = { name: string; kind: string; start: number; end: number; volume: number; pan: number; mute: number; solo: number; selected: number; focused: number };
type Label = { index: number; track: number; trackName: string; start: number; end: number; text: string };
type Clip = { track: number; start: number; end: number; name: string };
type Envelope = { track: number; points: { t: number; y: number }[] };
type Measurement = { duration: number; sampleRate: number; rms: number; rmsDbfs: number | null; peakDbfs: number | null; integratedLufs: number | null; truePeakDbtp: number | null };
type Windows = { windows: { title: string; visible: boolean; dialog: boolean; closed: boolean }[] };

function tone(path: string, seconds: number, amplitude = 12_000, quietStart = 0, rate = 48_000, channels = 1): void {
  const samples = Math.round(seconds * rate) * channels;
  const data = Buffer.alloc(samples * 2);
  for (let i = 0; i < samples; i++) {
    const frame = Math.floor(i / channels);
    const value = frame / rate < quietStart ? 0 : Math.sin((2 * Math.PI * 440 * frame) / rate) * amplitude;
    data.writeInt16LE(Math.round(value), i * 2);
  }
  const header = Buffer.alloc(44);
  header.write('RIFF', 0); header.writeUInt32LE(36 + data.length, 4); header.write('WAVEfmt ', 8);
  header.writeUInt32LE(16, 16); header.writeUInt16LE(1, 20); header.writeUInt16LE(channels, 22);
  header.writeUInt32LE(rate, 24); header.writeUInt32LE(rate * channels * 2, 28);
  header.writeUInt16LE(channels * 2, 32); header.writeUInt16LE(16, 34);
  header.write('data', 36); header.writeUInt32LE(data.length, 40);
  writeFileSync(path, Buffer.concat([header, data]));
}

function available(executable: string): boolean {
  return spawnSync(executable, ['-version'], { windowsHide: true, stdio: 'ignore', timeout: 10_000 }).status === 0;
}

describe.skipIf(!live)('live Audacity through stdio MCP', () => {
  let dir: string;
  let client: Client | undefined;
  let fixture: string;
  let quietFixture: string;
  let lowFixture: string;
  let multichannelFixture: string;
  const called = new Set<string>();
  let registered: string[] = [];
  let sequence = 0;

  const output = (stem: string, extension = 'wav') => join(dir, `${++sequence}-${stem}.${extension}`);
  const call = async <T = unknown>(name: string, args: Record<string, unknown> = {}): Promise<T> => {
    if (!client) throw new Error('MCP client is not connected');
    called.add(name);
    const result = await client.callTool({ name, arguments: args }, { timeout: 180_000 });
    const text = result.content.filter((item) => item.type === 'text').map((item) => item.text).join('\n');
    if (result.isError) throw new Error(`${name}: ${text}`);
    try { return JSON.parse(text) as T; } catch { return text as T; }
  };
  const tracks = async () => (await call<{ running: boolean; tracks: Track[] }>('audacity_status')).tracks;
  const clearTracks = async () => {
    const current = await tracks();
    if (current.length) await call('audacity_track_edit', { action: 'remove', track: 0, trackCount: current.length });
  };
  const importVoice = async (name = 'Voice', file = fixture, start = 0) => {
    await call('audacity_import', { file, name, start });
    return name;
  };

  beforeAll(async () => {
    if (process.platform !== 'win32') throw new Error('Live lifecycle verification requires Windows and pinned English Audacity 3.7.8');
    const executable = audacityExe();
    const versionResult = spawnSync('powershell.exe', ['-NoProfile', '-NonInteractive', '-Command',
      `(Get-Item -LiteralPath '${executable.replace(/'/g, "''")}').VersionInfo.FileVersion`],
    { windowsHide: true, encoding: 'utf8', timeout: 10_000 });
    const version = versionResult.stdout?.trim().replace(/,/g, '.');
    if (versionResult.status !== 0 || version !== '3.7.8.0') throw new Error(`Live tests require actual Audacity 3.7.8, found ${version ?? 'unknown'} at ${executable}; set AUDACITY_EXE and AUDACITY_CONFIG to the pinned installation`);
    const existing = await audacityProcesses();
    if (existing.some((process) => !process.executable || resolve(process.executable).toLowerCase() !== resolve(executable).toLowerCase())) {
      throw new Error('A different Audacity executable is already running; preserve and quit it before version-isolated live tests');
    }
    dir = mkdtempSync(join(tmpdir(), 'gizmos-audacity-live-'));
    fixture = join(dir, 'tone.wav'); tone(fixture, 2);
    quietFixture = join(dir, 'quiet-start.wav'); tone(quietFixture, 2, 12_000, 0.5);
    lowFixture = join(dir, 'room-tone.wav'); tone(lowFixture, 2, 120);
    multichannelFixture = join(dir, 'three-channel.wav'); tone(multichannelFixture, 0.25, 12_000, 0, 48_000, 3);
    const backups = join(root, '.work', 'live-backups');
    mkdirSync(backups, { recursive: true });
    client = new Client({ name: 'live-test', version: '1' });
    // SDK stdio intentionally inherits a narrow environment. Forward only our
    // explicit executable/config/ffmpeg overrides so version-isolated live
    // verification actually launches the requested Audacity, not the default.
    const env = Object.fromEntries(['AUDACITY_EXE', 'AUDACITY_CONFIG', 'AUDACITY_FFMPEG', 'AUDACITY_FFPROBE']
      .flatMap((key) => process.env[key] === undefined ? [] : [[key, process.env[key]!]]));
    await client.connect(new StdioClientTransport({ command: process.execPath, args: [join(root, 'dist', 'main.js')], env }));
    registered = (await client.listTools()).tools.map((tool) => tool.name).sort();
    await call('audacity_fresh', { visible: false, backupTo: join(backups, `before-live-${Date.now()}.aup3`) });
    await call('audacity_launch', { visible: false });
    const processes = await audacityProcesses();
    expect(processes).toHaveLength(1);
    expect(resolve(processes[0]!.executable!).toLowerCase()).toBe(resolve(executable).toLowerCase());
    expect(processes[0]!.fileVersion?.replace(/,/g, '.')).toBe('3.7.8.0');
    await call('audacity_command', { command: 'SetProject', params: { Rate: 48000 } });
  }, 120_000);

  beforeEach(async () => { await clearTracks(); }, testTimeout);

  afterAll(async () => {
    const errors: unknown[] = [];
    if (client) {
      try {
        if (await isRunning()) {
          await call('audacity_dialogs', { close: true });
          await call('audacity_recover', { closeDialogs: true });
          await call('audacity_transport', { action: 'stop' });
          const windows = await call<Windows>('audacity_dialogs');
          expect(windows.windows.filter((window) => window.dialog)).toEqual([]);
          await call('audacity_quit');
        }
        expect(await isRunning()).toBe(false);
        expect(recoveryEntries()).toEqual([]);
      } catch (error) { errors.push(error); }
      try { await client.close(); } catch (error) { errors.push(error); }
    }
    // Only scratch fixtures are deleted. The initial project backup is kept.
    // A teardown failure retains scratch projects for diagnosis and recovery.
    if (!errors.length && dir) {
      const absolute = resolve(dir);
      if (!absolute.startsWith(resolve(tmpdir()) + sep) || !absolute.includes('gizmos-audacity-live-')) {
        throw new Error(`refusing unsafe test cleanup: ${absolute}`);
      }
      rmSync(absolute, { recursive: true, force: true });
    }
    if (errors.length) throw new AggregateError(errors, 'Live Audacity teardown failed; scratch files were retained');
  }, 120_000);

  it('advertises typed tools and rejects unknown inputs and modal menu commands', async () => {
    const tools = (await client!.listTools()).tools;
    expect(tools.length).toBeGreaterThan(40);
    for (const tool of tools) {
      expect(tool.description?.length).toBeGreaterThan(30);
      expect(tool.inputSchema.type).toBe('object');
      expect(tool.inputSchema.additionalProperties).toBe(false);
    }
    await expect(call('audacity_status', { unexpected: true })).rejects.toThrow();
    await expect(call('audacity_menu', { command: 'New' })).rejects.toThrow();
    await expect(call('audacity_menu', { command: 'Preferences' })).rejects.toThrow();
    await expect(call('audacity_menu', { command: 'Record1stChoice' })).rejects.toThrow();
    await expect(call('audacity_menu', { command: 'Record2ndChoice' })).rejects.toThrow();
    await expect(call('audacity_command', { command: 'Amplify', params: { Bogus: 1 } })).rejects.toThrow();
    await expect(call('audacity_effect', { effect: 'ClickRemoval' })).rejects.toThrow();
    for (const effect of ['SpectralEditMultiTool', 'SpectralEditParametricEq', 'SpectralEditShelves', 'SpectralDelete', 'LabelSounds']) {
      await expect(call('audacity_effect', { effect })).rejects.toThrow();
      await expect(call('audacity_command', { command: effect })).rejects.toThrow();
    }
    expect((await call<Windows>('audacity_dialogs')).windows.some((window) => window.dialog)).toBe(false);
  }, testTimeout);

  it('launches, hides/shows windows and reads catalogue and project state', async () => {
    await call('audacity_window', { show: true });
    expect((await call<Windows>('audacity_dialogs')).windows.find((window) => window.title === 'Audacity')?.visible).toBe(true);
    await call('audacity_window', { show: false });
    expect((await call<Windows>('audacity_dialogs')).windows.find((window) => window.title === 'Audacity')?.visible).toBe(false);
    for (const type of ['Tracks', 'Clips', 'Envelopes', 'Labels', 'Boxes', 'Commands', 'Menus', 'Selection', 'Preferences']) {
      expect(await call('audacity_info', { type })).toBeDefined();
    }
    expect(await call('audacity_describe', { command: 'Amplify' })).toMatchObject({ id: 'Amplify' });
    await call('audacity_menu', { command: 'SelectNone' });
    expect(await call('audacity_status')).toMatchObject({ running: true, tracks: [] });
    expect(await call('audacity_project_info')).toMatchObject({ rate: null, lengthSeconds: 0 });
  }, testTimeout);

  it('refuses a different executable override before lifecycle calls touch the live project', async () => {
    await importVoice('Preserved voice');
    await call('audacity_select', { track: 'Preserved voice', start: 0.25, end: 0.75 });
    const before = await tracks();
    const selection = await call('audacity_info', { type: 'Selection' });
    const other = new Client({ name: 'wrong-installation-test', version: '1' });
    const env = Object.fromEntries(['AUDACITY_CONFIG', 'AUDACITY_FFMPEG', 'AUDACITY_FFPROBE']
      .flatMap((key) => process.env[key] === undefined ? [] : [[key, process.env[key]!]]));
    // This existing fixture is deliberately a different path; preflight must
    // refuse it before attempting either pipe access or executable launch.
    env.AUDACITY_EXE = fixture;
    try {
      await other.connect(new StdioClientTransport({ command: process.execPath, args: [join(root, 'dist', 'main.js')], env }));
      for (const name of ['audacity_launch', 'audacity_fresh', 'audacity_quit', 'audacity_recover']) {
        const result = await other.callTool({ name, arguments: {} });
        expect(result.isError).toBe(true);
        expect(result.content.filter((item) => item.type === 'text').map((item) => item.text).join('\n')).toMatch(/Preserve and quit that installation/);
      }
    } finally { await other.close(); }
    expect(await tracks()).toEqual(before);
    expect(await call('audacity_info', { type: 'Selection' })).toEqual(selection);
    expect((await call<Windows>('audacity_dialogs')).windows.filter((window) => window.dialog)).toEqual([]);
  }, testTimeout);

  it('rejects incomplete properties and invalid later measurement ranges without changing the project', async () => {
    await importVoice('Voice');
    await call('audacity_select', { track: 'Voice', start: 0.25, end: 0.75 });
    const previousTracks = await tracks();
    const previousSelection = await call('audacity_info', { type: 'Selection' });
    await expect(call('audacity_track_set', { track: 'Voice' })).rejects.toThrow(/at least one track property/);
    await expect(call('audacity_transport', { action: 'play', track: 'Voice', start: 0.5, end: 0.5 })).rejects.toThrow(/positive.duration/);
    await expect(call('audacity_labels_set', { trackName: '', labels: [{ start: 0, text: 'Invalid' }] })).rejects.toThrow();
    await expect(call('audacity_envelope_set', { track: 'Voice', points: [{ time: 0.1, value: 1 }, { time: 0.2, value: 2.1 }] })).rejects.toThrow();
    await expect(call('audacity_command', { command: 'SetTrack', params: { Pan: 101 } })).rejects.toThrow();
    await expect(call('audacity_generate', { kind: 'tone', track: 'Voice', channels: 2 })).rejects.toThrow(/existing tracks retain their channels/);
    await expect(call('audacity_measure', { track: 'Voice', start: 3, backend: 'wav' })).rejects.toThrow(/non-empty time selection/);
    await expect(call('audacity_contrast', { foreground: { track: 'Voice', start: 0, end: 1 },
      background: { track: 'Voice', start: 1, end: 0 } })).rejects.toThrow(/end must be after start/);
    expect(await tracks()).toEqual(previousTracks);
    expect(await call('audacity_info', { type: 'Selection' })).toEqual(previousSelection);
    expect((await call<Windows>('audacity_dialogs')).windows.filter((window) => window.dialog)).toEqual([]);
  }, testTimeout);

  it('reports multi-track imports explicitly and cleans every confirmed batch temporary track', async () => {
    await importVoice('Original');
    const previous = await tracks();
    await expect(call('audacity_import', { file: multichannelFixture, name: 'Unsupported multi-track' })).rejects.toThrow(/import added.*tracks/);
    const imported = await tracks();
    expect(imported.length).toBeGreaterThan(previous.length + 1);
    const { focused: _focused, selected: _selected, ...originalAudio } = previous[0]!;
    expect(imported[0]).toMatchObject(originalAudio);
    await call('audacity_track_edit', { action: 'remove', track: previous.length, trackCount: imported.length - previous.length });
    await call('audacity_select', { track: 'Original', start: 0.1, end: 0.2 });
    const selection = await call('audacity_info', { type: 'Selection' });
    const beforeBatch = await tracks();
    const file = output('multi-track-batch-refusal');
    await expect(call('audacity_batch', { jobs: [{ file: multichannelFixture, output: file }], measure: false })).rejects.toThrow(/import added.*tracks/);
    expect(await tracks()).toEqual(beforeBatch);
    expect(await call('audacity_info', { type: 'Selection' })).toEqual(selection);
    expect(existsSync(file)).toBe(false);
    expect((await call<Windows>('audacity_dialogs')).windows.filter((window) => window.dialog)).toEqual([]);
  }, testTimeout);

  it('preserves the integration argument shapes, boolean encoding and explicit export selection', async () => {
    await importVoice('Voice', fixture, 1.5);
    expect((await tracks())[0]).toMatchObject({ name: 'Voice', start: 1.5 });
    const changed = await call<Track>('audacity_track_set', { track: 'Voice', gainDb: -6, pan: 0.25, mute: true, solo: false });
    expect(changed.volume).toBeCloseTo(10 ** (-6 / 20), 4); expect(changed.mute).toBe(1);
    await call('audacity_track_set', { track: 'Voice', mute: false, solo: true });
    expect((await tracks())[0]?.solo).toBe(1);
    await call('audacity_track_set', { track: 'Voice', gainDb: 0, pan: 0, solo: false });
    await call('audacity_clip_move', { track: 'Voice', at: 2, start: 1 });
    expect((await tracks())[0]?.start).toBeCloseTo(1, 4);
    await call('audacity_envelope_set', { track: 'Voice', points: [{ time: 1, value: 1 }, { time: 2, value: 0.25 }] });
    const envelopes = await call<{ points: { t: number; y: number }[] }[]>('audacity_info', { type: 'Envelopes' });
    expect(envelopes.flatMap((entry) => entry.points).map((point) => point.y)).toEqual([1, 0.25]);
    await call('audacity_labels_set', { labels: [{ start: 1, text: 'line one' }, { start: 1.5, end: 2.5, text: 'region' }] });
    await call('audacity_effect', { effect: 'Amplify', params: { Ratio: 0.5 }, track: 'Voice' });
    const audio = output('mix'); await call('audacity_export', { file: audio, channels: 1 });
    expect(statSync(audio).size).toBeGreaterThan(48_000 * 2 * 2.9);
    expect(await call<Measurement>('audacity_measure_file', { file: audio, backend: 'wav' })).toMatchObject({ sampleRate: 48000 });
    expect((await call<Measurement>('audacity_measure_file', { file: audio, backend: 'wav' })).rms).toBeGreaterThan(0);
    expect((await tracks())[0]?.end).toBeCloseTo(3, 4);
  }, testTimeout);

  it('rejects ignored Set* scope arguments and edits only the explicitly requested track', async () => {
    await importVoice('Target'); await importVoice('Distractor');
    await call('audacity_select', { track: 'Distractor' });
    const initialSelection = await call('audacity_info', { type: 'Selection' });
    for (const command of ['SetTrack', 'SetTrackStatus', 'SetTrackAudio', 'SetTrackVisuals', 'SetClip', 'SetEnvelope']) {
      for (const key of ['Track', 'TrackCount', 'Channel', 'ChannelCount']) {
        await expect(call('audacity_command', { command, params: { [key]: 0 } })).rejects.toThrow();
      }
    }
    expect(await call('audacity_info', { type: 'Selection' })).toEqual(initialSelection);
    expect((await tracks()).map((track) => track.selected)).toEqual([0, 1]);
    const unchangedControls = (track: Track) => ({ name: track.name, volume: track.volume, pan: track.pan, mute: track.mute, solo: track.solo });
    const originalDistractor = unchangedControls((await tracks())[1]!);
    await call('audacity_track_set', { track: 'Target', name: 'Edited target', gainDb: -6, pan: -0.4, mute: true, solo: false });
    const properties = await tracks();
    expect(properties[0]).toMatchObject({ name: 'Edited target', pan: -0.4, mute: 1 });
    expect(properties[0]!.volume).toBeCloseTo(10 ** (-6 / 20), 4);
    expect(unchangedControls(properties[1]!)).toEqual(originalDistractor);
    await call('audacity_track_set', { track: 'Edited target', gainDb: 0, pan: 0, mute: false });

    const distractorClips = (await call<Clip[]>('audacity_info', { type: 'Clips' })).filter((clip) => clip.track === 1);
    await call('audacity_select', { track: 'Distractor' });
    await call('audacity_clip_move', { track: 'Edited target', at: 1, start: 1 });
    const moved = await call<Clip[]>('audacity_info', { type: 'Clips' });
    expect(moved.find((clip) => clip.track === 0)).toMatchObject({ start: 1, end: 3 });
    expect(moved.filter((clip) => clip.track === 1)).toEqual(distractorClips);

    await call('audacity_envelope_set', { track: 'Distractor', points: [{ time: 0.25, value: 0.7 }, { time: 1.75, value: 0.7 }] });
    const distractorEnvelope = (await call<Envelope[]>('audacity_info', { type: 'Envelopes' })).filter((entry) => entry.track === 1);
    expect(distractorEnvelope.flatMap((entry) => entry.points).length).toBeGreaterThan(0);
    await call('audacity_select', { track: 'Distractor' });
    await call('audacity_envelope_set', { track: 'Edited target', points: [{ time: 1.25, value: 1 }, { time: 1.75, value: 0.25 }] });
    const envelopes = await call<Envelope[]>('audacity_info', { type: 'Envelopes' });
    expect(envelopes.filter((entry) => entry.track === 1)).toEqual(distractorEnvelope);
    expect(envelopes.filter((entry) => entry.track === 0).flatMap((entry) => entry.points).map((point) => point.y)).toEqual([1, 0.25]);

    const distractorAudio = await call<Measurement>('audacity_measure', { track: 'Distractor', backend: 'wav' });
    await call('audacity_select', { track: 'Distractor' });
    await call('audacity_clip_set', { track: 'Edited target', at: 1.5, name: 'Target clip', color: 'Color2', gainDb: -6 });
    const editedClips = await call<Clip[]>('audacity_info', { type: 'Clips' });
    expect(editedClips.find((clip) => clip.track === 0)?.name).toBe('Target clip');
    expect(editedClips.filter((clip) => clip.track === 1)).toEqual(distractorClips);
    expect((await call<Measurement>('audacity_measure', { track: 'Distractor', backend: 'wav' })).rms).toBeCloseTo(distractorAudio.rms, 5);
    expect(unchangedControls((await tracks())[1]!)).toEqual(originalDistractor);
    // Native SetClip treats a shared boundary as belonging to both neighbors.
    // The task must identify the second clip and move it using an interior time.
    await call('audacity_edit', { action: 'split', track: 'Edited target', start: 2, end: 2 });
    await call('audacity_select', { track: 'Distractor' });
    await call('audacity_clip_move', { track: 'Edited target', at: 2, start: 4 });
    const boundaryMove = await call<Clip[]>('audacity_info', { type: 'Clips' });
    expect(boundaryMove.filter((clip) => clip.track === 0).map(({ start, end }) => ({ start, end }))).toEqual([{ start: 1, end: 2 }, { start: 4, end: 5 }]);
    expect(boundaryMove.filter((clip) => clip.track === 1)).toEqual(distractorClips);
  }, testTimeout);

  it('names imported/generated/label tracks without renaming previously selected tracks', async () => {
    await importVoice('Existing');
    const existing = (await tracks())[0]!;
    const preserveExisting = async () => {
      const current = (await tracks())[0]!;
      expect(current.name).toBe(existing.name); expect(current.kind).toBe(existing.kind);
      expect(current.start).toBe(existing.start); expect(current.end).toBe(existing.end);
      expect(current.volume).toBe(existing.volume); expect(current.pan).toBe(existing.pan);
      expect(current.mute).toBe(existing.mute); expect(current.solo).toBe(existing.solo);
    };
    await call('audacity_select', { track: 'Existing' });
    await call('audacity_import', { file: fixture, name: 'New import', start: 4 });
    expect((await tracks())[1]).toMatchObject({ name: 'New import', start: 4, end: 6 });
    await preserveExisting();
    await call('audacity_select', { track: 'Existing' });
    await call('audacity_generate', { kind: 'tone', name: 'Generated', duration: 0.25, amplitude: 0.1 });
    expect((await tracks())[2]?.name).toBe('Generated'); await preserveExisting();
    await call('audacity_select', { track: 'Existing' });
    await call('audacity_track_edit', { action: 'add_mono', name: 'Added mono' });
    expect((await tracks())[3]?.name).toBe('Added mono'); await preserveExisting();
    await call('audacity_select', { track: 'Existing' });
    await call('audacity_labels_set', { trackName: 'Story', labels: [{ start: 0, text: 'Delete this' }, { start: 1, text: 'Keep this' }] });
    expect((await tracks())[4]).toMatchObject({ name: 'Story', kind: 'label' }); await preserveExisting();
    const importedLabels = output('isolation-labels', 'tsv'); writeFileSync(importedLabels, '0.25\t0.75\tImported label\n');
    await call('audacity_select', { track: 'Existing' });
    await call('audacity_labels_file', { action: 'import', file: importedLabels, trackName: 'Imported labels' });
    expect((await tracks())[5]).toMatchObject({ name: 'Imported labels', kind: 'label' }); await preserveExisting();
    const deleted = (await call<Label[]>('audacity_labels', { action: 'find', query: 'Delete this' }))[0]!;
    await call('audacity_select', { track: 'Existing' });
    await call('audacity_labels', { action: 'delete', index: deleted.index });
    await preserveExisting();
    expect((await tracks()).map((track) => track.name)).toEqual(['Existing', 'New import', 'Generated', 'Added mono', 'Imported labels', 'Story']);
    expect((await call<Label[]>('audacity_labels', { action: 'list' })).map((label) => label.text).sort()).toEqual(['Imported label', 'Keep this']);
  }, testTimeout);

  it.each([
    { kind: 'tone', frequency: 220, amplitude: 0.1, waveform: 'Sine' },
    { kind: 'noise', noiseType: 'Pink', amplitude: 0.1 },
    { kind: 'silence' },
    { kind: 'chirp', frequency: 220, endFrequency: 880, amplitude: 0.1, endAmplitude: 0.05, interpolation: 'Logarithmic' },
    { kind: 'dtmf', sequence: '12#', dutyCycle: 55, amplitude: 0.1 },
    { kind: 'rhythm', tempo: 120, beatsPerBar: 4, swing: 0.1, clickSound: 'Metronome' },
  ])('generates $kind without dialogs', async (parameters) => {
    await call('audacity_generate', { ...parameters, name: parameters.kind, start: 0.25, duration: 0.75 });
    const generated = (await tracks())[0]!;
    expect(generated.name).toBe(parameters.kind); expect(generated.start).toBeCloseTo(0.25, 3);
    expect(generated.end).toBeGreaterThan(generated.start);
    const measured = await call<Measurement>('audacity_measure', { track: parameters.kind, backend: 'wav' });
    // Audacity's 16-bit PCM export can dither digital silence by one LSB.
    if (parameters.kind === 'silence') expect(measured.rms).toBeLessThanOrEqual(1e-4);
    else expect(measured.rms).toBeGreaterThan(0);
    expect((await call<Windows>('audacity_dialogs')).windows.some((window) => window.dialog)).toBe(false);
  }, testTimeout);

  it('replaces a range of an existing stereo track with generated audio', async () => {
    await call('audacity_generate', { kind: 'tone', name: 'Stereo', channels: 2, duration: 2, amplitude: 0.1 });
    expect(await call('audacity_measure', { track: 'Stereo', backend: 'wav' })).toMatchObject({ channels: 2 });
    await call('audacity_generate', { kind: 'silence', track: 'Stereo', start: 0.5, duration: 0.25 });
    expect((await tracks()).length).toBe(1);
    expect((await call<Measurement>('audacity_measure', { track: 'Stereo', start: 0.5, end: 0.75, backend: 'wav' })).rms).toBeLessThanOrEqual(1e-4);
  }, testTimeout);

  it('edits clips with split/trim/duplicate/delete/copy/paste/silence/join', async () => {
    await importVoice();
    await call('audacity_edit', { action: 'split', track: 'Voice', start: 1, end: 1 });
    expect((await call<unknown[]>('audacity_info', { type: 'Clips' })).length).toBe(2);
    await call('audacity_edit', { action: 'join', track: 'Voice', start: 0, end: 2 });
    expect((await call<unknown[]>('audacity_info', { type: 'Clips' })).length).toBe(1);
    await call('audacity_edit', { action: 'copy', track: 'Voice', start: 0.25, end: 0.5 });
    await call('audacity_edit', { action: 'paste', track: 'Voice', start: 2, end: 2 });
    expect((await tracks())[0]?.end).toBeCloseTo(2.25, 3);
    await call('audacity_edit', { action: 'silence', track: 'Voice', start: 0.5, end: 0.75 });
    expect((await call<Measurement>('audacity_measure', { track: 'Voice', start: 0.5, end: 0.75, backend: 'wav' })).rms).toBeLessThanOrEqual(1e-4);
    await call('audacity_edit', { action: 'duplicate', track: 'Voice', start: 0, end: 1 });
    expect((await tracks()).length).toBe(2);
    await call('audacity_track_edit', { action: 'remove', track: 1 });
    await call('audacity_edit', { action: 'trim', track: 'Voice', start: 0.25, end: 1.75 });
    expect((await tracks())[0]).toMatchObject({ start: 0.25, end: 1.75 });
    await call('audacity_edit', { action: 'split_delete', track: 'Voice', start: 0.5, end: 0.75 });
    expect((await tracks())[0]?.end).toBeCloseTo(1.75, 3);
    await call('audacity_edit', { action: 'delete', track: 'Voice', start: 1, end: 1.25 });
    expect((await tracks())[0]?.end).toBeCloseTo(1.5, 3);
    await expect(call('audacity_edit', { action: 'trim', track: 'Voice', start: 1, end: 1 })).rejects.toThrow(/non-empty/);
  }, testTimeout);

  it('adds/removes tracks, aligns audio tracks and mixes to existing/new tracks', async () => {
    for (const [action, name] of [['add_mono', 'Empty mono'], ['add_stereo', 'Empty stereo'], ['add_label', 'Empty labels']]) {
      await call('audacity_track_edit', { action, name });
    }
    expect((await tracks()).map((track) => track.name)).toEqual(['Empty mono', 'Empty stereo', 'Empty labels']);
    await clearTracks(); await importVoice('One', fixture, 1); await importVoice('Two', fixture, 2);
    await call('audacity_track_edit', { action: 'align_start_zero', track: 'One', trackCount: 2 });
    // Native Align_StartToZero shifts the selected group by its earliest start;
    // it preserves the one-second offset rather than aligning each track.
    expect((await tracks()).map((track) => track.start)).toEqual([0, 1]);
    await call('audacity_track_edit', { action: 'align_end_to_end', track: 'One', trackCount: 2 });
    expect((await tracks())[1]?.start).toBeCloseTo(2, 3);
    await call('audacity_track_edit', { action: 'align_together', track: 'One', trackCount: 2 });
    const together = await tracks(); expect(together[0]?.start).toBeCloseTo(together[1]!.start, 3);
    await call('audacity_track_edit', { action: 'mix_new', track: 'One', trackCount: 2 });
    expect((await tracks()).length).toBe(3);
    await call('audacity_track_edit', { action: 'mix', track: 'One', trackCount: 2 });
    expect((await tracks()).length).toBe(2);
  }, testTimeout);

  it('splits to a new track, cuts with/without ripple and disjoins silenced audio', async () => {
    await importVoice();
    await call('audacity_edit', { action: 'split_new', track: 'Voice', start: 0.5, end: 1 });
    expect((await tracks()).length).toBe(2);
    await clearTracks(); await importVoice();
    await call('audacity_edit', { action: 'cut', track: 'Voice', start: 0.5, end: 0.75 });
    expect((await tracks())[0]?.end).toBeCloseTo(1.75, 3);
    await clearTracks(); await importVoice();
    await call('audacity_edit', { action: 'split_cut', track: 'Voice', start: 0.5, end: 0.75 });
    expect((await tracks())[0]?.end).toBeCloseTo(2, 3);
    expect((await call<unknown[]>('audacity_info', { type: 'Clips' })).length).toBe(2);
    await clearTracks(); await importVoice();
    await call('audacity_edit', { action: 'silence', track: 'Voice', start: 0.5, end: 0.75 });
    await call('audacity_edit', { action: 'disjoin', track: 'Voice', start: 0, end: 2 });
    expect((await call<unknown[]>('audacity_info', { type: 'Clips' })).length).toBeGreaterThanOrEqual(2);
  }, testTimeout);

  it('aligns track starts and ends to either selection edge', async () => {
    await importVoice();
    await call('audacity_track_edit', { action: 'align_start_cursor', track: 'Voice', start: 0.5, end: 1 });
    expect((await tracks())[0]?.start).toBeCloseTo(0.5, 3);
    await call('audacity_track_edit', { action: 'align_start_end', track: 'Voice', start: 0.5, end: 1 });
    expect((await tracks())[0]?.start).toBeCloseTo(1, 3);
    await call('audacity_track_edit', { action: 'align_end_cursor', track: 'Voice', start: 3, end: 3 });
    expect((await tracks())[0]?.end).toBeCloseTo(3, 3);
    await call('audacity_track_edit', { action: 'align_end_end', track: 'Voice', start: 3, end: 4 });
    expect((await tracks())[0]?.end).toBeCloseTo(4, 3);
  }, testTimeout);

  it('renames/colors clips, applies clip gain and both fades', async () => {
    await importVoice();
    const before = await call<Measurement>('audacity_measure', { track: 'Voice', backend: 'wav' });
    await call('audacity_clip_set', { track: 'Voice', at: 1.5, name: 'Spoken clip', color: 'Color1', gainDb: -6 });
    expect(await call('audacity_info', { type: 'Clips' })).toEqual(expect.arrayContaining([expect.objectContaining({ name: 'Spoken clip' })]));
    const after = await call<Measurement>('audacity_measure', { track: 'Voice', backend: 'wav' });
    expect(after.rmsDbfs! - before.rmsDbfs!).toBeCloseTo(-6, 2);
    await call('audacity_fade', { track: 'Voice', direction: 'in', start: 0, end: 0.5 });
    await call('audacity_fade', { track: 'Voice', direction: 'out', start: 1.5, end: 2 });
    const beginning = await call<Measurement>('audacity_measure', { track: 'Voice', start: 0, end: 0.05, backend: 'wav' });
    const middle = await call<Measurement>('audacity_measure', { track: 'Voice', start: 0.75, end: 1, backend: 'wav' });
    expect(beginning.rms).toBeLessThan(middle.rms * 0.15);
  }, testTimeout);

  it('previews and applies auto-duck only with the required bed/voice topology', async () => {
    await importVoice('Bed'); await importVoice('Voice');
    const before = await call<Measurement>('audacity_measure', { track: 'Bed', backend: 'wav' });
    expect(await call('audacity_auto_duck', { bed: 'Bed', voice: 'Voice', dryRun: true })).toMatchObject({ dryRun: true, command: 'AutoDuck' });
    await call('audacity_auto_duck', { bed: 'Bed', voice: 'Voice', duckDb: -12, thresholdDb: -30, fadeDown: 0.1, fadeUp: 0.1 });
    const after = await call<Measurement>('audacity_measure', { track: 'Bed', backend: 'wav' });
    expect(after.rms).toBeLessThan(before.rms * 0.6);
    await expect(call('audacity_auto_duck', { bed: 'Voice', voice: 'Bed' })).rejects.toThrow(/next audio track/);
  }, testTimeout);

  it.each(['cleanup', 'voice', 'podcast', 'interview', 'audiobook', 'vocal', 'live', 'music', 'lofi'])('previews and applies the %s pipeline within the target extent', async (preset) => {
    await importVoice('Voice', fixture, 1); await importVoice('Long bed', fixture, 4);
    await call('audacity_select', { track: 'Long bed', start: 4.25, end: 4.5 });
    const selection = await call('audacity_info', { type: 'Selection' });
    const plan = await call<{ dryRun: boolean; steps: { command: string; params: unknown }[] }>('audacity_pipeline', { preset, track: 'Voice', dryRun: true });
    expect(plan.dryRun).toBe(true); expect(plan.steps.length).toBeGreaterThan(1);
    expect(await call('audacity_info', { type: 'Selection' })).toEqual(selection);
    const result = await call<{ applied: unknown[]; steps: unknown[] }>('audacity_pipeline', { preset, track: 'Voice' });
    expect(result.applied.length).toBe(result.steps.length);
    const voice = (await tracks()).find((track) => track.name === 'Voice')!;
    expect(voice.start).toBeCloseTo(1, 3); expect(voice.end).toBeCloseTo(3, 3);
    expect((await call<Measurement>('audacity_measure', { track: 'Voice', backend: 'wav' })).rms).toBeGreaterThan(0);
  }, testTimeout);

  it('captures a noise profile and runs explicit cleanup, pause shortening and loudness stages', async () => {
    const tracedCall = async <T = unknown>(name: string, args: Record<string, unknown> = {}): Promise<T> => {
      const label = `${name}${typeof args.effect === 'string' ? ` ${args.effect}` : typeof args.preset === 'string' ? ` ${args.preset}` : ''}`;
      const started = performance.now();
      process.stderr.write(`[noise workflow] starting ${label}\n`);
      try {
        const result = await call<T>(name, args);
        process.stderr.write(`[noise workflow] completed ${label} in ${Math.round(performance.now() - started)} ms\n`);
        return result;
      } catch (error) {
        process.stderr.write(`[noise workflow] failed ${label} after ${Math.round(performance.now() - started)} ms\n`);
        throw error;
      }
    };
    await importVoice('Voice', quietFixture);
    await tracedCall('audacity_generate', { kind: 'noise', track: 'Voice', start: 0, duration: 0.25, amplitude: 0.001 });
    const untouchedSelection = await call('audacity_info', { type: 'Selection' });
    const untouchedAudio = await call<Measurement>('audacity_measure', { track: 'Voice', backend: 'wav' });
    await expect(call('audacity_pipeline', { preset: 'voice', track: 'Voice', removeClicks: true })).rejects.toThrow(/Click removal|blocking modal/i);
    expect(await call('audacity_info', { type: 'Selection' })).toEqual(untouchedSelection);
    expect((await call<Measurement>('audacity_measure', { track: 'Voice', backend: 'wav' })).rms).toBeCloseTo(untouchedAudio.rms, 5);
    await tracedCall('audacity_noise_profile', { track: 'Voice', start: 0, end: 0.25 });
    // Native Noise Reduction has no automation parameters in 3.7.8. A profile
    // persists for this process; the pipeline reuses this exact room-tone scope.
    await tracedCall('audacity_effect', { effect: 'NoiseReduction', track: 'Voice', params: {} });
    const pipelineArgs = {
      preset: 'voice', track: 'Voice', noiseProfile: { start: 0, end: 0.25 },
      lowPassHz: 12000, shortenPauses: { thresholdDb: -50, minimum: 0.1, truncateTo: 0.05 },
      loudness: 'lufs', lufs: -18, limitPeakDb: -1,
    };
    const plan = await tracedCall<{ steps: { name: string; command: string }[] }>('audacity_pipeline', { ...pipelineArgs, dryRun: true });
    process.stderr.write(`[noise workflow] planned commands: ${plan.steps.map((step) => step.command).join(', ')}\n`);
    const result = await tracedCall<{ applied: unknown[]; steps: unknown[] }>('audacity_pipeline', pipelineArgs);
    expect(result.applied.length).toBe(result.steps.length);
    expect((await tracks())[0]?.end).toBeLessThanOrEqual(2.001);
    await tracedCall('audacity_pipeline', { preset: 'cleanup', track: 'Voice', loudness: 'rms', rmsDb: -20 });
    await tracedCall('audacity_pipeline', { preset: 'cleanup', track: 'Voice', loudness: 'peak', peakDb: -3 });
    expect((await call<Measurement>('audacity_measure', { track: 'Voice', backend: 'wav' })).peakDbfs).toBeCloseTo(-3, 1);
  }, testTimeout);

  it('validates noise-profile clip continuity and source frames independently of project rate', async () => {
    await call('audacity_fresh', { visible: false });
    await call('audacity_command', { command: 'SetProject', params: { Rate: 48000 } });
    const lowRate = output('source-rate-8000'); tone(lowRate, 1, 12000, 0, 8000);
    await importVoice('Low 8k', lowRate); await importVoice('Distractor 48k');
    await call('audacity_edit', { action: 'split_delete', track: 'Distractor 48k', start: 0.5, end: 1.5 });
    await call('audacity_select', { track: 'Distractor 48k', start: 0.75, end: 1.25 });
    const originalTracks = await tracks();
    const originalSelection = await call('audacity_info', { type: 'Selection' });
    const originalClips = await call('audacity_info', { type: 'Clips' });
    const originalAudio = await call<Measurement>('audacity_measure', { track: 'Low 8k', backend: 'wav' });
    await expect(call('audacity_noise_profile', { track: 'Distractor 48k', start: 0.25, end: 1.75 })).rejects.toThrow(/one audio clip/);
    expect(await tracks()).toEqual(originalTracks);
    expect(await call('audacity_info', { type: 'Selection' })).toEqual(originalSelection);
    expect(await call('audacity_info', { type: 'Clips' })).toEqual(originalClips);
    // The project render has 4800 frames in 0.1 seconds. Its 8 kHz source has
    // only 800, which would make native profiling open a blocking error dialog.
    expect(await call('audacity_measure', { track: 'Low 8k', start: 0, end: 0.1, backend: 'wav' })).toMatchObject({ sampleRate: 48000, frames: 4800 });
    await expect(call('audacity_noise_profile', { track: 'Low 8k', start: 0, end: 0.1 })).rejects.toThrow(/4096 source samples/);
    expect(await tracks()).toEqual(originalTracks);
    expect(await call('audacity_info', { type: 'Selection' })).toEqual(originalSelection);
    expect(await call('audacity_info', { type: 'Clips' })).toEqual(originalClips);
    expect((await call<Measurement>('audacity_measure', { track: 'Low 8k', backend: 'wav' })).rms).toBeCloseTo(originalAudio.rms, 5);
    expect((await call<Windows>('audacity_dialogs')).windows.filter((window) => window.dialog)).toEqual([]);
    await call('audacity_noise_profile', { track: 'Low 8k', start: 0, end: 0.6 });
    await call('audacity_effect', { effect: 'NoiseReduction', track: 'Low 8k', params: {} });
    expect((await tracks()).find((track) => track.name === 'Low 8k')).toMatchObject({ start: 0, end: 1 });
    expect((await call<Windows>('audacity_dialogs')).windows.filter((window) => window.dialog)).toEqual([]);
    await call('audacity_recover');
    await expect(call('audacity_effect', { effect: 'NoiseReduction', track: 'Low 8k', params: {} })).rejects.toThrow(/fresh Audacity process/);
  }, testTimeout);

  it('preflights native source-rate filter failures before changing selection or earlier pipeline samples', async () => {
    const lowRate = output('filter-source-8000'); tone(lowRate, 1, 12_000, 0, 8000);
    await importVoice('Low 8k', lowRate); await importVoice('Unrelated');
    await call('audacity_command', { command: 'SetProject', params: { Rate: 48000 } });
    await call('audacity_select', { track: 'Unrelated', start: 0.25, end: 0.5 });
    const previous = await tracks(); const selection = await call('audacity_info', { type: 'Selection' });
    const clips = await call('audacity_info', { type: 'Clips' });
    const before = await call<Measurement>('audacity_measure', { track: 'Low 8k', backend: 'wav' });
    for (const effect of ['High-passFilter', 'Low-passFilter', 'NotchFilter']) {
      await expect(call('audacity_effect', { effect, track: 'Low 8k', params: { FREQUENCY: 5000 } })).rejects.toThrow(/source|Nyquist|sample rate/i);
    }
    await expect(call('audacity_effect', { effect: 'Low-passFilter', track: 'Low 8k', params: {} })).rejects.toThrow(/explicit|FREQUENCY/);
    await expect(call('audacity_effect', { effect: 'Tremolo', track: 'Low 8k', start: 0, end: 0.000001, params: {} })).rejects.toThrow(/source frame/);
    await expect(call('audacity_pipeline', { preset: 'lofi', track: 'Low 8k' })).rejects.toThrow(/source|Nyquist|sample rate/i);
    expect(await tracks()).toEqual(previous); expect(await call('audacity_info', { type: 'Selection' })).toEqual(selection);
    expect(await call('audacity_info', { type: 'Clips' })).toEqual(clips);
    expect((await call<Measurement>('audacity_measure', { track: 'Low 8k', backend: 'wav' })).rms).toBeCloseTo(before.rms, 5);
    await call('audacity_effect', { effect: 'Low-passFilter', track: 'Low 8k', params: { FREQUENCY: 1000, ROLLOFF: 'dB12' } });
    expect((await call<Windows>('audacity_dialogs')).windows.filter((window) => window.dialog)).toEqual([]);
  }, testTimeout);

  it('finds/edits/deletes overlapping labels and preserves other label tracks', async () => {
    await importVoice();
    await call('audacity_labels_set', { trackName: 'Chapters', labels: [{ start: 0, end: 1.5, text: 'Outer' }, { start: 0.5, end: 1, text: 'Inner' }, { start: 1.25, text: 'Point' }, { start: 0.123456789, text: 'Precision' }] });
    await call('audacity_labels_set', { trackName: 'Subtitles', labels: [{ start: 0.25, end: 0.75, text: 'Preserve me' }] });
    const precise = (await call<Label[]>('audacity_labels', { action: 'find', query: 'precision' }))[0]!;
    expect(precise.start).toBeCloseTo(0.123456789, 5);
    expect((await call<Label[]>('audacity_labels', { action: 'list' })).some((label) => label.text === '')).toBe(false);
    const inner = (await call<Label[]>('audacity_labels', { action: 'find', query: 'inner' }))[0]!;
    expect(inner.text).toBe('Inner');
    await call('audacity_labels', { action: 'edit', index: inner.index, text: 'Edited inner', start: 0.4 });
    const edited = (await call<Label[]>('audacity_labels', { action: 'find', query: 'edited' }))[0]!;
    expect(edited.start).toBeCloseTo(0.4, 3);
    await call('audacity_labels', { action: 'delete', index: edited.index });
    const remaining = await call<Label[]>('audacity_labels', { action: 'list' });
    expect(remaining.map((label) => label.text).sort()).toEqual(['Outer', 'Point', 'Precision', 'Preserve me']);
    expect(remaining.find((label) => label.text === 'Outer')).toMatchObject({ start: 0, end: 1.5 });
    await call('audacity_labels', { action: 'regular', trackName: 'Markers', start: 0, end: 1, interval: 0.5, text: 'Beat' });
    expect((await call<Label[]>('audacity_labels', { action: 'list', trackName: 'Markers' })).map((label) => label.start)).toEqual([0, 0.5, 1]);
  }, testTimeout);

  it('imports TSV/JSON labels, exports all sidecars and renders labeled audio regions', async () => {
    await importVoice();
    const tsv = output('import-labels', 'tsv'); writeFileSync(tsv, '0\t0.5\tFirst\n0.5\t1\tSecond\n');
    expect(await call('audacity_labels_file', { action: 'import', file: tsv, trackName: 'Chapters' })).toMatchObject({ imported: 2 });
    const json = output('import-json', 'json'); writeFileSync(json, JSON.stringify([{ start: 1, end: 1.5, text: 'Third' }]));
    await call('audacity_labels_file', { action: 'import', file: json, format: 'json', trackName: 'Chapters' });
    for (const format of ['tsv', 'json', 'srt', 'vtt', 'chapters', 'cue', 'podlove', 'ffmetadata']) {
      const file = output(`labels-${format}`, format);
      expect(await call('audacity_labels_file', { action: 'export', file, format, trackName: 'Chapters' })).toMatchObject({ count: 3 });
      expect(readFileSync(file, 'utf8')).toContain('First');
      await expect(call('audacity_labels_file', { action: 'export', file, format, trackName: 'Chapters' })).rejects.toThrow(/exists/);
    }
    const rendered = await call<{ files: string[]; count: number }>('audacity_label_regions_export', { directory: join(dir, `regions-${++sequence}`), trackName: 'Chapters', channels: 1 });
    expect(rendered.count).toBe(3);
    for (const file of rendered.files) expect((await call<Measurement>('audacity_measure_file', { file, backend: 'wav' })).rms).toBeGreaterThan(0);
  }, testTimeout);

  it('measures selections/files and contrast, finds silence and checks numeric targets', async () => {
    await importVoice('Voice', quietFixture, 1); await importVoice('Room tone', lowFixture, 1);
    await call('audacity_select', { track: 'Room tone', start: 1.5, end: 2 });
    const selection = selectionTimes(await call('audacity_info', { type: 'Selection' }));
    const selected = (await tracks()).map((track) => track.selected);
    const measured = await call<Measurement>('audacity_measure', { track: 'Voice', start: 1.5, end: 2, backend: 'wav' });
    expect(measured.rmsDbfs).toBeCloseTo(20 * Math.log10(12000 / 32768 / Math.SQRT2), 2);
    expect(selectionTimes(await call('audacity_info', { type: 'Selection' }))).toEqual(selection);
    expect((await tracks()).map((track) => track.selected)).toEqual(selected);
    const current = await call<Measurement>('audacity_measure', { currentSelection: true, backend: 'wav' });
    expect(current.rms).toBeLessThan(measured.rms * 0.02);
    const checked = await call('audacity_measure_file', { file: fixture, backend: 'wav', targets: { peakDbfs: { max: 0 }, truePeakDbtp: { max: -1 } } });
    expect(checked).toMatchObject({ targetCheck: { status: 'unknown' } });
    expect(await call('audacity_targets')).toHaveProperty('presets.video');
    expect(await call('audacity_contrast', { foreground: { track: 'Voice', start: 1.5, end: 2 }, background: { track: 'Room tone', start: 1.5, end: 2 }, minimumDb: 20 })).toMatchObject({ status: 'met' });
    const silence = await call<{ regions: { start: number; end: number }[] }>('audacity_silence', { track: 'Voice', thresholdDb: -60, minimumSeconds: 0.25 });
    expect(silence.regions[0]!.start).toBeCloseTo(1, 4);
    // The tone starts with a zero sample, so the detected boundary can differ by one frame.
    expect(silence.regions[0]!.end).toBeCloseTo(1.5, 4);
    expect(await call('audacity_silence', { file: quietFixture, minimumSeconds: 0.25 })).toMatchObject({ count: 1 });
    const comparison = await call<{ delta: { rmsDbfs: { change: number } } }>('audacity_compare_files', { before: fixture, after: lowFixture, backend: 'wav' });
    expect(comparison.delta.rmsDbfs.change).toBeCloseTo(-40, 1);
  }, testTimeout);

  it('uses optional ffmpeg/ffprobe for real loudness and file metadata', async () => {
    const ffmpeg = process.env.AUDACITY_FFMPEG ?? 'ffmpeg';
    const ffprobe = process.env.AUDACITY_FFPROBE ?? 'ffprobe';
    if (available(ffmpeg)) {
      const measured = await call<Measurement>('audacity_measure_file', { file: fixture, backend: 'ffmpeg' });
      expect(Number.isFinite(measured.integratedLufs)).toBe(true); expect(Number.isFinite(measured.truePeakDbtp)).toBe(true);
    } else await expect(call('audacity_measure_file', { file: fixture, backend: 'ffmpeg' })).rejects.toThrow(/ffmpeg unavailable/);
    if (available(ffprobe)) {
      expect(await call('audacity_probe_file', { file: fixture })).toMatchObject({ streams: [expect.objectContaining({ codec_type: 'audio', sample_rate: '48000', channels: 1 })] });
    } else await expect(call('audacity_probe_file', { file: fixture })).rejects.toThrow(/ffprobe unavailable/);
  }, testTimeout);

  it('previews and verifies a bounded loudness target on a real track', async () => {
    await importVoice();
    const args = { track: 'Voice', targetLufs: -18, truePeakCeilingDbtp: -1, maxBoostDb: 18, toleranceLu: 0.5 };
    const before = await call<Measurement>('audacity_measure', { track: 'Voice', backend: 'wav' });
    if (available(process.env.AUDACITY_FFMPEG ?? 'ffmpeg')) {
      expect(await call('audacity_loudness_target', { ...args, dryRun: true })).toMatchObject({ dryRun: true });
      expect((await call<Measurement>('audacity_measure', { track: 'Voice', backend: 'wav' })).rms).toBeCloseTo(before.rms, 6);
      await call('audacity_loudness_target', args);
      const measured = await call<Measurement>('audacity_measure', { track: 'Voice', backend: 'ffmpeg' });
      expect(Math.abs(measured.integratedLufs! + 18)).toBeLessThanOrEqual(0.6);
      expect(measured.truePeakDbtp!).toBeLessThanOrEqual(-0.9);
    } else await expect(call('audacity_loudness_target', args)).rejects.toThrow(/ffmpeg unavailable/);
  }, testTimeout);

  it('preflights and processes a batch while restoring original tracks and selection', async () => {
    await importVoice('Original'); await call('audacity_select', { track: 'Original', start: 0.25, end: 0.75 });
    const previous = await tracks(); const selected = await call('audacity_info', { type: 'Selection' });
    const file = output('batch');
    const jobs = [{ file: fixture, output: file, options: { preset: 'cleanup', loudness: 'peak', peakDb: -3 } }];
    expect(await call('audacity_batch', { jobs, dryRun: true })).toMatchObject({ dryRun: true });
    expect(existsSync(file)).toBe(false);
    expect(await call('audacity_batch', { jobs, channels: 1 })).toMatchObject({ dryRun: false, completed: 1 });
    expect(await tracks()).toEqual(previous); expect(await call('audacity_info', { type: 'Selection' })).toEqual(selected);
    expect((await call<Measurement>('audacity_measure_file', { file, backend: 'wav' })).peakDbfs).toBeCloseTo(-3, 1);
    await expect(call('audacity_batch', { jobs })).rejects.toThrow(/exists/);
    const timingOutput = output('batch-timing-refusal');
    await expect(call('audacity_batch', { jobs: [{ file: fixture, output: timingOutput,
      options: { preset: 'cleanup', shortenPauses: { minimum: 0.5, truncateTo: 0.25 } } }], measure: false })).rejects.toThrow(/sync.lock/i);
    expect(existsSync(timingOutput)).toBe(false);
    expect(await tracks()).toEqual(previous); expect(await call('audacity_info', { type: 'Selection' })).toEqual(selected);
  }, testTimeout);

  it('plays with estimated position, pauses/resumes/stops and records a short real input', async () => {
    await importVoice(); await call('audacity_track_set', { track: 'Voice', mute: true });
    const playing = await call<{ state: string; positionSeconds: number }>('audacity_transport', { action: 'play', track: 'Voice', start: 0, end: 2 });
    expect(playing.positionSeconds).toBeGreaterThanOrEqual(0);
    expect(await call('audacity_transport', { action: 'status' })).toHaveProperty('positionSource');
    expect(await call('audacity_transport', { action: 'pause' })).toMatchObject({ state: 'paused' });
    await call('audacity_transport', { action: 'resume' });
    expect(await call('audacity_transport', { action: 'stop' })).toMatchObject({ state: 'stopped' });
    await clearTracks();
    expect(await call('audacity_transport', { action: 'record', duration: 0.15, newTrack: true })).toMatchObject({ state: 'stopped' });
    const recording = (await tracks()).find((track) => track.kind === 'wave')!;
    expect(recording).toBeDefined(); expect(recording.end).toBeGreaterThan(recording.start);
    const channels = Number((await call<{ value: string }>('audacity_preferences', { action: 'get', name: '/AudioIO/RecordChannels' })).value);
    expect([1, 2]).toContain(channels);
    await call('audacity_generate', { kind: 'tone', name: 'Append target', channels, duration: 0.25, amplitude: 0.1 });
    await call('audacity_select', { track: recording.name });
    const beforeAppend = await tracks();
    expect(await call('audacity_transport', { action: 'record', track: 'Append target', duration: 0.15, newTrack: false })).toMatchObject({ state: 'stopped' });
    const afterAppend = await tracks();
    expect(afterAppend.length).toBe(beforeAppend.length);
    expect(afterAppend.find((track) => track.name === 'Append target')!.end).toBeGreaterThan(0.25);
    expect(afterAppend.find((track) => track.name === recording.name)!.end).toBe(recording.end);
    await call('audacity_generate', { kind: 'tone', name: 'Wrong channels', channels: channels === 1 ? 2 : 1, duration: 0.25, amplitude: 0.1 });
    const beforeRefusal = await tracks();
    const selection = await call('audacity_info', { type: 'Selection' });
    await expect(call('audacity_transport', { action: 'record', track: 'Wrong channels', duration: 0.15, newTrack: false })).rejects.toThrow(/channels/i);
    await expect(call('audacity_transport', { action: 'record', duration: 0.15, newTrack: false })).rejects.toThrow(/track/i);
    expect(await tracks()).toEqual(beforeRefusal);
    expect(await call('audacity_info', { type: 'Selection' })).toEqual(selection);
    expect((await call<Windows>('audacity_dialogs')).windows.filter((window) => window.dialog)).toEqual([]);
  }, testTimeout);

  it('undoes and redoes timeline edits in native history', async () => {
    await importVoice();
    const before = await call<Measurement>('audacity_measure', { track: 'Voice', backend: 'wav' });
    await call('audacity_edit', { action: 'split_delete', track: 'Voice', start: 0.5, end: 1 });
    expect(await call('audacity_history', { action: 'undo' })).toMatchObject({ completed: 1 });
    expect((await call<Measurement>('audacity_measure', { track: 'Voice', backend: 'wav' })).rms).toBeCloseTo(before.rms, 5);
    await call('audacity_history', { action: 'redo' });
    expect((await call<Measurement>('audacity_measure', { track: 'Voice', backend: 'wav' })).rms).toBeCloseTo(before.rms * Math.sqrt(0.75), 4);
  }, testTimeout);

  it('lists preferences and safely sets/readbacks/restores each writable preference', async () => {
    expect(await call('audacity_preferences', { action: 'list' })).toBeDefined();
    for (const [name, value] of [['/SamplingRate/DefaultProjectSampleRate', 48000], ['/AudioIO/RecordChannels', 1]] as const) {
      const original = await call<{ value: string }>('audacity_preferences', { action: 'get', name });
      try {
        const updated = await call<{ value: string }>('audacity_preferences', { action: 'set', name, value });
        expect(Number(updated.value)).toBe(value);
        expect(Number((await call<{ value: string }>('audacity_preferences', { action: 'get', name })).value)).toBe(value);
      } finally { await call('audacity_preferences', { action: 'set', name, value: Number(original.value) }); }
    }
    await expect(call('audacity_preferences', { action: 'set', name: '/Module/mod-script-pipe', value: 0 })).rejects.toThrow(/writable preferences/);
  }, testTimeout);

  it('lists/previews/applies an existing macro without dialogs', async () => {
    await importVoice(); await call('audacity_select', { track: 'Voice' });
    const macros = await call<{ macros: { name: string; safe: boolean }[] }>('audacity_macros', { action: 'list' });
    expect(macros.macros.find((macro) => macro.name === 'Fade Ends')?.safe).toBe(true);
    expect(await call('audacity_macros', { action: 'apply', name: 'Fade Ends', dryRun: true })).toMatchObject({ dryRun: true });
    expect(await call('audacity_macros', { action: 'apply', name: 'Fade Ends' })).toHaveProperty('completed');
    expect((await call<Windows>('audacity_dialogs')).windows.filter((window) => window.dialog)).toEqual([]);
  }, testTimeout);

  it('serializes concurrent selection/effect operations and rapid disposable pipe instances', async () => {
    await importVoice('One'); await importVoice('Two');
    await Promise.all([
      call('audacity_effect', { effect: 'Amplify', track: 'One', params: { Ratio: 0.5 } }),
      call('audacity_effect', { effect: 'Amplify', track: 'Two', params: { Ratio: 0.25 } }),
      ...Array.from({ length: 8 }, () => call('audacity_info', { type: 'Tracks' })),
    ]);
    const a = await call<Measurement>('audacity_measure', { track: 'One', backend: 'wav' });
    const b = await call<Measurement>('audacity_measure', { track: 'Two', backend: 'wav' });
    expect(a.rms / b.rms).toBeCloseTo(2, 3);
  }, testTimeout);

  it('recovers a deliberately opened modal dialog and explicitly restarts the private pipe', async () => {
    await importVoice();
    const privatePipe = new AudacityPipe();
    // Intentional unsafe command ONLY in this integration test. The public
    // catalogue refuses Preferences; root verification records live 3.7.8.
    try {
      // Give the disposable TypeScript helper time to start and write once.
      // A shorter timeout can expire before the command reaches Audacity;
      // that unknown outcome must never be retried just to open the dialog.
      await expect(privatePipe.send('Preferences:', 10_000)).rejects.toBeInstanceOf(AudacityTimeout);
      expect(privatePipe.needsRecovery).toBe(true);
      await expect(privatePipe.send('GetInfo: Type=Tracks Format=JSON', 5_000)).rejects.toBeInstanceOf(AudacityNeedsRecovery);
      let windows: Windows = { windows: [] };
      const deadline = Date.now() + 10_000;
      do {
        windows = await call<Windows>('audacity_dialogs');
        if (windows.windows.some((window) => window.dialog)) break;
        await new Promise((resolve) => setTimeout(resolve, 200));
      } while (Date.now() < deadline);
      expect(windows.windows.some((window) => window.dialog), JSON.stringify(windows)).toBe(true);
    } finally {
      await call('audacity_dialogs', { close: true });
      await call('audacity_recover', { closeDialogs: true });
    }
    const reply = await privatePipe.reconnect(5_000);
    expect(privatePipe.needsRecovery).toBe(false);
    expect(reply.ok).toBe(true); expect(reply.body).toContain('Voice');
    expect((await call<Windows>('audacity_dialogs')).windows.some((window) => window.dialog)).toBe(false);
    expect(await call('audacity_recover', { reconnect: false })).toMatchObject({ running: true, needsRecovery: false });
  }, testTimeout);

  it('reads the actual project rate, refuses unsafe saves/opens, restarts and reopens a saved project', async () => {
    await importVoice(); await call('audacity_command', { command: 'SetProject', params: { Rate: 48000 } });
    expect(await call('audacity_project_info')).toMatchObject({ rate: 48000, lengthSeconds: 2 });
    const project = output('saved-project', 'aup3');
    await call('audacity_project', { action: 'save', file: project }); expect(existsSync(project)).toBe(true);
    await expect(call('audacity_project', { action: 'save', file: project })).rejects.toThrow(/exists/);
    await expect(call('audacity_project', { action: 'open', file: project })).rejects.toThrow(/empty project/);
    await expect(call('audacity_fresh', { visible: false })).rejects.toThrow(/backupTo/);
    expect((await call<Windows>('audacity_dialogs')).windows.some((window) => window.dialog)).toBe(false);
    await call('audacity_quit', { saveTo: output('kept-on-quit', 'aup3') });
    expect(recoveryEntries()).toEqual([]); expect(await call('audacity_status')).toEqual({ running: false });
    await call('audacity_launch', { visible: false });
    await call('audacity_project', { action: 'open', file: project });
    expect((await tracks())[0]?.name).toBe('Voice');
    const backup = join(root, '.work', 'live-backups', `fresh-backup-${Date.now()}.aup3`);
    expect(await call('audacity_fresh', { visible: false, backupTo: backup })).toMatchObject({ backedUpTo: backup });
    expect(existsSync(backup)).toBe(true); expect(await tracks()).toEqual([]);
    expect((await call<Windows>('audacity_dialogs')).windows.some((window) => window.dialog)).toBe(false);
    await call('audacity_quit');
    expect(await isRunning()).toBe(false); expect(recoveryEntries()).toEqual([]);
    const configFile = configPath();
    const originalConfig = readFileSync(configFile, 'utf8');
    const originalProject = readFileSync(backup);
    const stalePath = backup.replace(/\\/g, '/');
    const newline = originalConfig.includes('\r\n') ? '\r\n' : '\n';
    const recoverySection = `[ActiveProjects]${newline}1=${stalePath}${newline}`;
    const section = /^\[ActiveProjects\](?:\r?\n|$)[\s\S]*?(?=^\[|$(?![\s\S]))/m;
    const injectedConfig = section.test(originalConfig) ? originalConfig.replace(section, recoverySection) : `${originalConfig}${newline}${recoverySection}`;
    // Retain an exact original config backup as well as the backup produced by
    // audacity_recover. Only the stopped test process's config is changed.
    writeFileSync(`${configFile}.before-live-recovery-${Date.now()}.bak`, originalConfig);
    try {
      writeFileSync(configFile, injectedConfig);
      expect(recoveryEntries()).toEqual([stalePath]);
      await expect(call('audacity_launch', { visible: false })).rejects.toThrow(/crash-recovery entries/);
      expect(await isRunning()).toBe(false);
      expect((await call<Windows>('audacity_dialogs')).windows.filter((window) => window.dialog)).toEqual([]);
      const recovered = await call<{ discarded: { backup: string; projects: string[] } | null }>('audacity_recover', { discardRecovery: true, reconnect: false });
      expect(recovered.discarded?.projects).toEqual([stalePath]);
      expect(recovered.discarded?.backup).toBeDefined();
      expect(readFileSync(recovered.discarded!.backup, 'utf8').includes(`1=${stalePath}`)).toBe(true);
      expect(recoveryEntries()).toEqual([]);
      expect(readFileSync(backup).equals(originalProject)).toBe(true);
    } finally {
      if (await isRunning()) {
        await call('audacity_dialogs', { close: true });
        await call('audacity_recover', { closeDialogs: true });
        await call('audacity_quit');
      }
      if (await isRunning()) throw new Error('cannot restore the test config while Audacity is running');
      writeFileSync(configFile, originalConfig);
      expect(recoveryEntries()).toEqual([]);
      await call('audacity_launch', { visible: false });
    }
  }, 180_000);

  it('successfully exercises every registered MCP tool', () => {
    expect([...called].sort()).toEqual(registered);
  });
});
