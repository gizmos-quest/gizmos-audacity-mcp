// Reviewed editing and processing tasks built from Audacity's own catalogue.
// Pipeline ideas were independently implemented after studying xDarkzx/Audacity-MCP
// and FFriends/MCP-Audacity; parameter names come from this host's 3.7.8 catalogue.
import { z } from 'zod';
import { preflightScopedEffects } from '../effects/context.js';
import { preflightEffectParameters } from '../effects/parameters.js';
import { catalogueCommand, type ParamValue } from '../format.js';
import { errorWithContext, type Ops, type TrackRef } from '../ops.js';
import type { ToolProgress } from '../tools.js';
import { audioTrack, Frequency, resolveRange, Scope, Seconds, validRange } from './scope.js';

const NoiseProfile = z
  .object({
    start: Seconds,
    end: Seconds,
  })
  .strict()
  .refine(validRange, { message: 'noise profile end must be after start' });

const ShortenPauses = z
  .object({
    thresholdDb: z.number().finite().min(-80).max(-20).default(-40), // native TruncateSilence limit
    minimum: z.number().finite().min(0.01).max(60).default(0.5),
    truncateTo: z.number().finite().min(0).max(60).default(0.3),
  })
  .strict()
  .refine((a) => a.truncateTo <= a.minimum, { message: 'truncateTo must not exceed minimum' });

export const PipelineSchema = z
  .object({
    preset: z
      .enum(['cleanup', 'voice', 'podcast', 'interview', 'audiobook', 'vocal', 'live', 'music', 'lofi'])
      .default('voice'),
    ...Scope,
    dryRun: z.boolean().default(false),
    noiseProfile: NoiseProfile.optional().describe('explicit room-tone interval; omitting it skips noise reduction'),
    shortenPauses: ShortenPauses.optional().describe(
      'optional destructive silence truncation; changes timing and video sync',
    ),
    removeDc: z.boolean().default(true),
    highPassHz: Frequency.optional(),
    lowPassHz: Frequency.optional(),
    removeClicks: z
      .boolean()
      .default(false)
      .refine((enabled) => !enabled, {
        message: 'Click removal is unavailable: Audacity 3.7.8 opens a blocking modal dialog when no clicks are found.',
      })
      .describe('must remain false: native Click Removal can open a blocking result dialog'),
    compress: z.boolean().optional(),
    thresholdDb: z.number().finite().min(-60).max(0).optional(),
    ratio: z.number().finite().min(1).max(20).optional(),
    // Native Compressor limits (catalogue/parameters.json); others open a modal.
    attackMs: z.number().finite().min(0).max(200).optional(),
    releaseMs: z.number().finite().min(1).max(1000).optional(),
    bassDb: z.number().finite().min(-20).max(20).optional(),
    trebleDb: z.number().finite().min(-20).max(20).optional(),
    loudness: z
      .enum(['none', 'peak', 'lufs', 'rms'])
      .default('none')
      .describe('normalization can raise quiet audio; select it explicitly'),
    peakDb: z.number().finite().min(-60).max(0).default(-1),
    lufs: z.number().finite().min(-50).max(-5).default(-16),
    rmsDb: z.number().finite().min(-50).max(-5).default(-20),
    limitPeakDb: z
      .number()
      .finite()
      .min(-20)
      .max(0)
      .optional()
      .describe('optional limiter after normalization; measure the result'),
  })
  .strict()
  .refine(validRange, { message: 'end must be after start' });

export type PipelineArgs = z.input<typeof PipelineSchema>;
export interface PipelineStep {
  name: string;
  command: string;
  params: Record<string, ParamValue>;
  scope: { track: TrackRef; start?: number; end?: number };
  captureProfile?: true;
}

interface Preset {
  highPassHz: number;
  lowPassHz?: number;
  thresholdDb: number;
  ratio: number;
  attackMs: number;
  releaseMs: number;
  bassDb?: number;
  trebleDb?: number;
}

// Conservative starting points, not promises of platform/ACX compliance.
const PRESETS: Record<z.infer<typeof PipelineSchema>['preset'], Preset> = {
  cleanup: { highPassHz: 80, thresholdDb: -18, ratio: 1, attackMs: 30, releaseMs: 200 },
  voice: { highPassHz: 80, thresholdDb: -18, ratio: 3, attackMs: 20, releaseMs: 200 },
  podcast: { highPassHz: 80, thresholdDb: -18, ratio: 3, attackMs: 30, releaseMs: 200 },
  interview: { highPassHz: 80, thresholdDb: -20, ratio: 2, attackMs: 20, releaseMs: 200 },
  audiobook: { highPassHz: 80, thresholdDb: -18, ratio: 2.5, attackMs: 10, releaseMs: 1000 },
  vocal: { highPassHz: 100, thresholdDb: -16, ratio: 3, attackMs: 10, releaseMs: 500, bassDb: -1, trebleDb: 2 },
  live: { highPassHz: 100, thresholdDb: -14, ratio: 4, attackMs: 10, releaseMs: 500 },
  music: { highPassHz: 30, thresholdDb: -16, ratio: 1.5, attackMs: 100, releaseMs: 300 },
  lofi: {
    highPassHz: 100,
    lowPassHz: 8000,
    thresholdDb: -16,
    ratio: 2,
    attackMs: 100,
    releaseMs: 300,
    bassDb: 2,
    trebleDb: -2,
  },
};

/** Pure planning: validate every command before any selection or audio mutation. */
export function planPipeline(input: unknown): { preset: string; steps: PipelineStep[]; notes: string[] } {
  const args = PipelineSchema.parse(input);
  const preset = PRESETS[args.preset];
  const scope = { track: args.track, start: args.start, end: args.end };
  const steps: PipelineStep[] = [];
  const add = (name: string, command: string, params: Record<string, ParamValue>, stepScope = scope) => {
    catalogueCommand(command, params);
    preflightEffectParameters(command, params);
    steps.push({ name, command, params, scope: stepScope });
  };
  if (args.noiseProfile) {
    const { start, end } = args.noiseProfile;
    add('Capture or reuse supplied room-tone noise profile', 'NoiseReduction', {}, { track: args.track, start, end });
    steps.at(-1)!.captureProfile = true;
    add('Reduce profiled background noise using saved Audacity settings', 'NoiseReduction', {});
  }
  if (args.removeDc)
    add('Remove DC offset without normalization', 'Normalize', {
      RemoveDcOffset: true,
      ApplyVolume: false,
      StereoIndependent: false,
      PeakLevel: -1,
    });
  add('Remove low-frequency rumble', 'High-passFilter', {
    FREQUENCY: args.highPassHz ?? preset.highPassHz,
    ROLLOFF: 'dB12',
  });
  const lowPassHz = args.lowPassHz ?? preset.lowPassHz;
  if (lowPassHz !== undefined) add('Low-pass filtering', 'Low-passFilter', { FREQUENCY: lowPassHz, ROLLOFF: 'dB12' });
  if (args.shortenPauses) {
    // Exact catalogue parameters ran without a dialog on live Audacity 3.7.8 (2026-10-02).
    add('Shorten detected pauses (changes timing)', 'TruncateSilence', {
      Threshold: args.shortenPauses.thresholdDb,
      Minimum: args.shortenPauses.minimum,
      Truncate: args.shortenPauses.truncateTo,
      Action: 'Truncate Detected Silence',
      Independent: false,
      TruncateStart: true,
      TruncateMiddle: true,
      TruncateEnd: true,
    });
  }
  if (args.compress ?? args.preset !== 'cleanup') {
    add('Compress dynamics without makeup gain', 'Compressor', {
      thresholdDb: args.thresholdDb ?? preset.thresholdDb,
      compressionRatio: args.ratio ?? preset.ratio,
      attackMs: args.attackMs ?? preset.attackMs,
      releaseMs: args.releaseMs ?? preset.releaseMs,
      makeupGainDb: 0,
      kneeWidthDb: 5,
      lookaheadMs: 1,
    });
  }
  const bass = args.bassDb ?? preset.bassDb ?? 0;
  const treble = args.trebleDb ?? preset.trebleDb ?? 0;
  if (bass !== 0 || treble !== 0)
    add('Shape bass and treble', 'BassAndTreble', { Bass: bass, Treble: treble, Gain: 0 });
  if (args.loudness === 'peak')
    add('Normalize sample peak', 'Normalize', {
      PeakLevel: args.peakDb,
      ApplyVolume: true,
      RemoveDcOffset: false,
      StereoIndependent: false,
    });
  if (args.loudness === 'lufs' || args.loudness === 'rms') {
    add(`Normalize ${args.loudness.toUpperCase()}`, 'LoudnessNormalization', {
      NormalizeTo: args.loudness === 'lufs' ? 0 : 1,
      LUFSLevel: args.lufs,
      RMSLevel: args.rmsDb,
      StereoIndependent: false,
      DualMono: true,
    });
  }
  if (args.limitPeakDb !== undefined)
    add('Limit peaks without makeup boost', 'Limiter', {
      thresholdDb: args.limitPeakDb,
      makeupTargetDb: args.limitPeakDb,
      kneeWidthDb: 0,
      lookaheadMs: 5,
      releaseMs: 50,
    });
  const notes = [
    "Default scope is the target track's own extent, recalculated before each step.",
    'Processing changes samples; save a project backup and measure the result.',
  ];
  if (!args.noiseProfile) notes.push('Noise reduction skipped: no room-tone interval was supplied.');
  else
    notes.push(
      'Audacity 3.7.8 uses saved noise-reduction settings. Only one profile can be captured per fresh process; the exact same interval can reuse it. Scripting cannot change reduction, sensitivity or smoothing.',
    );
  if (args.loudness !== 'none') notes.push('Normalization may boost quiet audio and background noise.');
  if (args.limitPeakDb !== undefined)
    notes.push('Limiting can alter the requested LUFS/RMS; verify loudness and true peak after processing.');
  if (args.shortenPauses) notes.push('Silence truncation changes duration and alignment with video and other tracks.');
  return { preset: args.preset, steps, notes };
}

export async function pipeline(ops: Ops, input: unknown, progress?: ToolProgress): Promise<unknown> {
  const args = PipelineSchema.parse(input);
  const plan = planPipeline(args);
  if (args.dryRun) return { dryRun: true, ...plan };
  // Preflight the processing range before capturing a profile (which changes
  // Audacity's effect state). Subsequent steps still recalculate track extents.
  const processingRange = await resolveRange(ops, args);
  if (args.noiseProfile) {
    const { info } = await audioTrack(ops, args.track);
    if (args.noiseProfile.start < info.start || args.noiseProfile.end > info.end)
      throw new Error('noise profile must be inside the target track extent');
  }
  await preflightScopedEffects(ops, plan.steps, processingRange);
  const applied: string[] = [];
  for (const step of plan.steps) {
    await progress?.(applied.length, plan.steps.length, step.name);
    try {
      const range = await resolveRange(ops, step.scope);
      if (step.captureProfile) await ops.captureNoiseProfile(range.track, range.start, range.end);
      else {
        await ops.select(range);
        await ops.command(step.command, step.params, 600_000);
      }
      applied.push(step.name);
      await progress?.(applied.length, plan.steps.length, `Completed: ${step.name}`);
    } catch (error) {
      throw errorWithContext(
        error,
        `pipeline stopped at "${step.name}" after ${applied.length} completed steps: ${error instanceof Error ? error.message : String(error)}`,
      );
    }
  }
  return { dryRun: false, ...plan, applied };
}
