import { createHash, randomUUID } from 'node:crypto';
import { existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir, userInfo } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { acquirePipeOwnership, releasePipeOwnership } from '../src/pipe-ownership.js';

const paths = () => ({ to: randomUUID(), from: randomUUID() });
function lock(paths: { to: string; from: string }): string {
  const hash = createHash('sha256')
    .update(JSON.stringify([userInfo().username, paths.to, paths.from]))
    .digest('hex')
    .slice(0, 24);
  return join(tmpdir(), `gizmos-audacity-owner-${hash}`);
}
afterEach(() => {
  releasePipeOwnership();
  vi.restoreAllMocks();
});
describe('single pipe session owner', () => {
  it('holds ownership lazily for its session and allows same-process exchanges', () => {
    const endpoint = paths();
    acquirePipeOwnership(endpoint);
    acquirePipeOwnership(endpoint);
    const owner = JSON.parse(readFileSync(join(lock(endpoint), 'owner.json'), 'utf8'));
    expect(owner.pid).toBe(process.pid);
    releasePipeOwnership(endpoint);
    expect(existsSync(lock(endpoint))).toBe(false);
  });
  it('reclaims only a confirmed stopped owner', () => {
    const endpoint = paths();
    const dir = lock(endpoint);
    mkdirSync(dir);
    writeFileSync(join(dir, 'owner.json'), JSON.stringify({ pid: 1234, token: 'stale' }));
    vi.spyOn(process, 'kill').mockImplementation(() => {
      throw Object.assign(new Error('stopped'), { code: 'ESRCH' });
    });
    acquirePipeOwnership(endpoint);
    expect(JSON.parse(readFileSync(join(dir, 'owner.json'), 'utf8')).pid).toBe(process.pid);
  });
  it('refuses alive, uninspectable and malformed ownership', () => {
    const endpoint = paths();
    const dir = lock(endpoint);
    mkdirSync(dir);
    const file = join(dir, 'owner.json');
    try {
      expect(() => acquirePipeOwnership(endpoint)).toThrow('incomplete');
      writeFileSync(file, JSON.stringify({ pid: -1 }));
      expect(() => acquirePipeOwnership(endpoint)).toThrow('Invalid');
      writeFileSync(file, JSON.stringify({ pid: 1234, token: 'live' }));
      vi.spyOn(process, 'kill').mockReturnValue(true);
      expect(() => acquirePipeOwnership(endpoint)).toThrow('owned by');
      vi.spyOn(process, 'kill').mockImplementation(() => {
        throw Object.assign(new Error('permission denied'), { code: 'EPERM' });
      });
      expect(() => acquirePipeOwnership(endpoint)).toThrow('Cannot verify');
    } finally {
      rmSync(dir, { recursive: true });
    }
  });
  it('never removes a lock whose identity changed after acquisition', () => {
    const endpoint = paths();
    acquirePipeOwnership(endpoint);
    const dir = lock(endpoint);
    writeFileSync(join(dir, 'owner.json'), '{"token":"other"}');
    releasePipeOwnership(endpoint);
    expect(existsSync(dir)).toBe(true);
    rmSync(dir, { recursive: true });
  });
});
