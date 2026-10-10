import { describe, expect, it } from 'vitest';
import { edits, type LabelTuple, label, project, wave } from '../helpers/project-fixture.js';

describe('flat label insertion', () => {
  it('preserves existing labels in every track while inserting earlier, middle, tied and later labels', async () => {
    const fixture = project(
      [wave('Audio'), label('Opening'), wave('Bed'), label('Cues'), label('Ending')],
      [
        [
          1,
          [
            [0, 0, 'opening'],
            [1, 2, 'opening range'],
          ],
        ],
        [
          3,
          [
            [2, 2, 'existing early'],
            [6, 6, 'existing tied'],
            [6, 6, ''],
          ],
        ],
        [4, [[9, 9, 'ending']]],
      ],
    );
    const count = await fixture.ops.setLabels(
      [
        { start: 8, text: 'late' },
        { start: 0.5, text: 'earlier' },
        { start: 6, text: 'tied' },
        { start: 3, end: 4, text: 'middle' },
      ],
      'Cues',
    );
    expect(count).toBe(4);
    expect(fixture.labelTracks[0]).toEqual([
      1,
      [
        [0, 0, 'opening'],
        [1, 2, 'opening range'],
      ],
    ]);
    expect(fixture.labelTracks[2]).toEqual([4, [[9, 9, 'ending']]]);
    const cues = fixture.labelTracks[1]![1];
    expect(cues).toHaveLength(7);
    for (const tuple of [
      [2, 2, 'existing early'],
      [6, 6, 'existing tied'],
      [6, 6, ''],
      [8, 8, 'late'],
      [0.5, 0.5, 'earlier'],
      [6, 6, 'tied'],
      [3, 4, 'middle'],
    ]) {
      expect(cues).toContainEqual(tuple);
    }
    expect(fixture.calls.filter((command) => command.startsWith('SetLabel:'))).toHaveLength(4);
    expect(fixture.calls.at(-1)).toBe('SelectNone:');
  });

  it('creates and targets a new label track after audio and existing labels', async () => {
    const fixture = project([wave('Audio'), label('Old')], [[1, [[0, 0, 'keep']]]]);
    await fixture.ops.setLabels([{ start: 1, end: 2, text: 'new cue' }], 'New Cues');
    expect(fixture.tracks[2]?.name).toBe('New Cues');
    expect(fixture.labelTracks).toEqual([
      [1, [[0, 0, 'keep']]],
      [2, [[1, 2, 'new cue']]],
    ]);
    expect(fixture.calls).toContain('SetLabel: Label=1 Text="new cue" Start=1 End=2 Selected=0');
  });

  it('preflights all label ranges before creating a track', async () => {
    const fixture = project([wave('Audio')]);
    await expect(
      fixture.ops.setLabels([
        { start: 0, text: 'valid' },
        { start: 3, end: 2, text: 'invalid' },
      ]),
    ).rejects.toThrow('end');
    expect(fixture.calls).toEqual([]);
  });

  it.each([
    { start: 1, text: 'bad"text' },
    { start: Infinity, text: 'bad' },
    { start: 1, end: NaN, text: 'bad' },
  ])('preflights every label before creating or changing a label track %#', async (invalid) => {
    const fixture = project([wave('Audio')]);
    await expect(fixture.ops.setLabels([{ start: 0, text: 'valid' }, invalid])).rejects.toThrow();
    expect(fixture.calls).toEqual([]);
  });

  it('refuses labels beyond the native SetLabel index range before any edit', async () => {
    // SetLabelCommand.cpp declares Label 0..10000 across all label tracks.
    const existing = Array.from({ length: 10_000 }, (_, i): LabelTuple => [i, i, `old ${i}`]);
    const fixture = project([label('Cues')], [[0, existing]]);
    await expect(
      fixture.ops.setLabels([
        { start: 1, text: 'one' },
        { start: 2, text: 'two' },
      ]),
    ).rejects.toThrow('at most 10001 labels');
    expect(edits(fixture.calls)).toEqual([]);
  });

  it('refuses an empty label-track name before creating a track', async () => {
    const fixture = project([wave('Audio')]);
    await expect(fixture.ops.setLabels([{ start: 0, text: 'valid' }], '')).rejects.toThrow();
    expect(fixture.calls).toEqual([]);
  });

  it('refuses duplicate destination track names without adding or changing labels', async () => {
    const fixture = project(
      [label('Cues'), label('Cues')],
      [
        [0, []],
        [1, []],
      ],
    );
    await expect(fixture.ops.setLabels([{ start: 0, text: 'new' }], 'Cues')).rejects.toThrow('multiple');
    expect(edits(fixture.calls)).toEqual([]);
  });
});
