import { EventEmitter } from 'node:events';
import { PassThrough } from 'node:stream';
import { afterEach, describe, expect, it, vi } from 'vitest';

const mocks = vi.hoisted(() => ({ helper: vi.fn(), spawn: vi.fn() }));
vi.mock('../src/app-helper.js', () => ({ powershell: mocks.helper }));
vi.mock('node:child_process', () => ({ spawn: mocks.spawn }));

import {
  assertSupportedVersion,
  audacityProcesses,
  currentProcessIdentity,
  executableVersion,
  isRunning,
  preflightExecutableOverride,
  startPosix,
} from '../src/app-process.js';

const originalPlatform = process.platform;
afterEach(() => {
  Object.defineProperty(process, 'platform', { value: originalPlatform });
  vi.unstubAllEnvs();
  vi.clearAllMocks();
});
const platform = (value: string) => Object.defineProperty(process, 'platform', { value });
function child() {
  return Object.assign(new EventEmitter(), {
    stdout: new PassThrough(),
    stderr: new PassThrough(),
    kill: vi.fn(),
    unref: vi.fn(),
  });
}
describe('actual process evidence', () => {
  it('reads measured executable/start/user and binds a unique epoch', async () => {
    platform('win32');
    mocks.helper.mockResolvedValue(
      JSON.stringify([{ pid: 42, executable: '/Audacity.exe', started: 'ticks', owner: 'user' }]),
    );
    expect(await currentProcessIdentity()).toBe('[42,"/Audacity.exe","ticks"]');
    expect(await isRunning()).toBe(true);
    mocks.helper.mockResolvedValue('[]');
    expect(await currentProcessIdentity()).toBeUndefined();
    expect(await isRunning()).toBe(false);
    mocks.helper.mockResolvedValue('[{"pid":42}]');
    expect(await currentProcessIdentity()).toBeUndefined();
    mocks.helper.mockResolvedValue('');
    expect(await audacityProcesses()).toEqual([]);
  });
  it('reads actual POSIX process names even when no FIFO exists', async () => {
    platform('linux');
    const process = child();
    mocks.spawn.mockReturnValue(process);
    const result = audacityProcesses();
    process.stdout.write(
      ' 42 1000 Fri Oct  9 20:00:00 2026 /usr/bin/audacity\n 43 1000 Fri Oct  9 20:00:00 2026 /usr/bin/other\n',
    );
    process.emit('close', 0);
    expect(await result).toEqual([
      {
        pid: 42,
        owner: '1000',
        executable: '/usr/bin/audacity',
        started: 'Fri Oct  9 20:00:00 2026',
        fileVersion: null,
        productVersion: null,
      },
    ]);
    expect(mocks.spawn).toHaveBeenCalledWith('ps', ['-axo', 'pid=,uid=,lstart=,comm='], expect.any(Object));
  });
  it('reports process inspection errors instead of interpreting them as stopped', async () => {
    platform('linux');
    const process = child();
    mocks.spawn.mockReturnValue(process);
    const result = audacityProcesses();
    process.stderr.write('permission denied');
    process.emit('close', 1);
    await expect(result).rejects.toThrow('permission denied');
    const another = child();
    mocks.spawn.mockReturnValue(another);
    const error = audacityProcesses();
    another.emit('error', new Error('missing ps'));
    await expect(error).rejects.toThrow('missing ps');
  });
  it('verifies explicit binary before reading a shared endpoint', async () => {
    platform('win32');
    vi.stubEnv('AUDACITY_EXE', process.execPath.endsWith('.exe') ? process.execPath : undefined);
    if (process.env.AUDACITY_EXE) {
      mocks.helper.mockResolvedValue('[{"pid":42,"executable":"other.exe"}]');
      await expect(preflightExecutableOverride()).rejects.toThrow('Preserve and quit');
    } else await expect(preflightExecutableOverride()).resolves.toBeUndefined();
  });
  it('checks actual version and clearly refuses Audacity 4', async () => {
    platform('win32');
    mocks.helper.mockResolvedValue('3,7,8,0');
    expect(await executableVersion('/Audacity.exe')).toBe('3.7.8.0');
    expect(() => assertSupportedVersion('4.0.0')).toThrow('has no mod-script-pipe');
    expect(() => assertSupportedVersion('3.6.0')).toThrow('Unsupported');
    for (const version of ['3.7.8', '3.7.8.0', '3.7.9.0']) expect(() => assertSupportedVersion(version)).not.toThrow();
  });
  it('reads POSIX version and rejects an unrecognized version', async () => {
    platform('darwin');
    const process = child();
    mocks.spawn.mockReturnValue(process);
    const result = executableVersion('/Audacity');
    process.stdout.write('Audacity 3.7.8');
    process.emit('close', 0);
    expect(await result).toBe('3.7.8');
    const next = child();
    mocks.spawn.mockReturnValue(next);
    const unknown = executableVersion('/Audacity');
    next.emit('close', 0);
    await expect(unknown).rejects.toThrow('Cannot determine');
  });
  it('handles detached spawn failure and observes spawn before unref', async () => {
    const process = child();
    mocks.spawn.mockReturnValue(process);
    const failed = startPosix('/Audacity');
    process.emit('error', new Error('EACCES'));
    await expect(failed).rejects.toThrow('EACCES');
    const next = child();
    mocks.spawn.mockReturnValue(next);
    const launched = startPosix('/Audacity');
    next.emit('spawn');
    await launched;
    expect(next.unref).toHaveBeenCalledOnce();
  });
});
