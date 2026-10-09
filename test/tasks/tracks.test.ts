import { describe, expect, it, vi } from 'vitest';
import type { TrackInfo } from '../../src/ops.js';
import { trackEdit } from '../../src/tasks.js';

vi.mock('../../src/source-rate.js', () => ({ measureSourceRate: vi.fn(async () => 48_000) }));

import { expectNoMutation, mockOps, wave } from '../helpers/task-fixture.js';

describe('track creation, mixing, removal and alignment', () => {
  it.each([
    ['add_mono', 'NewMonoTrack'],
    ['add_stereo', 'NewStereoTrack'],
    ['add_label', 'NewLabelTrack'],
  ])('creates and names a track with %s', async (action, command) => {
    const mocks = mockOps();
    mocks.run.mockImplementation(async () => {
      mocks.trackList.push(wave('New', 0, 0));
      return 'OK';
    });
    const result = await trackEdit(mocks.ops, { action, name: 'New track' });
    expect(mocks.run).toHaveBeenCalledExactlyOnceWith(command);
    expect(mocks.command.mock.calls).toEqual([
      ['SelectTracks', { Track: 1, TrackCount: 1, Mode: 'Set' }],
      ['SetTrack', { Name: 'New track' }],
    ]);
    expect(result).toMatchObject({ track: 1 });
  });

  it.each([
    ['remove', 'RemoveTracks'],
    ['mix', 'MixAndRender'],
    ['mix_new', 'MixAndRenderToNewTrack'],
    ['align_end_to_end', 'Align_EndToEnd'],
    ['align_together', 'Align_Together'],
    ['align_start_zero', 'Align_StartToZero'],
    ['align_start_cursor', 'Align_StartToSelStart'],
    ['align_start_end', 'Align_StartToSelEnd'],
    ['align_end_cursor', 'Align_EndToSelStart'],
    ['align_end_end', 'Align_EndToSelEnd'],
  ])('runs %s on the requested audio tracks and time range', async (action, command) => {
    const mocks = mockOps([wave('Voice'), wave('Bed')]);
    await trackEdit(mocks.ops, { action, track: 0, trackCount: 2, start: 3, end: 4 });
    expect(mocks.select).toHaveBeenCalledExactlyOnceWith({ track: 0, trackCount: 2, start: 3, end: 4 });
    expect(mocks.run).toHaveBeenCalledExactlyOnceWith(command, {}, 600_000);
  });

  it('allows removing a label track', async () => {
    const mocks = mockOps([{ name: 'Labels', kind: 'label', start: 0, end: 2 }]);
    await trackEdit(mocks.ops, { action: 'remove', track: 0 });
    expect(mocks.run.mock.calls[0]?.[0]).toBe('RemoveTracks');
  });

  it('removes an actual GetInfo label track without omitted extents becoming NaN', async () => {
    const label = { name: 'Labels', kind: 'label' } as TrackInfo;
    const mocks = mockOps([label]);
    await trackEdit(mocks.ops, { action: 'remove', track: 0 });
    expect(mocks.select).toHaveBeenCalledExactlyOnceWith({ track: 0, trackCount: 1, start: 0, end: 0 });
    expect(mocks.run).toHaveBeenCalledExactlyOnceWith('RemoveTracks', {}, 600_000);
  });

  it('removes mixed audio and extent-free label tracks with a finite selection', async () => {
    const label = { name: 'Labels', kind: 'label' } as TrackInfo;
    const mocks = mockOps([wave(), label]);
    await trackEdit(mocks.ops, { action: 'remove', track: 0, trackCount: 2 });
    expect(mocks.select).toHaveBeenCalledExactlyOnceWith({ track: 0, trackCount: 2, start: 0, end: 10 });
    expect(mocks.run).toHaveBeenCalledExactlyOnceWith('RemoveTracks', {}, 600_000);
  });

  it.each(['mix', 'align_together'])('refuses %s of label tracks before selection', async (action) => {
    const mocks = mockOps([{ name: 'Labels', kind: 'label', start: 0, end: 2 }]);
    await expect(trackEdit(mocks.ops, { action, track: 0 })).rejects.toThrow('require audio tracks');
    expectNoMutation(mocks);
  });
});
