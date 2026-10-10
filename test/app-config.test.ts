import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it, vi } from 'vitest';

const mock = vi.hoisted(() => ({ running: vi.fn() }));
vi.mock('../src/app-process.js', () => ({ isRunning: mock.running }));

import { configPath, discardStaleRecovery, parseActiveProjects, recoveryEntries } from '../src/app-config.js';

const originalPlatform = process.platform;
afterEach(() => {
  Object.defineProperty(process, 'platform', { value: originalPlatform });
  vi.unstubAllEnvs();
  vi.clearAllMocks();
});
describe('project recovery config', () => {
  it('discovers each platform config with explicit overrides first', () => {
    vi.stubEnv('AUDACITY_CONFIG', '/explicit/audacity.cfg');
    expect(configPath()).toBe('/explicit/audacity.cfg');
    vi.stubEnv('AUDACITY_CONFIG', undefined);
    vi.stubEnv('APPDATA', '/config');
    Object.defineProperty(process, 'platform', { value: 'win32' });
    expect(configPath()).toBe(join('/config', 'audacity', 'audacity.cfg'));
    Object.defineProperty(process, 'platform', { value: 'darwin' });
    expect(configPath()).toContain('Application Support');
    Object.defineProperty(process, 'platform', { value: 'linux' });
    vi.stubEnv('XDG_CONFIG_HOME', '/xdg');
    expect(configPath()).toBe(join('/xdg', 'audacity', 'audacity.cfg'));
  });
  it('clears only stopped entries with retained config/project bytes', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'gizmos-config-test-'));
    const file = join(dir, 'audacity.cfg');
    const project = join(dir, 'retained.aup3');
    await writeFile(project, 'project bytes');
    const original = `[Other]\nkeep=1\n[ActiveProjects]\n1=${project}\n[After]\nkeep=2\n`;
    await writeFile(file, original);
    vi.stubEnv('AUDACITY_CONFIG', file);
    try {
      expect(recoveryEntries()).toEqual([project]);
      mock.running.mockResolvedValue(true);
      await expect(discardStaleRecovery()).rejects.toThrow('stopped');
      mock.running.mockResolvedValue(false);
      const result = await discardStaleRecovery();
      expect(result.projects).toEqual([project]);
      expect(await readFile(result.backup, 'utf8')).toBe(original);
      expect(recoveryEntries()).toEqual([]);
      expect(await readFile(project, 'utf8')).toBe('project bytes');
      expect(await readFile(file, 'utf8')).toContain('[After]\nkeep=2');
    } finally {
      await rm(dir, { recursive: true });
    }
  });
  it('returns no entries for missing config and handles native escaped paths', () => {
    vi.stubEnv('AUDACITY_CONFIG', join(tmpdir(), 'nonexistent-gizmos-config.cfg'));
    expect(recoveryEntries()).toEqual([]);
    expect(parseActiveProjects('[ActiveProjects]\r\n1=C:\\\\Audio\\\\project.aup3\r\n[Next]\r\nx=1')).toEqual([
      'C:\\Audio\\project.aup3',
    ]);
  });
  it('reads only the recovery section and preserves project paths', () => {
    expect(
      parseActiveProjects(
        '[Other]\n1=ignored\n[ActiveProjects]\n1=C:\\\\projects\\\\x.aup3\n2=/tmp/a.aup3\n[Window]\n1=no',
      ),
    ).toEqual(['C:\\projects\\x.aup3', '/tmp/a.aup3']);
    expect(parseActiveProjects('[ActiveProjects]\n1=last.aup3')).toEqual(['last.aup3']);
    expect(parseActiveProjects('[ActiveProjects]\n[Window]\nX=1')).toEqual([]);
  });
});
