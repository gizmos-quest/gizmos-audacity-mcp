import { mkdir, mkdtemp, readdir, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const running = vi.hoisted(() => vi.fn());
vi.mock('../src/app-process.js', () => ({ isRunning: running }));

import { configPath, discardStaleRecovery, writeStoppedConfig } from '../src/app-config.js';

let dir: string;
let file: string;
const original = '[Other]\nkeep=1\n[ActiveProjects]\n1=example.aup3\n[After]\nkeep=2\n';
beforeEach(async () => {
  running.mockReset().mockResolvedValue(false);
  dir = await mkdtemp(join(tmpdir(), 'gizmos-config-safety-'));
  file = join(dir, 'audacity.cfg');
  await writeFile(file, original);
  vi.stubEnv('AUDACITY_CONFIG', file);
});
afterEach(async () => {
  vi.unstubAllEnvs();
  await rm(dir, { recursive: true, force: true });
});
async function backup(): Promise<string> {
  const name = (await readdir(dir)).find((name) => name.includes('.before-recovery-'));
  expect(name).toBeDefined();
  return readFile(join(dir, name!), 'utf8');
}

describe('stopped unchanged config mutation', () => {
  it('refuses startup during backup and retains original config plus exact backup', async () => {
    running.mockResolvedValueOnce(false).mockResolvedValueOnce(true);
    await expect(discardStaleRecovery()).rejects.toThrow('started during config backup');
    expect(await readFile(file, 'utf8')).toBe(original);
    expect(await backup()).toBe(original);
    expect((await readdir(dir)).some((name) => name.endsWith('.tmp'))).toBe(false);
  });
  it('preserves an externally changed config instead of overwriting it with a stale snapshot', async () => {
    const changed = `${original}[New]\nkeep=3\n`;
    running.mockResolvedValueOnce(false).mockImplementationOnce(async () => {
      await writeFile(file, changed);
      return false;
    });
    await expect(discardStaleRecovery()).rejects.toThrow('config changed during backup');
    expect(await readFile(file, 'utf8')).toBe(changed);
    expect(await backup()).toBe(original);
    expect((await readdir(dir)).some((name) => name.endsWith('.tmp'))).toBe(false);
  });
  it('replaces the full stopped unchanged file and removes only its own staging file', async () => {
    const updated = '[Module]\nmod-script-pipe=1\n';
    const unrelated = join(dir, 'unrelated.tmp');
    await writeFile(unrelated, 'retain');
    await writeStoppedConfig(file, original, updated);
    expect(await readFile(file, 'utf8')).toBe(updated);
    expect(await readFile(unrelated, 'utf8')).toBe('retain');
    expect(await readdir(dir)).toEqual(['audacity.cfg', 'unrelated.tmp']);
  });
  it('discovers an explicit executable adjacent Portable Settings without editing global config', async () => {
    vi.stubEnv('AUDACITY_CONFIG', undefined);
    const portable = join(dir, 'Portable Settings');
    await mkdir(portable);
    vi.stubEnv('AUDACITY_EXE', join(dir, 'Audacity.exe'));
    expect(configPath()).toBe(join(portable, 'audacity.cfg'));
    vi.stubEnv('AUDACITY_CONFIG', file);
    expect(configPath()).toBe(file);
  });
});
