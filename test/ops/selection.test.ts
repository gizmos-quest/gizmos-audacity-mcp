import { describe, expect, it } from 'vitest';
import { Ops, type TrackInfo } from '../../src/ops.js';
import { AudacityPipe, type PipeReply } from '../../src/pipe.js';

type LabelTuple = [number, number, string];
type LabelTrack = [number, LabelTuple[]];

/** A stateful fixture catches flat-index mistakes across real label-track ordering. */
function project(
  tracks: TrackInfo[],
  initialLabels: LabelTrack[] = [],
  initialClips: { track: number; start: number; end: number }[] = [],
) {
  const calls: string[] = [];
  const labelTracks = structuredClone(initialLabels);
  const clips = structuredClone(initialClips);
  let selection = { track: 0, start: 0, end: 0 };
  let failure: { id: string; text: string } | undefined;
  const pipe = new AudacityPipe(
    { to: 'fixture.to', from: 'fixture.from' },
    100,
    async (_paths, command): Promise<PipeReply> => {
      calls.push(command);
      const id = command.slice(0, command.indexOf(':'));
      const parameters: Record<string, string> = {};
      const token = /([A-Za-z_][A-Za-z0-9_-]*)=(?:"([^"]*)"|([^\s]+))/g;
      for (const match of command.matchAll(token)) parameters[match[1]!] = match[2] ?? match[3]!;
      if (failure?.id === id) return { ok: false, body: failure.text, status: 'Failed!' };
      let body = '';
      if (id === 'GetInfo') {
        if (parameters.Type === 'Tracks') body = JSON.stringify(tracks);
        else if (parameters.Type === 'Labels') body = JSON.stringify(labelTracks);
        else if (parameters.Type === 'Clips') body = JSON.stringify(clips);
      } else if (id === 'NewLabelTrack') {
        const index = tracks.length;
        tracks.push({ name: 'Label Track', kind: 'label', start: 0, end: 0 });
        labelTracks.push([index, []]);
      } else if (id === 'SetTrack') {
        // Native SetTrack visits the current track selection; unknown Track
        // parameters must never make this fixture mask selection mistakes.
        tracks[selection.track]!.name = parameters.Name!;
      } else if (id === 'SelectTracks') {
        selection.track = Number(parameters.Track);
      } else if (id === 'Select') {
        selection = { track: Number(parameters.Track), start: Number(parameters.Start), end: Number(parameters.End) };
      } else if (id === 'RemoveTracks') {
        tracks.splice(selection.track, 1);
        for (let i = labelTracks.length - 1; i >= 0; i--) {
          const labelTrack = labelTracks[i]!;
          if (labelTrack[0] === selection.track) labelTracks.splice(i, 1);
          else if (labelTrack[0] > selection.track) labelTrack[0]--;
        }
        for (let i = clips.length - 1; i >= 0; i--) {
          const clip = clips[i]!;
          if (clip.track === selection.track) clips.splice(i, 1);
          else if (clip.track > selection.track) clip.track--;
        }
      } else if (id === 'SetClip') {
        // Audacity includes both clip boundaries when applying this command.
        const matches = clips.filter(
          (clip) =>
            clip.track === selection.track && clip.start <= Number(parameters.At) && Number(parameters.At) <= clip.end,
        );
        for (const clip of matches) {
          const duration = clip.end - clip.start;
          clip.start = Number(parameters.Start);
          clip.end = clip.start + duration;
        }
      } else if (id === 'AddLabel') {
        const labels = labelTracks.find(([index]) => index === selection.track)![1];
        const before = labels.findIndex(([start]) => start >= selection.start);
        // Tied labels can precede existing ones, so insertion cannot assume an append index.
        labels.splice(before < 0 ? labels.length : before, 0, [selection.start, selection.end, '']);
      } else if (id === 'SetLabel') {
        const flat = labelTracks.flatMap(([, labels]) => labels);
        const label = flat[Number(parameters.Label)]!;
        label[0] = Number(parameters.Start);
        label[1] = Number(parameters.End);
        label[2] = parameters.Text!;
      }
      return { ok: true, body, status: 'OK' };
    },
  );
  return {
    ops: new Ops(pipe),
    tracks,
    labelTracks,
    clips,
    calls,
    fail: (id: string, text: string) => {
      failure = { id, text };
    },
  };
}

const wave = (name: string, start = 0, end = 10): TrackInfo => ({ name, kind: 'wave', start, end });
const label = (name: string): TrackInfo => ({ name, kind: 'label', start: 0, end: 0 });
const edits = (calls: string[]) => calls.filter((command) => !command.startsWith('GetInfo:'));

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
