import { z } from 'zod';
import { type Measurement, round } from './types.js';

const Bound = z
  .object({ min: z.number().finite().optional(), max: z.number().finite().optional() })
  .strict()
  .refine((b) => b.min !== undefined || b.max !== undefined, 'a target needs min or max')
  .refine((b) => b.min === undefined || b.max === undefined || b.max >= b.min, 'target max must be >= min');
export const TargetSchema = z
  .object({
    integratedLufs: Bound.optional(),
    truePeakDbtp: Bound.optional(),
    rmsDbfs: Bound.optional(),
    peakDbfs: Bound.optional(),
    noiseFloorDbfs: Bound.optional(),
  })
  .strict()
  .refine((value) => Object.values(value).some((v) => v !== undefined), 'supply at least one target');
export type Targets = z.infer<typeof TargetSchema>;

/** Numeric house references, not certification or promises about a platform's playback policy. */
export const TARGETS = {
  podcast: { integratedLufs: { min: -17, max: -15 }, truePeakDbtp: { max: -1 } },
  video: { integratedLufs: { min: -15, max: -13 }, truePeakDbtp: { max: -1 } },
  broadcast: { integratedLufs: { min: -23.5, max: -22.5 }, truePeakDbtp: { max: -1 } },
  audiobook: { rmsDbfs: { min: -23, max: -18 }, peakDbfs: { max: -3 }, noiseFloorDbfs: { max: -60 } },
  premaster: { integratedLufs: { min: -19, max: -17 }, truePeakDbtp: { max: -1 } },
} as const satisfies Record<string, Targets>;

export interface TargetCheck {
  status: 'met' | 'missed' | 'unknown';
  actual: number | null;
  target: { min?: number; max?: number };
  reason?: string;
  gap?: number;
}
export function checkTargets(
  measurement: Measurement,
  targets: Targets,
): { status: 'met' | 'missed' | 'unknown'; checks: Record<string, TargetCheck> } {
  const validated = TargetSchema.parse(targets);
  const checks: Record<string, TargetCheck> = {};
  for (const [metric, target] of Object.entries(validated)) {
    if (target === undefined) continue;
    const value = metric === 'noiseFloorDbfs' ? null : measurement[metric as keyof Measurement];
    const actual = typeof value === 'number' && Number.isFinite(value) ? value : null;
    if (actual === null)
      checks[metric] = {
        status: 'unknown',
        actual,
        target,
        reason:
          metric === 'noiseFloorDbfs'
            ? 'Quiet-block RMS is an estimate; it cannot certify the recording noise floor. Measure isolated room tone separately.'
            : (measurement.unavailable[metric] ?? 'No finite measurement (silence or empty audio).'),
      };
    else if ((target.min !== undefined && actual < target.min) || (target.max !== undefined && actual > target.max)) {
      checks[metric] = {
        status: 'missed',
        actual,
        target,
        gap: round(target.min !== undefined && actual < target.min ? actual - target.min : actual - target.max!),
      };
    } else checks[metric] = { status: 'met', actual, target };
  }
  const statuses = Object.values(checks).map((c) => c.status);
  return { status: statuses.includes('missed') ? 'missed' : statuses.includes('unknown') ? 'unknown' : 'met', checks };
}

export function compareMeasurements(
  before: Measurement,
  after: Measurement,
): Record<string, { before: number; after: number; change: number }> {
  const delta: Record<string, { before: number; after: number; change: number }> = {};
  for (const key of [
    'duration',
    'peakDbfs',
    'rmsDbfs',
    'crestDb',
    'dcOffset',
    'clippedSamples',
    'discontinuities',
    'silenceGapCount',
    'quietRmsDbfsEstimate',
    'dynamicRangeDbEstimate',
    'integratedLufs',
    'truePeakDbtp',
    'loudnessRangeLu',
  ] as const) {
    const a = before[key];
    const b = after[key];
    if (a !== null && b !== null && Number.isFinite(a) && Number.isFinite(b))
      delta[key] = { before: a, after: b, change: round(b - a) };
  }
  return delta;
}

export const LoudnessTargetShape = {
  targetLufs: z.number().finite().min(-50).max(-5).default(-16),
  truePeakCeilingDbtp: z.number().finite().min(-20).max(0).default(-1),
  maxBoostDb: z.number().finite().min(0).max(36).default(18),
  toleranceLu: z.number().finite().min(0.1).max(3).default(0.5),
};
export const LoudnessTargetSchema = z.object(LoudnessTargetShape).strict();

/** Plan static sample gain from established LUFS/true peak; never infer either from RMS/sample peak. */
export function planLoudnessTarget(before: Measurement, input: z.input<typeof LoudnessTargetSchema> = {}) {
  const args = LoudnessTargetSchema.parse(input);
  if (
    before.integratedLufs === null ||
    !Number.isFinite(before.integratedLufs) ||
    before.truePeakDbtp === null ||
    !Number.isFinite(before.truePeakDbtp) ||
    before.rms <= 0
  ) {
    throw new Error(
      'Loudness targeting requires established integrated LUFS and true peak from non-silent audio; install ffmpeg and measure a longer selection.',
    );
  }
  const requestedGainDb = args.targetLufs - before.integratedLufs;
  // ffmpeg's text summary rounds true peak to 0.1 dB. Retain that much
  // additional headroom rather than pretend its printed peak is exact.
  const peakHeadroomDb = args.truePeakCeilingDbtp - before.truePeakDbtp - 0.1;
  const gainDb = Math.min(requestedGainDb, peakHeadroomDb, args.maxBoostDb);
  if (gainDb < -60)
    throw new Error(
      'The requested true-peak ceiling needs more than 60 dB attenuation; choose a sensible source/ceiling.',
    );
  const limits = [
    ...(peakHeadroomDb < requestedGainDb ? ['true-peak ceiling'] : []),
    ...(args.maxBoostDb < requestedGainDb ? ['maximum boost'] : []),
  ];
  return {
    ...args,
    requestedGainDb: round(requestedGainDb),
    peakHeadroomDb: round(peakHeadroomDb),
    gainDb: round(gainDb),
    ratio: 10 ** (gainDb / 20),
    predictedLufs: round(before.integratedLufs + gainDb),
    predictedTruePeakDbtp: round(before.truePeakDbtp + gainDb),
    achievable: Math.abs(before.integratedLufs + gainDb - args.targetLufs) <= args.toleranceLu,
    limits,
  };
}
