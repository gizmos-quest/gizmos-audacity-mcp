import type { Ops, TrackInfo } from '../ops.js';
import { type EffectStep, needsEffectContext, preflightEffect } from './context.js';
import { FILTERS } from './parameters.js';

const PRESERVES_CONTEXT = new Set([
  'Amplify',
  'Normalize',
  'LoudnessNormalization',
  'Compressor',
  'LegacyCompressor',
  'Limiter',
  'LegacyLimiter',
  'BassAndTreble',
  ...FILTERS,
  'FadeIn',
  'FadeOut',
  'StudioFadeOut',
  'NoiseGate',
  'Invert',
  'Reverse',
  'Tremolo',
  'Wahwah',
  'Vocoder',
  'AdjustableFade',
  'AutoDuck',
  'NoiseReduction',
  'CrossfadeTracks',
]);

/** Conservative macro proof: filters must be safe at every existing audio rate. */
export async function preflightMacroEffects(ops: Ops, steps: EffectStep[]): Promise<void> {
  if (!steps.some((step) => needsEffectContext(step.command))) return;
  let changedSelection = false;
  let unknownContext = false;
  const rates = new Map<number, number>();
  let tracks: TrackInfo[] | undefined;
  for (const step of steps) {
    if (needsEffectContext(step.command)) {
      if (unknownContext)
        throw new Error(
          `macro ${step.command} cannot be preflighted after topology, generation or timing changes; use separate typed operations`,
        );
      if (FILTERS.has(step.command)) {
        tracks ??= await ops.tracks();
        const audio = tracks.flatMap((track, index) => (track.kind === 'wave' ? [{ track, index }] : []));
        if (!audio.length)
          throw new Error(`macro ${step.command} needs existing audio tracks for source-rate preflight`);
        for (const { track, index } of audio)
          await preflightEffect(
            ops,
            step.command,
            step.params,
            { track: index, start: track.start, end: track.end },
            rates,
          );
      } else {
        if (changedSelection)
          throw new Error(
            `macro ${step.command} needs selection-dependent preflight; place it before selection changes or use audacity_effect separately`,
          );
        await preflightEffect(ops, step.command, step.params, undefined, rates);
      }
    }
    const selection = /^(Select|Sel|Curs)/.test(step.command);
    if (selection) changedSelection = true;
    else if (!PRESERVES_CONTEXT.has(step.command) && !step.command.startsWith('Get')) unknownContext = true;
  }
}
