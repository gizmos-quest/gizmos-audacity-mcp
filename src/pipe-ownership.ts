// Audacity has no reply correlation IDs: one controlling reader/writer owns an
// endpoint for its session. This lock coordinates this project's entry points;
// unrelated clients and manual UI edits remain outside the safety contract.
import { createHash, randomUUID } from 'node:crypto';
import { existsSync, mkdirSync, readFileSync, renameSync, rmSync, writeFileSync } from 'node:fs';
import { userInfo } from 'node:os';
import { join, resolve } from 'node:path';
import type { PipePaths } from './pipe.js';

const held = new Map<string, { directory: string; token: string }>();
function key(paths: PipePaths): string {
  const normalize = (path: string) => (process.platform === 'win32' ? path.toLowerCase() : resolve(path));
  return createHash('sha256')
    .update(JSON.stringify([userInfo().username, normalize(paths.to), normalize(paths.from)]))
    .digest('hex')
    .slice(0, 24);
}
/** One lock per user and endpoint, whatever TEMP/TMPDIR a launcher sets: the account's
 * local temp (os.userInfo reads the account, not the environment) on Windows, and /tmp
 * beside Audacity's own FIFOs elsewhere. */
export function ownershipDirectory(paths: PipePaths): string {
  const root = process.platform === 'win32' ? join(userInfo().homedir, 'AppData', 'Local', 'Temp') : '/tmp';
  return join(root, `gizmos-audacity-owner-${key(paths)}`);
}
/** Move a lock aside in one step, so no contender ever sees it without its owner record. */
function retire(directory: string): void {
  const retired = `${directory}.retired-${randomUUID()}`;
  renameSync(directory, retired);
  try {
    rmSync(retired, { recursive: true, force: true });
  } catch {
    /* A leftover retired directory holds no lock. */
  }
}
export function acquirePipeOwnership(paths: PipePaths): void {
  const id = key(paths);
  if (held.has(id)) return;
  const directory = ownershipDirectory(paths);
  const ownerFile = join(directory, 'owner.json');
  const token = randomUUID();
  // Publish the lock directory only together with its owner record.
  const staged = `${directory}.new-${token}`;
  mkdirSync(staged, { mode: 0o700 });
  writeFileSync(join(staged, 'owner.json'), JSON.stringify({ pid: process.pid, token }), { mode: 0o600 });
  try {
    renameSync(staged, directory);
    held.set(id, { directory, token });
    return;
  } catch (error) {
    rmSync(staged, { recursive: true, force: true });
    if (!existsSync(directory)) throw error;
  }
  let owner: { pid: number; token: string };
  try {
    owner = JSON.parse(readFileSync(ownerFile, 'utf8'));
  } catch {
    throw new Error('Audacity endpoint ownership is incomplete; inspect its local lock before retrying.');
  }
  if (!Number.isInteger(owner.pid) || owner.pid <= 0 || typeof owner.token !== 'string')
    throw new Error('Invalid Audacity endpoint ownership record; refusing to steal the pipe.');
  try {
    process.kill(owner.pid, 0);
  } catch (probe) {
    if ((probe as NodeJS.ErrnoException).code !== 'ESRCH')
      throw new Error(`Cannot verify Audacity endpoint owner PID ${owner.pid}; refusing access.`);
    // Elect one reclaimer inside the old directory. A delayed contender must
    // re-read the owner AFTER election; it may now be looking at a new live
    // session's directory. Never delete based on an earlier stale snapshot.
    const marker = join(directory, 'reclaim');
    try {
      writeFileSync(marker, randomUUID(), { flag: 'wx', mode: 0o600 });
    } catch {
      throw new Error('Audacity endpoint ownership is being reclaimed; retry after that session finishes.');
    }
    let retired = false;
    try {
      const current = JSON.parse(readFileSync(ownerFile, 'utf8')) as { pid: number; token: string };
      if (current.pid !== owner.pid || current.token !== owner.token)
        throw new Error('Audacity endpoint owner changed during reclamation; refusing access.');
      try {
        process.kill(current.pid, 0);
        throw new Error('Audacity endpoint owner became live; refusing access.');
      } catch (check) {
        if ((check as NodeJS.ErrnoException).code !== 'ESRCH') throw check;
      }
      retire(directory); // The election marker leaves together with the stale record.
      retired = true;
    } finally {
      if (!retired) rmSync(marker, { force: true });
    }
    acquirePipeOwnership(paths);
    return;
  }
  throw new Error(
    `Audacity endpoint is owned by MCP process ${owner.pid}. Close that session before attaching another client.`,
  );
}

/** Explicit sequential ownership handoff; callers must first await all I/O. */
export function releasePipeOwnership(paths?: PipePaths): void {
  for (const [id, owner] of held) {
    if (paths && id !== key(paths)) continue;
    try {
      const actual = JSON.parse(readFileSync(join(owner.directory, 'owner.json'), 'utf8')) as { token?: string };
      if (actual.token === owner.token) retire(owner.directory);
    } catch {
      /* Exit cleanup cannot establish ownership: leave unknown files. */
    }
    held.delete(id);
  }
}
process.once('exit', () => releasePipeOwnership());
