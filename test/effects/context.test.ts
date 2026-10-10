import { beforeEach, describe, expect, it, vi } from 'vitest';
import { preflightEffect } from '../../src/effects/context.js';
import { preflightMacroEffects } from '../../src/effects/macros.js';
import { preflightEffectParameters } from '../../src/effects/parameters.js';
import { catalogueCommand } from '../../src/format.js';
import { Ops, type TrackInfo } from '../../src/ops.js';
import { AudacityPipe } from '../../src/pipe.js';
import { pipeline } from '../../src/tasks/pipeline.js';

const mocks = vi.hoisted(() => ({ measureSourceRate: vi.fn() }));
vi.mock('../../src/source-rate.js', () => ({ measureSourceRate: mocks.measureSourceRate }));

function fixture(rates = [8000], selection = { Start: 0, End: 1 }) {
  const tracks: TrackInfo[] = rates.map((_rate, i) => ({
    name: `Audio ${i}`,
    kind: 'wave',
    start: 0,
    end: 1,
    selected: 1,
  }));
  let clips = rates.map((_rate, track) => ({ track, start: 0, end: 1 }));
  const calls: string[] = [];
  const ops = new Ops(
    new AudacityPipe({ to: 'fixture.to', from: 'fixture.from' }, 100, async (_paths, command) => {
      calls.push(command);
      const body = command.includes('Type=Tracks')
        ? JSON.stringify(tracks)
        : command.includes('Type=Clips')
          ? JSON.stringify(clips)
          : command.includes('Type=Selection')
            ? JSON.stringify(selection)
            : '';
      return { ok: true, status: 'OK', body };
    }),
  );
  mocks.measureSourceRate.mockImplementation(async (_ops: Ops, scope: { track: number }) => rates[scope.track]);
  return {
    ops,
    tracks,
    calls,
    setClips: (values: typeof clips) => {
      clips = values;
    },
  };
}

beforeEach(() => {
  mocks.measureSourceRate.mockReset();
});
const edits = (calls: string[]) => calls.filter((call) => !call.startsWith('GetInfo:'));

describe('static Nyquist modal preflight', () => {
  it.each([
    ['High-passFilter', {}],
    ['Low-passFilter', { FREQUENCY: 0.09 }],
    ['ShelfFilter', { HZ: 9 }],
    ['Vocoder', { 'TRACK-VL': 0, 'NOISE-VL': 0, 'RADAR-VL': 0 }],
    ['Vocoder', { 'TRACK-VL': 100 }],
    ['LegacyLimiter', {}],
    ['LegacyLimiter', { TYPE: 'SoftLimit' }],
    ['LegacyLimiter', { TYPE: 'HardLimit' }],
    ['NoiseGate', { MODE: 'Analyze', 'GATE-FREQ': 0 }],
    ['NoiseGate', { 'GATE-FREQ': 0 }],
    ['RhythmTrack', { BARS: 0, 'CLICK-TRACK-DUR': 0 }],
    ['RhythmTrack', {}],
    ['AdjustableFade', {}],
    ['AdjustableFade', { PRESET: 'None', UNITS: 'Percent', GAIN0: -1, GAIN1: 100 }],
    ['AdjustableFade', { PRESET: 'None', UNITS: 'Percent', GAIN0: 0, GAIN1: 1001 }],
    ['AdjustableFade', { PRESET: 'None', UNITS: 'dB', GAIN0: 101, GAIN1: 0 }],
  ])('rejects %s invalid or unprovable settings before pipe access', (id, params) => {
    const state = fixture();
    expect(() => state.ops.command(id as string, params as Record<string, unknown>)).toThrow();
    expect(state.calls).toEqual([]);
  });

  it('accepts explicit nonzero Vocoder carrier, positive rhythm and preset fades', () => {
    expect(() => preflightEffectParameters('Vocoder', { 'TRACK-VL': 0, 'NOISE-VL': 1, 'RADAR-VL': 0 })).not.toThrow();
    expect(() => preflightEffectParameters('RhythmTrack', { BARS: 1 })).not.toThrow();
    expect(() => preflightEffectParameters('AdjustableFade', { PRESET: 'LinearIn' })).not.toThrow();
  });
});

describe('source sample-rate filter guards', () => {
  it.each(['High-passFilter', 'Low-passFilter', 'NotchFilter'])(
    'rejects %s at source Nyquist despite a higher project render rate',
    async (command) => {
      const state = fixture([8000]);
      await expect(state.ops.command(command, { FREQUENCY: 4000 })).rejects.toThrow('source sample rate 8000 Hz');
      expect(edits(state.calls)).toEqual([]);
      expect(mocks.measureSourceRate).toHaveBeenCalledExactlyOnceWith(state.ops, { track: 0, start: 0, end: 1 });
    },
  );

  it('accepts ShelfFilter at source Nyquist and rejects it above, including a zero gain no-op', async () => {
    const state = fixture([8000]);
    await preflightEffect(state.ops, 'ShelfFilter', { HZ: 4000, GAIN: 0 });
    await expect(preflightEffect(state.ops, 'ShelfFilter', { HZ: 4001, GAIN: 0 })).rejects.toThrow(
      'source sample rate 8000 Hz',
    );
    expect(edits(state.calls)).toEqual([]);
  });

  it('refuses a scoped effect before selecting an invalid low-rate target', async () => {
    const state = fixture([8000, 48000]);
    state.tracks[0]!.selected = 0;
    await expect(state.ops.applyEffect('Low-passFilter', { FREQUENCY: 8000 }, { track: 0 })).rejects.toThrow(
      'source sample rate 8000 Hz',
    );
    expect(edits(state.calls)).toEqual([]);
  });

  it('preflights the entire lofi pipeline before DC removal or a valid high-pass step', async () => {
    const state = fixture([8000]);
    await expect(pipeline(state.ops, { track: 0, preset: 'lofi' })).rejects.toThrow('Low-passFilter FREQUENCY=8000');
    expect(edits(state.calls)).toEqual([]);
    expect(mocks.measureSourceRate).toHaveBeenCalledOnce();
  });

  it('preflights a later macro filter before earlier amplification and against every existing source rate', async () => {
    const state = fixture([48000, 8000]);
    state.tracks[1]!.selected = 0;
    await expect(
      preflightMacroEffects(state.ops, [
        { command: 'Amplify', params: { Ratio: 0.5 } },
        { command: 'SelectTracks', params: { Track: 0 } },
        { command: 'Low-passFilter', params: { FREQUENCY: 8000 } },
      ]),
    ).rejects.toThrow('source sample rate 8000 Hz');
    expect(edits(state.calls)).toEqual([]);
  });

  it('refuses macro rate-dependent effects after unprovable topology or timing changes', async () => {
    const state = fixture();
    await expect(
      preflightMacroEffects(state.ops, [
        { command: 'NewMonoTrack', params: {} },
        { command: 'High-passFilter', params: { FREQUENCY: 80 } },
      ]),
    ).rejects.toThrow('topology, generation or timing changes');
    expect(edits(state.calls)).toEqual([]);
  });
});

describe('selection and topology Nyquist guards', () => {
  it.each(['BeatFinder', 'ClipFix', 'Delay', 'Tremolo', 'StudioFadeOut', 'CrossfadeClips'])(
    'rejects %s without selected audio before invoking native Nyquist',
    async (command) => {
      const state = fixture();
      state.tracks[0]!.selected = 0;
      await expect(state.ops.command(command)).rejects.toThrow('selected audio');
      expect(edits(state.calls)).toEqual([]);
    },
  );

  it.each(['SoftLimit', 'HardLimit'])(
    'refuses %s at 1000 Hz with a zero averaging step before native code runs',
    async (type) => {
      const state = fixture([1000]);
      await expect(state.ops.command('LegacyLimiter', { TYPE: type, HOLD: 1 })).rejects.toThrow(
        'averaging window needs at least one full source sample',
      );
      expect(edits(state.calls)).toEqual([]);
    },
  );

  it.each(['SoftClip', 'HardClip'])('accepts explicit %s without the unused HOLD control', async (type) => {
    const state = fixture([1000]);
    await preflightEffect(state.ops, 'LegacyLimiter', { TYPE: type });
    expect(edits(state.calls)).toEqual([]);
  });

  it.each(['SoftLimit', 'HardLimit'])('accepts %s with a full averaging step at 48000 Hz', async (type) => {
    const state = fixture([48000]);
    await preflightEffect(state.ops, 'LegacyLimiter', { TYPE: type, HOLD: 1 });
    expect(edits(state.calls)).toEqual([]);
  });

  it('checks NoiseGate source frame minimum and its 45 percent frequency ceiling', async () => {
    const state = fixture([8000], { Start: 0, End: 0.01 });
    await expect(state.ops.command('NoiseGate', { MODE: 'Gate', 'GATE-FREQ': 0 })).rejects.toThrow(
      'at least 100 source frames',
    );
    await expect(
      preflightEffect(state.ops, 'NoiseGate', { MODE: 'Gate', 'GATE-FREQ': 3.6 }, { track: 0, start: 0, end: 1 }),
    ).rejects.toThrow('below 3.6 kHz');
    expect(edits(state.calls)).toEqual([]);
  });

  it('refuses StudioFadeOut with fewer than three source frames', async () => {
    const state = fixture([8000], { Start: 0, End: 0.00025 });
    await expect(state.ops.command('StudioFadeOut')).rejects.toThrow('at least 3 source frames');
    expect(edits(state.calls)).toEqual([]);
  });

  it.each([
    ['Tremolo', {}],
    ['AdjustableFade', { PRESET: 'LinearIn' }],
    ['High-passFilter', { FREQUENCY: 80 }],
  ])('refuses a positive sub-source-sample %s interval before native processing', async (command, params) => {
    const state = fixture([8000], { Start: 0, End: 0.000001 });
    await expect(state.ops.command(command as string, params as Record<string, unknown>)).rejects.toThrow(
      'at least 1 source frames',
    );
    expect(edits(state.calls)).toEqual([]);
    expect(mocks.measureSourceRate).toHaveBeenCalledExactlyOnceWith(state.ops, { track: 0, start: 0, end: 1 });
  });

  it('refuses processing wholly within a timeline gap before querying rate or invoking native Nyquist', async () => {
    const state = fixture([8000], { Start: 0.3, End: 0.6 });
    state.setClips([
      { track: 0, start: 0, end: 0.2 },
      { track: 0, start: 0.8, end: 1 },
    ]);
    await expect(state.ops.command('Tremolo')).rejects.toThrow('timeline gaps alone');
    expect(edits(state.calls)).toEqual([]);
    expect(mocks.measureSourceRate).not.toHaveBeenCalled();
  });

  it('preflights source frames for the public silent sample exporter', async () => {
    const state = fixture([8000]);
    await state.ops.command('SampleDataExport', { NUMBER: 1, FILENAME: 'samples.txt', MESSAGES: 'None' });
    // Relative paths are sent absolute, exactly as the shared formatter writes them.
    expect(edits(state.calls)).toEqual([
      catalogueCommand('SampleDataExport', { NUMBER: 1, FILENAME: 'samples.txt', MESSAGES: 'None' }),
    ]);
    expect(mocks.measureSourceRate).toHaveBeenCalledOnce();
  });

  it('reserves even valid silent regular-label requests because native trace state may already be enabled', () => {
    const state = fixture();
    expect(() =>
      state.ops.command('RegularIntervalLabels', { MODE: 'Number', TOTALNUM: 2, REGION: 0, VERBOSE: 'None' }),
    ).toThrow('reserved');
    expect(state.calls).toEqual([]);
    expect(mocks.measureSourceRate).not.toHaveBeenCalled();
  });

  it('requires two audio tracks for CrossfadeTracks', async () => {
    const state = fixture();
    await expect(state.ops.command('CrossfadeTracks')).rejects.toThrow('at least two selected audio tracks');
    expect(edits(state.calls)).toEqual([]);
  });

  it('accepts one continuous CrossfadeClips selection and refuses extra clips or outer whitespace', async () => {
    const state = fixture();
    await preflightEffect(state.ops, 'CrossfadeClips', {});
    state.setClips([
      { track: 0, start: 0, end: 0.2 },
      { track: 0, start: 0.3, end: 0.5 },
      { track: 0, start: 0.6, end: 1 },
    ]);
    await expect(preflightEffect(state.ops, 'CrossfadeClips', {})).rejects.toThrow('one or two');
    state.setClips([{ track: 0, start: 0.1, end: 1 }]);
    await expect(preflightEffect(state.ops, 'CrossfadeClips', {})).rejects.toThrow('start and end in audio');
    expect(edits(state.calls)).toEqual([]);
  });

  it('refuses a one-source-frame continuous crossfade before halving it to nil audio', async () => {
    const state = fixture([8000], { Start: 0, End: 1 / 8000 });
    await expect(state.ops.command('CrossfadeClips')).rejects.toThrow('at least 2 source frames');
    expect(edits(state.calls)).toEqual([]);
  });

  it('refuses a long-gap crossfade whose participating tails and heads contain no guaranteed output frames', async () => {
    const state = fixture([8000], { Start: 0.2 - 0.00001, End: 0.8 + 0.00001 });
    state.setClips([
      { track: 0, start: 0, end: 0.2 },
      { track: 0, start: 0.8, end: 1 },
    ]);
    await expect(state.ops.command('CrossfadeClips')).rejects.toThrow(
      'each participating audio portion; timeline gaps do not count',
    );
    expect(edits(state.calls)).toEqual([]);
  });

  it('accepts two-clip crossfades when both participating audio portions have adequate source frames', async () => {
    const state = fixture([8000], { Start: 0.1, End: 0.9 });
    state.setClips([
      { track: 0, start: 0, end: 0.2 },
      { track: 0, start: 0.8, end: 1 },
    ]);
    await preflightEffect(state.ops, 'CrossfadeClips', {});
    expect(edits(state.calls)).toEqual([]);
  });
});
