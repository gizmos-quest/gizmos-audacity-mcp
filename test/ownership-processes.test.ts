// Real processes against the ownership module: launchers with their own TEMP/TMPDIR,
// and a delayed contender interleaved with a reclaimer at file-system barriers.
import { type ChildProcess, spawn, spawnSync } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import { existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { ownershipDirectory } from '../src/pipe-ownership.js';

const moduleUrl = new URL('../src/pipe-ownership.ts', import.meta.url).href;
// The child pauses only at the barriers its role names; every file-system call still runs.
const child = `import fs from 'node:fs';
import { syncBuiltinESMExports } from 'node:module';
import { join } from 'node:path';
const env = process.env;
const signal = (name) => fs.writeFileSync(join(env.BARRIERS, name), '');
const wait = (name) => {
  const end = Date.now() + 20000;
  while (!fs.existsSync(join(env.BARRIERS, name))) {
    if (Date.now() > end) throw new Error('barrier timeout ' + name);
    Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, 10);
  }
};
if (env.PAUSE_AFTER_PROBE) {
  const kill = process.kill.bind(process);
  let first = true;
  process.kill = (pid, code) => {
    if (first) { first = false; signal('observed'); wait(env.PAUSE_AFTER_PROBE); }
    return kill(pid, code);
  };
}
if (env.PAUSE_AFTER_RETIRE) {
  const rename = fs.renameSync;
  fs.renameSync = (from, to) => {
    const result = rename(from, to);
    if (String(to).includes('.retired-')) { signal('retired'); wait(env.PAUSE_AFTER_RETIRE); }
    return result;
  };
  syncBuiltinESMExports();
}
const { acquirePipeOwnership, releasePipeOwnership } = await import(env.MODULE);
try {
  acquirePipeOwnership(JSON.parse(env.ENDPOINT));
  process.send({ owned: true });
  process.on('message', () => { releasePipeOwnership(); process.disconnect(); });
} catch (error) {
  process.send({ owned: false, error: error.message });
  process.disconnect();
}`;

const children: ChildProcess[] = [];
const scratch: string[] = [];
afterEach(() => {
  for (const process of children.splice(0)) if (process.connected) process.send('release', () => undefined);
  for (const directory of scratch.splice(0)) rmSync(directory, { recursive: true, force: true });
});
function start(endpoint: object, temp: string, env: Record<string, string> = {}) {
  const process = spawn(globalThis.process.execPath, ['--input-type=module', '-e', child], {
    env: {
      ...globalThis.process.env,
      ...env,
      TEMP: temp,
      TMP: temp,
      TMPDIR: temp,
      MODULE: moduleUrl,
      ENDPOINT: JSON.stringify(endpoint),
    },
    stdio: ['ignore', 'ignore', 'inherit', 'ipc'],
    windowsHide: true,
  });
  children.push(process);
  const result = new Promise<{ owned: boolean; error?: string }>((resolve, reject) => {
    process.once('message', (message) => resolve(message as { owned: boolean; error?: string }));
    process.once('exit', (code) => reject(new Error(`ownership child exited ${code} without a result`)));
  });
  const exited = new Promise<void>((resolve) => process.once('exit', () => resolve()));
  return { result, exited, release: () => process.send('release', () => undefined) };
}
function directories() {
  const temp = mkdtempSync(join(tmpdir(), 'gizmos-ownership-'));
  scratch.push(temp);
  const endpoint = { to: `ownership-${randomUUID()}.to`, from: `ownership-${randomUUID()}.from` };
  const lock = ownershipDirectory(endpoint);
  scratch.push(lock);
  return { temp, endpoint, lock };
}
function staleLock(lock: string): void {
  const exited = spawnSync(process.execPath, ['-e', 'process.stdout.write(String(process.pid))'], {
    encoding: 'utf8',
  });
  mkdirSync(lock);
  writeFileSync(join(lock, 'owner.json'), JSON.stringify({ pid: Number(exited.stdout), token: 'stale' }));
}

describe('endpoint ownership across processes', () => {
  it('keeps one owner when launchers set different temporary directories', async () => {
    const { temp, endpoint } = directories();
    const [first, second] = [join(temp, 'a'), join(temp, 'b')];
    mkdirSync(first);
    mkdirSync(second);
    const owner = start(endpoint, first);
    expect(await owner.result).toEqual({ owned: true });
    for (const temp of [first, second])
      expect(await start(endpoint, temp).result).toMatchObject({
        owned: false,
        error: expect.stringContaining('owned by'),
      });
    owner.release();
    await owner.exited;
    expect(await start(endpoint, second).result).toEqual({ owned: true });
  });

  it.each([
    ['while the stale lock is retired', 'retired', 'being reclaimed'],
    ['after the reclaimer owns the endpoint', 'owned', 'owner changed during reclamation'],
  ])('refuses a delayed contender %s and never leaves an incomplete lock', async (_, resumeAt, refusal) => {
    const { temp, endpoint, lock } = directories();
    const barriers = join(temp, 'barriers');
    mkdirSync(barriers);
    staleLock(lock);
    const late = start(endpoint, temp, { BARRIERS: barriers, PAUSE_AFTER_PROBE: resumeAt });
    while (!existsSync(join(barriers, 'observed'))) await new Promise((resolve) => setTimeout(resolve, 10));
    const reclaimer = start(endpoint, temp, {
      BARRIERS: barriers,
      ...(resumeAt === 'retired' ? { PAUSE_AFTER_RETIRE: 'late-done' } : {}),
    });
    if (resumeAt === 'owned') {
      expect(await reclaimer.result).toEqual({ owned: true });
      writeFileSync(join(barriers, 'owned'), '');
    }
    expect(await late.result).toMatchObject({ owned: false, error: expect.stringContaining(refusal) });
    writeFileSync(join(barriers, 'late-done'), '');
    expect(await reclaimer.result).toEqual({ owned: true });
    expect(readdirSync(lock)).toEqual(['owner.json']);
    expect(JSON.parse(readFileSync(join(lock, 'owner.json'), 'utf8')).token).not.toBe('stale');
    expect(await start(endpoint, temp).result).toMatchObject({
      owned: false,
      error: expect.stringContaining('owned by'),
    });
    reclaimer.release();
    await reclaimer.exited;
    expect(existsSync(lock)).toBe(false);
    expect(await start(endpoint, temp).result).toEqual({ owned: true });
  });
});
