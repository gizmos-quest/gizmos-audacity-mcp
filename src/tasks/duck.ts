import { z } from 'zod';
import { catalogueCommand } from '../format.js';
import type { Ops } from '../ops.js';
import { Seconds, Track } from '../tool-input.js';
import { audioTrack, resolveRange, validRange } from './scope.js';

export const AutoDuckSchema = z
  .object({
    bed: Track.describe('bed track index (0-based) or unique name; must immediately precede the voice track'),
    voice: Track.describe('voice track index (0-based) or unique name; must immediately follow the bed track'),
    start: Seconds.optional(),
    end: Seconds.optional(),
    // Native AutoDuck limits (catalogue/parameters.json); others open a modal.
    duckDb: z.number().min(-24).max(0).default(-12).describe('attenuation applied to the bed, in dB'),
    thresholdDb: z.number().min(-100).max(0).default(-30).describe('voice detection threshold, in dB'),
    fadeDown: z.number().min(0).max(3).default(0.5).describe('outer fade-down duration, in seconds'),
    fadeUp: z.number().min(0).max(3).default(0.5).describe('outer fade-up duration, in seconds'),
    innerFadeDown: z.number().min(0).max(3).default(0).describe('inner fade-down duration, in seconds'),
    innerFadeUp: z.number().min(0).max(3).default(0).describe('inner fade-up duration, in seconds'),
    maximumPause: z.number().min(0).max(60).default(1).describe('maximum pause to bridge while ducking, in seconds'),
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
      'Auto Duck requires the voice to be the immediately following audio track below the bed; use audacity_fresh with backupTo and import the bed before the voice for a new mix, or use audacity_envelope_set for editable ducking in the existing track order',
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
