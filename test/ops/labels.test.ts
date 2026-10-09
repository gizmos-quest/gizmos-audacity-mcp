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
