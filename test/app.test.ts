import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { launch } from '../src/app.js';
import { assertExecutableMatches, audacityExe, preflightExecutableOverride } from '../src/app-process.js';

afterEach(() => vi.unstubAllEnvs());

describe('native application preflight', () => {
  it('honors an explicit executable override without falling back to an installed Audacity', () => {
    const file = process.execPath;
    vi.stubEnv('AUDACITY_EXE', file);
    expect(audacityExe()).toBe(resolve(file));
  });
  it.each(['', join(tmpdir(), 'gizmos-audacity-nonexistent-executable-review.exe'), tmpdir()])(
    'rejects an invalid explicit executable override %j',
    (file) => {
      vi.stubEnv('AUDACITY_EXE', file);
      expect(() => audacityExe()).toThrow('AUDACITY_EXE is not an existing executable file');
    },
  );
  it.each(['', join(tmpdir(), 'gizmos-audacity-nonexistent-executable-review.exe'), tmpdir()])(
    'rejects invalid override %j before attaching to a reachable pipe',
    async (file) => {
      vi.stubEnv('AUDACITY_EXE', file);
      await expect(launch(false)).rejects.toThrow('AUDACITY_EXE is not an existing executable file');
    },
  );
  it('keeps automatic discovery free of explicit-override process inspection', async () => {
    vi.stubEnv('AUDACITY_EXE', undefined);
    await expect(preflightExecutableOverride()).resolves.toBeUndefined();
  });
  it('accepts the same Windows installation with case differences', () => {
    const executable = resolve('portable', 'Audacity.exe');
    expect(() =>
      assertExecutableMatches(
        executable,
        [{ pid: 123, executable: executable.toUpperCase(), fileVersion: '3.7.8.0', productVersion: '3.7.8' }],
        'win32',
      ),
    ).not.toThrow();
    expect(() => assertExecutableMatches(executable, [], 'win32')).not.toThrow();
  });
  it.each([null, resolve('installed', 'Audacity.exe')])(
    'refuses a different or unidentified running executable %j',
    (executable) => {
      expect(() =>
        assertExecutableMatches(
          resolve('portable', 'Audacity.exe'),
          [{ pid: 123, executable, fileVersion: '3.7.9.0', productVersion: '3.7.9' }],
          'win32',
        ),
      ).toThrow(/Preserve and quit that installation/);
    },
  );
  it('matches the macOS bundle Wrapper with the Audacity binary it executes', () => {
    const bundle = resolve('Applications', 'Audacity.app', 'Contents', 'MacOS');
    const running = [{ pid: 7, executable: join(bundle, 'Audacity'), fileVersion: null, productVersion: null }];
    expect(() => assertExecutableMatches(join(bundle, 'Wrapper'), running, 'darwin')).not.toThrow();
    expect(() => assertExecutableMatches(join(bundle, 'Other'), running, 'darwin')).toThrow(/running from/);
  });
  it('does not ignore case differences on a case-sensitive host', () => {
    const executable = resolve('portable', 'Audacity');
    expect(() =>
      assertExecutableMatches(
        executable,
        [{ pid: 123, executable: executable.toUpperCase(), fileVersion: null, productVersion: null }],
        'linux',
      ),
    ).toThrow(/running from/);
  });
  it.each([0, -1, Infinity, NaN, 2_147_483_648])(
    'rejects invalid launch wait %s before inspecting or starting Audacity',
    async (wait) => {
      await expect(launch(false, wait)).rejects.toThrow('waitMs must be positive');
    },
  );
});
