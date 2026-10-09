import { beforeEach, describe, expect, it, vi } from 'vitest';
import { z } from 'zod';
import { parseMacro, registerControlTools } from '../src/controls.js';
import type { Ops } from '../src/ops.js';
import { AudacityTimeout } from '../src/pipe.js';
import type { ToolRegistrar } from '../src/tools.js';

const fixtures = vi.hoisted(() => ({
  readFile: vi.fn(),
  readdir: vi.fn(),
  isRunning: vi.fn(),
  launch: vi.fn(),
  listWindows: vi.fn(),
}));
vi.mock('node:fs/promises', async (original) => ({
  ...(await original<typeof import('node:fs/promises')>()),
  readFile: fixtures.readFile,
  readdir: fixtures.readdir,
}));
vi.mock('../src/app.js', () => ({
  preflightExecutableOverride: vi.fn(),
  configPath: () => '/fixtures/audacity.cfg',
  recoveryEntries: () => [],
  discardStaleRecovery: vi.fn(),
  isRunning: fixtures.isRunning,
  launch: fixtures.launch,
  listWindows: fixtures.listWindows,
}));

function controls() {
  const ops = {
    pipe: { needsRecovery: true, reconnect: vi.fn(async () => ({ ok: true, body: '[]', status: 'OK' })) },
    unknownApplication: vi.fn(),
    freshApplication: vi.fn(),
    tracks: vi.fn(async () => []),
    restoreImportPreferences: vi.fn(),
    run: vi.fn(async (_command: string, _params?: Record<string, unknown>) => ''),
    command: vi.fn(async (_command: string, _params?: Record<string, unknown>) => ''),
    info: vi.fn(async () => ({ Start: 0, End: 1 })),
    resolveSelection: vi.fn(async () => ({ Mode: 'Set', Track: 0, TrackCount: 1, Start: 0, End: 1 })),
  };
  const handlers = new Map<string, (args: unknown) => Promise<unknown>>();
  const register: ToolRegistrar = (name, _description, shape, handler) => {
    handlers.set(name, (args) => handler(z.object(shape).strict().parse(args)));
  };
  registerControlTools(register, ops as unknown as Ops);
  return { ops, call: (name: string, args: unknown) => handlers.get(name)!(args) };
}

beforeEach(() => {
  vi.clearAllMocks();
  fixtures.readdir.mockReset().mockResolvedValue(['Example.txt']);
  fixtures.readFile.mockReset().mockResolvedValue('Amplify:Ratio=0.5\nFadeOut:');
  fixtures.isRunning.mockReset().mockResolvedValue(true);
  fixtures.launch.mockReset().mockResolvedValue({ started: true });
  fixtures.listWindows.mockReset().mockResolvedValue([]);
});

describe('saved macro edge cases', () => {
  it.each([
    'Amplify:Ratio=""',
    'Amplify:Ratio="  "',
    'FadeIn:Use_Preset="<Current Settings>" Use_Preset="<Current Settings>"',
  ])('rejects empty numeric and duplicated implicit preset fields %s', (source) => {
    expect(() => parseMacro(source)).toThrow();
  });

  it('lists an empty macro folder when Audacity has never saved a macro', async () => {
    fixtures.readdir.mockRejectedValueOnce(Object.assign(new Error('not found'), { code: 'ENOENT' }));
    const { call } = controls();
    expect(await call('audacity_macros', { action: 'list' })).toMatchObject({ macros: [] });
    expect(fixtures.readFile).not.toHaveBeenCalled();
  });

  it.each([{ name: 'Example' }, { dryRun: true }, { outputTo: 'out.wav' }])(
    'rejects ignored list fields before reading files %#',
    async (fields) => {
      const { call } = controls();
      await expect(call('audacity_macros', { action: 'list', ...fields })).rejects.toThrow('list takes no');
      expect(fixtures.readdir).not.toHaveBeenCalled();
    },
  );

  it('reports the failing command/count while retaining the original timeout class', async () => {
    const { call, ops } = controls();
    const failure = new AudacityTimeout('native reply unavailable');
    ops.command.mockImplementation(async (command: string) => {
      if (command === 'FadeOut') throw failure;
      return '';
    });
    await expect(call('audacity_macros', { action: 'apply', name: 'Example' })).rejects.toBe(failure);
    expect(failure.message).toContain('macro stopped at FadeOut after 1 completed steps: native reply unavailable');
    expect(failure).toBeInstanceOf(AudacityTimeout);
    expect(ops.command).toHaveBeenCalledTimes(2);
  });

  it('refuses a later silent regular-label command before an earlier macro edit', async () => {
    fixtures.readFile.mockResolvedValueOnce(
      'Amplify:Ratio=0.5\nRegularIntervalLabels:MODE=Number TOTALNUM=2 REGION=0 VERBOSE=None',
    );
    const { call, ops } = controls();
    await expect(call('audacity_macros', { action: 'apply', name: 'Example' })).rejects.toThrow('unsafe');
    expect(ops.command).not.toHaveBeenCalled();
    expect(ops.run).not.toHaveBeenCalled();
  });
});

describe('transport preflight', () => {
  it('does not stop native transport when the requested target/range fails preflight', async () => {
    const { call, ops } = controls();
    ops.resolveSelection.mockRejectedValueOnce(new Error('track does not exist'));
    await expect(call('audacity_transport', { action: 'play', track: 9 })).rejects.toThrow('track does not exist');
    expect(ops.run).not.toHaveBeenCalled();
  });

  it('does not stop or play a cursor-only selection', async () => {
    const { call, ops } = controls();
    ops.resolveSelection.mockResolvedValueOnce({ Mode: 'Set', Track: 0, TrackCount: 1, Start: 1, End: 1 });
    await expect(call('audacity_transport', { action: 'play', start: 1, end: 1 })).rejects.toThrow('positive-duration');
    expect(ops.run).not.toHaveBeenCalled();
  });

  it('uses the already-resolved positive range after stopping transport', async () => {
    const { call, ops } = controls();
    await call('audacity_transport', { action: 'play' });
    expect(ops.run.mock.calls).toEqual([
      ['Stop'],
      ['Select', { Mode: 'Set', Track: 0, TrackCount: 1, Start: 0, End: 1 }],
      ['Play'],
    ]);
    expect(ops.resolveSelection).toHaveBeenCalledExactlyOnceWith({
      start: undefined,
      end: undefined,
      track: undefined,
    });
  });
});

describe('real reconnection requirement', () => {
  it('marks application state unknown and restores pending guards only after a successful probe', async () => {
    const { call, ops } = controls();
    await call('audacity_recover', {});
    expect(ops.unknownApplication).toHaveBeenCalledOnce();
    expect(ops.pipe.reconnect).toHaveBeenCalledOnce();
    expect(ops.pipe.reconnect.mock.invocationCallOrder[0]).toBeLessThan(ops.tracks.mock.invocationCallOrder[0]!);
    expect(ops.pipe.reconnect.mock.invocationCallOrder[0]).toBeLessThan(
      ops.restoreImportPreferences.mock.invocationCallOrder[0]!,
    );
  });

  it('preserves a failed native probe and never restores import preferences through it', async () => {
    const { call, ops } = controls();
    ops.pipe.reconnect.mockResolvedValueOnce({ ok: false, body: 'Native reconnection rejected.', status: 'Failed!' });
    await expect(call('audacity_recover', {})).rejects.toThrow('Native reconnection rejected.');
    expect(ops.tracks).not.toHaveBeenCalled();
    expect(ops.restoreImportPreferences).not.toHaveBeenCalled();
  });

  it('does not reset application state for inspection without reconnecting', async () => {
    const { call, ops } = controls();
    await call('audacity_recover', { reconnect: false });
    expect(ops.pipe.reconnect).not.toHaveBeenCalled();
    expect(ops.unknownApplication).not.toHaveBeenCalled();
    expect(ops.restoreImportPreferences).not.toHaveBeenCalled();
  });
});
