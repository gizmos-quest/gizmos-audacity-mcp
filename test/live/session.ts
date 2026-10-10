// Real stdio MCP integration against Audacity 3.7.x. Only AUDACITY_LIVE=1
// enables process or pipe access. User projects are backed up persistently;
// every test edit happens in the hidden, disposable test project.

import { spawnSync } from 'node:child_process';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve, sep } from 'node:path';
import { fileURLToPath } from 'node:url';
import { Client } from '@modelcontextprotocol/client';
import { StdioClientTransport } from '@modelcontextprotocol/client/stdio';
import { afterAll, beforeAll, beforeEach, expect } from 'vitest';
import { audacityExe, audacityProcesses, isRunning, recoveryEntries } from '../../src/app.js';

const root = fileURLToPath(new URL('../..', import.meta.url));
export const testTimeout = 120_000;
export type Track = {
  name: string;
  kind: string;
  start: number;
  end: number;
  volume: number;
  pan: number;
  mute: number;
  solo: number;
  selected: number;
  focused: number;
};
export type Label = { index: number; track: number; trackName: string; start: number; end: number; text: string };
export type Clip = { track: number; start: number; end: number; name: string };
export type Envelope = { track: number; points: { t: number; y: number }[] };
export type Measurement = {
  duration: number;
  sampleRate: number;
  rms: number;
  rmsDbfs: number | null;
  peakDbfs: number | null;
  integratedLufs: number | null;
  truePeakDbtp: number | null;
};
export type Windows = { windows: { title: string; visible: boolean; dialog: boolean; closed: boolean }[] };

export function tone(
  path: string,
  seconds: number,
  amplitude = 12_000,
  quietStart = 0,
  rate = 48_000,
  channels = 1,
): void {
  const samples = Math.round(seconds * rate) * channels;
  const data = Buffer.alloc(samples * 2);
  for (let i = 0; i < samples; i++) {
    const frame = Math.floor(i / channels);
    const value = frame / rate < quietStart ? 0 : Math.sin((2 * Math.PI * 440 * frame) / rate) * amplitude;
    data.writeInt16LE(Math.round(value), i * 2);
  }
  const header = Buffer.alloc(44);
  header.write('RIFF', 0);
  header.writeUInt32LE(36 + data.length, 4);
  header.write('WAVEfmt ', 8);
  header.writeUInt32LE(16, 16);
  header.writeUInt16LE(1, 20);
  header.writeUInt16LE(channels, 22);
  header.writeUInt32LE(rate, 24);
  header.writeUInt32LE(rate * channels * 2, 28);
  header.writeUInt16LE(channels * 2, 32);
  header.writeUInt16LE(16, 34);
  header.write('data', 36);
  header.writeUInt32LE(data.length, 40);
  writeFileSync(path, Buffer.concat([header, data]));
}

export function available(executable: string): boolean {
  return spawnSync(executable, ['-version'], { windowsHide: true, stdio: 'ignore', timeout: 10_000 }).status === 0;
}

/** What setup preserved of the user's Audacity before replacing it with the test project. */
export interface LiveOriginal {
  running: boolean;
  visible: boolean;
  backup: string | null;
}
type Call = <T = unknown>(name: string, args?: Record<string, unknown>) => Promise<T>;

/** Discard only the disposable test project, and only after setup preserved the user's
 * original; then reopen that original as it was. After a failed setup Audacity is left
 * untouched, so unsaved user work is never discarded. */
export async function finishLiveSession(original: LiveOriginal | undefined, call: Call): Promise<void> {
  if (!original)
    throw new Error('Live setup did not preserve the open Audacity project; it was left open and untouched.');
  if (await isRunning()) {
    await call('audacity_dialogs', { close: true });
    await call('audacity_recover', { closeDialogs: true });
    await call('audacity_transport', { action: 'stop' });
    expect((await call<Windows>('audacity_dialogs')).windows.filter((window) => window.dialog)).toEqual([]);
    await call('audacity_quit');
  }
  expect(await isRunning()).toBe(false);
  expect(recoveryEntries()).toEqual([]);
  if (!original.running) return;
  await call('audacity_launch', { visible: original.visible });
  if (original.backup) await call('audacity_project', { action: 'open', file: original.backup });
}

export function installLiveSession() {
  let dir: string;
  let client: Client | undefined;
  let original: LiveOriginal | undefined;
  let fixture: string;
  let quietFixture: string;
  let lowFixture: string;
  let multichannelFixture: string;
  const attempted = new Set<string>();
  const succeeded = new Set<string>();
  const refused = new Map<string, number>();
  const expectedRefusals = new Map<string, number>();
  const unavailable = new Set<string>();
  let registered: string[] = [];
  let sequence = 0;

  const output = (stem: string, extension = 'wav') => join(dir, `${++sequence}-${stem}.${extension}`);
  const call = async <T = unknown>(
    name: string,
    args: Record<string, unknown> = {},
    expectedRefusal = false,
  ): Promise<T> => {
    if (!client) throw new Error('MCP client is not connected');
    attempted.add(name);
    const result = await client.callTool({ name, arguments: args }, { timeout: 180_000 });
    const text = result.content
      .filter((item) => item.type === 'text')
      .map((item) => item.text)
      .join('\n');
    if (result.isError) {
      refused.set(name, (refused.get(name) ?? 0) + 1);
      if (expectedRefusal) expectedRefusals.set(name, (expectedRefusals.get(name) ?? 0) + 1);
      throw new Error(`${name}: ${text}`);
    }
    succeeded.add(name);
    try {
      return JSON.parse(text) as T;
    } catch {
      return text as T;
    }
  };
  const refuse = <T = unknown>(name: string, args: Record<string, unknown> = {}) => call<T>(name, args, true);
  const connectClient = async () => {
    client = new Client({ name: 'live-test', version: '1' });
    // SDK stdio intentionally inherits a narrow environment. Forward only our
    // explicit executable/config/ffmpeg overrides so version-isolated live
    // verification actually launches the requested Audacity, not the default.
    const env = Object.fromEntries(
      ['AUDACITY_EXE', 'AUDACITY_CONFIG', 'AUDACITY_FFMPEG', 'AUDACITY_FFPROBE'].flatMap((key) =>
        process.env[key] === undefined ? [] : [[key, process.env[key]!]],
      ),
    );
    await client.connect(
      new StdioClientTransport({ command: process.execPath, args: [join(root, 'dist', 'main.js')], env }),
    );
  };
  const closeClient = async () => {
    await client?.close();
    client = undefined;
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
    if (process.platform !== 'win32')
      throw new Error('Live lifecycle verification requires Windows and pinned English Audacity 3.7.8');
    const expectedVersion = process.env.AUDACITY_LIVE_VERSION ?? '3.7.8.0';
    if (!['3.7.8.0', '3.7.9.0'].includes(expectedVersion))
      throw new Error('AUDACITY_LIVE_VERSION must be an explicitly qualified 3.7.8.0 or 3.7.9.0');
    const executable = audacityExe();
    const versionResult = spawnSync(
      'powershell.exe',
      [
        '-NoProfile',
        '-NonInteractive',
        '-Command',
        `(Get-Item -LiteralPath '${executable.replace(/'/g, "''")}').VersionInfo.FileVersion`,
      ],
      { windowsHide: true, encoding: 'utf8', timeout: 10_000 },
    );
    const version = versionResult.stdout?.trim().replace(/,/g, '.');
    if (versionResult.status !== 0 || version !== expectedVersion)
      throw new Error(
        `Live tests require actual Audacity ${expectedVersion}, found ${version ?? 'unknown'} at ${executable}; set AUDACITY_EXE and AUDACITY_CONFIG to the pinned installation`,
      );
    const existing = await audacityProcesses();
    if (
      existing.some(
        (process) =>
          !process.executable || resolve(process.executable).toLowerCase() !== resolve(executable).toLowerCase(),
      )
    ) {
      throw new Error(
        'A different Audacity executable is already running; preserve and quit it before version-isolated live tests',
      );
    }
    dir = mkdtempSync(join(tmpdir(), 'gizmos-audacity-live-'));
    fixture = join(dir, 'tone.wav');
    tone(fixture, 2);
    quietFixture = join(dir, 'quiet-start.wav');
    tone(quietFixture, 2, 12_000, 0.5);
    lowFixture = join(dir, 'room-tone.wav');
    tone(lowFixture, 2, 120);
    multichannelFixture = join(dir, 'three-channel.wav');
    tone(multichannelFixture, 0.25, 12_000, 0, 48_000, 3);
    const backups = join(root, '.work', 'live-backups');
    mkdirSync(backups, { recursive: true });
    await connectClient();
    registered = (await client!.listTools()).tools.map((tool) => tool.name).sort();
    const running = await isRunning();
    const visible =
      running &&
      (await call<Windows>('audacity_dialogs')).windows.some(
        (window) => !window.dialog && window.visible && window.title,
      );
    const fresh = await call<{ backedUpTo: string | null }>('audacity_fresh', {
      visible: false,
      backupTo: join(backups, `before-live-${Date.now()}.aup3`),
    });
    original = { running, visible, backup: fresh.backedUpTo };
    await call('audacity_launch', { visible: false });
    const processes = await audacityProcesses();
    expect(processes).toHaveLength(1);
    expect(resolve(processes[0]!.executable!).toLowerCase()).toBe(resolve(executable).toLowerCase());
    expect(processes[0]!.fileVersion?.replace(/,/g, '.')).toBe(expectedVersion);
    await call('audacity_command', { command: 'SetProject', params: { Rate: 48000 } });
  }, 120_000);

  beforeEach(async () => {
    await clearTracks();
  }, testTimeout);

  afterAll(async () => {
    const errors: unknown[] = [];
    if (client) {
      try {
        await finishLiveSession(original, call);
      } catch (error) {
        errors.push(error);
      }
      try {
        await client.close();
      } catch (error) {
        errors.push(error);
      }
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

  return {
    call,
    refuse,
    tracks,
    clearTracks,
    importVoice,
    output,
    connectClient,
    closeClient,
    attempted,
    succeeded,
    refused,
    expectedRefusals,
    unavailable,
    get dir() {
      return dir;
    },
    get client() {
      return client;
    },
    get fixture() {
      return fixture;
    },
    get quietFixture() {
      return quietFixture;
    },
    get lowFixture() {
      return lowFixture;
    },
    get multichannelFixture() {
      return multichannelFixture;
    },
    get registered() {
      return registered;
    },
  };
}
export type LiveContext = ReturnType<typeof installLiveSession>;
