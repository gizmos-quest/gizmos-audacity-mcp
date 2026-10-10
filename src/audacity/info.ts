// Readers for GetInfo JSON, validated where native data enters the server. The shapes
// follow Audacity-3.7.8 src/commands/GetInfoCommand.cpp (SendTracks, SendClips,
// SendLabels, SendSelection, ExploreMenu): flags arrive as 0/1 numbers and only audio
// tracks report start, end, pan, volume, channels, solo and mute.
import { z } from 'zod';
import type { TrackInfo } from '../ops.js';

export interface ClipInfo {
  track: number;
  start: number;
  end: number;
  name?: string;
}
/** A label track's index and its [start, end, text] labels. */
export type LabelTrackInfo = [number, [number, number, string][]];

const Index = z.number().int().nonnegative();
const Tracks = z.array(
  z
    .looseObject({
      name: z.string(),
      kind: z.string(),
      start: z.number().optional(),
      end: z.number().optional(),
      volume: z.number().optional(),
      pan: z.number().optional(),
      mute: z.number().optional(),
      solo: z.number().optional(),
      channels: z.number().optional(),
      selected: z.number().optional(),
      focused: z.number().optional(),
    })
    .refine((track) => track.kind !== 'wave' || (track.start !== undefined && track.end !== undefined), {
      message: 'an audio track without start and end',
    }),
);
const Clips = z.array(z.looseObject({ track: Index, start: z.number(), end: z.number(), name: z.string().optional() }));
const Labels = z.array(z.tuple([Index, z.array(z.tuple([z.number(), z.number(), z.string()]))]));
const Menus = z.array(z.looseObject({ id: z.string().optional(), label: z.string() }));

/** Validate, then return Audacity's own value, so callers keep its field order. */
function read<T>(schema: z.ZodType, value: unknown, type: string): T {
  const result = schema.safeParse(value);
  if (!result.success)
    throw new Error(`Audacity GetInfo ${type} has an unexpected shape: ${z.prettifyError(result.error)}`);
  return value as T;
}

export const tracksInfo = (value: unknown): TrackInfo[] => read(Tracks, value, 'Tracks');
export const clipsInfo = (value: unknown): ClipInfo[] => read(Clips, value, 'Clips');
export const labelsInfo = (value: unknown): LabelTrackInfo[] => read(Labels, value, 'Labels');
export const menusInfo = (value: unknown): { id?: string; label: string }[] => read(Menus, value, 'Menus');

/** GetInfo Selection: a finite, ordered time selection. */
export function selectionTimes(info: unknown): { start: number; end: number } {
  const object = Array.isArray(info) ? info[0] : info;
  if (!object || typeof object !== 'object') throw new Error('Audacity returned no readable selection');
  const value = object as Record<string, unknown>;
  const start = value.start ?? value.Start;
  const end = value.end ?? value.End;
  if (
    typeof start !== 'number' ||
    typeof end !== 'number' ||
    !Number.isFinite(start) ||
    !Number.isFinite(end) ||
    start < 0 ||
    end < start
  ) {
    throw new Error('Audacity returned invalid selection start/end');
  }
  return { start, end };
}
