import { z } from 'zod';
import { catalogueCommand } from '../format.js';
import type { Ops } from '../ops.js';
import { Seconds, Track } from '../tool-input.js';
import { MeasureScopeSchema } from './options.js';
import { measureScope } from './render.js';
import { checkTargets, LoudnessTargetShape, planLoudnessTarget } from './targets.js';

export const LoudnessApplySchema = z
  .object({
    track: Track,
    start: Seconds.optional(),
    end: Seconds.optional(),
    ...LoudnessTargetShape,
    dryRun: z.boolean().default(false),
  })
  .strict();

/** Measurement injection keeps planning/orchestration testable without spawning Audacity or ffmpeg. */
export async function loudnessTarget(ops: Ops, input: unknown, measure = measureScope): Promise<unknown> {
  const { track, start, end, dryRun, ...targets } = LoudnessApplySchema.parse(input);
  const index = await ops.trackIndex(track);
  const info = (await ops.tracks())[index]!;
  if (info.kind !== 'wave') throw new Error('loudness targeting needs an audio track');
  const scope = { track: index, start: start ?? info.start, end: end ?? info.end };
  MeasureScopeSchema.parse(scope);
  const before = await measure(ops, scope, { backend: 'ffmpeg' });
  const plan = planLoudnessTarget(before, targets);
  const steps = [{ command: 'Amplify', params: { Ratio: plan.ratio, AllowClipping: true }, scope }];
  catalogueCommand('Amplify', steps[0]!.params);
  if (dryRun) return { dryRun, before, plan, steps };
  await ops.select(scope);
  // Current track gain/pan/envelopes may lower the rendered level, so
  // Audacity's float samples may exceed full scale while the rendered
  // true peak stays within the measured ceiling. Verify the export again.
  await ops.command('Amplify', steps[0]!.params, 600_000);
  const after = await measure(ops, scope, { backend: 'ffmpeg' });
  const targetCheck = checkTargets(after, {
    integratedLufs: { min: plan.targetLufs - plan.toleranceLu, max: plan.targetLufs + plan.toleranceLu },
    truePeakDbtp: { max: plan.truePeakCeilingDbtp },
  });
  return {
    dryRun,
    before,
    after,
    plan,
    steps,
    targetCheck,
    samplePeakDbfs: after.peakDbfs,
    clippedSamples: after.clippedSamples,
    notes: [
      'Static gain preserves dynamics; a peak-limited source may require a separately reviewed limiter/compressor pipeline to reach the requested LUFS.',
    ],
  };
}
