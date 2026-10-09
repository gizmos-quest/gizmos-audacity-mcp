import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const mocks = vi.hoisted(() => ({
  serve: vi.fn(async (factory: () => unknown) => factory()),
  build: vi.fn(() => ({})),
  doctor: vi.fn(async (_args: string[]) => undefined),
}));
vi.mock('@modelcontextprotocol/server/stdio', () => ({ serveStdio: mocks.serve }));
vi.mock('../src/server.js', () => ({ buildServer: mocks.build }));
vi.mock('../src/doctor.js', () => ({ runDoctor: mocks.doctor }));

const originalArgs = process.argv;
const originalExit = process.exitCode;
beforeEach(() => {
  vi.resetModules();
  vi.clearAllMocks();
  process.exitCode = undefined;
});
afterEach(() => {
  process.argv = originalArgs;
  process.exitCode = originalExit;
  vi.restoreAllMocks();
});

describe('shared executable entry point', () => {
  it('starts stdio without arguments', async () => {
    process.argv = ['node', 'main.js'];
    await import('../src/main.js');
    expect(mocks.serve).toHaveBeenCalledWith(expect.any(Function), { legacy: 'serve' });
    expect(mocks.build).toHaveBeenCalledOnce();
    expect(mocks.doctor).not.toHaveBeenCalled();
  });
  it('forwards doctor options without starting stdio', async () => {
    process.argv = ['node', 'main.js', 'doctor', '--fix'];
    await import('../src/main.js');
    expect(mocks.doctor).toHaveBeenCalledWith(['--fix']);
    expect(mocks.serve).not.toHaveBeenCalled();
  });
  it.each([new Error('diagnosis failed'), 'diagnosis failed'])(
    'reports diagnosis failure %s on stderr',
    async (error) => {
      mocks.doctor.mockRejectedValueOnce(error);
      const stderr = vi.spyOn(process.stderr, 'write').mockReturnValue(true);
      process.argv = ['node', 'main.js', 'doctor'];
      await import('../src/main.js');
      expect(stderr).toHaveBeenCalledWith('diagnosis failed\n');
      expect(process.exitCode).toBe(1);
    },
  );
  it('rejects an unknown subcommand with a useful usage line', async () => {
    const stderr = vi.spyOn(process.stderr, 'write').mockReturnValue(true);
    process.argv = ['node', 'main.js', 'unknown'];
    await import('../src/main.js');
    expect(stderr).toHaveBeenCalledWith(expect.stringContaining('Usage: gizmos-audacity-mcp'));
    expect(process.exitCode).toBe(1);
    expect(mocks.serve).not.toHaveBeenCalled();
  });
});
