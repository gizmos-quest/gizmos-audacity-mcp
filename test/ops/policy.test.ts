import { describe, expect, it } from 'vitest';
import { parseMacro } from '../../src/controls.js';
import { Ops, preflightCommand, type TrackInfo, validateProjectFile } from '../../src/ops.js';
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
const _label = (name: string): TrackInfo => ({ name, kind: 'label', start: 0, end: 0 });
const _edits = (calls: string[]) => calls.filter((command) => !command.startsWith('GetInfo:'));

describe('shared safety preflight', () => {
  it.each([
    ['ClickRemoval', { Threshold: 200, Width: 20 }],
    ['NoiseGate', { MODE: 'Analyze' }],
    ['RegularIntervalLabels', { VERBOSE: 'Details' }],
    ['RegularIntervalLabels', {}],
    ['RegularIntervalLabels', { MODE: 'Number', TOTALNUM: 2, REGION: 0, VERBOSE: 'None' }],
    ['SampleDataExport', { MESSAGES: 'None' }],
    ['SampleDataExport', { FILENAME: 'samples.txt', MESSAGES: 'Yes' }],
    ['Export2', { Filename: 'out.aup3' }],
    ['Import2', { Filename: 'definitely-missing-audio-fixture.wav' }],
  ])('rejects unsafe generic command %s before any pipe I/O', (command, params) => {
    const fixture = project([wave('Voice')]);
    expect(() => preflightCommand(command as string, params as Record<string, unknown>)).toThrow();
    expect(() => fixture.ops.command(command as string, params as Record<string, unknown>)).toThrow();
    expect(fixture.calls).toEqual([]);
  });

  it.each([
    'ClickRemoval:Threshold=200 Width=20',
    'NoiseGate:MODE=Analyze',
    'RegularIntervalLabels:VERBOSE=Details',
    'RegularIntervalLabels:MODE=Number TOTALNUM=2 REGION=0 VERBOSE=None',
    'SampleDataExport:MESSAGES=None',
    'Export2:Filename=out.aup3',
    'Import2:Filename=definitely-missing-audio-fixture.wav',
  ])('rejects unsafe later macro steps during planning: %s', (step) => {
    expect(() => parseMacro(`Amplify:Ratio=0.5\n${step}`)).toThrow();
  });

  it('validates special export parameters and the step limit', () => {
    expect(() => parseMacro('ExportMP3:Bad=1', 'out.mp3')).toThrow('no parameters');
    expect(() => parseMacro(Array.from({ length: 1001 }, () => 'ExportWav:').join('\n'), 'out.wav')).toThrow('1000');
    expect(() => parseMacro('ExportWav:', 'not-created-directory/out.wav')).toThrow('directory');
  });

  it('requires real .aup3 destinations and refuses overwrite before saving', () => {
    expect(() => validateProjectFile('backup.wav', true)).toThrow('.aup3');
    expect(() => validateProjectFile('not-created-directory/backup.aup3', true)).toThrow('directory');
    expect(() => validateProjectFile('definitely-missing-fixture.aup3', false)).toThrow('existing');
  });
});
