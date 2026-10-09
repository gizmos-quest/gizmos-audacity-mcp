import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { defaultPipePaths } from '../src/pipe.js';
import { validatePipePaths } from '../src/pipe-paths.js';
import { exchangePipeRequest } from '../src/pipe-worker.js';

const directories: string[] = [];
const originalPlatform = process.platform;
afterEach(async () => {
  Object.defineProperty(process, 'platform', { value: originalPlatform });
  vi.unstubAllEnvs();
  await Promise.all(directories.splice(0).map((dir) => rm(dir, { recursive: true, force: true })));
});

describe('strict scripting endpoint paths', () => {
  it.each([
    '',
    'relative',
    'C:\\Audio\\file.wav',
    '\\\\host\\pipe\\Audacity',
    '\\\\.\\pipe\\nested\\name',
    '\\\\.\\pipe\\line\nname',
    '\\\\.\\pipe\\nul\0name',
  ])('refuses an unsafe Windows write endpoint %j', (to) => {
    expect(() => validatePipePaths({ to, from: '\\\\.\\pipe\\FromSrvPipe' }, 'win32')).toThrow();
  });
  it('accepts only local named-pipe namespaces on Windows', () => {
    expect(() =>
      validatePipePaths({ to: '\\\\.\\PIPE\\ToSrvPipe', from: '\\\\.\\pipe\\FromSrvPipe' }, 'win32'),
    ).not.toThrow();
  });
  it('requires both overrides and checks their namespace before any I/O', () => {
    vi.stubEnv('AUDACITY_PIPE_TO', '\\\\.\\pipe\\test-to');
    vi.stubEnv('AUDACITY_PIPE_FROM', undefined);
    expect(() => defaultPipePaths('win32')).toThrow('both be nonempty');
    vi.stubEnv('AUDACITY_PIPE_FROM', 'ordinary-file');
    expect(() => defaultPipePaths('win32')).toThrow('named-pipe namespace');
  });
  it('allows missing absolute FIFO endpoints for bounded native open retries', () => {
    expect(() =>
      validatePipePaths({ to: '/tmp/nonexistent-gizmos-fifo-to', from: '/tmp/nonexistent-gizmos-fifo-from' }, 'linux'),
    ).not.toThrow();
    expect(() => validatePipePaths({ to: 'relative', from: '/tmp/example-fifo' }, 'linux')).toThrow('absolute FIFO');
  });
  it('refuses existing regular-file overrides and preserves their contents', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'gizmos-endpoint-test-'));
    directories.push(dir);
    const file = join(dir, 'retained.txt');
    await writeFile(file, 'original retained bytes');
    Object.defineProperty(process, 'platform', { value: 'linux' });
    vi.stubEnv('AUDACITY_PIPE_TO', file);
    vi.stubEnv('AUDACITY_PIPE_FROM', join(dir, 'from'));
    expect(() => defaultPipePaths()).toThrow('FIFOs, never regular files');
    expect(
      await exchangePipeRequest({ to: file, from: join(dir, 'from') }, 'GetInfo: Type=Tracks Format=JSON'),
    ).toMatchObject({ sent: false, error: expect.stringContaining('FIFOs') });
    expect(await readFile(file, 'utf8')).toBe('original retained bytes');
  });
});
