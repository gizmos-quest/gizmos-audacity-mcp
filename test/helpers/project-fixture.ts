import { Ops, type TrackInfo } from '../../src/ops.js';
import { AudacityPipe, type PipeReply } from '../../src/pipe.js';

export type LabelTuple = [number, number, string];
type LabelTrack = [number, LabelTuple[]];

/** A stateful fixture catches flat-index mistakes across real label-track ordering. */
export function project(
  tracks: TrackInfo[],
  initialLabels: LabelTrack[] = [],
  initialClips: { track: number; start: number; end: number }[] = [],
) {
  const calls: string[] = [];
  const labelTracks = structuredClone(initialLabels);
  const clips = structuredClone(initialClips);
  let selection = { track: 0, start: 0, end: 0 };
  let failure: { id: string; text: string; status: string } | undefined;
  let imported: TrackInfo[] | undefined;
  let labelDialogPreference: string | undefined;
  const pipe = new AudacityPipe(
    { to: 'fixture.to', from: 'fixture.from' },
    100,
    async (_paths, command): Promise<PipeReply> => {
      calls.push(command);
      const id = command.slice(0, command.indexOf(':'));
      const parameters: Record<string, string> = {};
      const token = /([A-Za-z_][A-Za-z0-9_-]*)=(?:"([^"]*)"|([^\s]+))/g;
      for (const match of command.matchAll(token)) parameters[match[1]!] = match[2] ?? match[3]!;
      if (failure?.id === id) return { ok: false, body: failure.text, status: failure.status };
      let body = '';
      if (id === 'GetPreference') {
        if (parameters.Name === '/GUI/DialogForNameNewLabel' && labelDialogPreference !== undefined)
          return { ok: true, body: labelDialogPreference, status: 'OK' };
        return { ok: false, body: '', status: 'Failed!' }; // The native absent-preference reply.
      } else if (id === 'GetInfo') {
        if (parameters.Type === 'Tracks') body = JSON.stringify(tracks);
        else if (parameters.Type === 'Labels') body = JSON.stringify(labelTracks);
        else if (parameters.Type === 'Clips') body = JSON.stringify(clips);
      } else if (id === 'Import2') {
        // Audacity names an imported track after its file; one container can add several tracks.
        const added = imported ?? [
          wave(
            parameters
              .Filename!.split('/')
              .pop()!
              .replace(/\.[^.]+$/, ''),
            0,
            1,
          ),
        ];
        imported = undefined;
        for (const track of added) {
          if (track.kind === 'wave') clips.push({ track: tracks.length, start: track.start, end: track.end });
          tracks.push({ ...track });
        }
      } else if (id === 'NewLabelTrack') {
        const index = tracks.length;
        tracks.push({ name: 'Label Track', kind: 'label', start: 0, end: 0 });
        labelTracks.push([index, []]);
      } else if (id === 'SetTrack') {
        // Native SetTrack visits the current track selection; unknown Track
        // parameters must never make this fixture mask selection mistakes.
        tracks[selection.track]!.name = parameters.Name!;
      } else if (id === 'SetTrackStatus' && parameters.Focused !== undefined) {
        for (const [index, track] of tracks.entries())
          track.focused = Number(parameters.Focused === '1' && index === selection.track);
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
        // Native AddLabel finds a label track at/after focus, independently of selection.
        const focused = Math.max(
          0,
          tracks.findIndex((track) => track.focused),
        );
        const labels = labelTracks.find(([index]) => index >= focused)![1];
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
    fail: (id: string, text: string, status = 'Failed!') => {
      failure = { id, text, status };
    },
    /** The tracks the next Import2 adds instead of one audio track named after the file. */
    importAs: (added: TrackInfo[]) => {
      imported = added;
    },
    labelDialog: (value: string | undefined) => {
      labelDialogPreference = value;
    },
  };
}

export const wave = (name: string, start = 0, end = 10): TrackInfo => ({ name, kind: 'wave', start, end });
export const label = (name: string): TrackInfo => ({ name, kind: 'label', start: 0, end: 0 });
export const edits = (calls: string[]) => calls.filter((command) => !/^Get(?:Info|Preference):/.test(command));
