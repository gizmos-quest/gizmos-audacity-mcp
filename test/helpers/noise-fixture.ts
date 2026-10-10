import { Ops, type TrackInfo } from '../../src/ops.js';
import { AudacityPipe, AudacityTimeout, type PipeReply } from '../../src/pipe.js';

/** A fake Audacity whose process identity, profile reply and recording reply tests can change. */
export function fixture(
  tracks: TrackInfo[] = [
    { name: 'Voice', kind: 'wave', start: 0, end: 10 },
    { name: 'Other', kind: 'wave', start: 0, end: 10 },
    { name: 'Labels', kind: 'label', start: 0, end: 10 },
  ],
) {
  const calls: string[] = [];
  const clips = tracks.flatMap((track, index) =>
    track.kind === 'wave' ? [{ track: index, start: track.start, end: track.end }] : [],
  );
  let rejection: string | undefined;
  let timeout = false;
  let identity: string | undefined = 'synthetic-process-1';
  let selection = { Start: 0, End: 10 };
  const pipe = new AudacityPipe(
    { to: 'fixture.to', from: 'fixture.from' },
    100,
    async (_paths, command): Promise<PipeReply> => {
      calls.push(command);
      if (command.startsWith('GetInfo:'))
        return {
          ok: true,
          status: 'OK',
          body: JSON.stringify(
            command.includes('Type=Clips')
              ? clips
              : command.includes('Type=Selection')
                ? selection
                : command.includes('Type=Menus')
                  ? [
                      { id: 'Undo', label: 'Undo Split' },
                      { id: 'Redo', label: 'Redo Split' },
                    ]
                  : tracks,
          ),
        };
      if (command.startsWith('Select:')) {
        const first = Number(/\bTrack=(\d+)/.exec(command)?.[1]);
        const count = Number(/\bTrackCount=(\d+)/.exec(command)?.[1]);
        for (const [index, track] of tracks.entries()) track.selected = Number(index >= first && index < first + count);
        selection = {
          Start: Number(/\bStart=([\d.]+)/.exec(command)?.[1]),
          End: Number(/\bEnd=([\d.]+)/.exec(command)?.[1]),
        };
      }
      if (command.startsWith('NoiseReduction:')) {
        if (timeout) throw new AudacityTimeout('fixture native profile reply was lost');
        if (rejection) return { ok: false, status: 'Failed!', body: rejection };
      }
      if (command.startsWith('Record') && timeout) throw new AudacityTimeout('fixture recording reply was lost');
      return { ok: true, status: 'OK', body: '' };
    },
  );
  return {
    ops: new Ops(pipe, async () => identity),
    pipe,
    calls,
    tracks,
    clips,
    changeIdentity: (value: string | undefined) => {
      identity = value;
    },
    rejectProfile: (text: string) => {
      rejection = text;
    },
    loseProfileReply: () => {
      timeout = true;
    },
    loseRecordingReply: () => {
      timeout = true;
    },
  };
}

export const mutations = (calls: string[]) => calls.filter((command) => !command.startsWith('GetInfo:'));
