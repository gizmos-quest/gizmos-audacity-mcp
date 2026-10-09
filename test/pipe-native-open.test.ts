import { constants } from 'node:fs';
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it, vi } from 'vitest';

const fake = vi.hoisted(() => ({
  open: vi.fn(),
  originalOpen: undefined as unknown as typeof import('node:fs/promises')['open'],
}));
vi.mock('node:fs/promises', async (original) => {
  const actual = await original<typeof import('node:fs/promises')>();
  fake.originalOpen = actual.open;
  return { ...actual, open: fake.open };
});
// Model the precise race: validation observes FIFO, then the path changes to a
// regular file before native open. Post-open fstat must refuse before writing.
vi.mock('../src/pipe-paths.js', () => ({ validatePipePaths: vi.fn() }));

import { exchangePipeRequest } from '../src/pipe-worker.js';

const originalPlatform = process.platform;
afterEach(() => {
  Object.defineProperty(process, 'platform', { value: originalPlatform });
  vi.restoreAllMocks();
});
describe('non-truncating native FIFO opens', () => {
  it('uses O_WRONLY without create/truncate and refuses a changed file after opening', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'gizmos-native-open-test-'));
    const file = join(dir, 'retained.txt');
    await writeFile(file, 'retain every byte');
    fake.open.mockImplementation(fake.originalOpen);
    Object.defineProperty(process, 'platform', { value: 'linux' });
    try {
      expect(await exchangePipeRequest({ to: file, from: join(dir, 'unused') }, 'Stop:')).toMatchObject({
        sent: false,
        error: expect.stringContaining('FIFO changed'),
      });
      expect(fake.open).toHaveBeenCalledExactlyOnceWith(file, constants.O_WRONLY);
      expect(await readFile(file, 'utf8')).toBe('retain every byte');
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });
});
