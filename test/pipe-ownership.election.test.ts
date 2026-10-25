import { randomUUID } from 'node:crypto';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it, vi } from 'vitest';

const fake = vi.hoisted(() => ({
  write: vi.fn(),
  homedir: undefined as string | undefined,
  originalWrite: undefined as unknown as typeof import('node:fs')['writeFileSync'],
}));
vi.mock('node:os', async (original) => {
  const actual = await original<typeof import('node:os')>();
  return { ...actual, userInfo: () => ({ ...actual.userInfo(), homedir: fake.homedir ?? actual.userInfo().homedir }) };
});
vi.mock('node:fs', async (original) => {
  const actual = await original<typeof import('node:fs')>();
  fake.originalWrite = actual.writeFileSync;
  fake.write.mockImplementation(actual.writeFileSync);
  return { ...actual, writeFileSync: fake.write };
});

import { acquirePipeOwnership, ownershipDirectory, releasePipeOwnership } from '../src/pipe-ownership.js';

const originalPlatform = process.platform;
const directories: string[] = [];
afterEach(() => {
  releasePipeOwnership();
  Object.defineProperty(process, 'platform', { value: originalPlatform });
  for (const dir of directories.splice(0)) rmSync(dir, { recursive: true, force: true });
  vi.restoreAllMocks();
  fake.write.mockReset().mockImplementation(fake.originalWrite);
  fake.homedir = undefined;
});
function fixture() {
  const paths = { to: `\\\\.\\pipe\\ElectionTo-${randomUUID()}`, from: `\\\\.\\pipe\\ElectionFrom-${randomUUID()}` };
  const directory = ownershipDirectory(paths);
  directories.push(directory);
  return { paths, directory, owner: join(directory, 'owner.json'), marker: join(directory, 'reclaim') };
}
const dead = () => {
  throw Object.assign(new Error('confirmed stopped owner'), { code: 'ESRCH' });
};

describe('endpoint owner election', () => {
  it('normalizes Windows pipe casing to one session lock', () => {
    fake.homedir = mkdtempSync(join(tmpdir(), 'audacity-owner-home-'));
    directories.push(fake.homedir);
    mkdirSync(join(fake.homedir, 'AppData', 'Local', 'Temp'), { recursive: true });
    Object.defineProperty(process, 'platform', { value: 'win32' });
    const state = fixture();
    const alias = { to: state.paths.to.toUpperCase(), from: state.paths.from.toUpperCase() };
    expect(ownershipDirectory(alias)).toBe(ownershipDirectory(state.paths));
    acquirePipeOwnership(state.paths);
    const before = readFileSync(state.owner, 'utf8');
    acquirePipeOwnership(alias);
    expect(readFileSync(state.owner, 'utf8')).toBe(before);
    releasePipeOwnership(alias);
    expect(existsSync(state.directory)).toBe(false);
  });
  it('does not remove another reclaimer election marker', () => {
    const state = fixture();
    mkdirSync(state.directory);
    fake.originalWrite(state.owner, JSON.stringify({ pid: 1234, token: 'stale' }));
    fake.originalWrite(state.marker, 'another-reclaimer');
    vi.spyOn(process, 'kill').mockImplementation(dead);
    expect(() => acquirePipeOwnership(state.paths)).toThrow('being reclaimed');
    expect(readFileSync(state.marker, 'utf8')).toBe('another-reclaimer');
    expect(JSON.parse(readFileSync(state.owner, 'utf8')).token).toBe('stale');
  });
  it('re-reads PID and token after exclusive election and preserves a replacement live owner', () => {
    const state = fixture();
    mkdirSync(state.directory);
    fake.originalWrite(state.owner, JSON.stringify({ pid: 1234, token: 'stale' }));
    vi.spyOn(process, 'kill').mockImplementation(dead);
    fake.write.mockImplementation((file, data, options) => {
      fake.originalWrite(file, data, options);
      if (String(file) === state.marker)
        fake.originalWrite(state.owner, JSON.stringify({ pid: process.pid, token: 'replacement' }));
    });
    expect(() => acquirePipeOwnership(state.paths)).toThrow('owner changed during reclamation');
    expect(JSON.parse(readFileSync(state.owner, 'utf8'))).toEqual({ pid: process.pid, token: 'replacement' });
    expect(existsSync(state.marker)).toBe(false);
    expect(process.kill).toHaveBeenCalledOnce();
  });
});
