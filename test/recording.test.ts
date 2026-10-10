import { describe, expect, it, vi } from 'vitest';
import { z } from 'zod';
import { registerControlTools } from '../src/controls.js';
import { CommandFailed, type Ops } from '../src/ops.js';
import type { ToolRegistrar } from '../src/tools.js';

describe('transport state', () => {
  it('preserves recording mode through pause/resume and rejects ignored arguments', async () => {
    const handlers = new Map<string, (args: unknown) => Promise<unknown>>();
    const register: ToolRegistrar = (name, _description, shape, handler) => {
      handlers.set(name, (args) => handler(z.object(shape).strict().parse(args)));
    };
    const ops = {
      run: vi.fn(async () => ''),
      record: vi.fn(async () => ''),
      command: vi.fn(async () => '0'),
      info: vi.fn(async () => ({ Start: 0, End: 1 })),
      select: vi.fn(),
    } as unknown as Ops;
    registerControlTools(register, ops);
    const call = handlers.get('audacity_transport')!;
    await expect(call({ action: 'record', end: 2 })).rejects.toThrow('not end');
    expect(ops.run).not.toHaveBeenCalled();
    await call({ action: 'record' });
    expect(await call({ action: 'pause' })).toMatchObject({ state: 'paused' });
    expect(await call({ action: 'resume' })).toMatchObject({ state: 'recording' });
    await call({ action: 'stop' });
    await expect(call({ action: 'resume' })).rejects.toThrow('not paused');
  });
});

function recordingFixture(preferNew = '0', inputChannels = '2', targetChannels = 2, targetKind = 'wave') {
  const handlers = new Map<string, (args: unknown) => Promise<unknown>>();
  const register: ToolRegistrar = (name, _description, shape, handler) => {
    handlers.set(name, (args) => handler(z.object(shape).strict().parse(args)));
  };
  let selection = { Start: 0.5, End: 2 };
  const ops = {
    run: vi.fn(async (_command: string) => ''),
    record: vi.fn(async (_command: string) => ''),
    command: vi.fn(async (command: string, params: Record<string, unknown>) => {
      if (command === 'SelectTime') selection = { Start: Number(params.Start), End: Number(params.End) };
      return params.Name === '/AudioIO/RecordChannels' ? inputChannels : preferNew;
    }),
    trackIndex: vi.fn(async () => 1),
    tracks: vi.fn(async () => [
      { name: 'Unselected distractor', kind: 'wave', channels: 1, start: 0, end: 10 },
      { name: 'Target', kind: targetKind, channels: targetChannels, start: 0, end: 3 },
    ]),
    info: vi.fn(async () => selection),
    select: vi.fn(async (scope: { start: number; end: number; track: number }) => {
      selection = { Start: scope.start, End: scope.end };
      return {};
    }),
  };
  registerControlTools(register, ops as unknown as Ops);
  return { ops, call: handlers.get('audacity_transport')! };
}

describe('recording modal preflight', () => {
  it('requires an explicit append target before accessing native preferences or mutating selection', async () => {
    const { call, ops } = recordingFixture();
    await expect(call({ action: 'record', newTrack: false })).rejects.toThrow('explicit audio track');
    expect(ops.command).not.toHaveBeenCalled();
    expect(ops.run).not.toHaveBeenCalled();
    expect(ops.select).not.toHaveBeenCalled();
    expect(ops.record).not.toHaveBeenCalled();
  });
  it.each([
    ['2', 1],
    ['1', 2],
    ['4', 2],
    ['unknown', 2],
  ] as const)(
    'refuses input channels %s with target channels %i before mutation',
    async (inputChannels, targetChannels) => {
      const { call, ops } = recordingFixture('0', inputChannels, targetChannels);
      await expect(call({ action: 'record', newTrack: false, track: 1 })).rejects.toThrow(/channels/);
      expect(ops.run).not.toHaveBeenCalled();
      expect(ops.select).not.toHaveBeenCalled();
      expect(ops.record).not.toHaveBeenCalled();
    },
  );
  it('refuses a label recording target before querying preferences or mutating selection', async () => {
    const { call, ops } = recordingFixture('0', '2', 2, 'label');
    await expect(call({ action: 'record', newTrack: false, track: 1 })).rejects.toThrow('audio track');
    expect(ops.command).not.toHaveBeenCalled();
    expect(ops.run).not.toHaveBeenCalled();
    expect(ops.record).not.toHaveBeenCalled();
  });
  it.each([
    { newTrack: false, preferNew: '0', command: 'Record1stChoice' },
    { newTrack: false, preferNew: '1', command: 'Record2ndChoice' },
    { newTrack: true, preferNew: '0', command: 'Record2ndChoice' },
    { newTrack: true, preferNew: '1', command: 'Record1stChoice' },
  ])(
    'respects preference $preferNew for newTrack=$newTrack and replaces a time range with a cursor',
    async ({ newTrack, preferNew, command }) => {
      const { call, ops } = recordingFixture(preferNew);
      // A frozen clock keeps the position estimate exact on slow runners.
      vi.spyOn(performance, 'now').mockReturnValue(1_000);
      const result = (await call({ action: 'record', newTrack, track: 1, start: 1 })) as {
        state: string;
        positionSeconds: number;
      };
      vi.restoreAllMocks();
      expect(ops.select).toHaveBeenCalledWith({ track: 1, start: 1, end: 1 });
      expect(ops.record).toHaveBeenCalledExactlyOnceWith(command);
      expect(ops.run).toHaveBeenCalledExactlyOnceWith('Stop');
      expect(result.state).toBe('recording');
      expect(result.positionSeconds).toBe(newTrack ? 1 : 3);
    },
  );
  it('clears track selection before untargeted new recording to avoid mixed-rate selected tracks', async () => {
    const { call, ops } = recordingFixture();
    await call({ action: 'record' });
    expect(ops.run.mock.calls).toEqual([['Stop'], ['SelectNone']]);
    expect(ops.command).toHaveBeenCalledWith('SelectTime', { Start: 0.5, End: 0.5, RelativeTo: 'ProjectStart' });
    expect(ops.trackIndex).not.toHaveBeenCalled();
    expect(ops.select).not.toHaveBeenCalled();
    expect(ops.record).toHaveBeenCalledExactlyOnceWith('Record2ndChoice');
    expect(ops.run.mock.invocationCallOrder[1]).toBeLessThan(ops.record.mock.invocationCallOrder[0]!);
  });
  it('uses the native false default only for an absent preference with an empty Failed reply', async () => {
    const { call, ops } = recordingFixture();
    ops.command.mockRejectedValueOnce(new CommandFailed('GetPreference', { ok: false, body: '', status: 'Failed!' }));
    await call({ action: 'record' });
    expect(ops.record).toHaveBeenCalledExactlyOnceWith('Record2ndChoice');
  });
  it('preserves a native preference error and leaves selection untouched', async () => {
    const { call, ops } = recordingFixture();
    ops.command.mockRejectedValueOnce(
      new CommandFailed('GetPreference', {
        ok: false,
        body: 'The native preference is unavailable.',
        status: 'Failed!',
      }),
    );
    await expect(call({ action: 'record' })).rejects.toThrow('The native preference is unavailable.');
    expect(ops.run).not.toHaveBeenCalled();
    expect(ops.select).not.toHaveBeenCalled();
    expect(ops.record).not.toHaveBeenCalled();
  });
  it.each(['True', 'false', '2', ''])(
    'rejects malformed recording preference %j before any mutation',
    async (preference) => {
      const { call, ops } = recordingFixture(preference);
      await expect(call({ action: 'record' })).rejects.toThrow('expected 0 or 1');
      expect(ops.run).not.toHaveBeenCalled();
      expect(ops.select).not.toHaveBeenCalled();
      expect(ops.record).not.toHaveBeenCalled();
    },
  );
});
