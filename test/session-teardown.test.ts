import { beforeEach, describe, expect, it, vi } from 'vitest';

const fake = vi.hoisted(() => ({ running: vi.fn(), recovery: vi.fn() }));
vi.mock('../src/app-config.js', () => ({ recoveryEntries: fake.recovery }));
vi.mock('../src/app-process.js', () => ({ audacityExe: vi.fn(), audacityProcesses: vi.fn(), isRunning: fake.running }));

import { finishLiveSession } from './live/session.js';

function session(running: boolean) {
  let alive = running;
  fake.running.mockImplementation(async () => alive);
  fake.recovery.mockReturnValue([]);
  const calls: [string, unknown][] = [];
  const call = vi.fn(async (name: string, args: Record<string, unknown> = {}) => {
    calls.push([name, args]);
    if (name === 'audacity_quit') alive = false;
    if (name === 'audacity_launch') alive = true;
    return (name === 'audacity_dialogs' ? { windows: [] } : {}) as never;
  });
  return { call, calls, names: () => calls.map(([name]) => name) };
}
beforeEach(() => vi.resetAllMocks());

describe('live test teardown', () => {
  it('leaves the user project untouched when setup could not preserve it', async () => {
    const state = session(true);
    await expect(finishLiveSession(undefined, state.call)).rejects.toThrow('left open and untouched');
    expect(state.calls).toEqual([]);
  });

  it('discards only the disposable test project when Audacity was not running before', async () => {
    const state = session(true);
    await finishLiveSession({ running: false, visible: false, backup: null }, state.call);
    expect(state.names()).toEqual([
      'audacity_dialogs',
      'audacity_recover',
      'audacity_transport',
      'audacity_dialogs',
      'audacity_quit',
    ]);
  });

  it('reopens the preserved original project with its visibility', async () => {
    const state = session(true);
    await finishLiveSession({ running: true, visible: true, backup: 'before-live.aup3' }, state.call);
    expect(state.calls.slice(-3)).toEqual([
      ['audacity_quit', {}],
      ['audacity_launch', { visible: true }],
      ['audacity_project', { action: 'open', file: 'before-live.aup3' }],
    ]);
  });
});
