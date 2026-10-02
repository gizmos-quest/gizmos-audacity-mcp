// Original safeguards researched from Audacity-3.7.8/plug-ins/*.ny and
// libraries/lib-nyquist-effects/NyquistBase.cpp. A non-empty string result
// opens a message box, including parameter/context errors in these effects.
// Live exact English Audacity 3.7.8, 2026-10-02: a 5000 Hz filter cutoff on
// an 8000 Hz source opened the native error dialog despite a 48000 Hz project.
// Source-rate guards therefore use the silent sample header, not WAV render rate.
import { z } from 'zod';
import type { Ops, TrackInfo } from './ops.js';
import { selectionTimes } from './analysis.js';
import { measureSourceRate } from './source-rate.js';

type Parameters = Record<string, unknown>;
export interface EffectStep { command: string; params: Parameters }
export interface EffectScope { track: number; trackCount?: number; start: number; end: number }
const FILTERS = new Set(['High-passFilter', 'Low-passFilter', 'NotchFilter', 'ShelfFilter']);
// Native NyquistBase::ProcessOne refuses zero selected audio channels with a
// message box. Generators create their own track input and are not included.
const NYQUIST_AUDIO = new Set(['AdjustableFade', 'BeatFinder', 'ClipFix', 'CrossfadeClips', 'CrossfadeTracks', 'Delay',
  ...FILTERS, 'LegacyLimiter', 'NoiseGate', 'StudioFadeOut', 'Tremolo', 'Vocoder', 'SampleDataExport']);
const NYQUIST_PROCESS = new Set([...NYQUIST_AUDIO].filter((id) => !['BeatFinder', 'SampleDataExport'].includes(id)));
const CONTEXT_EFFECTS = NYQUIST_AUDIO;
const NumberValue = z.number().finite();

function explicitNumber(id: string, params: Parameters, key: string): number {
  if (params[key] === undefined) throw new Error(`${id} requires explicit ${key}; saved UI settings cannot establish dialog-free processing`);
  return NumberValue.parse(params[key]);
}

/** Static guards run before selecting tracks, creating tracks or earlier macro edits. */
export function preflightEffectParameters(id: string, params: Parameters): void {
  if (FILTERS.has(id)) {
    const key = id === 'ShelfFilter' ? 'HZ' : 'FREQUENCY';
    const value = explicitNumber(id, params, key);
    if (value < (id === 'ShelfFilter' ? 10 : 0.1)) throw new Error(`${id} ${key} is below its supported minimum`);
  } else if (id === 'NoiseGate') {
    if (params.MODE !== 'Gate') throw new Error('NoiseGate requires explicit MODE=Gate; Analyze opens a result dialog');
    if (explicitNumber(id, params, 'GATE-FREQ') < 0) throw new Error('NoiseGate GATE-FREQ must be nonnegative');
  } else if (id === 'Vocoder') {
    const levels = ['TRACK-VL', 'NOISE-VL', 'RADAR-VL'].map((key) => explicitNumber(id, params, key));
    if (levels.some((value) => value < 0 || value > 100) || levels.every((value) => value === 0)) throw new Error('Vocoder needs at least one positive carrier level; carrier levels must be between 0 and 100');
  } else if (id === 'LegacyLimiter') {
    if (!['SoftLimit', 'HardLimit', 'SoftClip', 'HardClip'].includes(String(params.TYPE))) throw new Error('LegacyLimiter requires explicit TYPE to preflight its averaging window');
    if (['SoftLimit', 'HardLimit'].includes(String(params.TYPE)) && !(explicitNumber(id, params, 'HOLD') >= 1)) throw new Error('LegacyLimiter limiting modes require HOLD of at least 1 ms');
  } else if (id === 'RhythmTrack') {
    const bars = explicitNumber(id, params, 'BARS');
    if (bars < 0 || !Number.isInteger(bars)) throw new Error('RhythmTrack BARS must be a nonnegative integer');
    if (bars === 0 && !(explicitNumber(id, params, 'CLICK-TRACK-DUR') > 0)) throw new Error('RhythmTrack needs positive BARS or CLICK-TRACK-DUR to avoid a result dialog');
  } else if (id === 'AdjustableFade') {
    if (params.PRESET === undefined) throw new Error('AdjustableFade requires explicit PRESET to avoid unknown saved UI gain settings');
    if (params.PRESET === 'None') {
      if (!['Percent', 'dB'].includes(String(params.UNITS))) throw new Error('AdjustableFade with PRESET=None requires explicit UNITS');
      const gains = ['GAIN0', 'GAIN1'].map((key) => explicitNumber(id, params, key));
      if (params.UNITS === 'Percent' && gains.some((value) => value < 0 || value > 1000)) throw new Error('AdjustableFade percentage gains must be between 0 and 1000');
      if (params.UNITS === 'dB' && gains.some((value) => value > 100)) throw new Error('AdjustableFade dB gains must not exceed 100');
    }
  }
}

export function needsEffectContext(id: string): boolean { return CONTEXT_EFFECTS.has(id); }

/** Preflight source-rate and clip/selection conditions without changing audio. */
export async function preflightEffect(ops: Ops, id: string, params: Parameters, scope?: EffectScope,
  rates = new Map<number, number>()): Promise<void> {
  preflightEffectParameters(id, params);
  if (!needsEffectContext(id)) return;
  const tracks = await ops.tracks();
  const time = scope ?? selectionTimes(await ops.info('Selection'));
  if (!Number.isFinite(time.start) || !Number.isFinite(time.end) || !(time.end > time.start)) throw new Error(`${id} needs a positive-duration audio selection`);
  const selected = tracks.flatMap((track, index) => track.kind === 'wave' &&
    (scope ? index >= scope.track && index < scope.track + (scope.trackCount ?? 1) : !!track.selected) ? [{ track, index }] : []);
  if (!selected.length) throw new Error(`${id} needs selected audio tracks`);
  if (selected.some(({ track }) => !Number.isFinite(track.start) || !Number.isFinite(track.end) || !(track.end > track.start) || time.end <= track.start || time.start >= track.end)) {
    throw new Error(`${id} requires audio within the selected range on every selected track`);
  }
  const allClips = await ops.info('Clips') as { track: number; start: number; end: number }[];
  if (selected.some(({ index }) => !allClips.some((clip) => clip.track === index && clip.start < time.end && clip.end > time.start))) {
    throw new Error(`${id} selection must intersect an audio clip on every selected track; timeline gaps alone are not audio input`);
  }
  if (id === 'CrossfadeTracks') {
    if (selected.length < 2) throw new Error('CrossfadeTracks requires at least two selected audio tracks');
  }
  let crossfadePortions: number[] | undefined;
  if (id === 'CrossfadeClips') {
    if (selected.length !== 1) throw new Error('CrossfadeClips requires exactly one selected audio track');
    const clips = allClips
      .filter((clip) => clip.track === selected[0]!.index && clip.start < time.end && clip.end > time.start).sort((a, b) => a.start - b.start);
    if (clips.length < 1 || clips.length > 2) throw new Error('CrossfadeClips requires one or two audio clips within the selection');
    if (time.start < clips[0]!.start || time.end > clips.at(-1)!.end || (clips.length === 2 && clips[0]!.end > clips[1]!.start)) {
      throw new Error('CrossfadeClips selection must start and end in audio, with no overlapping clips');
    }
    // crossfadeclips.ny halves a continuous selection and removes a gap
    // between two clips. Timeline length alone does not establish output
    // frames; retain at least two source frames in every audio portion.
    crossfadePortions = clips.length === 1 ? [time.end - time.start]
      : [clips[0]!.end - time.start, time.end - clips[1]!.start];
  }
  // Source-rate export is an analyzer and deliberately does not enter this
  // loop. It queries full track extents, so guards cannot recurse through it.
  if (!NYQUIST_PROCESS.has(id)) return;
  for (const { track, index } of selected) {
    let rate = rates.get(index);
    if (rate === undefined) {
      rate = await measureSourceRate(ops, { track: index, start: track.start, end: track.end });
      rates.set(index, rate);
    }
    if (FILTERS.has(id)) {
      const key = id === 'ShelfFilter' ? 'HZ' : 'FREQUENCY';
      const value = Number(params[key]);
      if (id === 'ShelfFilter' ? value > rate / 2 : value >= rate / 2) throw new Error(`${id} ${key}=${value} Hz is too high for track ${index} source sample rate ${rate} Hz`);
    }
    // Native 3.7.8 converts selection endpoints to source samples. A positive
    // sub-sample interval can collapse to zero frames and return nil audio,
    // which NyquistBase::ProcessOne reports in a blocking message box.
    const frames = Math.floor((time.end - time.start) * rate);
    const minimum = id === 'NoiseGate' ? 100 : id === 'StudioFadeOut' ? 3 : id === 'CrossfadeClips' ? 2 : 1;
    if (frames < minimum) throw new Error(`${id} needs at least ${minimum} source frames on track ${index}`);
    // legacy-limiter.ny feeds snd-avg a truncated SoftLimit or rounded
    // HardLimit HOLD*rate/3000 step. Zero reaches native averaging code with
    // a zero divisor. Requiring a full sample before rounding protects both
    // modes conservatively; this crash path must never be live-probed.
    if (id === 'LegacyLimiter' && ['SoftLimit', 'HardLimit'].includes(String(params.TYPE)) && Math.floor(Number(params.HOLD) * rate / 3000) < 1) {
      throw new Error(`LegacyLimiter ${params.TYPE} HOLD is too short for track ${index} source sample rate ${rate} Hz; its averaging window needs at least one full source sample`);
    }
    if (crossfadePortions?.some((duration) => Math.floor(duration * rate) < 2)) {
      throw new Error('CrossfadeClips needs at least 2 source frames in each participating audio portion; timeline gaps do not count');
    }
    if (['NoiseGate', 'StudioFadeOut'].includes(id)) {
      if (time.start < track.start || time.end > track.end) throw new Error(`${id} selection must fit within each selected audio track's extent`);
      if (id === 'NoiseGate' && Number(params['GATE-FREQ']) * 1000 >= rate * 0.45) throw new Error(`NoiseGate GATE-FREQ must be below ${rate * 0.00045} kHz for track ${index} source sample rate ${rate} Hz`);
    }
  }
}

/** Validate every planned stateful effect before the first destructive step. */
export async function preflightScopedEffects(ops: Ops, steps: EffectStep[], scope: EffectScope): Promise<void> {
  const rates = new Map<number, number>();
  for (const step of steps) await preflightEffect(ops, step.command, step.params, scope, rates);
}

const PRESERVES_CONTEXT = new Set(['Amplify', 'Normalize', 'LoudnessNormalization', 'Compressor', 'LegacyCompressor', 'Limiter', 'LegacyLimiter',
  'BassAndTreble', ...FILTERS, 'FadeIn', 'FadeOut', 'StudioFadeOut', 'NoiseGate', 'Invert', 'Reverse', 'Tremolo', 'Wahwah',
  'Vocoder', 'AdjustableFade', 'AutoDuck', 'NoiseReduction', 'CrossfadeTracks']);

/** Conservative macro proof: filters must be safe at every existing audio rate. */
export async function preflightMacroEffects(ops: Ops, steps: EffectStep[]): Promise<void> {
  if (!steps.some((step) => needsEffectContext(step.command))) return;
  let changedSelection = false; let unknownContext = false;
  const rates = new Map<number, number>();
  let tracks: TrackInfo[] | undefined;
  for (const step of steps) {
    if (needsEffectContext(step.command)) {
      if (unknownContext) throw new Error(`macro ${step.command} cannot be preflighted after topology, generation or timing changes; use separate typed operations`);
      if (FILTERS.has(step.command)) {
        tracks ??= await ops.tracks();
        const audio = tracks.flatMap((track, index) => track.kind === 'wave' ? [{ track, index }] : []);
        if (!audio.length) throw new Error(`macro ${step.command} needs existing audio tracks for source-rate preflight`);
        for (const { track, index } of audio) await preflightEffect(ops, step.command, step.params, { track: index, start: track.start, end: track.end }, rates);
      } else {
        if (changedSelection) throw new Error(`macro ${step.command} needs selection-dependent preflight; place it before selection changes or use audacity_effect separately`);
        await preflightEffect(ops, step.command, step.params, undefined, rates);
      }
    }
    const selection = /^(Select|Sel|Curs)/.test(step.command);
    if (selection) changedSelection = true;
    else if (!PRESERVES_CONTEXT.has(step.command) && !step.command.startsWith('Get')) unknownContext = true;
  }
}
