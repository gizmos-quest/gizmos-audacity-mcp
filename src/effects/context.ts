// Original safeguards researched from Audacity-3.7.8/plug-ins/*.ny and
// libraries/lib-nyquist-effects/NyquistBase.cpp. A non-empty string result
// opens a message box, including parameter/context errors in these effects.
// Live exact English Audacity 3.7.8, 2026-10-02: a 5000 Hz filter cutoff on
// an 8000 Hz source opened the native error dialog despite a 48000 Hz project.
// Source-rate guards therefore use the silent sample header, not WAV render rate.

import { clipsInfo, selectionTimes } from '../audacity/info.js';
import { EFFECT_IDS } from '../catalogue.js';
import type { Ops, TrackInfo } from '../ops.js';
import { measureSourceRate } from '../source-rate.js';
import { NATIVE_CONTEXT, preflightNativeEffect } from './native.js';
import { FILTERS, type Parameters, preflightEffectParameters } from './parameters.js';

export interface EffectStep {
  command: string;
  params: Parameters;
}
export interface EffectScope {
  track: number;
  trackCount?: number;
  start: number;
  end: number;
}

// Native NyquistBase::ProcessOne refuses zero selected audio channels with a
// message box. Generators create their own track input and are not included.
const NYQUIST_AUDIO = new Set([
  'AdjustableFade',
  'BeatFinder',
  'ClipFix',
  'CrossfadeClips',
  'CrossfadeTracks',
  'Delay',
  ...FILTERS,
  'LegacyLimiter',
  'NoiseGate',
  'StudioFadeOut',
  'Tremolo',
  'Vocoder',
  'SampleDataExport',
]);
const CONTEXT_EFFECTS = new Set([...NYQUIST_AUDIO, 'AutoDuck', ...NATIVE_CONTEXT]);
export function needsEffectContext(id: string): boolean {
  return CONTEXT_EFFECTS.has(id);
}

const inScope = (scope: EffectScope | undefined, track: TrackInfo, index: number) =>
  scope ? index >= scope.track && index < scope.track + (scope.trackCount ?? 1) : !!track.selected;

/** Every effect, generators included, opens a modal without a selected track that
 * supports editing (all but time tracks) or with an empty time selection, unless
 * /GUI/SelectAllOnNone is set (Audacity-3.7.8 src/BatchCommands.cpp:543-551,
 * src/SelectUtilities.cpp:100-114). Context effects check this in preflightEffect. */
export async function requireEffectSelection(ops: Ops, id: string, scope?: EffectScope): Promise<void> {
  if (!EFFECT_IDS.includes(id) || needsEffectContext(id)) return;
  const time = scope ?? selectionTimes(await ops.info('Selection'));
  const tracks = await ops.tracks();
  if (!(time.end > time.start) || !tracks.some((track, index) => inScope(scope, track, index) && track.kind !== 'time'))
    throw new Error(`${id} needs a selected audio or label track and a non-empty time selection`);
}

/** Preflight source-rate and clip/selection conditions without changing audio. */
export async function preflightEffect(
  ops: Ops,
  id: string,
  params: Parameters,
  scope?: EffectScope,
  rates = new Map<number, number>(),
): Promise<void> {
  preflightEffectParameters(id, params);
  if (!needsEffectContext(id)) return;
  const tracks = await ops.tracks();
  const time = scope ?? selectionTimes(await ops.info('Selection'));
  if (!Number.isFinite(time.start) || !Number.isFinite(time.end) || !(time.end > time.start))
    throw new Error(`${id} needs a positive-duration audio selection`);
  if (!tracks.some((track, index) => inScope(scope, track, index) && track.kind !== 'time'))
    throw new Error(`${id} needs a selected audio or label track`);
  if (NATIVE_CONTEXT.has(id)) {
    const audio = tracks.flatMap((track, index) =>
      track.kind === 'wave' && inScope(scope, track, index) ? [{ track, index }] : [],
    );
    return preflightNativeEffect(id, params, time, audio, async ({ track, index }) => {
      const known =
        rates.get(index) ?? (await measureSourceRate(ops, { track: index, start: track.start, end: track.end }));
      rates.set(index, known);
      return known;
    });
  }
  if (id === 'AutoDuck') {
    // Audacity-3.7.8 AutoDuckBase::Init walks every native track, not just
    // audio tracks. Selected labels or a label below the last bed open modals.
    const beds = tracks.flatMap((track, index) => (inScope(scope, track, index) ? [{ track, index }] : []));
    if (!beds.length || beds.some(({ track }) => track.kind !== 'wave'))
      throw new Error('AutoDuck requires selected audio tracks only');
    const controlIndex = beds.at(-1)!.index + 1;
    if (tracks[controlIndex]?.kind !== 'wave' || beds.some(({ index }) => index === controlIndex)) {
      throw new Error(
        'AutoDuck requires an unselected audio control track immediately below the last selected audio track',
      );
    }
  }
  const selected = tracks.flatMap((track, index) =>
    track.kind === 'wave' && inScope(scope, track, index) ? [{ track, index }] : [],
  );
  if (!selected.length) throw new Error(`${id} needs selected audio tracks`);
  if (
    selected.some(
      ({ track }) =>
        !Number.isFinite(track.start) ||
        !Number.isFinite(track.end) ||
        !(track.end > track.start) ||
        time.end <= track.start ||
        time.start >= track.end,
    )
  ) {
    throw new Error(`${id} requires audio within the selected range on every selected track`);
  }
  const allClips = clipsInfo(await ops.info('Clips'));
  if (
    selected.some(
      ({ index }) => !allClips.some((clip) => clip.track === index && clip.start < time.end && clip.end > time.start),
    )
  ) {
    throw new Error(
      `${id} selection must intersect an audio clip on every selected track; timeline gaps alone are not audio input`,
    );
  }
  if (id === 'CrossfadeTracks') {
    if (selected.length < 2) throw new Error('CrossfadeTracks requires at least two selected audio tracks');
  }
  let crossfadePortions: number[] | undefined;
  if (id === 'CrossfadeClips') {
    if (selected.length !== 1) throw new Error('CrossfadeClips requires exactly one selected audio track');
    const clips = allClips
      .filter((clip) => clip.track === selected[0]!.index && clip.start < time.end && clip.end > time.start)
      .sort((a, b) => a.start - b.start);
    if (clips.length < 1 || clips.length > 2)
      throw new Error('CrossfadeClips requires one or two audio clips within the selection');
    if (
      time.start < clips[0]!.start ||
      time.end > clips.at(-1)!.end ||
      (clips.length === 2 && clips[0]!.end > clips[1]!.start)
    ) {
      throw new Error('CrossfadeClips selection must start and end in audio, with no overlapping clips');
    }
    // crossfadeclips.ny halves a continuous selection and removes a gap
    // between two clips. Timeline length alone does not establish output
    // frames; retain at least two source frames in every audio portion.
    crossfadePortions =
      clips.length === 1 ? [time.end - time.start] : [clips[0]!.end - time.start, time.end - clips[1]!.start];
  }
  if (id === 'AutoDuck') return;
  for (const { track, index } of selected) {
    let rate = rates.get(index);
    if (rate === undefined) {
      rate = await measureSourceRate(ops, { track: index, start: track.start, end: track.end });
      rates.set(index, rate);
    }
    if (FILTERS.has(id)) {
      const key = id === 'ShelfFilter' ? 'HZ' : 'FREQUENCY';
      const value = Number(params[key]);
      if (id === 'ShelfFilter' ? value > rate / 2 : value >= rate / 2)
        throw new Error(`${id} ${key}=${value} Hz is too high for track ${index} source sample rate ${rate} Hz`);
    }
    // Native 3.7.8 converts selection endpoints to source samples. A positive
    // sub-sample interval can collapse to zero frames and return nil audio,
    // which NyquistBase::ProcessOne reports in a blocking message box.
    const frames = Math.floor((time.end - time.start) * rate);
    const minimum = id === 'NoiseGate' ? 100 : id === 'StudioFadeOut' ? 3 : id === 'CrossfadeClips' ? 2 : 1;
    if (frames < minimum) throw new Error(`${id} needs at least ${minimum} source frames on track ${index}`);
    // Sample Data Export truncates len before averaging/dividing NUMBER in
    // full/HTML headers; BeatFinder also evaluates source input. Analyzer
    // labels do not establish that a sub-frame native selection is safe.
    // legacy-limiter.ny feeds snd-avg a truncated SoftLimit or rounded
    // HardLimit HOLD*rate/3000 step. Zero reaches native averaging code with
    // a zero divisor. Requiring a full sample before rounding protects both
    // modes conservatively; this crash path must never be live-probed.
    if (
      id === 'LegacyLimiter' &&
      ['SoftLimit', 'HardLimit'].includes(String(params.TYPE)) &&
      Math.floor((Number(params.HOLD) * rate) / 3000) < 1
    ) {
      throw new Error(
        `LegacyLimiter ${params.TYPE} HOLD is too short for track ${index} source sample rate ${rate} Hz; its averaging window needs at least one full source sample`,
      );
    }
    if (crossfadePortions?.some((duration) => Math.floor(duration * rate) < 2)) {
      throw new Error(
        'CrossfadeClips needs at least 2 source frames in each participating audio portion; timeline gaps do not count',
      );
    }
    if (['NoiseGate', 'StudioFadeOut'].includes(id)) {
      if (time.start < track.start || time.end > track.end)
        throw new Error(`${id} selection must fit within each selected audio track's extent`);
      if (id === 'NoiseGate' && Number(params['GATE-FREQ']) * 1000 >= rate * 0.45)
        throw new Error(
          `NoiseGate GATE-FREQ must be below ${rate * 0.00045} kHz for track ${index} source sample rate ${rate} Hz`,
        );
    }
  }
}

/** Validate every planned stateful effect before the first destructive step. */
export async function preflightScopedEffects(ops: Ops, steps: EffectStep[], scope: EffectScope): Promise<void> {
  const rates = new Map<number, number>();
  for (const step of steps) await preflightEffect(ops, step.command, step.params, scope, rates);
}
