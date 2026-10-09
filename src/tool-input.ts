import { z } from 'zod';
import { SafeString } from './catalogue.js';

export const Seconds = z.number().finite().min(0).max(86_400);
export const TrackRef = z
  .union([z.number().int().min(0), SafeString.min(1)])
  .describe('track index (0-based) or unique track name');
export const Scope = {
  track: TrackRef.optional(),
  trackCount: z.number().int().min(1).max(256).optional(),
  start: Seconds.optional(),
  end: Seconds.optional(),
};
export const Params = z.record(z.string(), z.union([SafeString, z.number().finite(), z.boolean()]));
