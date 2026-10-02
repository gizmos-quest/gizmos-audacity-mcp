import { describe, expect, it, vi } from 'vitest';
import { Ops, type TrackInfo, type TrackRef } from '../src/ops.js';
import { catalogueCommand } from '../src/format.js';
import {
  AutoDuckSchema, ClipSetSchema, EditSchema, FadeSchema, GenerateSchema, PipelineSchema, TrackEditSchema,
  autoDuck, clipSet, edit, fade, generate, pipeline, planPipeline, trackEdit,
} from '../src/tasks.js';

vi.mock('../src/source-rate.js', () => ({ measureSourceRate: vi.fn(async () => 48_000) }));

function wave(name = 'Voice', start = 2, end = 10): TrackInfo {
  return { name, kind: 'wave', start, end, channels: 1 };
}

function mockOps(trackList = [wave()]) {
  const tracks = vi.fn(async () => trackList);
  const trackIndex = vi.fn(async (ref: TrackRef) => {
    const indexes = trackList.flatMap((track, index) => typeof ref === 'number' ? (ref === index ? [index] : []) : (ref === track.name ? [index] : []));
    if (indexes.length !== 1) throw new Error(`track ${ref} does not identify one track`);
    return indexes[0]!;
  });
  const select = vi.fn(async (_scope: { track?: TrackRef; trackCount?: number; start?: number; end?: number }) => undefined);
  const command = vi.fn(async (_id: string, _params?: Record<string, unknown>, _timeout?: number) => 'Audacity reply');
  const run = vi.fn(async (_id: string, _params?: Record<string, unknown>, _timeout?: number) => 'Audacity reply');
  const info = vi.fn(async (type: string): Promise<unknown> => type === 'Clips'
    ? trackList.flatMap((track, index) => track.kind === 'wave' && track.end > track.start ? [{ track: index, start: track.start, end: track.end }] : [])
    : []);
  const mocks = { tracks, trackIndex, select, command, run, info };
  return { ...mocks, ops: mocks as unknown as Ops, trackList };
}

function expectNoMutation(mocks: ReturnType<typeof mockOps>): void {
  expect(mocks.select).not.toHaveBeenCalled();
  expect(mocks.command).not.toHaveBeenCalled();
  expect(mocks.run).not.toHaveBeenCalled();
}

describe('strict task contracts', () => {
  it('accepts consistent nonnegative track indices beyond 255', () => {
    expect(PipelineSchema.parse({ track: 256 }).track).toBe(256);
    expect(GenerateSchema.parse({ kind: 'tone', track: 256 }).track).toBe(256);
    expect(EditSchema.parse({ action: 'split', track: 256 }).track).toBe(256);
  });
  it.each([
    ['pipeline', PipelineSchema, { track: 0 }],
    ['edit', EditSchema, { action: 'split', track: 0 }],
    ['generate', GenerateSchema, { kind: 'tone' }],
    ['clip_set', ClipSetSchema, { track: 0, at: 1, name: 'Clip' }],
    ['track_edit', TrackEditSchema, { action: 'add_mono' }],
    ['fade', FadeSchema, { track: 0, direction: 'in' }],
    ['auto_duck', AutoDuckSchema, { bed: 0, voice: 1 }],
  ] as const)('%s rejects unknown root properties', (_name, schema, input) => {
    expect(() => schema.parse({ ...input, typo: true })).toThrow();
  });

  it.each([
    { noiseProfile: { start: 0, end: 1, typo: 0 } },
    { shortenPauses: { minimum: 1, typo: 0 } },
    { noiseProfile: { start: 1, end: 1 } },
    { shortenPauses: { minimum: 0.2, truncateTo: 0.3 } },
  ])('rejects invalid nested pipeline settings %#', (settings) => {
    expect(() => PipelineSchema.parse({ track: 0, ...settings })).toThrow();
  });

  it.each([
    { kind: 'silence', frequency: 440 },
    { kind: 'noise', waveform: 'Sine' },
    { kind: 'tone', endFrequency: 880 },
    { kind: 'dtmf', sequence: 'pause,wait' },
    { kind: 'rhythm', beatsPerBar: 2.5 },
    { kind: 'tone', start: 86_399, duration: 2 },
    { kind: 'tone', frequency: Number.NaN },
    { kind: 'tone', amplitude: Number.POSITIVE_INFINITY },
    { kind: 'chirp', duration: 0 },
    { kind: 'tone', track: 0, channels: 1 },
    { kind: 'tone', track: 0, channels: 2 },
  ])('rejects invalid or irrelevant generation settings %#', (input) => {
    expect(() => GenerateSchema.parse(input)).toThrow();
  });

  it.each(['clickThreshold', 'clickWidth'])('rejects unused click removal option %s', (key) => {
    expect(() => PipelineSchema.parse({ track: 0, [key]: 200 })).toThrow();
  });

  it.each([
    { action: 'remove' },
    { action: 'add_mono', track: 0 },
    { action: 'add_stereo', start: 1 },
    { action: 'add_label', trackCount: 2 },
    { action: 'mix', track: 0, name: 'ignored' },
    { action: 'align_together', track: 0, start: 2, end: 1 },
  ])('rejects ambiguous track-edit settings %#', (input) => {
    expect(() => TrackEditSchema.parse(input)).toThrow();
  });

  it.each([
    [PipelineSchema, { track: 0, start: 1, end: 1 }],
    [FadeSchema, { track: 0, direction: 'in', start: 1, end: 1 }],
    [AutoDuckSchema, { bed: 0, voice: 1, start: 2, end: 1 }],
    [EditSchema, { action: 'split', track: 0, start: 2, end: 1 }],
    [ClipSetSchema, { track: 0, at: 1 }],
    [ClipSetSchema, { track: 0, at: 1, name: 'a"b' }],
  ] as const)('rejects invalid edit scope or clip properties %#', (schema, input) => {
    expect(() => schema.parse(input)).toThrow();
  });

  it.each([
    [pipeline, { track: 0, noiseProfile: { start: 0, end: 1, typo: true } }],
    [edit, { track: 0, action: 'unknown' }],
    [generate, { kind: 'silence', amplitude: 0.25 }],
    [clipSet, { track: 0, at: 1, gainDb: Number.NaN }],
    [trackEdit, { action: 'add_mono', track: 0 }],
    [fade, { track: 0, direction: 'in', start: 2, end: 1 }],
    [autoDuck, { bed: 0, voice: 1, typo: true }],
  ] as const)('validates a task before any pipe interaction %#', async (handler, input) => {
    const mocks = mockOps();
    await expect(handler(mocks.ops, input)).rejects.toThrow();
    expectNoMutation(mocks);
    expect(mocks.tracks).not.toHaveBeenCalled();
    expect(mocks.trackIndex).not.toHaveBeenCalled();
    expect(mocks.info).not.toHaveBeenCalled();
  });
});

describe('reviewed pipeline plans', () => {
  it.each([
    ['cleanup', ['Normalize', 'High-passFilter']],
    ['voice', ['Normalize', 'High-passFilter', 'Compressor']],
    ['podcast', ['Normalize', 'High-passFilter', 'Compressor']],
    ['interview', ['Normalize', 'High-passFilter', 'Compressor']],
    ['audiobook', ['Normalize', 'High-passFilter', 'Compressor']],
    ['vocal', ['Normalize', 'High-passFilter', 'Compressor', 'BassAndTreble']],
    ['live', ['Normalize', 'High-passFilter', 'Compressor']],
    ['music', ['Normalize', 'High-passFilter', 'Compressor']],
    ['lofi', ['Normalize', 'High-passFilter', 'Low-passFilter', 'Compressor', 'BassAndTreble']],
  ])('validates the complete %s preset against the installed catalogue', (preset, commands) => {
    const plan = planPipeline({ track: 'Voice', preset });
    expect(plan.steps.map((step) => step.command)).toEqual(commands);
    for (const step of plan.steps) {
      expect(catalogueCommand(step.command, step.params)).toMatch(new RegExp(`^${step.command}:`));
      expect(step.scope.track).toBe('Voice');
    }
  });

  it('orders profiling, timing edits, dynamics, EQ, loudness and limiting', () => {
    const plan = planPipeline({
      track: 0, start: 2, end: 9, noiseProfile: { start: 2, end: 2.2 },
      lowPassHz: 9000, shortenPauses: { minimum: 1, truncateTo: 0.2 },
      bassDb: 1, trebleDb: 2, loudness: 'lufs', lufs: -18, limitPeakDb: -1,
    });
    expect(plan.steps.map((step) => step.command)).toEqual([
      'NoiseReduction', 'NoiseReduction', 'Normalize', 'High-passFilter', 'Low-passFilter',
      'TruncateSilence', 'Compressor', 'BassAndTreble', 'LoudnessNormalization', 'Limiter',
    ]);
    expect(plan.steps[0]).toMatchObject({ params: {}, scope: { track: 0, start: 2, end: 2.2 } });
    expect(plan.steps[0]?.captureProfile).toBe(true);
    expect(plan.steps[1]).toMatchObject({ params: {}, scope: { track: 0, start: 2, end: 9 } });
    expect(plan.steps[2]?.params).toMatchObject({ RemoveDcOffset: true, ApplyVolume: false });
    expect(plan.steps[6]?.params).toMatchObject({ makeupGainDb: 0 });
    expect(plan.steps.at(-1)?.params).toMatchObject({ thresholdDb: -1, makeupTargetDb: -1 });
    expect(plan.notes.join(' ')).toMatch(/alignment with video/);
    expect(plan.notes.join(' ')).toMatch(/verify loudness and true peak/);
  });

  it.each([false, true])('rejects requested click removal before pipe interaction even when dryRun=%s', async (dryRun) => {
    const mocks = mockOps();
    await expect(pipeline(mocks.ops, { track: 0, dryRun, removeClicks: true })).rejects.toThrow('blocking modal dialog');
    expectNoMutation(mocks);
    expect(mocks.tracks).not.toHaveBeenCalled();
    expect(() => planPipeline({ track: 0, removeClicks: true })).toThrow('blocking modal dialog');
  });

  it.each([
    ['peak', 'Normalize', { PeakLevel: -2, ApplyVolume: true, RemoveDcOffset: false }],
    ['lufs', 'LoudnessNormalization', { NormalizeTo: 0, LUFSLevel: -18 }],
    ['rms', 'LoudnessNormalization', { NormalizeTo: 1, RMSLevel: -22 }],
  ])('uses the catalogue parameters for %s normalization', (loudness, command, params) => {
    const plan = planPipeline({ track: 0, loudness, peakDb: -2, lufs: -18, rmsDb: -22 });
    expect(plan.steps.at(-1)).toMatchObject({ command, params });
    expect(plan.notes.join(' ')).toMatch(/boost quiet audio/);
  });

  it('can disable DC removal and compression without implicitly normalizing', () => {
    const plan = planPipeline({ track: 0, removeDc: false, compress: false, highPassHz: 120 });
    expect(plan.steps).toHaveLength(1);
    expect(plan.steps[0]).toMatchObject({ command: 'High-passFilter', params: { FREQUENCY: 120 } });
    expect(plan.notes.join(' ')).toMatch(/no room-tone interval/);
  });

  it('uses explicit compressor settings and never silently adds makeup gain', () => {
    const plan = planPipeline({ preset: 'cleanup', track: 0, compress: true, thresholdDb: -24, ratio: 4, attackMs: 15, releaseMs: 300 });
    expect(plan.steps.at(-1)?.params).toMatchObject({ thresholdDb: -24, compressionRatio: 4, attackMs: 15, releaseMs: 300, makeupGainDb: 0 });
  });
});

describe('pipeline execution', () => {
  it('returns an offline dry-run with no Audacity interaction', async () => {
    const mocks = mockOps();
    const result = await pipeline(mocks.ops, { track: 'unresolved', dryRun: true, preset: 'podcast' });
    expect(result).toMatchObject({ dryRun: true, preset: 'podcast', steps: expect.any(Array) });
    expectNoMutation(mocks);
    expect(mocks.tracks).not.toHaveBeenCalled();
  });

  it('selects only the target extent for each effect', async () => {
    const mocks = mockOps([wave('Other', 0, 30), wave('Voice', 2, 10)]);
    const result = await pipeline(mocks.ops, { track: 'Voice' });
    expect(mocks.select.mock.calls.map(([scope]) => scope)).toEqual(Array(3).fill({ track: 1, start: 2, end: 10 }));
    expect(mocks.command.mock.calls.map(([command]) => command)).toEqual(['Normalize', 'High-passFilter', 'Compressor']);
    expect(mocks.command.mock.calls.every(([, , timeout]) => timeout === 600_000)).toBe(true);
    expect(result).toMatchObject({ dryRun: false, applied: expect.any(Array) });
  });

  it('recalculates the default extent after shortening pauses', async () => {
    const mocks = mockOps();
    mocks.command.mockImplementation(async (id) => {
      if (id === 'TruncateSilence') mocks.trackList[0]!.end = 6;
      return 'OK';
    });
    await pipeline(mocks.ops, { track: 0, shortenPauses: { minimum: 1, truncateTo: 0.3 } });
    expect(mocks.select.mock.calls.map(([scope]) => scope.end)).toEqual([10, 10, 10, 6]);
  });

  it.each([{ start: 1, end: 2.1 }, { start: 9, end: 11 }])('refuses an out-of-track noise profile before selection %#', async (noiseProfile) => {
    const mocks = mockOps();
    await expect(pipeline(mocks.ops, { track: 0, noiseProfile })).rejects.toThrow('noise profile must be inside');
    expectNoMutation(mocks);
  });

  it('preflights the processing extent before capturing a valid noise profile', async () => {
    const mocks = mockOps();
    await expect(pipeline(mocks.ops, { track: 0, start: 20, noiseProfile: { start: 2, end: 3 } })).rejects.toThrow('nothing to process');
    expectNoMutation(mocks);
  });

  it('stops after the failing step and includes Audacity error text and completed count', async () => {
    const mocks = mockOps();
    mocks.command.mockImplementation(async (id) => {
      if (id === 'High-passFilter') throw new Error('Audacity rejected: requires selected audio');
      return 'OK';
    });
    await expect(pipeline(mocks.ops, { track: 0 })).rejects.toThrow(/Remove low-frequency rumble.*1 completed steps.*Audacity rejected: requires selected audio/);
    expect(mocks.command.mock.calls.map(([id]) => id)).toEqual(['Normalize', 'High-passFilter']);
  });

  it('refuses processing a label track before selection', async () => {
    const mocks = mockOps([{ name: 'Labels', kind: 'label', start: 0, end: 4 }]);
    await expect(pipeline(mocks.ops, { track: 0 })).rejects.toThrow('not an audio track');
    expectNoMutation(mocks);
  });
});

describe('audio generation', () => {
  it('rejects channel overrides on existing tracks before reading or changing Audacity', async () => {
    const mocks = mockOps();
    await expect(generate(mocks.ops, { kind: 'tone', track: 0, channels: 2 })).rejects.toThrow('existing tracks retain their channels');
    expect(mocks.tracks).not.toHaveBeenCalled();
    expect(mocks.trackIndex).not.toHaveBeenCalled();
    expectNoMutation(mocks);
  });
  it.each([
    ['tone', 'Tone', { Frequency: 440, Amplitude: 0.25, Waveform: 'Sine' }],
    ['noise', 'Noise', { Type: 'White', Amplitude: 0.25 }],
    ['silence', 'Silence', {}],
    ['chirp', 'Chirp', { StartFreq: 440, EndFreq: 1320, StartAmp: 0.25, EndAmp: 0.1, Interpolation: 'Linear', Waveform: 'Sine' }],
    ['dtmf', 'DtmfTones', { Sequence: '0123456789', 'Duty Cycle': 55, Amplitude: 0.25 }],
    ['rhythm', 'RhythmTrack', { TEMPO: 120, TIMESIG: 4, SWING: 0, BARS: 0, 'CLICK-TRACK-DUR': 2.5, OFFSET: 0, 'CLICK-TYPE': 'Metronome', HIGH: 84, LOW: 80 }],
  ])('generates %s with explicit safe catalogue parameters', async (kind, command, params) => {
    const mocks = mockOps();
    await generate(mocks.ops, { kind, track: 'Voice', start: 3, duration: 2.5 });
    expect(mocks.select).toHaveBeenCalledExactlyOnceWith({ track: 0, start: 3, end: 5.5 });
    expect(mocks.command).toHaveBeenCalledExactlyOnceWith(command, params, 600_000);
    expect(mocks.run).not.toHaveBeenCalled();
  });

  it.each([[1, 'NewMonoTrack'], [2, 'NewStereoTrack']])('creates a new %i-channel track without opening a project window', async (channels, command) => {
    const mocks = mockOps([wave('Existing')]);
    mocks.run.mockImplementation(async () => { mocks.trackList.push(wave('New', 0, 1)); return 'OK'; });
    await generate(mocks.ops, { kind: 'tone', channels, name: 'Test tone' });
    expect(mocks.run).toHaveBeenCalledExactlyOnceWith(command);
    expect(mocks.select).toHaveBeenCalledExactlyOnceWith({ track: 1, start: 0, end: 1 });
    expect(mocks.command.mock.calls[1]).toEqual(['SetTrack', { Name: 'Test tone' }]);
  });

  it('uppercases a validated DTMF sequence and formats its spaced parameter', async () => {
    const mocks = mockOps();
    await generate(mocks.ops, { kind: 'dtmf', track: 0, sequence: 'a1b2*#', dutyCycle: 75 });
    const params = mocks.command.mock.calls[0]![1]!;
    expect(catalogueCommand('DtmfTones', params)).toContain('"Duty Cycle"=75');
    expect(params.Sequence).toBe('A1B2*#');
  });

  it('refuses replacing audio on a non-audio track before selection', async () => {
    const mocks = mockOps([{ name: 'Labels', kind: 'label', start: 0, end: 1 }]);
    await expect(generate(mocks.ops, { kind: 'silence', track: 0 })).rejects.toThrow('not an audio track');
    expectNoMutation(mocks);
  });
});

describe('clip properties and destructive clip gain', () => {
  it('converts dB to a sample ratio and selects exactly the identified clip', async () => {
    const mocks = mockOps();
    mocks.info.mockResolvedValue([{ track: 0, start: 2, end: 4, name: 'first' }, { track: 0, start: 5, end: 10, name: 'second' }]);
    const result = await clipSet(mocks.ops, { track: 0, at: 3, gainDb: -6, name: 'Renamed', color: 'Color2' });
    expect(mocks.select).toHaveBeenCalledExactlyOnceWith({ track: 0, start: 2, end: 4 });
    expect(mocks.command.mock.calls[0]![0]).toBe('Amplify');
    expect(mocks.command.mock.calls[0]![1]?.Ratio).toBeCloseTo(0.5011872336, 9);
    expect(mocks.command.mock.calls[1]).toEqual(['SetClip', { At: 3, Name: 'Renamed', Color: 'Color2' }]);
    expect(result).toMatchObject({ start: 2, end: 4, gainDbApplied: -6, name: 'Renamed' });
  });

  it('resolves a clip boundary to the clip starting there', async () => {
    const mocks = mockOps();
    mocks.info.mockResolvedValue([{ track: 0, start: 2, end: 4 }, { track: 0, start: 4, end: 10 }]);
    await clipSet(mocks.ops, { track: 0, at: 4, gainDb: 0 });
    expect(mocks.select).toHaveBeenCalledExactlyOnceWith({ track: 0, start: 4, end: 10 });
    expect(mocks.command).toHaveBeenCalledExactlyOnceWith('Amplify', { Ratio: 1 }, 600_000);
  });

  it.each([{ name: 'Only second' }, { color: 'Color1' }, { gainDb: -6, name: 'Only second' }])('rejects shared-boundary clip metadata before any gain or selection %#', async (properties) => {
    const mocks = mockOps();
    mocks.info.mockResolvedValue([{ track: 0, start: 2, end: 4 }, { track: 0, start: 4, end: 10 }]);
    await expect(clipSet(mocks.ops, { track: 0, at: 4, ...properties })).rejects.toThrow('strictly inside one clip');
    expectNoMutation(mocks);
  });

  it.each([
    { clips: [] },
    { clips: [{ track: 1, start: 0, end: 10 }] },
    { clips: [{ track: 0, start: 2, end: 4 }, { track: 0, start: 3, end: 5 }] },
  ])('refuses missing or ambiguous clips without selecting or processing %#', async ({ clips }) => {
    const mocks = mockOps();
    mocks.info.mockResolvedValue(clips);
    await expect(clipSet(mocks.ops, { track: 0, at: 3, gainDb: 3 })).rejects.toThrow(/identifies [02] clips/);
    expectNoMutation(mocks);
  });

  it('only changes clip metadata when gain is omitted', async () => {
    const mocks = mockOps();
    mocks.info.mockResolvedValue([{ track: 0, start: 2, end: 10 }]);
    await clipSet(mocks.ops, { track: 0, at: 3, name: 'Scene' });
    expect(mocks.command).toHaveBeenCalledExactlyOnceWith('SetClip', { At: 3, Name: 'Scene', Color: undefined });
  });
});

describe('selection editing', () => {
  it.each([
    ['split', 'Split'], ['split_new', 'SplitNew'], ['trim', 'Trim'], ['duplicate', 'Duplicate'], ['delete', 'Delete'],
    ['split_delete', 'SplitDelete'], ['cut', 'Cut'], ['split_cut', 'SplitCut'], ['copy', 'Copy'], ['paste', 'Paste'],
    ['silence', 'Silence'], ['join', 'Join'], ['disjoin', 'Disjoin'],
  ])('runs %s on the explicitly selected audio extent', async (action, command) => {
    const mocks = mockOps([wave('Voice'), wave('Bed', 0, 20)]);
    const result = await edit(mocks.ops, { action, track: 0, trackCount: 2 });
    expect(mocks.select).toHaveBeenCalledExactlyOnceWith({ track: 0, trackCount: 2, start: 0, end: 20 });
    expect(mocks.run).toHaveBeenCalledExactlyOnceWith(command, {}, 600_000);
    expect(result).toMatchObject({ action, track: 0, start: 0, end: 20, reply: 'Audacity reply' });
  });

  it.each(['split', 'paste'])('accepts an explicit cursor point for %s', async (action) => {
    const mocks = mockOps();
    await edit(mocks.ops, { action, track: 0, start: 3, end: 3 });
    expect(mocks.select).toHaveBeenCalledExactlyOnceWith({ track: 0, trackCount: 1, start: 3, end: 3 });
  });

  it.each(['trim', 'delete', 'copy', 'silence'])('refuses a cursor-only %s before selection', async (action) => {
    const mocks = mockOps();
    await expect(edit(mocks.ops, { action, track: 0, start: 3, end: 3 })).rejects.toThrow('requires a finite non-empty time range');
    expectNoMutation(mocks);
  });

  it('rejects a trackCount beyond the project before selection', async () => {
    const mocks = mockOps();
    await expect(edit(mocks.ops, { action: 'duplicate', track: 0, trackCount: 2 })).rejects.toThrow('existing audio tracks only');
    expectNoMutation(mocks);
  });

  it('rejects a multi-track edit containing labels before selection', async () => {
    const mocks = mockOps([wave(), { name: 'Labels', kind: 'label', start: 0, end: 5 }]);
    await expect(edit(mocks.ops, { action: 'delete', track: 0, trackCount: 2 })).rejects.toThrow('existing audio tracks only');
    expectNoMutation(mocks);
  });

  it('trims separate outside clips on every selected track without shifting audio or editing other tracks', async () => {
    const mocks = mockOps([wave('Other', 0, 100), wave('Voice', 0, 30), wave('Bed', 1, 40)]);
    let clips = [
      { track: 0, start: 0, end: 100 },
      { track: 1, start: 0, end: 2 }, { track: 1, start: 3, end: 10 }, { track: 1, start: 20, end: 30 },
      { track: 2, start: 1, end: 3 }, { track: 2, start: 8, end: 14 }, { track: 2, start: 30, end: 40 },
    ];
    mocks.info.mockImplementation(async () => clips);
    mocks.run.mockImplementation(async (id) => {
      const scope = mocks.select.mock.calls.at(-1)![0];
      const fromTrack = scope.track as number;
      const toTrack = fromTrack + scope.trackCount!;
      const from = scope.start!;
      const to = scope.end!;
      clips = clips.flatMap((clip) => {
        if (clip.track < fromTrack || clip.track >= toTrack || clip.end <= from || clip.start >= to) return [clip];
        if (id === 'Trim') return [{ ...clip, start: Math.max(clip.start, from), end: Math.min(clip.end, to) }];
        if (id !== 'SplitDelete') throw new Error(`unexpected test edit ${id}`);
        return [
          ...(clip.start < from ? [{ ...clip, end: from }] : []),
          ...(clip.end > to ? [{ ...clip, start: to }] : []),
        ];
      });
      return 'OK';
    });
    await edit(mocks.ops, { action: 'trim', track: 'Voice', trackCount: 2, start: 5, end: 12 });
    expect(clips).toEqual([
      { track: 0, start: 0, end: 100 }, { track: 1, start: 5, end: 10 }, { track: 2, start: 8, end: 12 },
    ]);
    expect(mocks.select.mock.calls.map(([scope]) => scope)).toEqual([
      { track: 1, trackCount: 2, start: 12, end: 40 },
      { track: 1, trackCount: 2, start: 0, end: 5 },
      { track: 1, trackCount: 2, start: 5, end: 12 },
    ]);
    expect(mocks.run.mock.calls.map(([id]) => id)).toEqual(['SplitDelete', 'SplitDelete', 'Trim']);
  });

  it.each([{ start: 4, end: 6 }, { start: 20, end: 30 }])('refuses trimming an audio-free range before deleting separate clips %#', async (range) => {
    const mocks = mockOps([wave('Voice', 0, 10)]);
    mocks.info.mockResolvedValue([{ track: 0, start: 0, end: 2 }, { track: 0, start: 8, end: 10 }, { track: 1, start: 0, end: 30 }]);
    await expect(edit(mocks.ops, { action: 'trim', track: 0, ...range })).rejects.toThrow('trim range must overlap audio');
    expectNoMutation(mocks);
  });

  it('skips empty exterior deletes for a trim covering the complete track extent', async () => {
    const mocks = mockOps([wave('Voice', 2, 10)]);
    await edit(mocks.ops, { action: 'trim', track: 0, start: 0, end: 20 });
    expect(mocks.run).toHaveBeenCalledExactlyOnceWith('Trim', {}, 600_000);
    expect(mocks.select).toHaveBeenCalledExactlyOnceWith({ track: 0, trackCount: 1, start: 0, end: 20 });
  });

  it('preserves Audacity error text and stops a trim at its first failing delete', async () => {
    const mocks = mockOps([wave('Voice', 0, 10)]);
    mocks.run.mockRejectedValue(new Error('Audacity rejected: selection is locked'));
    await expect(edit(mocks.ops, { action: 'trim', track: 0, start: 2, end: 8 })).rejects.toThrow('Audacity rejected: selection is locked');
    expect(mocks.run).toHaveBeenCalledExactlyOnceWith('SplitDelete', {}, 600_000);
    expect(mocks.select).toHaveBeenCalledExactlyOnceWith({ track: 0, trackCount: 1, start: 8, end: 10 });
  });
});

describe('track creation, mixing, removal and alignment', () => {
  it.each([['add_mono', 'NewMonoTrack'], ['add_stereo', 'NewStereoTrack'], ['add_label', 'NewLabelTrack']])('creates and names a track with %s', async (action, command) => {
    const mocks = mockOps();
    mocks.run.mockImplementation(async () => { mocks.trackList.push(wave('New', 0, 0)); return 'OK'; });
    const result = await trackEdit(mocks.ops, { action, name: 'New track' });
    expect(mocks.run).toHaveBeenCalledExactlyOnceWith(command);
    expect(mocks.command.mock.calls).toEqual([['SelectTracks', { Track: 1, TrackCount: 1, Mode: 'Set' }], ['SetTrack', { Name: 'New track' }]]);
    expect(result).toMatchObject({ track: 1 });
  });

  it.each([
    ['remove', 'RemoveTracks'], ['mix', 'MixAndRender'], ['mix_new', 'MixAndRenderToNewTrack'],
    ['align_end_to_end', 'Align_EndToEnd'], ['align_together', 'Align_Together'], ['align_start_zero', 'Align_StartToZero'],
    ['align_start_cursor', 'Align_StartToSelStart'], ['align_start_end', 'Align_StartToSelEnd'],
    ['align_end_cursor', 'Align_EndToSelStart'], ['align_end_end', 'Align_EndToSelEnd'],
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

describe('fades', () => {
  it.each([['in', 'FadeIn'], ['out', 'FadeOut']])('applies fade %s to the track extent', async (direction, command) => {
    const mocks = mockOps();
    expect(await fade(mocks.ops, { direction, track: 'Voice' })).toEqual({ track: 0, start: 2, end: 10, direction });
    expect(mocks.select).toHaveBeenCalledExactlyOnceWith({ track: 0, start: 2, end: 10 });
    expect(mocks.command).toHaveBeenCalledExactlyOnceWith(command, {}, 600_000);
  });

  it('honors a supplied fade region without selecting adjacent audio', async () => {
    const mocks = mockOps();
    await fade(mocks.ops, { direction: 'out', track: 0, start: 9, end: 10 });
    expect(mocks.select).toHaveBeenCalledExactlyOnceWith({ track: 0, start: 9, end: 10 });
  });

  it('refuses an empty target before selection', async () => {
    const mocks = mockOps([wave('Empty', 0, 0)]);
    await expect(fade(mocks.ops, { direction: 'in', track: 0 })).rejects.toThrow('nothing to process');
    expectNoMutation(mocks);
  });
});

describe('Auto Duck control-track semantics', () => {
  it('selects only the bed and leaves the following voice unselected', async () => {
    const mocks = mockOps([wave('Bed', 0, 20), wave('Voice', 2, 10)]);
    const result = await autoDuck(mocks.ops, { bed: 'Bed', voice: 'Voice', start: 2, end: 10, duckDb: -9 });
    expect(mocks.select).toHaveBeenCalledExactlyOnceWith({ track: 0, start: 2, end: 10 });
    expect(mocks.command).toHaveBeenCalledExactlyOnceWith('AutoDuck', {
      DuckAmountDb: -9, ThresholdDb: -30, OuterFadeDownLen: 0.5, OuterFadeUpLen: 0.5,
      InnerFadeDownLen: 0, InnerFadeUpLen: 0, MaximumPause: 1,
    }, 600_000);
    expect(result).toMatchObject({ dryRun: false, bed: 0, voice: 1 });
  });

  it('skips label tracks when identifying the next audio control track', async () => {
    const mocks = mockOps([wave('Bed'), { name: 'Labels', kind: 'label', start: 0, end: 5 }, wave('Voice')]);
    await autoDuck(mocks.ops, { bed: 0, voice: 2 });
    expect(mocks.command.mock.calls[0]?.[0]).toBe('AutoDuck');
  });

  it.each([
    [0, 0],
    [0, 2],
    [1, 0],
  ])('refuses a non-adjacent control track before selection (bed=%i voice=%i)', async (bed, voice) => {
    const mocks = mockOps([wave('Bed'), wave('Other'), wave('Voice')]);
    await expect(autoDuck(mocks.ops, { bed, voice })).rejects.toThrow('next audio track below the bed');
    expectNoMutation(mocks);
  });

  it('previews validated ducking parameters and resolved scope without selecting', async () => {
    const mocks = mockOps([wave('Bed', 0, 20), wave('Voice')]);
    const result = await autoDuck(mocks.ops, { bed: 0, voice: 1, dryRun: true, fadeDown: 0.2, innerFadeUp: 0.1 });
    expect(result).toMatchObject({ dryRun: true, command: 'AutoDuck', scope: { track: 0, start: 0, end: 20 }, voice: 1, params: { OuterFadeDownLen: 0.2, InnerFadeUpLen: 0.1 } });
    expectNoMutation(mocks);
  });
});
