import { z } from 'zod';
import { SafeString } from './catalogue.js';

// Input vocabulary shared by the tool registrations and by the operations that
// validate their arguments again before any native call.

/** Seconds on the project timeline, at most 24 hours. */
export const Seconds = z.number().min(0).max(86_400);
/** A zero-based track index or a unique track name. */
export const Track = z.union([z.number().int().nonnegative(), SafeString.min(1)]);
export const TrackRef = Track.describe('track index (0-based) or unique track name');
/** Consecutive tracks from the first selected one. */
export const TrackCount = z.number().int().min(1).max(256);
export const Scope = {
  track: TrackRef.optional(),
  trackCount: TrackCount.optional(),
  start: Seconds.optional(),
  end: Seconds.optional(),
};
export const Params = z.record(z.string(), z.union([SafeString, z.number(), z.boolean()]));
