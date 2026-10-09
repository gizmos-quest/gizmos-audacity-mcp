import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const mocks = vi.hoisted(() => ({ run: vi.fn(), read: vi.fn(), write: vi.fn() }));
vi.mock('node:child_process', () => ({ spawnSync: mocks.run }));
vi.mock('node:fs', () => ({ readFileSync: mocks.read, writeFileSync: mocks.write, mkdirSync: vi.fn() }));

const base = 'a'.repeat(40);
const commit = 'b'.repeat(40);
beforeEach(() => {
  vi.resetModules();
  vi.clearAllMocks();
  vi.stubEnv('GITHUB_ACTIONS', 'true');
  vi.stubEnv('GITHUB_EVENT_NAME', 'workflow_dispatch');
  vi.stubEnv('GITHUB_REF', 'refs/heads/main');
  vi.stubEnv('npm_execpath', 'npm-cli-fixture.js');
});
afterEach(() => vi.unstubAllEnvs());

async function publicationFixture(
  options: {
    published?: boolean;
    committed?: boolean;
    integrity?: string;
    localTag?: boolean;
    failPush?: boolean;
    conflictTag?: boolean;
  } = {},
) {
  let published = options.published ?? false;
  let committed = options.committed ?? false;
  const commands: string[] = [];
  mocks.read.mockImplementation((file: string) =>
    file.endsWith('state.json')
      ? JSON.stringify({
          base,
          version: '0.1.0',
          tag: 'v0.1.0',
          committed,
          name: '@example/audio-mcp',
        })
      : '# Changelog\n\n## [Unreleased]\n\n## [0.1.0] - 2026-10-09\n\n- Audio tools.\n',
  );
  mocks.run.mockImplementation((command: string, args: string[]) => {
    const tool = command === process.execPath ? 'npm' : command;
    const actual = tool === 'npm' ? args.slice(1) : args;
    commands.push(`${tool} ${actual.join(' ')}`);
    if (tool === 'npm') {
      if (actual[0] === '--version') return { status: 0, stdout: '11.19.1\n' };
      if (actual[0] === 'pack')
        return { status: 0, stdout: JSON.stringify([{ filename: 'fixture.tgz', integrity: 'sha512-neutral' }]) };
      if (actual[0] === 'view')
        return published
          ? { status: 0, stdout: JSON.stringify(options.integrity ?? 'sha512-neutral') }
          : { status: 1, stderr: 'npm error E404' };
      if (actual[0] === 'publish') published = true;
    }
    if (tool === 'git') {
      if (actual.includes('commit')) committed = true;
      if (actual[0] === 'rev-parse' && actual[1] === 'origin/main') return { status: 0, stdout: base };
      if (actual[0] === 'rev-parse' && actual[1] === 'HEAD') return { status: 0, stdout: committed ? commit : base };
      if (actual.includes('--verify'))
        return options.localTag || options.committed
          ? { status: 0, stdout: options.conflictTag ? base : commit }
          : { status: 1 };
      if (actual[0] === 'push' && actual.includes('HEAD:main') && options.failPush)
        return { status: 1, stderr: 'push disconnected' };
    }
    if (tool === 'gh' && actual.includes('view')) return { status: options.committed ? 0 : 1, stderr: 'not found' };
    return { status: 0, stdout: '' };
  });
  // @ts-expect-error This maintenance CLI has no library declarations.
  const script = await import('../scripts/release.mjs');
  return { commands, publish: script.publish as () => void };
}

describe('release external side-effect ordering', () => {
  it('verifies publication before committing, tagging and creating a release', async () => {
    const { commands, publish } = await publicationFixture();
    publish();
    const publishIndex = commands.findIndex((command) => command.startsWith('npm publish '));
    const verifyIndex = commands.findIndex((command, index) => index > publishIndex && command.startsWith('npm view '));
    const commitIndex = commands.findIndex((command) => command.includes(' commit '));
    const pushCommitIndex = commands.indexOf('git push origin HEAD:main');
    const tagIndex = commands.findIndex((command) => command.includes(' tag -a '));
    const pushTagIndex = commands.indexOf('git push origin refs/tags/v0.1.0');
    const releaseIndex = commands.findIndex((command) => command.startsWith('gh release create '));
    expect(publishIndex).toBeGreaterThanOrEqual(0);
    expect(verifyIndex).toBeGreaterThan(publishIndex);
    expect(commitIndex).toBeGreaterThan(verifyIndex);
    expect(pushCommitIndex).toBeGreaterThan(commitIndex);
    expect(tagIndex).toBeGreaterThan(pushCommitIndex);
    expect(pushTagIndex).toBeGreaterThan(tagIndex);
    expect(releaseIndex).toBeGreaterThan(pushTagIndex);
    expect(commands[publishIndex]).toContain('--provenance');
  });
  it('resumes an interrupted published version without publishing it again', async () => {
    const { commands, publish } = await publicationFixture({ published: true });
    publish();
    expect(commands.some((command) => command.startsWith('npm publish '))).toBe(false);
    expect(commands.some((command) => command.includes(' commit '))).toBe(true);
  });
  it('does no further mutation when npm, commit, tag and release already exist', async () => {
    const { commands, publish } = await publicationFixture({ published: true, committed: true });
    publish();
    expect(commands.some((command) => /npm publish | commit | tag -a |gh release create /.test(command))).toBe(false);
    expect(commands).toContain('git push origin refs/tags/v0.1.0');
  });
  it('stops before Git or release writes when an existing registry version differs', async () => {
    const { commands, publish } = await publicationFixture({ published: true, integrity: 'sha512-other' });
    expect(publish).toThrow('existing npm version differs');
    expect(commands.some((command) => / commit |git push | tag -a |gh release create /.test(command))).toBe(false);
  });
  it('retains a verified registry version when the release commit push is interrupted', async () => {
    const { commands, publish } = await publicationFixture({ failPush: true });
    expect(publish).toThrow('push disconnected');
    expect(commands.some((command) => command.startsWith('npm publish '))).toBe(true);
    expect(commands.some((command) => command.includes(' tag -a '))).toBe(false);
    expect(commands.some((command) => command.startsWith('gh release create '))).toBe(false);
  });
  it('pushes a verified existing local tag after an interrupted tag push', async () => {
    const { commands, publish } = await publicationFixture({ published: true, committed: true, localTag: true });
    publish();
    expect(commands.some((command) => command.includes(' tag -a '))).toBe(false);
    expect(commands).toContain('git push origin refs/tags/v0.1.0');
  });
  it('refuses an existing local tag pointing at a different commit', async () => {
    const { commands, publish } = await publicationFixture({ published: true, committed: true, conflictTag: true });
    expect(publish).toThrow('existing release tag points elsewhere');
    expect(commands.some((command) => command.startsWith('git push '))).toBe(false);
  });
});

async function preparationFixture(options: { child?: boolean; changedMain?: boolean; wrongParent?: boolean } = {}) {
  vi.stubEnv('GITHUB_SHA', base);
  vi.stubEnv('RELEASE_LEVEL', 'patch');
  const commands: string[] = [];
  mocks.read.mockImplementation((file: string) =>
    file.endsWith('server.json')
      ? JSON.stringify({ version: '0.1.0', packages: [{ version: '0.1.0' }] })
      : '# Changelog\n\n## [Unreleased]\n\n- Audio tools.\n',
  );
  mocks.run.mockImplementation((command: string, args: string[]) => {
    const tool = command === process.execPath ? 'npm' : command;
    const actual = tool === 'npm' ? args.slice(1) : args;
    commands.push(`${tool} ${actual.join(' ')}`);
    if (tool === 'git') {
      if (actual[0] === 'show' && actual[1] === `${base}:package.json`)
        return {
          status: 0,
          stdout: JSON.stringify({ name: '@example/audio-mcp', version: '0.1.0' }),
        };
      if (actual[0] === 'show' && actual.includes('--format=%cs')) return { status: 0, stdout: '2026-10-09' };
      if (actual[0] === 'rev-parse' && actual[1] === 'origin/main')
        return { status: 0, stdout: options.child || options.changedMain ? commit : base };
      if (actual[0] === 'rev-parse' && actual[1] === `${commit}^`)
        return { status: 0, stdout: options.wrongParent ? 'c'.repeat(40) : base };
      if (actual[0] === 'log')
        return { status: 0, stdout: options.child ? 'chore(release): v0.1.1' : 'fix: another change' };
      if (actual[0] === 'show' && actual[1] === `${commit}:package.json`)
        return { status: 0, stdout: '{"version":"0.1.1"}' };
    }
    return { status: 0, stdout: '' };
  });
  // @ts-expect-error This maintenance CLI has no library declarations.
  const script = await import('../scripts/release.mjs');
  return { commands, prepare: script.prepare as () => void };
}

describe('release rerun preparation', () => {
  it('prepares one deterministic target from its immutable dispatch commit', async () => {
    const { prepare, commands } = await preparationFixture();
    prepare();
    const state = mocks.write.mock.calls.find(([file]) => file.endsWith('state.json'));
    expect(JSON.parse(state![1])).toMatchObject({ base, version: '0.1.1', date: '2026-10-09', committed: false });
    expect(commands.some((command) => command.startsWith('npm publish ') || command.startsWith('git push '))).toBe(
      false,
    );
  });
  it('recognizes the exact remote release child and skips version/changelog rewrites', async () => {
    const { prepare, commands } = await preparationFixture({ child: true });
    prepare();
    const state = mocks.write.mock.calls.find(([file]) => file.endsWith('state.json'));
    expect(JSON.parse(state![1])).toMatchObject({ version: '0.1.1', committed: true });
    expect(commands.some((command) => command.startsWith('npm version '))).toBe(false);
    expect(mocks.write.mock.calls.some(([file]) => file.endsWith('CHANGELOG.md'))).toBe(false);
  });
  it.each([{ changedMain: true }, { child: true, wrongParent: true }])(
    'refuses unrelated main changes %#',
    async (options) => {
      const { prepare, commands } = await preparationFixture(options);
      expect(prepare).toThrow(/main moved|direct child/);
      expect(mocks.write).not.toHaveBeenCalled();
      expect(commands.some((command) => command.startsWith('npm version '))).toBe(false);
    },
  );
});
