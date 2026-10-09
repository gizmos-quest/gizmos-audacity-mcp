import { describe, expect, it } from 'vitest';
import { z } from 'zod';
import { registerLabelTools } from '../../src/labels.js';
import { Ops, type TrackInfo } from '../../src/ops.js';
import { AudacityPipe, type PipeReply } from '../../src/pipe.js';
import type { ToolRegistrar } from '../../src/tools.js';

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

describe('label deletion preflight', () => {
  const labelHandler = (ops: Ops) => {
    const handlers = new Map<string, (args: unknown) => Promise<unknown>>();
    const register: ToolRegistrar = (name, _description, shape, handler) => {
      handlers.set(name, (args) => handler(z.object(shape).strict().parse(args)));
    };
    registerLabelTools(register, ops);
    return handlers.get('audacity_labels')!;
  };

  it('refuses duplicate track names before deleting any track', async () => {
    const fixture = project(
      [label('Cues'), label('Cues')],
      [
        [0, [[0, 0, 'remove']]],
        [1, [[1, 1, 'keep']]],
      ],
    );
    await expect(labelHandler(fixture.ops)({ action: 'delete', index: 0 })).rejects.toThrow('unique');
    expect(edits(fixture.calls)).toEqual([]);
    expect(fixture.labelTracks).toEqual([
      [0, [[0, 0, 'remove']]],
      [1, [[1, 1, 'keep']]],
    ]);
  });

  it('refuses unrepresentable preserved label text before deleting any track', async () => {
    const fixture = project(
      [label('Cues')],
      [
        [
          0,
          [
            [0, 0, 'remove'],
            [1, 1, 'say "hello"'],
          ],
        ],
      ],
    );
    await expect(labelHandler(fixture.ops)({ action: 'delete', index: 0 })).rejects.toThrow('double quotes');
    expect(edits(fixture.calls)).toEqual([]);
    expect(fixture.labelTracks[0]?.[1]).toHaveLength(2);
  });

  it('refuses oversized preserved wire text before removing the label track', async () => {
    const fixture = project(
      [label('Cues')],
      [
        [
          0,
          [
            [0, 0, 'remove'],
            [1, 1, '音'.repeat(400)],
          ],
        ],
      ],
    );
    await expect(labelHandler(fixture.ops)({ action: 'delete', index: 0 })).rejects.toThrow('encoded bytes');
    expect(edits(fixture.calls)).toEqual([]);
    expect(fixture.labelTracks[0]?.[1]).toHaveLength(2);
  });

  it('reconstructs a native label track larger than the public insertion limit without losing remaining labels', async () => {
    const nativeLabels: LabelTuple[] = Array.from({ length: 502 }, (_, i) => [i, i + 1, `Native label ${i}`]);
    const fixture = project(
      [label('Cues'), wave('Audio'), label('Other')],
      [
        [0, nativeLabels],
        [2, [[0, 2, 'preserve other track']]],
      ],
    );
    const result = (await labelHandler(fixture.ops)({ action: 'delete', index: 0 })) as {
      track: number;
      text: string;
    }[];
    expect(fixture.tracks.map((track) => track.name)).toEqual(['Audio', 'Other', 'Cues']);
    expect(fixture.labelTracks).toEqual([
      [1, [[0, 2, 'preserve other track']]],
      [2, nativeLabels.slice(1)],
    ]);
    expect(result).toHaveLength(502);
    expect(result[0]).toMatchObject({ track: 1, text: 'preserve other track' });
    expect(result.at(-1)).toMatchObject({ track: 2, text: 'Native label 501' });
  });
});
