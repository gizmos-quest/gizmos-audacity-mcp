// The release script in disposable Git repositories: real git, a fake npm registry
// and a fake GitHub CLI. Covers prepare-then-lint and publication-success/main-divergence
// recovery, including a rerun of the same dispatch after an interrupted landing.
import type { SpawnSyncReturns } from 'node:child_process';
import { createHash } from 'node:crypto';
import { copyFileSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

type Spawn = (command: string, args: string[], options: { cwd?: string }) => SpawnSyncReturns<string>;
const hooks = vi.hoisted(() => ({ spawn: undefined as unknown as Spawn }));
vi.mock('node:child_process', async (original) => {
  const actual = await original<typeof import('node:child_process')>();
  return { ...actual, spawnSync: (...args: Parameters<Spawn>) => hooks.spawn(...args) };
});
const { spawnSync } = await vi.importActual<typeof import('node:child_process')>('node:child_process');

const project = fileURLToPath(new URL('..', import.meta.url));
const biome = join(project, 'node_modules', '@biomejs', 'biome', 'bin', 'biome');
const name = '@example/audio-mcp';
let root: string;
let registry: Map<string, string>;
let releases: string[];
let afterPublish: (() => void) | undefined;
let failMerge: boolean;

const run = (cwd: string, ...args: string[]) => {
  const result = spawnSync('git', ['-c', 'user.name=Test', '-c', 'user.email=test@example.invalid', ...args], {
    cwd,
    encoding: 'utf8',
  });
  if (result.status !== 0) throw new Error(`git ${args.join(' ')}: ${result.stderr}`);
  return result.stdout.trim();
};
const result = (status: number, stdout = '', stderr = '') =>
  ({ status, stdout, stderr }) as unknown as SpawnSyncReturns<string>;
const integrity = (cwd: string) =>
  `sha512-${createHash('sha256')
    .update(['package.json', 'server.json', 'CHANGELOG.md'].map((file) => readFileSync(join(cwd, file))).join('\n'))
    .digest('hex')}`;
function fakeNpm(cwd: string, args: string[]): SpawnSyncReturns<string> {
  if (args[0] === '--version') return result(0, '11.19.1\n');
  if (args[0] === 'version') {
    // npm rewrites both manifests in plain two-space JSON.
    for (const file of ['package.json', 'package-lock.json']) {
      const manifest = JSON.parse(readFileSync(join(cwd, file), 'utf8'));
      manifest.version = args[1];
      if (manifest.packages) manifest.packages[''].version = args[1];
      writeFileSync(join(cwd, file), `${JSON.stringify(manifest, null, 2)}\n`);
    }
    return result(0);
  }
  if (args[0] === 'pack') {
    writeFileSync(join(cwd, '.release', 'fixture.tgz'), 'tarball');
    return result(0, JSON.stringify([{ filename: 'fixture.tgz', integrity: integrity(cwd) }]));
  }
  if (args[0] === 'view') {
    const published = registry.get(args[1]!);
    return published ? result(0, JSON.stringify(published)) : result(1, '', 'npm error code E404');
  }
  if (args[0] === 'publish') {
    const version = JSON.parse(readFileSync(join(cwd, 'package.json'), 'utf8')).version;
    registry.set(`${name}@${version}`, integrity(cwd));
    afterPublish?.();
    return result(0);
  }
  throw new Error(`unexpected npm ${args.join(' ')}`);
}

beforeEach(() => {
  root = mkdtempSync(join(tmpdir(), 'gizmos-release-'));
  registry = new Map();
  releases = [];
  afterPublish = undefined;
  failMerge = false;
  hooks.spawn = (command, args, options) => {
    if (command === process.execPath && args[0] === 'fake-npm') return fakeNpm(options.cwd!, args.slice(1));
    if (command === 'gh') {
      if (args[1] === 'view') return result(releases.includes(args[2]!) ? 0 : 1, '', 'release not found');
      releases.push(args[2]!);
      return result(0);
    }
    if (command === 'git' && failMerge && args.includes('merge')) {
      failMerge = false;
      return result(1, '', 'merge interrupted');
    }
    return spawnSync(command, args, { ...options, encoding: 'utf8' });
  };
  for (const [key, value] of Object.entries({
    GITHUB_ACTIONS: 'true',
    GITHUB_EVENT_NAME: 'workflow_dispatch',
    GITHUB_REF: 'refs/heads/main',
    GITHUB_REPOSITORY: 'gizmos-quest/gizmos-audacity-mcp',
    RELEASE_LEVEL: 'patch',
    npm_execpath: 'fake-npm',
  }))
    vi.stubEnv(key, value);
});
afterEach(() => {
  vi.unstubAllEnvs();
  rmSync(root, { recursive: true, force: true });
});

/** An origin with the real server.json, release script and Biome settings at version 0.1.0. */
function repository(): string {
  const origin = join(root, 'origin.git');
  run(root, 'init', '--quiet', '--bare', '--initial-branch=main', origin);
  const seed = join(root, 'seed');
  run(root, 'clone', '--quiet', origin, seed);
  mkdirSync(join(seed, 'scripts'));
  for (const file of ['server.json', 'biome.json', join('scripts', 'release.mjs')])
    copyFileSync(join(project, file), join(seed, file));
  writeFileSync(join(seed, '.gitattributes'), '* text=auto eol=lf\n');
  writeFileSync(join(seed, 'package.json'), `${JSON.stringify({ name, version: '0.1.0' }, null, 2)}\n`);
  const lock = { name, version: '0.1.0', lockfileVersion: 3, packages: { '': { name, version: '0.1.0' } } };
  writeFileSync(join(seed, 'package-lock.json'), `${JSON.stringify(lock, null, 2)}\n`);
  writeFileSync(join(seed, 'CHANGELOG.md'), '# Changelog\n\n## [Unreleased]\n\n### Added\n\n- Audio tools.\n');
  run(seed, 'add', '.');
  run(seed, 'commit', '--quiet', '-m', 'feat: audio tools');
  run(seed, 'push', '--quiet', 'origin', 'HEAD:main');
  return run(seed, 'rev-parse', 'HEAD');
}
/** A fresh checkout of the dispatch commit, as the hosted job makes it. */
async function job(base: string, label: string) {
  const directory = join(root, label);
  run(root, 'clone', '--quiet', join(root, 'origin.git'), directory);
  run(directory, 'checkout', '--quiet', '--detach', base);
  vi.stubEnv('GITHUB_SHA', base);
  const script = await import(pathToFileURL(join(directory, 'scripts', 'release.mjs')).href);
  return { directory, prepare: script.prepare as () => void, publish: script.publish as () => void };
}
/** Another contributor pushes to main. */
function moveMain(): void {
  const other = join(root, `other-${releases.length}-${Math.random().toString(36).slice(2)}`);
  run(root, 'clone', '--quiet', join(root, 'origin.git'), other);
  writeFileSync(join(other, 'README.md'), '# Audio tools\n');
  run(other, 'add', 'README.md');
  run(other, 'commit', '--quiet', '-m', 'docs: readme');
  run(other, 'push', '--quiet', 'origin', 'HEAD:main');
}
const origin = (...args: string[]) => run(join(root, 'origin.git'), ...args);
const contains = (ancestor: string) =>
  spawnSync('git', ['merge-base', '--is-ancestor', ancestor, 'main'], { cwd: join(root, 'origin.git') }).status === 0;

// Dozens of real git processes per case: generous limits for slow hosted runners.
describe('release script in a disposable repository', () => {
  it('prepares files the following lint gate accepts and lands a normal release', async () => {
    const base = repository();
    const first = await job(base, 'job');
    first.prepare();
    const lint = spawnSync(process.execPath, [biome, 'ci', '--vcs-enabled=false', 'package.json', 'server.json'], {
      cwd: first.directory,
      encoding: 'utf8',
    });
    expect(lint.status, lint.stdout + lint.stderr).toBe(0);
    expect(JSON.parse(readFileSync(join(first.directory, 'server.json'), 'utf8')).version).toBe('0.1.1');
    first.publish();
    const release = origin('rev-parse', 'refs/tags/v0.1.1^{commit}');
    expect(origin('rev-parse', 'main')).toBe(release);
    expect(origin('rev-parse', `${release}^`)).toBe(base);
    expect([...registry.keys(), ...releases]).toEqual([`${name}@0.1.1`, 'v0.1.1']);
  }, 60_000);

  it('merges a release published just before main moved, then resumes an interrupted landing', async () => {
    const base = repository();
    const first = await job(base, 'job');
    first.prepare();
    afterPublish = moveMain;
    failMerge = true;
    expect(first.publish).toThrow('merge interrupted');
    const release = origin('rev-parse', 'refs/tags/v0.1.1^{commit}');
    expect(origin('rev-parse', `${release}^`)).toBe(base);
    expect(contains(release)).toBe(false);
    expect(releases).toEqual([]);
    // Rerun of the same dispatch: it resumes from the tag instead of refusing the moved main.
    afterPublish = undefined;
    const rerun = await job(base, 'rerun');
    rerun.prepare();
    rerun.publish();
    expect(contains(release)).toBe(true);
    expect(origin('log', '-1', '--format=%s', 'main')).toBe('chore(release): merge v0.1.1');
    expect([...registry.keys(), ...releases]).toEqual([`${name}@0.1.1`, 'v0.1.1']);
  }, 60_000);

  it('refuses before publication when main moved during the gates', async () => {
    const base = repository();
    const first = await job(base, 'job');
    first.prepare();
    moveMain();
    expect(first.publish).toThrow('main moved during the gates');
    expect(registry.size).toBe(0);
    expect(
      spawnSync('git', ['rev-parse', '--verify', '--quiet', 'v0.1.1'], { cwd: join(root, 'origin.git') }).status,
    ).toBe(1);
  }, 60_000);
});
