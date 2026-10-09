import { z } from 'zod';
import { SafeString } from '../catalogue.js';
import { type SilenceOptions, SilenceSchema } from './types.js';

export interface MeasureOptions {
  backend?: 'auto' | 'wav' | 'ffmpeg';
  dualMono?: boolean;
  timeoutMs?: number;
  silence?: SilenceOptions;
}

const Seconds = z.number().finite().min(0).max(86_400);
const Track = z.union([z.number().int().nonnegative(), SafeString.min(1)]);
export const MeasureScopeShape = {
  track: Track.optional(),
  trackCount: z.number().int().min(1).max(256).optional(),
  start: Seconds.optional(),
  end: Seconds.optional(),
  currentSelection: z.boolean().default(false),
};
export const MeasureOptionsShape = {
  backend: z.enum(['auto', 'wav', 'ffmpeg']).default('auto'),
  dualMono: z.boolean().default(true),
  timeoutMs: z.number().int().min(1000).max(600_000).default(300_000),
};
export const MeasureOptionsSchema = z.object({ ...MeasureOptionsShape, silence: SilenceSchema.optional() }).strict();
export const MeasureScopeSchema = z
  .object(MeasureScopeShape)
  .strict()
  .superRefine((scope, ctx) => {
    if (scope.trackCount !== undefined && scope.track === undefined)
      ctx.addIssue({ code: 'custom', message: 'trackCount requires track' });
    if (
      scope.currentSelection &&
      [scope.track, scope.trackCount, scope.start, scope.end].some((v) => v !== undefined)
    ) {
      ctx.addIssue({ code: 'custom', message: 'currentSelection cannot be combined with track or time arguments' });
    }
    if (scope.start !== undefined && scope.end !== undefined && scope.end <= scope.start)
      ctx.addIssue({ code: 'custom', message: 'end must be after start' });
  });
