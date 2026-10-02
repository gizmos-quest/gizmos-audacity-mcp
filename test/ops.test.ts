import { describe, expect, it } from 'vitest';
import { z } from 'zod';
import { AudacityNeedsRecovery, AudacityPipe, AudacityUnavailable, type PipeReply } from '../src/pipe.js';
import { CommandFailed, Ops, preflightCommand, trackPanPercent, validateProjectFile, type TrackInfo } from '../src/ops.js';
import { parseMacro } from '../src/controls.js';
import { registerLabelTools } from '../src/labels.js';
import type { ToolRegistrar } from '../src/tools.js';

type LabelTuple = [number, number, string];
type LabelTrack = [number, LabelTuple[]];

/** A stateful fixture catches flat-index mistakes across real label-track ordering. */
function project(tracks: TrackInfo[], initialLabels: LabelTrack[] = [], initialClips: { track: number; start: number; end: number }[] = []) {
  const calls: string[] = [];
  const labelTracks = structuredClone(initialLabels);
  const clips = structuredClone(initialClips);
  let selection = { track: 0, start: 0, end: 0 };
  let failure: { id: string; text: string } | undefined;
  const pipe = new AudacityPipe({ to: 'fixture.to', from: 'fixture.from' }, 100,
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
      } else if (id === 'SetClip') {
        // Audacity includes both clip boundaries when applying this command.
        const matches = clips.filter((clip) => clip.track === selection.track && clip.start <= Number(parameters.At) && Number(parameters.At) <= clip.end);
        for (const clip of matches) {
          const duration = clip.end - clip.start;
          clip.start = Number(parameters.Start); clip.end = clip.start + duration;
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
    });
  return { ops: new Ops(pipe), tracks, labelTracks, clips, calls,
    fail: (id: string, text: string) => { failure = { id, text }; } };
}

const wave = (name: string, start = 0, end = 10): TrackInfo => ({ name, kind: 'wave', start, end });
const label = (name: string): TrackInfo => ({ name, kind: 'label', start: 0, end: 0 });
const edits = (calls: string[]) => calls.filter((command) => !command.startsWith('GetInfo:'));

describe('native pan units', () => {
  it.each([[-1, -100], [-0.4, -40], [0, 0], [0.25, 25], [1, 100]])('maps public pan %s to native percent %s', (pan, percent) => {
    expect(trackPanPercent(pan)).toBe(percent);
  });
  it.each([-1.01, 1.01, NaN, Infinity, -Infinity])('refuses invalid normalized pan %s', (pan) => {
    expect(() => trackPanPercent(pan)).toThrow('between -1 and 1');
  });
});

describe('explicit operation selection', () => {
  it('selects only the requested tracks and their own combined extent', async () => {
    const fixture = project([wave('Unselected', 0, 60), wave('First', 3, 7), wave('Second', 5, 12)]);
    await fixture.ops.select({ track: 'First', trackCount: 2 });
    expect(edits(fixture.calls)).toEqual(['Select: Mode=Set Track=1 TrackCount=2 Start=3 End=12']);
  });

  it('selects all tracks and an explicit full-project time range when no track is supplied', async () => {
    const fixture = project([wave('Voice', 2, 4), label('Cues'), wave('Bed', 0, 10)]);
    await fixture.ops.select({});
    expect(edits(fixture.calls)).toEqual(['Select: Track=0 TrackCount=3 Start=0 End=10 Mode=Set']);
  });

  it.each([{ trackCount: 2 }, { track: 0, start: 2, end: 1 }])('refuses invalid scope before touching selection: %j', async (scope) => {
    const fixture = project([wave('Voice')]);
    await expect(fixture.ops.select(scope)).rejects.toThrow();
    expect(fixture.calls).toEqual([]);
  });

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

  it.each([{ at: 0, starts: [4, 1] }, { at: 1, starts: [0, 4] }])('moves one clip at boundary $at without moving its neighbor or the selected distractor', async ({ at, starts }) => {
    const fixture = project([wave('Target', 0, 2), wave('Distractor', 0, 2)], [], [
      { track: 0, start: 0, end: 1 }, { track: 0, start: 1, end: 2 }, { track: 1, start: 0, end: 2 },
    ]);
    await fixture.ops.select({ track: 'Distractor' });
    await fixture.ops.moveClip('Target', at, 4);
    expect(fixture.clips.filter((clip) => clip.track === 0).map((clip) => clip.start)).toEqual(starts);
    expect(fixture.clips.find((clip) => clip.track === 1)).toEqual({ track: 1, start: 0, end: 2 });
  });

  it('refuses an ambiguous clip point before changing selection or audio', async () => {
    const clips = [{ track: 0, start: 0, end: 1 }, { track: 0, start: 0.5, end: 1.5 }];
    const fixture = project([wave('Overlaps')], [], clips);
    await expect(fixture.ops.moveClip(0, 0.75, 4)).rejects.toThrow('identifies 2 clips');
    expect(edits(fixture.calls)).toEqual([]); expect(fixture.clips).toEqual(clips);
  });
});

describe('flat label insertion', () => {
  it('preserves existing labels in every track while inserting earlier, middle, tied and later labels', async () => {
    const fixture = project([wave('Audio'), label('Opening'), wave('Bed'), label('Cues'), label('Ending')], [
      [1, [[0, 0, 'opening'], [1, 2, 'opening range']]],
      [3, [[2, 2, 'existing early'], [6, 6, 'existing tied'], [6, 6, '']]],
      [4, [[9, 9, 'ending']]],
    ]);
    const count = await fixture.ops.setLabels([
      { start: 8, text: 'late' }, { start: 0.5, text: 'earlier' },
      { start: 6, text: 'tied' }, { start: 3, end: 4, text: 'middle' },
    ], 'Cues');
    expect(count).toBe(4);
    expect(fixture.labelTracks[0]).toEqual([1, [[0, 0, 'opening'], [1, 2, 'opening range']]]);
    expect(fixture.labelTracks[2]).toEqual([4, [[9, 9, 'ending']]]);
    const cues = fixture.labelTracks[1]![1];
    expect(cues).toHaveLength(7);
    for (const tuple of [[2, 2, 'existing early'], [6, 6, 'existing tied'], [6, 6, ''],
      [8, 8, 'late'], [0.5, 0.5, 'earlier'], [6, 6, 'tied'], [3, 4, 'middle']]) {
      expect(cues).toContainEqual(tuple);
    }
    expect(fixture.calls.filter((command) => command.startsWith('SetLabel:'))).toHaveLength(4);
    expect(fixture.calls.at(-1)).toBe('SelectNone:');
  });

  it('creates and targets a new label track after audio and existing labels', async () => {
    const fixture = project([wave('Audio'), label('Old')], [[1, [[0, 0, 'keep']]]]);
    await fixture.ops.setLabels([{ start: 1, end: 2, text: 'new cue' }], 'New Cues');
    expect(fixture.tracks[2]?.name).toBe('New Cues');
    expect(fixture.labelTracks).toEqual([[1, [[0, 0, 'keep']]], [2, [[1, 2, 'new cue']]]]);
    expect(fixture.calls).toContain('SetLabel: Label=1 Text="new cue" Start=1 End=2 Selected=0');
  });

  it('preflights all label ranges before creating a track', async () => {
    const fixture = project([wave('Audio')]);
    await expect(fixture.ops.setLabels([{ start: 0, text: 'valid' }, { start: 3, end: 2, text: 'invalid' }])).rejects.toThrow('end');
    expect(fixture.calls).toEqual([]);
  });

  it('refuses duplicate destination track names without adding or changing labels', async () => {
    const fixture = project([label('Cues'), label('Cues')], [[0, []], [1, []]]);
    await expect(fixture.ops.setLabels([{ start: 0, text: 'new' }], 'Cues')).rejects.toThrow('multiple');
    expect(edits(fixture.calls)).toEqual([]);
  });
});

describe('export and Audacity failures', () => {
  it('clears label editing through an explicit time/track selection before export', async () => {
    const fixture = project([wave('Voice', 1, 3), label('Cues'), wave('Bed', 0, 5)]);
    await fixture.ops.exportMix('mix.wav', 1);
    expect(edits(fixture.calls)).toEqual([
      'Select: Start=0 End=5 Track=0 TrackCount=3 Mode=Set',
      'Export2: Filename=mix.wav NumChannels=1',
    ]);
    expect(fixture.calls).not.toContain('SelectAll:');
  });

  it('refuses unsupported export formats before reading or changing the project', async () => {
    const fixture = project([wave('Voice')]);
    await expect(fixture.ops.exportMix('mix.aup3')).rejects.toThrow('filename');
    expect(fixture.calls).toEqual([]);
  });

  it('refuses empty exports without changing the selection', async () => {
    const fixture = project([wave('Voice')]);
    await expect(fixture.ops.exportMix('mix.wav', 2, 3, 3)).rejects.toThrow('nothing to export');
    expect(edits(fixture.calls)).toEqual([]);
  });

  it('retains Audacity failure text and stops before export after a failed selection', async () => {
    const fixture = project([wave('Voice')]);
    fixture.fail('Select', 'Selection outside project bounds.');
    await expect(fixture.ops.exportMix('mix.wav')).rejects.toThrow('Selection outside project bounds.');
    expect(fixture.calls.some((command) => command.startsWith('Export2:'))).toBe(false);
  });

  it('reports command, full reply and Audacity error text on effect failure', async () => {
    const fixture = project([wave('Voice')]);
    fixture.fail('Amplify', 'Amplification would cause clipping.');
    let error: unknown;
    try { await fixture.ops.applyEffect('Amplify', { Ratio: 4 }, { track: 0 }); }
    catch (caught) { error = caught; }
    expect(error).toBeInstanceOf(CommandFailed);
    expect(error).toMatchObject({ command: 'Amplify: Ratio=4', reply: { body: 'Amplification would cause clipping.', status: 'Failed!', ok: false } });
    expect((error as Error).message).toContain('Amplification would cause clipping.');
  });
});

describe('shared safety preflight', () => {
  it.each([
    ['ClickRemoval', { Threshold: 200, Width: 20 }],
    ['NoiseGate', { MODE: 'Analyze' }],
    ['RegularIntervalLabels', { VERBOSE: 'Details' }],
    ['RegularIntervalLabels', {}],
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
    'NoiseGate:MODE=Analyze', 'RegularIntervalLabels:VERBOSE=Details',
    'SampleDataExport:MESSAGES=None', 'Export2:Filename=out.aup3',
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
    const fixture = project([label('Cues'), label('Cues')], [[0, [[0, 0, 'remove']]], [1, [[1, 1, 'keep']]]]);
    await expect(labelHandler(fixture.ops)({ action: 'delete', index: 0 })).rejects.toThrow('unique');
    expect(edits(fixture.calls)).toEqual([]);
    expect(fixture.labelTracks).toEqual([[0, [[0, 0, 'remove']]], [1, [[1, 1, 'keep']]]]);
  });

  it('refuses unrepresentable preserved label text before deleting any track', async () => {
    const fixture = project([label('Cues')], [[0, [[0, 0, 'remove'], [1, 1, 'say "hello"']]]]);
    await expect(labelHandler(fixture.ops)({ action: 'delete', index: 0 })).rejects.toThrow('double quotes');
    expect(edits(fixture.calls)).toEqual([]);
    expect(fixture.labelTracks[0]?.[1]).toHaveLength(2);
  });
});

describe('lost pipe replies', () => {
  it('requires recovery after a sent command loses its reply and never retries the edit', async () => {
    let attempts = 0;
    const pipe = new AudacityPipe({ to: 'to', from: 'from' }, 100, async () => {
      attempts++;
      if (attempts === 1) throw new AudacityUnavailable('reply disconnected', true);
      return { ok: true, status: 'OK', body: '' };
    });
    await expect(pipe.send('Amplify: Ratio=0.5')).rejects.toThrow('reply disconnected');
    expect(pipe.needsRecovery).toBe(true);
    await expect(pipe.send('Amplify: Ratio=0.5')).rejects.toThrow(AudacityNeedsRecovery);
    expect(attempts).toBe(1);
    pipe.reset();
    await expect(pipe.send('GetInfo: Type=Tracks')).resolves.toMatchObject({ ok: true });
    expect(attempts).toBe(2);
  });

  it('allows reconnecting an unavailable pipe when the command was never sent', async () => {
    let attempts = 0;
    const pipe = new AudacityPipe({ to: 'to', from: 'from' }, 100, async () => {
      attempts++;
      if (attempts === 1) throw new AudacityUnavailable('pipe missing', false);
      return { ok: true, status: 'OK', body: '' };
    });
    await expect(pipe.send('GetInfo: Type=Tracks')).rejects.toThrow('pipe missing');
    expect(pipe.needsRecovery).toBe(false);
    await expect(pipe.send('GetInfo: Type=Tracks')).resolves.toMatchObject({ ok: true });
    expect(attempts).toBe(2);
  });
});
