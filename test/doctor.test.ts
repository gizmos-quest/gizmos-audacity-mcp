import { mkdir, mkdtemp, readdir, readFile, rm, utimes, writeFile } from 'node:fs/promises';
import { tmpdir, userInfo } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const fake = vi.hoisted(() => ({
  running: vi.fn(),
  processes: vi.fn(),
  version: vi.fn(),
  present: vi.fn(),
  send: vi.fn(),
  ffmpeg: vi.fn(),
  english: vi.fn(),
  release: vi.fn(),
  exe: vi.fn(),
}));
vi.mock('../src/app-process.js', async (original) => ({
  ...(await original<typeof import('../src/app-process.js')>()),
  isRunning: fake.running,
  audacityProcesses: fake.processes,
  executableVersion: fake.version,
  pipeExists: fake.present,
  audacityExe: fake.exe,
}));
vi.mock('../src/app.js', () => ({ assertEnglishCommands: fake.english }));
vi.mock('../src/pipe.js', () => ({
  AudacityPipe: class {
    send = fake.send;
    release = fake.release;
  },
}));
vi.mock('node:child_process', () => ({ spawnSync: fake.ffmpeg }));

import { configValue, doctor, enablePipeConfig, fixPipeConfig, moduleStamp, runDoctor } from '../src/doctor.js';

let dir: string;
beforeEach(async () => {
  vi.resetAllMocks();
  dir = await mkdtemp(join(tmpdir(), 'gizmos-doctor-test-'));
  vi.stubEnv('AUDACITY_CONFIG', join(dir, 'audacity.cfg'));
  await writeFile(join(dir, 'audacity.cfg'), '[Module]\nmod-script-pipe=1\n[Locale]\nLanguage=en\n');
  fake.running.mockResolvedValue(false);
  fake.processes.mockResolvedValue([]);
  fake.version.mockResolvedValue('3.7.8.0');
  fake.ffmpeg.mockReturnValue({ status: 0 });
  fake.exe.mockReturnValue(process.execPath);
});

/** A portable-style install: modules/ beside the executable, as Audacity searches it. */
async function installedModule(): Promise<string> {
  await mkdir(join(dir, 'modules'));
  const module = join(dir, 'modules', `mod-script-pipe${process.platform === 'win32' ? '.dll' : '.so'}`);
  await writeFile(module, 'module');
  await utimes(module, new Date('2026-06-11T07:46:52.400Z'), new Date('2026-06-11T07:46:52.400Z'));
  fake.exe.mockReturnValue(join(dir, 'Audacity.exe'));
  return module;
}
afterEach(async () => {
  vi.unstubAllEnvs();
  vi.restoreAllMocks();
  await rm(dir, { recursive: true });
});

describe('stopped-only setup', () => {
  it('refuses Audacity 4 before changing or backing up its configuration', async () => {
    const file = join(dir, 'audacity.cfg');
    const original = await readFile(file, 'utf8');
    fake.version.mockResolvedValue('4.0.0');
    await expect(doctor(true)).rejects.toThrow('removed the scripting interface (mod-script-pipe)');
    expect(await readFile(file, 'utf8')).toBe(original);
    expect(await readdir(dir)).toEqual(['audacity.cfg']);
    expect(fake.running).not.toHaveBeenCalled();
  });
  it('refuses executable inspection failure before configuration mutation', async () => {
    const file = join(dir, 'audacity.cfg');
    const original = await readFile(file, 'utf8');
    fake.version.mockRejectedValue(new Error('AUDACITY_EXE is not an existing executable file'));
    await expect(fixPipeConfig()).rejects.toThrow('not an existing executable');
    expect(await readFile(file, 'utf8')).toBe(original);
    expect(await readdir(dir)).toEqual(['audacity.cfg']);
  });
  it('changes only the module enablement and preserves section boundaries/newlines', () => {
    const original = '[Module]\r\nmod-script-pipe=0\r\ncustom=1\r\n[ModulePath]\r\nmod-script-pipe=/a.dll\r\n';
    const enabled = enablePipeConfig(original);
    expect(enabled).toBe(original.replace('mod-script-pipe=0', 'mod-script-pipe=1'));
    expect(configValue(enabled, 'Module', 'mod-script-pipe')).toBe('1');
    expect(configValue(enabled, 'Missing', 'key')).toBeUndefined();
    expect(enablePipeConfig('[Module]\ncustom=1')).toBe('[Module]\nmod-script-pipe=1\ncustom=1');
    expect(enablePipeConfig('[Other]\nx=1\n')).toBe('[Other]\nx=1\n[Module]\nmod-script-pipe=1\n');
    expect(enablePipeConfig('')).toBe('\n[Module]\nmod-script-pipe=1\n');
  });
  it('retains a byte-for-byte config backup', async () => {
    const original = '[Module]\nmod-script-pipe=0\n';
    await writeFile(join(dir, 'audacity.cfg'), original);
    const backup = await fixPipeConfig();
    expect(await readFile(backup!, 'utf8')).toBe(original);
    expect(await readFile(join(dir, 'audacity.cfg'), 'utf8')).toBe(enablePipeConfig(original));
  });
  it('refuses running and startup-during-backup without modifying config', async () => {
    await writeFile(join(dir, 'audacity.cfg'), '[Module]\nmod-script-pipe=0\n');
    fake.running.mockResolvedValue(true);
    await expect(fixPipeConfig()).rejects.toThrow('stopped');
    fake.running.mockResolvedValueOnce(false).mockResolvedValueOnce(true);
    await expect(fixPipeConfig()).rejects.toThrow('config unchanged');
  });
});

describe('doctor diagnostics', () => {
  it('checks ffprobe beside a custom ffmpeg and respects an explicit probe override', async () => {
    const ffmpeg = join('/example-tools', 'ffmpeg.exe');
    const adjacent = join('/example-tools', 'ffprobe.exe');
    vi.stubEnv('AUDACITY_FFMPEG', ffmpeg);
    vi.stubEnv('AUDACITY_FFPROBE', undefined);
    await doctor();
    expect(fake.ffmpeg.mock.calls.map(([file]) => file)).toEqual([ffmpeg, adjacent]);
    fake.ffmpeg.mockClear();
    const explicit = join('/separate-tools', 'ffprobe.exe');
    vi.stubEnv('AUDACITY_FFPROBE', explicit);
    await doctor();
    expect(fake.ffmpeg.mock.calls.map(([file]) => file)).toEqual([ffmpeg, explicit]);
  });
  it('reports stopped pipe separately and keeps ffmpeg optional', async () => {
    fake.ffmpeg.mockReturnValue({ status: null });
    const report = await doctor();
    expect(report.ok).toBe(false);
    expect(report.checks.find((check) => check.name === 'pipe')).toMatchObject({ ok: false });
    expect(report.checks.find((check) => check.name === 'ffmpeg (optional)')).toMatchObject({
      ok: false,
      detail: expect.stringContaining('WAV measurement'),
    });
  });
  it('reports all supported live checks and releases endpoint ownership', async () => {
    fake.processes.mockResolvedValue([
      {
        pid: 42,
        executable: process.execPath,
        owner: process.platform === 'win32' ? userInfo().username : String(userInfo().uid),
      },
    ]);
    fake.present.mockReturnValue(true);
    fake.send.mockResolvedValue({ ok: true, body: 'commands' });
    expect((await doctor()).ok).toBe(true);
    expect(fake.english).toHaveBeenCalledWith('commands');
    expect(fake.release).toHaveBeenCalledOnce();
  });
  it('refuses 4.x, disabled module and mismatched executable before probing', async () => {
    fake.version.mockResolvedValue('4.0.0');
    fake.processes.mockResolvedValue([{ pid: 42, executable: '/different' }]);
    await writeFile(join(dir, 'audacity.cfg'), '[Module]\nmod-script-pipe=0\n');
    const report = await doctor();
    expect(report.checks.find((check) => check.name === 'version')?.detail).toContain(
      'winget install --id Audacity.Audacity',
    );
    expect(report.ok).toBe(false);
    expect(fake.send).not.toHaveBeenCalled();
  });
  it('returns native failure and releases its lock without erasing settings', async () => {
    fake.processes.mockResolvedValue([
      {
        pid: 42,
        executable: process.execPath,
        owner: process.platform === 'win32' ? userInfo().username : String(userInfo().uid),
      },
    ]);
    fake.present.mockReturnValue(true);
    fake.send.mockResolvedValue({ ok: false, body: 'Native error' });
    expect((await doctor()).checks.find((check) => check.name === 'English command IDs')?.detail).toBe('Native error');
    expect(fake.release).toHaveBeenCalledOnce();
  });
  it('prints CLI JSON and rejects unknown flags', async () => {
    const output = vi.spyOn(process.stdout, 'write').mockReturnValue(true);
    const originalCode = process.exitCode;
    try {
      await runDoctor([]);
      expect(JSON.parse(String(output.mock.calls[0]?.[0]))).toHaveProperty('checks');
      expect(process.exitCode).toBe(1);
    } finally {
      process.exitCode = originalCode;
    }
    await expect(runDoctor(['--unknown'])).rejects.toThrow('Usage:');
  });
  it('includes --fix backup in diagnostics', async () => {
    await writeFile(join(dir, 'audacity.cfg'), '[Module]\nmod-script-pipe=0\n');
    expect(await doctor(true)).toHaveProperty('backup');
  });
});

describe('native module status', () => {
  it('formats the local modification time to the second like wxDateTime', async () => {
    const stamp = moduleStamp(await installedModule());
    expect(stamp).toMatch(/^2026-06-1[01]T\d{2}:\d{2}:52$/);
  });
  it('reports an enabled module recorded for a different file as skipped', async () => {
    await installedModule();
    await writeFile(
      join(dir, 'audacity.cfg'),
      '[Module]\nmod-script-pipe=1\n[ModuleDateTime]\nmod-script-pipe=2020-01-01T00:00:00\n',
    );
    const check = (await doctor()).checks.find((entry) => entry.name === 'mod-script-pipe');
    expect(check).toMatchObject({ ok: false, detail: expect.stringContaining('different module file') });
  });
  it('fix records the current module timestamp, then leaves a correct config untouched', async () => {
    const module = await installedModule();
    const file = join(dir, 'audacity.cfg');
    await writeFile(file, '[Module]\nmod-script-pipe=4\n[ModuleDateTime]\nmod-script-pipe=2020-01-01T00:00:00\n');
    expect(await fixPipeConfig()).toBeDefined();
    const fixed = await readFile(file, 'utf8');
    expect(configValue(fixed, 'Module', 'mod-script-pipe')).toBe('1');
    expect(configValue(fixed, 'ModuleDateTime', 'mod-script-pipe')).toBe(moduleStamp(module));
    expect((await doctor()).checks.find((entry) => entry.name === 'mod-script-pipe')?.ok).toBe(true);
    const files = await readdir(dir);
    expect(await fixPipeConfig()).toBeUndefined();
    expect(await readdir(dir)).toEqual(files);
  });
  it('explains missing settings instead of a raw file error', async () => {
    await rm(join(dir, 'audacity.cfg'));
    await expect(fixPipeConfig()).rejects.toThrow('Start and quit Audacity once');
    expect((await doctor()).checks.find((entry) => entry.name === 'mod-script-pipe')?.detail).toContain(
      'No Audacity settings',
    );
  });
});
