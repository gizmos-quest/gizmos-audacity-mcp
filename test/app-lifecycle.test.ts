import { existsSync, writeFileSync } from 'node:fs';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const fake = vi.hoisted(() => ({
  processes: vi.fn(),
  identity: vi.fn(),
  running: vi.fn(),
  present: vi.fn(),
  override: vi.fn(),
  version: vi.fn(),
  exe: vi.fn(),
  windows: vi.fn(),
  visibility: vi.fn(),
  close: vi.fn(),
  recovery: vi.fn(),
  helper: vi.fn(),
  start: vi.fn(),
}));
vi.mock('../src/app-process.js', async (original) => ({
  ...(await original<typeof import('../src/app-process.js')>()),
  audacityProcesses: fake.processes,
  currentProcessIdentity: fake.identity,
  isRunning: fake.running,
  pipeExists: fake.present,
  preflightExecutableOverride: fake.override,
  executableVersion: fake.version,
  audacityExe: fake.exe,
  startPosix: fake.start,
}));
vi.mock('../src/app-windows.js', () => ({
  listWindows: fake.windows,
  setWindowVisible: fake.visibility,
  closeProjectWindow: fake.close,
}));
vi.mock('../src/app-config.js', () => ({ recoveryEntries: fake.recovery }));
vi.mock('../src/app-helper.js', () => ({ powershell: fake.helper }));

import { assertEnglishCommands, launch, quit } from '../src/app.js';
import { AudacityNoProject, AudacityPipe, AudacityTimeout } from '../src/pipe.js';

const frame = { handle: '123', pid: 42, title: 'Audacity', className: 'wxWindowNR', enabled: true, dialog: false };
const actualPlatform = process.platform;
beforeEach(() => {
  Object.defineProperty(process, 'platform', { value: 'win32' });
  vi.resetAllMocks();
  fake.processes.mockResolvedValue([{ pid: 42, executable: process.execPath }]);
  fake.identity.mockResolvedValue('epoch');
  fake.running.mockResolvedValue(true);
  fake.present.mockReturnValue(true);
  fake.exe.mockReturnValue(process.execPath);
  fake.version.mockResolvedValue('3.7.8.0');
  fake.windows.mockResolvedValue([frame]);
  fake.close.mockResolvedValue(true);
  fake.recovery.mockReturnValue([]);
});
afterEach(() => {
  Object.defineProperty(process, 'platform', { value: actualPlatform });
  vi.restoreAllMocks();
  vi.useRealTimers();
});

describe('qualified launch', () => {
  function transport() {
    return vi.fn(async (_paths, command: string) => ({
      ok: true,
      status: 'OK',
      body: command.includes('Commands')
        ? JSON.stringify(['GetInfo', 'Select', 'SampleDataExport', 'High-passFilter'].map((id) => ({ id })))
        : '[]',
    }));
  }
  it('checks blocking dialogs before any potentially blocked readiness request', async () => {
    fake.windows.mockResolvedValue([{ ...frame, dialog: true }]);
    const send = vi.spyOn(AudacityPipe.prototype, 'send');
    await expect(launch(false)).rejects.toThrow('blocking startup dialog');
    expect(send).not.toHaveBeenCalled();
  });
  it('refuses windowless, ambiguous or disabled projects before pipe I/O', async () => {
    for (const windows of [[], [frame, frame], [{ ...frame, enabled: false }]]) {
      fake.windows.mockResolvedValue(windows);
      await expect(launch(false)).rejects.toThrow('single enabled project');
    }
  });
  it('attaches only after actual Tracks and indispensable English command IDs', async () => {
    const reply = transport();
    vi.spyOn(AudacityPipe.prototype, 'send').mockImplementation((command) => reply({}, command));
    expect(await launch(false)).toMatchObject({ started: false, visible: false });
    expect(fake.visibility).toHaveBeenCalledWith(false);
    expect(reply).toHaveBeenCalledTimes(2);
  });
  it('does not retry a lost readiness response', async () => {
    const send = vi.spyOn(AudacityPipe.prototype, 'send').mockRejectedValue(new Error('lost response'));
    await expect(launch(false)).rejects.toThrow('lost response');
    expect(send).toHaveBeenCalledOnce();
  });
  it('refuses running-without-module and stale recovery before starting', async () => {
    fake.present.mockReturnValue(false);
    await expect(launch(false)).rejects.toThrow('without a reachable pipe');
    fake.running.mockResolvedValue(false);
    fake.processes.mockResolvedValue([]);
    fake.recovery.mockReturnValue(['retained.aup3']);
    await expect(launch(false)).rejects.toThrow('crash-recovery');
    expect(fake.helper).not.toHaveBeenCalled();
  });
  it('starts a stopped application then verifies its initialized project', async () => {
    vi.useFakeTimers();
    fake.running.mockResolvedValue(false);
    fake.processes.mockResolvedValue([]);
    vi.spyOn(AudacityPipe.prototype, 'send').mockImplementation((command) => transport()({}, command));
    const result = launch(true);
    const assertion = expect(result).resolves.toMatchObject({ started: true });
    await vi.runAllTimersAsync();
    await assertion;
    expect(fake.helper).toHaveBeenCalledWith(expect.stringContaining('-WindowStyle Normal'));
  });
  it('waits for the overlapping native startup window before its first read', async () => {
    vi.useFakeTimers();
    fake.running.mockResolvedValue(false);
    fake.processes.mockResolvedValue([]);
    fake.windows
      .mockResolvedValueOnce([frame, { ...frame, title: 'Audacity is starting up...' }])
      .mockResolvedValue([frame]);
    const send = vi.spyOn(AudacityPipe.prototype, 'send').mockImplementation((command) => transport()({}, command));
    const pending = launch(false);
    await vi.advanceTimersByTimeAsync(0);
    expect(send).not.toHaveBeenCalled();
    await vi.runAllTimersAsync();
    expect(await pending).toMatchObject({ started: true });
    expect(send).toHaveBeenCalledTimes(2);
  });
  it('retries only the read-only readiness probe while Audacity has no project yet', async () => {
    vi.useFakeTimers();
    const reply = transport();
    const send = vi
      .spyOn(AudacityPipe.prototype, 'send')
      .mockRejectedValueOnce(new AudacityNoProject('projectless', true))
      .mockImplementation((command) => reply({}, command));
    const pending = launch(false);
    await vi.runAllTimersAsync();
    expect(await pending).toMatchObject({ started: false });
    expect(send.mock.calls.map(([command]) => command)).toEqual([
      'GetInfo: Type=Tracks Format=JSON',
      'GetInfo: Type=Tracks Format=JSON',
      'GetInfo: Type=Commands Format=JSON',
    ]);
  });
  it('lets an attach wait out the startup frame but not a windowless process', async () => {
    vi.useFakeTimers();
    fake.windows.mockResolvedValueOnce([{ ...frame, title: 'Audacity is starting up...' }]).mockResolvedValue([frame]);
    const send = vi.spyOn(AudacityPipe.prototype, 'send').mockImplementation((command) => transport()({}, command));
    const pending = launch(false);
    await vi.runAllTimersAsync();
    expect(await pending).toMatchObject({ started: false });
    expect(send).toHaveBeenCalledTimes(2);
    fake.windows.mockReset().mockResolvedValue([]);
    await expect(launch(false)).rejects.toThrow('single enabled project');
    expect(fake.windows).toHaveBeenCalledOnce();
  });
  it('bounds launch waiting when no pipe appears', async () => {
    vi.useFakeTimers();
    fake.running.mockResolvedValue(false);
    fake.processes.mockResolvedValue([]);
    fake.present.mockReturnValue(false);
    const assertion = expect(launch(false, 500)).rejects.toThrow('pipe did not appear');
    await vi.runAllTimersAsync();
    await assertion;
  });
  it.each(['{}', '[{"id":"GetInfo"}]'])('rejects missing English IDs %s', (body) =>
    expect(() => assertEnglishCommands(body)).toThrow(),
  );
});

describe('save-before-native-close quit', () => {
  it('keeps acknowledged user destination and requires actual process exit', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'gizmos-lifecycle-test-'));
    const target = join(dir, 'retained.aup3');
    const transport = vi.fn(async () => {
      writeFileSync(target, 'saved');
      return { ok: true, body: '', status: 'OK' };
    });
    fake.running.mockResolvedValue(false);
    expect(await quit(new AudacityPipe({ to: 'to', from: 'from' }, 20, transport), target)).toEqual({
      savedTo: target,
    });
    expect(existsSync(target)).toBe(true);
    expect(fake.close).toHaveBeenCalledWith('123', 42);
    expect(transport.mock.calls).toHaveLength(2);
    await rm(dir, { recursive: true });
  });
  it('retains scratch and never closes a frame after a lost save', async () => {
    const lost = new AudacityTimeout('lost save');
    const transport = vi.fn().mockResolvedValueOnce({ ok: true }).mockRejectedValueOnce(lost);
    await expect(quit(new AudacityPipe({ to: 'to', from: 'from' }, 20, transport))).rejects.toBe(lost);
    expect(lost.message).toMatch(/lost save.*retained/);
    expect(fake.close).not.toHaveBeenCalled();
  });
  it('refuses dialogs, multiple processes, missing identity and projectless attachments before saving', async () => {
    const pipe = new AudacityPipe({ to: 'to', from: 'from' }, 20, vi.fn());
    fake.processes.mockResolvedValue([]);
    await expect(quit(pipe)).rejects.toThrow('exactly one');
    fake.processes.mockResolvedValue([{ pid: 42 }]);
    fake.identity.mockResolvedValue(undefined);
    await expect(quit(pipe)).rejects.toThrow('identity');
    fake.identity.mockResolvedValue('epoch');
    fake.windows.mockResolvedValue([{ ...frame, dialog: true }]);
    await expect(quit(pipe)).rejects.toThrow('no blocking');
  });
  it('retains saves when process changes, window changes, or recovery remains', async () => {
    const transport = vi.fn().mockResolvedValue({ ok: true });
    fake.identity.mockResolvedValueOnce('epoch').mockResolvedValueOnce('changed');
    await expect(quit(new AudacityPipe({ to: 'to', from: 'from' }, 20, transport))).rejects.toThrow('process changed');
    fake.identity.mockResolvedValue('epoch');
    fake.close.mockResolvedValue(false);
    await expect(quit(new AudacityPipe({ to: 'to', from: 'from' }, 20, transport))).rejects.toThrow('window changed');
    fake.close.mockResolvedValue(true);
    fake.running.mockResolvedValue(false);
    fake.recovery.mockReturnValue(['retained.aup3']);
    await expect(quit(new AudacityPipe({ to: 'to', from: 'from' }, 20, transport))).rejects.toThrow('recovery entries');
  });
  it('preserves Audacity native error text without posting close', async () => {
    const transport = vi.fn().mockResolvedValue({ ok: false, body: 'Native refusal', status: 'Failed!' });
    await expect(quit(new AudacityPipe({ to: 'to', from: 'from' }, 20, transport))).rejects.toThrow('Native refusal');
    expect(fake.close).not.toHaveBeenCalled();
  });
});
