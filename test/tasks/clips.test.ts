import { describe, expect, it, vi } from 'vitest';
import { clipSet } from '../../src/tasks.js';

vi.mock('../../src/source-rate.js', () => ({ measureSourceRate: vi.fn(async () => 48_000) }));

import { expectNoMutation, mockOps } from '../helpers/task-fixture.js';

describe('clip properties and destructive clip gain', () => {
  it('converts dB to a sample ratio and selects exactly the identified clip', async () => {
    const mocks = mockOps();
    mocks.info.mockResolvedValue([
      { track: 0, start: 2, end: 4, name: 'first' },
      { track: 0, start: 5, end: 10, name: 'second' },
    ]);
    const result = await clipSet(mocks.ops, { track: 0, at: 3, gainDb: -6, name: 'Renamed', color: 'Color2' });
    expect(mocks.select).toHaveBeenCalledExactlyOnceWith({ track: 0, start: 2, end: 4 });
    expect(mocks.command.mock.calls[0]![0]).toBe('Amplify');
    expect(mocks.command.mock.calls[0]![1]?.Ratio).toBeCloseTo(0.5011872336, 9);
    expect(mocks.command.mock.calls[1]).toEqual(['SetClip', { At: 3, Name: 'Renamed', Color: 'Color2' }]);
    expect(result).toMatchObject({ start: 2, end: 4, gainDbApplied: -6, name: 'Renamed' });
  });

  it('resolves a clip boundary to the clip starting there', async () => {
    const mocks = mockOps();
    mocks.info.mockResolvedValue([
      { track: 0, start: 2, end: 4 },
      { track: 0, start: 4, end: 10 },
    ]);
    await clipSet(mocks.ops, { track: 0, at: 4, gainDb: 0 });
    expect(mocks.select).toHaveBeenCalledExactlyOnceWith({ track: 0, start: 4, end: 10 });
    expect(mocks.command).toHaveBeenCalledExactlyOnceWith('Amplify', { Ratio: 1 }, 600_000);
  });

  it.each([{ name: 'Only second' }, { color: 'Color1' }, { gainDb: -6, name: 'Only second' }])(
    'rejects shared-boundary clip metadata before any gain or selection %#',
    async (properties) => {
      const mocks = mockOps();
      mocks.info.mockResolvedValue([
        { track: 0, start: 2, end: 4 },
        { track: 0, start: 4, end: 10 },
      ]);
      await expect(clipSet(mocks.ops, { track: 0, at: 4, ...properties })).rejects.toThrow('strictly inside one clip');
      expectNoMutation(mocks);
    },
  );

  it.each([
    { clips: [] },
    { clips: [{ track: 1, start: 0, end: 10 }] },
    {
      clips: [
        { track: 0, start: 2, end: 4 },
        { track: 0, start: 3, end: 5 },
      ],
    },
  ])('refuses missing or ambiguous clips without selecting or processing %#', async ({ clips }) => {
    const mocks = mockOps();
    mocks.info.mockResolvedValue(clips);
    await expect(clipSet(mocks.ops, { track: 0, at: 3, gainDb: 3 })).rejects.toThrow(/identifies [02] clips/);
    expectNoMutation(mocks);
  });

  it('only changes clip metadata when gain is omitted', async () => {
    const mocks = mockOps();
    mocks.info.mockResolvedValue([{ track: 0, start: 2, end: 10 }]);
    await clipSet(mocks.ops, { track: 0, at: 3, name: 'Scene' });
    expect(mocks.command).toHaveBeenCalledExactlyOnceWith('SetClip', { At: 3, Name: 'Scene', Color: undefined });
  });
});
