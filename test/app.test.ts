import { afterEach, describe, expect, it, vi } from 'vitest';
import { fileURLToPath } from 'node:url';
import { tmpdir } from 'node:os';
import { resolve, join } from 'node:path';
import { audacityExe, launch } from '../src/app.js';

afterEach(() => vi.unstubAllEnvs());

describe('native application preflight', () => {
  it('honors an explicit executable override without falling back to an installed Audacity', () => {
    const file = fileURLToPath(import.meta.url);
    vi.stubEnv('AUDACITY_EXE', file);
    expect(audacityExe()).toBe(resolve(file));
  });
  it.each(['', join(tmpdir(), 'gizmos-audacity-nonexistent-executable-review.exe'), tmpdir()])('rejects an invalid explicit executable override %j', (file) => {
    vi.stubEnv('AUDACITY_EXE', file);
    expect(() => audacityExe()).toThrow('AUDACITY_EXE is not an existing executable file');
  });
  it.each([0, -1, Infinity, NaN, 2_147_483_648])('rejects invalid launch wait %s before inspecting or starting Audacity', async (wait) => {
    await expect(launch(false, wait)).rejects.toThrow('waitMs must be positive');
  });
});
