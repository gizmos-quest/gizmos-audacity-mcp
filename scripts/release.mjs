import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { packedPackage } from './pack-result.ts';

const root = fileURLToPath(new URL('..', import.meta.url));
const stateFile = join(root, '.release/state.json');
const npmCli = process.env.npm_execpath;
const readJson = (path) => JSON.parse(readFileSync(join(root, path), 'utf8'));
const writeJson = (path, value) => writeFileSync(join(root, path), `${JSON.stringify(value, null, 2)}\n`);
function run(command, args, allowFailure = false) {
  const result = spawnSync(command, args, { cwd: root, encoding: 'utf8', windowsHide: true, timeout: 120_000 });
  if (!allowFailure) assert.equal(result.status, 0, result.stderr || result.error?.message || result.stdout);
  return result;
}
const git = (...args) => run('git', args).stdout.trim();
const bot = [
  '-c',
  'user.name=github-actions[bot]',
  '-c',
  'user.email=41898282+github-actions[bot]@users.noreply.github.com',
];
const upstream = 'gizmos-quest/gizmos-audacity-mcp';
const npm = (args, allowFailure = false) => {
  assert(npmCli, 'invoke this release script with npm run release:prepare or npm run release:publish');
  return run(process.execPath, [npmCli, ...args], allowFailure);
};

export function releaseVersion(current, level) {
  assert(/^(0|[1-9]\d*)\.(0|[1-9]\d*)\.(0|[1-9]\d*)$/.test(current), 'release requires stable semver');
  assert(['initial', 'patch', 'minor', 'major'].includes(level), 'invalid version level');
  const [major, minor, patch] = current.split('.').map(Number);
  assert([major, minor, patch].every(Number.isSafeInteger), 'version components must be safe integers');
  if (level === 'initial') return current;
  if (level === 'major') return `${major + 1}.0.0`;
  if (level === 'minor') return `${major}.${minor + 1}.0`;
  return `${major}.${minor}.${patch + 1}`;
}

export function releaseChangelog(source, version, date) {
  assert(/^## \[Unreleased\][ \t]*\r?$/m.test(source), 'CHANGELOG must have an Unreleased section');
  if (new RegExp(`^## \\[${version.replaceAll('.', '\\.')}\\]`, 'm').test(source)) return source;
  return source.replace(/^## \[Unreleased\][ \t]*\r?$/m, `## [Unreleased]\n\n## [${version}] - ${date}`);
}

export function releasePlan(current, level, dispatchDate) {
  assert(/^\d{4}-\d{2}-\d{2}$/.test(dispatchDate), 'dispatch commit date is required');
  return { version: releaseVersion(current, level), date: dispatchDate };
}

function hostedDispatch() {
  assert.equal(process.env.GITHUB_ACTIONS, 'true', 'releases run only through the hosted workflow');
  assert.equal(process.env.GITHUB_EVENT_NAME, 'workflow_dispatch');
  assert.equal(process.env.GITHUB_REF, 'refs/heads/main', 'dispatch the release workflow on main');
  assert.equal(process.env.GITHUB_REPOSITORY, upstream, `releases run only in ${upstream}, never in a fork`);
}

export function prepare() {
  hostedDispatch();
  assert.equal(git('status', '--porcelain'), '', 'release checkout must be clean');
  const base = process.env.GITHUB_SHA;
  assert(/^[a-f\d]{40}$/.test(base ?? ''), 'missing dispatch commit');
  git('fetch', 'origin', 'main', '--tags');
  const original = JSON.parse(git('show', `${base}:package.json`));
  const { version, date } = releasePlan(
    original.version,
    process.env.RELEASE_LEVEL,
    git('show', '-s', '--format=%cs', base),
  );
  const tag = `v${version}`;
  // Resume from the release commit on main, or from the tag an interrupted attempt
  // pushed for its published release before landing it on a main that had moved.
  const release =
    run('git', ['rev-parse', '--verify', '--quiet', `refs/tags/${tag}^{commit}`], true).stdout.trim() ||
    git('rev-parse', 'origin/main');
  const committed = release !== base || git('log', '-1', '--format=%s', base) === `chore(release): ${tag}`;
  if (release !== base) {
    assert.equal(
      git('log', '-1', '--format=%s', release),
      `chore(release): ${tag}`,
      'main moved; dispatch a new release',
    );
    assert.equal(git('rev-parse', `${release}^`), base, 'release must be the direct child of its dispatch commit');
    assert.equal(JSON.parse(git('show', `${release}:package.json`)).version, version);
  }
  git('checkout', '--detach', release);
  if (!committed) {
    npm(['version', version, '--no-git-tag-version', '--allow-same-version', '--ignore-scripts']);
    const manifest = readJson('server.json');
    manifest.version = version;
    for (const pack of manifest.packages) pack.version = version;
    writeJson('server.json', manifest);
    const changelog = readFileSync(join(root, 'CHANGELOG.md'), 'utf8');
    writeFileSync(join(root, 'CHANGELOG.md'), releaseChangelog(changelog, version, date));
  }
  mkdirSync(join(root, '.release'), { recursive: true });
  writeJson('.release/state.json', { base, version, date, tag, committed, name: original.name });
  console.log(`Prepared ${original.name}@${version}; existing release commit: ${committed}.`);
}

/** npm accepts a publication before the registry serves it: on 2026-10-11 a new version
 * answered E404 for one to five minutes. Poll for up to ten minutes before failing; a rerun
 * of the same dispatch then verifies the served tarball and lands the release. */
function servedIntegrity(state) {
  const pause = Number(process.env.RELEASE_REGISTRY_POLL_MS ?? 15_000);
  for (let attempt = 1; ; attempt++) {
    const view = npm(['view', `${state.name}@${state.version}`, 'dist.integrity', '--json'], true);
    if (view.status === 0) return JSON.parse(view.stdout);
    assert(/\bE404\b/.test(view.stderr), view.stderr || 'npm lookup failed');
    assert(
      attempt < 40,
      `npm accepted ${state.name}@${state.version} but does not serve it yet; rerun this dispatch to land it`,
    );
    Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, pause);
  }
}

/** Main must contain the published release commit. A push to main after the pre-publish
 * check cannot be undone: merge the tagged release commit into the newer main instead. */
function land(commit, state) {
  if (run('git', ['push', 'origin', `${commit}:refs/heads/main`], true).status === 0) return;
  git('fetch', 'origin', 'main');
  if (run('git', ['merge-base', '--is-ancestor', commit, 'origin/main'], true).status === 0) return;
  const forward = run('git', ['merge-base', '--is-ancestor', state.base, 'origin/main'], true).status === 0;
  assert(forward, `main no longer contains ${state.base}; merge ${state.tag} into main by hand, then rerun`);
  git('checkout', '--detach', 'origin/main');
  git(...bot, 'merge', '--no-ff', '-m', `chore(release): merge ${state.tag}`, commit);
  git('push', 'origin', 'HEAD:main');
}

export function publish() {
  hostedDispatch();
  const state = JSON.parse(readFileSync(stateFile, 'utf8'));
  const npmVersion = npm(['--version']).stdout.trim().split('.').map(Number);
  assert(
    npmVersion[0] > 11 || (npmVersion[0] === 11 && (npmVersion[1] > 5 || (npmVersion[1] === 5 && npmVersion[2] >= 1))),
    'trusted publishing requires npm >=11.5.1',
  );
  const packed = packedPackage(npm(['pack', '--json', '--ignore-scripts', '--pack-destination', '.release']).stdout);
  const published = npm(['view', `${state.name}@${state.version}`, 'dist.integrity', '--json'], true);
  if (published.status === 0)
    assert.equal(
      JSON.parse(published.stdout),
      packed.integrity,
      'the existing npm version differs from this release; refusing to overwrite or advance Git',
    );
  else {
    assert(/\bE404\b/.test(published.stderr), published.stderr || 'npm lookup failed');
    if (!state.committed) {
      // The gates ran for minutes: re-check main and the tag right before the irreversible step.
      git('fetch', 'origin', 'main', '--tags');
      assert.equal(git('rev-parse', 'origin/main'), state.base, 'main moved during the gates; dispatch a new release');
      const tagged = run('git', ['rev-parse', '--verify', '--quiet', `refs/tags/${state.tag}`], true);
      assert.notEqual(tagged.status, 0, `tag ${state.tag} appeared during the gates; inspect it before releasing`);
    }
    npm(['publish', join('.release', packed.filename), '--access', 'public', '--provenance']);
    assert.equal(servedIntegrity(state), packed.integrity);
  }
  // Registry publication is irreversible. Git changes happen only after npm verifies the exact tarball.
  if (!state.committed) {
    git('add', 'package.json', 'package-lock.json', 'server.json', 'CHANGELOG.md');
    git(...bot, 'commit', '--allow-empty', '-m', `chore(release): ${state.tag}`);
  }
  const commit = git('rev-parse', 'HEAD');
  const existingTag = run('git', ['rev-parse', '--verify', `refs/tags/${state.tag}^{commit}`], true);
  if (existingTag.status === 0)
    assert.equal(existingTag.stdout.trim(), commit, 'existing release tag points elsewhere');
  else git(...bot, 'tag', '-a', state.tag, '-m', state.tag);
  // The tag anchors the published snapshot first, so a rerun of this dispatch can resume
  // from it. An identical remote tag makes this a no-op; Git refuses a conflicting one.
  git('push', 'origin', `refs/tags/${state.tag}`);
  land(commit, state);
  const release = run('gh', ['release', 'view', state.tag, '--json', 'tagName'], true);
  if (release.status !== 0) {
    const source = readFileSync(join(root, 'CHANGELOG.md'), 'utf8');
    const escaped = state.version.replaceAll('.', '\\.');
    const notes = new RegExp(`^## \\[${escaped}\\][^\\n]*\\n([\\s\\S]*?)(?=^## |$(?![\\s\\S]))`, 'm')
      .exec(source)?.[1]
      ?.trim();
    assert(notes, 'release notes missing');
    writeFileSync(join(root, '.release/notes.md'), notes);
    run('gh', [
      'release',
      'create',
      state.tag,
      '--verify-tag',
      '--title',
      state.tag,
      '--notes-file',
      '.release/notes.md',
    ]);
  }
  console.log(`Published and verified ${state.name}@${state.version}; Git release ${state.tag} is complete.`);
}

if (process.argv[1] === fileURLToPath(import.meta.url)) {
  if (process.argv[2] === 'prepare') prepare();
  else if (process.argv[2] === 'publish') publish();
  else throw new Error('use prepare or publish through release.yml');
}
