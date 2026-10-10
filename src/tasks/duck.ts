import { z } from 'zod';
import { catalogueCommand } from '../format.js';
import type { Ops } from '../ops.js';
import { audioTrack, resolveRange, Seconds, Track, validRange } from './scope.js';

export const AutoDuckSchema = z
  .object({
    bed: Track,
    voice: Track,
    start: Seconds.optional(),
    end: Seconds.optional(),
    // Native AutoDuck limits (catalogue/parameters.json); others open a modal.
    duckDb: z.number().finite().min(-24).max(0).default(-12),
    thresholdDb: z.number().finite().min(-100).max(0).default(-30),
    fadeDown: z.number().finite().min(0).max(3).default(0.5),
    fadeUp: z.number().finite().min(0).max(3).default(0.5),
    innerFadeDown: z.number().finite().min(0).max(3).default(0),
    innerFadeUp: z.number().finite().min(0).max(3).default(0),
    maximumPause: z.number().finite().min(0).max(60).default(1),
    dryRun: z.boolean().default(false),
  })
  .strict()
  .refine(validRange, { message: 'end must be after start' });

export async function autoDuck(ops: Ops, input: unknown): Promise<unknown> {
  const args = AutoDuckSchema.parse(input);
  const bed = await audioTrack(ops, args.bed);
  const voice = await audioTrack(ops, args.voice);
  const tracks = await ops.tracks();
  // AutoDuckBase::Init in Audacity-3.7.8 walks the complete track list. An
  // intervening label clears the control candidate and opens a native modal.
  if (voice.index !== bed.index + 1 || tracks[bed.index + 1]?.kind !== 'wave') {
    throw new Error(
      'Auto Duck requires the voice to be the immediately following audio track below the bed; reorder the tracks first',
    );
  }
  const params = {
    DuckAmountDb: args.duckDb,
    ThresholdDb: args.thresholdDb,
    OuterFadeDownLen: args.fadeDown,
    OuterFadeUpLen: args.fadeUp,
    InnerFadeDownLen: args.innerFadeDown,
    InnerFadeUpLen: args.innerFadeUp,
    MaximumPause: args.maximumPause,
  };
  catalogueCommand('AutoDuck', params);
  const scope = await resolveRange(ops, { track: bed.index, start: args.start, end: args.end });
  if (args.dryRun) return { dryRun: true, command: 'AutoDuck', params, scope, voice: voice.index };
  await ops.select(scope); // The unselected next audio track is Audacity's control track.
  await ops.command('AutoDuck', params, 600_000);
  return { dryRun: false, bed: bed.index, voice: voice.index, params, scope };
}
