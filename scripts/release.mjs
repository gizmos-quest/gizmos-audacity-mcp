import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';

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
  const head = git('rev-parse', 'origin/main');
  let committed = false;
  if (head === base && git('log', '-1', '--format=%s', head) === `chore(release): ${tag}`) committed = true;
  if (head !== base) {
    assert.equal(git('log', '-1', '--format=%s', head), `chore(release): ${tag}`, 'main moved; dispatch a new release');
    assert.equal(git('rev-parse', `${head}^`), base, 'release must be the direct child of its dispatch commit');
    assert.equal(JSON.parse(git('show', `${head}:package.json`)).version, version);
    committed = true;
  }
  git('checkout', '--detach', head);
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

export function publish() {
  hostedDispatch();
  const state = JSON.parse(readFileSync(stateFile, 'utf8'));
  const npmVersion = npm(['--version']).stdout.trim().split('.').map(Number);
  assert(
    npmVersion[0] > 11 || (npmVersion[0] === 11 && (npmVersion[1] > 5 || (npmVersion[1] === 5 && npmVersion[2] >= 1))),
    'trusted publishing requires npm >=11.5.1',
  );
  const [packed] = JSON.parse(npm(['pack', '--json', '--ignore-scripts', '--pack-destination', '.release']).stdout);
  const published = npm(['view', `${state.name}@${state.version}`, 'dist.integrity', '--json'], true);
  if (published.status === 0)
    assert.equal(
      JSON.parse(published.stdout),
      packed.integrity,
      'the existing npm version differs from this release; refusing to overwrite or advance Git',
    );
  else {
    assert(/\bE404\b/.test(published.stderr), published.stderr || 'npm lookup failed');
    npm(['publish', join('.release', packed.filename), '--access', 'public', '--provenance']);
    assert.equal(
      JSON.parse(npm(['view', `${state.name}@${state.version}`, 'dist.integrity', '--json']).stdout),
      packed.integrity,
    );
  }
  // Registry publication is irreversible. Git changes happen only after npm verifies the exact tarball.
  if (!state.committed) {
    git('fetch', 'origin', 'main');
    assert.equal(
      git('rev-parse', 'origin/main'),
      state.base,
      'main moved after publication; rerun after reviewing the published version',
    );
    git('add', 'package.json', 'package-lock.json', 'server.json', 'CHANGELOG.md');
    git(
      '-c',
      'user.name=github-actions[bot]',
      '-c',
      'user.email=41898282+github-actions[bot]@users.noreply.github.com',
      'commit',
      '--allow-empty',
      '-m',
      `chore(release): ${state.tag}`,
    );
    git('push', 'origin', 'HEAD:main');
  }
  const commit = git('rev-parse', 'HEAD');
  const existingTag = run('git', ['rev-parse', '--verify', `refs/tags/${state.tag}^{commit}`], true);
  if (existingTag.status === 0)
    assert.equal(existingTag.stdout.trim(), commit, 'existing release tag points elsewhere');
  else {
    git(
      '-c',
      'user.name=github-actions[bot]',
      '-c',
      'user.email=41898282+github-actions[bot]@users.noreply.github.com',
      'tag',
      '-a',
      state.tag,
      '-m',
      state.tag,
    );
  }
  // A prior attempt can stop after creating a local tag but before pushing it.
  // An identical remote tag makes this a no-op; Git refuses a conflicting remote tag.
  git('push', 'origin', `refs/tags/${state.tag}`);
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
