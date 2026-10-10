import { describe, expect, it, vi } from 'vitest';
import { edit } from '../../src/tasks/editing.js';

vi.mock('../../src/source-rate.js', () => ({ measureSourceRate: vi.fn(async () => 48_000) }));

import { expectNoMutation, mockOps, wave } from '../helpers/task-fixture.js';

describe('selection editing', () => {
  it.each([
    ['split', 'Split'],
    ['split_new', 'SplitNew'],
    ['trim', 'Trim'],
    ['duplicate', 'Duplicate'],
    ['delete', 'Delete'],
    ['split_delete', 'SplitDelete'],
    ['cut', 'Cut'],
    ['split_cut', 'SplitCut'],
    ['copy', 'Copy'],
    ['silence', 'Silence'],
    ['join', 'Join'],
    ['disjoin', 'Disjoin'],
  ])('runs %s on the explicitly selected audio extent', async (action, command) => {
    const mocks = mockOps([wave('Voice'), wave('Bed', 0, 20)]);
    const result = await edit(mocks.ops, { action, track: 0, trackCount: 2 });
    expect(mocks.select).toHaveBeenCalledExactlyOnceWith({ track: 0, trackCount: 2, start: 0, end: 20 });
    expect(mocks.run).toHaveBeenCalledExactlyOnceWith(command, {}, 600_000);
    expect(result).toMatchObject({ action, track: 0, start: 0, end: 20, reply: 'Audacity reply' });
  });

  it('accepts an explicit cursor point for split', async () => {
    const mocks = mockOps();
    await edit(mocks.ops, { action: 'split', track: 0, start: 3, end: 3 });
    expect(mocks.select).toHaveBeenCalledExactlyOnceWith({ track: 0, trackCount: 1, start: 3, end: 3 });
  });

  it('does not offer paste, whose source is the system clipboard', async () => {
    const mocks = mockOps();
    await expect(edit(mocks.ops, { action: 'paste', track: 0, start: 3, end: 3 })).rejects.toThrow();
    expectNoMutation(mocks);
  });

  it.each(['trim', 'delete', 'copy', 'silence'])('refuses a cursor-only %s before selection', async (action) => {
    const mocks = mockOps();
    await expect(edit(mocks.ops, { action, track: 0, start: 3, end: 3 })).rejects.toThrow(
      'requires a finite non-empty time range',
    );
    expectNoMutation(mocks);
  });

  it('rejects a trackCount beyond the project before selection', async () => {
    const mocks = mockOps();
    await expect(edit(mocks.ops, { action: 'duplicate', track: 0, trackCount: 2 })).rejects.toThrow(
      'existing audio tracks only',
    );
    expectNoMutation(mocks);
  });

  it('rejects a multi-track edit containing labels before selection', async () => {
    const mocks = mockOps([wave(), { name: 'Labels', kind: 'label', start: 0, end: 5 }]);
    await expect(edit(mocks.ops, { action: 'delete', track: 0, trackCount: 2 })).rejects.toThrow(
      'existing audio tracks only',
    );
    expectNoMutation(mocks);
  });

  it('trims separate outside clips on every selected track without shifting audio or editing other tracks', async () => {
    const mocks = mockOps([wave('Other', 0, 100), wave('Voice', 0, 30), wave('Bed', 1, 40)]);
    let clips = [
      { track: 0, start: 0, end: 100 },
      { track: 1, start: 0, end: 2 },
      { track: 1, start: 3, end: 10 },
      { track: 1, start: 20, end: 30 },
      { track: 2, start: 1, end: 3 },
      { track: 2, start: 8, end: 14 },
      { track: 2, start: 30, end: 40 },
    ];
    mocks.info.mockImplementation(async () => clips);
    mocks.run.mockImplementation(async (id) => {
      const scope = mocks.select.mock.calls.at(-1)![0];
      const fromTrack = scope.track as number;
      const toTrack = fromTrack + scope.trackCount!;
      const from = scope.start!;
      const to = scope.end!;
      clips = clips.flatMap((clip) => {
        if (clip.track < fromTrack || clip.track >= toTrack || clip.end <= from || clip.start >= to) return [clip];
        if (id === 'Trim') return [{ ...clip, start: Math.max(clip.start, from), end: Math.min(clip.end, to) }];
        if (id !== 'SplitDelete') throw new Error(`unexpected test edit ${id}`);
        return [
          ...(clip.start < from ? [{ ...clip, end: from }] : []),
          ...(clip.end > to ? [{ ...clip, start: to }] : []),
        ];
      });
      return 'OK';
    });
    await edit(mocks.ops, { action: 'trim', track: 'Voice', trackCount: 2, start: 5, end: 12 });
    expect(clips).toEqual([
      { track: 0, start: 0, end: 100 },
      { track: 1, start: 5, end: 10 },
      { track: 2, start: 8, end: 12 },
    ]);
    expect(mocks.select.mock.calls.map(([scope]) => scope)).toEqual([
      { track: 1, trackCount: 2, start: 12, end: 40 },
      { track: 1, trackCount: 2, start: 0, end: 5 },
      { track: 1, trackCount: 2, start: 5, end: 12 },
    ]);
    expect(mocks.run.mock.calls.map(([id]) => id)).toEqual(['SplitDelete', 'SplitDelete', 'Trim']);
  });

  it.each([
    { start: 4, end: 6 },
    { start: 20, end: 30 },
  ])('refuses trimming an audio-free range before deleting separate clips %#', async (range) => {
    const mocks = mockOps([wave('Voice', 0, 10)]);
    mocks.info.mockResolvedValue([
      { track: 0, start: 0, end: 2 },
      { track: 0, start: 8, end: 10 },
      { track: 1, start: 0, end: 30 },
    ]);
    await expect(edit(mocks.ops, { action: 'trim', track: 0, ...range })).rejects.toThrow(
      'trim range must overlap audio',
    );
    expectNoMutation(mocks);
  });

  it('skips empty exterior deletes for a trim covering the complete track extent', async () => {
    const mocks = mockOps([wave('Voice', 2, 10)]);
    await edit(mocks.ops, { action: 'trim', track: 0, start: 0, end: 20 });
    expect(mocks.run).toHaveBeenCalledExactlyOnceWith('Trim', {}, 600_000);
    expect(mocks.select).toHaveBeenCalledExactlyOnceWith({ track: 0, trackCount: 1, start: 0, end: 20 });
  });

  it('preserves Audacity error text and stops a trim at its first failing delete', async () => {
    const mocks = mockOps([wave('Voice', 0, 10)]);
    mocks.run.mockRejectedValue(new Error('Audacity rejected: selection is locked'));
    await expect(edit(mocks.ops, { action: 'trim', track: 0, start: 2, end: 8 })).rejects.toThrow(
      'Audacity rejected: selection is locked',
    );
    expect(mocks.run).toHaveBeenCalledExactlyOnceWith('SplitDelete', {}, 600_000);
    expect(mocks.select).toHaveBeenCalledExactlyOnceWith({ track: 0, trackCount: 1, start: 8, end: 10 });
  });
});
