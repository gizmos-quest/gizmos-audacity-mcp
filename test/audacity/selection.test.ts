import { describe, expect, it } from 'vitest';
import { edits, label, project, wave } from '../helpers/project-fixture.js';

describe('explicit operation selection', () => {
  it('selects only the requested tracks and their own combined extent', async () => {
    const fixture = project([wave('Unselected', 0, 60), wave('First', 3, 7), wave('Second', 5, 12)]);
    await fixture.ops.select({ track: 'First', trackCount: 2 });
    expect(edits(fixture.calls)).toEqual(['Select: Mode=Set Track=1 TrackCount=2 Start=3 End=12']);
  });

  it('selects all tracks and an explicit full-project time range when no track is supplied', async () => {
    const fixture = project([wave('Voice', 2, 4), label('Cues'), wave('Bed', 0, 10)]);
    await fixture.ops.select({});
    expect(edits(fixture.calls)).toEqual(['Select: Mode=Set Track=0 TrackCount=3 Start=0 End=10']);
  });

  it.each([
    [{ start: 3 }, 'Select: Mode=Set Start=3 End=10 Track=0 TrackCount=2'],
    [{ end: 6 }, 'Select: Mode=Set Start=0 End=6 Track=0 TrackCount=2'],
  ])('fills an open time range from the project when no track is supplied: %j', async (scope, command) => {
    const fixture = project([wave('Voice', 2, 4), wave('Bed', 0, 10)]);
    await fixture.ops.select(scope);
    expect(edits(fixture.calls)).toEqual([command]);
  });

  it('refuses to select in an empty project', async () => {
    const fixture = project([]);
    await expect(fixture.ops.select({})).rejects.toThrow('no tracks to select');
    expect(edits(fixture.calls)).toEqual([]);
  });

  it('refuses a start after the end of the selected tracks', async () => {
    const fixture = project([wave('Voice', 2, 4)]);
    await expect(fixture.ops.select({ track: 0, start: 5 })).rejects.toThrow('within the selected tracks');
    expect(edits(fixture.calls)).toEqual([]);
  });

  it.each([{ trackCount: 2 }, { track: 0, start: 2, end: 1 }])(
    'refuses invalid scope before touching selection: %j',
    async (scope) => {
      const fixture = project([wave('Voice')]);
      await expect(fixture.ops.select(scope)).rejects.toThrow();
      expect(fixture.calls).toEqual([]);
    },
  );

  it('refuses ambiguous track names and counts outside the project without selection changes', async () => {
    const fixture = project([wave('Voice'), wave('Voice')]);
    await expect(fixture.ops.select({ track: 'Voice' })).rejects.toThrow('matches 2 tracks');
    await expect(fixture.ops.select({ track: 1, trackCount: 2 })).rejects.toThrow('exceeds');
    expect(edits(fixture.calls)).toEqual([]);
  });

  it('validates effect parameters before changing selection', async () => {
    const fixture = project([wave('Voice')]);
    await expect(fixture.ops.applyEffect('Amplify', { Unknown: 1 }, { track: 0 })).rejects.toThrow();
    expect(fixture.calls).toEqual([]);
  });

  it('resolves a transport selection without sending an edit', async () => {
    const fixture = project([wave('Voice', 2, 4), wave('Bed', 0, 10)]);
    expect(await fixture.ops.resolveSelection({ track: 'Voice', start: 3 })).toEqual({
      Mode: 'Set',
      Track: 0,
      TrackCount: 1,
      Start: 3,
      End: 4,
    });
    expect(edits(fixture.calls)).toEqual([]);
  });

  it.each([{ start: NaN }, { end: Infinity }, { track: 0, trackCount: 0 }, { track: 0, trackCount: 1.5 }])(
    'rejects malformed internal selections before pipe reads %#',
    async (scope) => {
      const fixture = project([wave('Voice')]);
      await expect(fixture.ops.select(scope)).rejects.toThrow();
      expect(fixture.calls).toEqual([]);
    },
  );

  it('validates every envelope point before clearing the existing curve', async () => {
    const fixture = project([wave('Voice')]);
    await expect(
      fixture.ops.setEnvelope(0, [
        { time: 0, value: 1 },
        { time: 2, value: NaN },
      ]),
    ).rejects.toThrow();
    expect(fixture.calls).toEqual([]);
  });

  it('rejects a later envelope value above the native maximum before clearing the curve', async () => {
    const fixture = project([wave('Voice')]);
    await expect(
      fixture.ops.setEnvelope(0, [
        { time: 0, value: 1 },
        { time: 2, value: 2.1 },
      ]),
    ).rejects.toThrow();
    expect(fixture.calls).toEqual([]);
  });

  it('refuses envelope operations on label tracks before changing selection', async () => {
    const fixture = project([label('Cues')], [[0, [[0, 1, 'keep']]]]);
    await expect(fixture.ops.setEnvelope(0, [{ time: 0, value: 1 }])).rejects.toThrow('audio track');
    expect(edits(fixture.calls)).toEqual([]);
  });

  it.each([
    { name: 'bad"name', start: 0 },
    { name: 'valid', start: Infinity },
    { name: 'valid', start: -1 },
  ])('validates import metadata before Import2 or track queries %#', async ({ name, start }) => {
    const fixture = project([wave('Voice')]);
    await expect(fixture.ops.importTrack('package.json', name, start)).rejects.toThrow();
    expect(fixture.calls).toEqual([]);
  });

  it.each([
    { at: 0, starts: [4, 1] },
    { at: 1, starts: [0, 4] },
  ])(
    'moves one clip at boundary $at without moving its neighbor or the selected distractor',
    async ({ at, starts }) => {
      const fixture = project(
        [wave('Target', 0, 2), wave('Distractor', 0, 2)],
        [],
        [
          { track: 0, start: 0, end: 1 },
          { track: 0, start: 1, end: 2 },
          { track: 1, start: 0, end: 2 },
        ],
      );
      await fixture.ops.select({ track: 'Distractor' });
      await fixture.ops.moveClip('Target', at, 4);
      expect(fixture.clips.filter((clip) => clip.track === 0).map((clip) => clip.start)).toEqual(starts);
      expect(fixture.clips.find((clip) => clip.track === 1)).toEqual({ track: 1, start: 0, end: 2 });
    },
  );

  it('refuses an ambiguous clip point before changing selection or audio', async () => {
    const clips = [
      { track: 0, start: 0, end: 1 },
      { track: 0, start: 0.5, end: 1.5 },
    ];
    const fixture = project([wave('Overlaps')], [], clips);
    await expect(fixture.ops.moveClip(0, 0.75, 4)).rejects.toThrow('identifies 2 clips');
    expect(edits(fixture.calls)).toEqual([]);
    expect(fixture.clips).toEqual(clips);
  });
});
