import { z } from 'zod';
import { catalogueCommand, type ParamValue } from '../format.js';
import type { Ops, TrackRef } from '../ops.js';
import { Seconds, Track, TrackCount } from '../tool-input.js';

const SelectionScope = z
  .object({
    start: Seconds.optional(),
    end: Seconds.optional(),
    track: Track.optional(),
    trackCount: TrackCount.optional(),
  })
  .strict();

export async function resolveSelection(
  ops: Ops,
  scope: { start?: number; end?: number; track?: TrackRef; trackCount?: number },
): Promise<Record<string, ParamValue | undefined>> {
  scope = SelectionScope.parse(scope);
  const params: Record<string, ParamValue | undefined> = { Mode: 'Set' };
  if (scope.trackCount !== undefined && scope.track === undefined) throw new Error('trackCount requires track');
  if (scope.start !== undefined && scope.end !== undefined && scope.end < scope.start)
    throw new Error('end must be at least start');
  if (scope.track !== undefined) {
    params.Track = await ops.trackIndex(scope.track);
    params.TrackCount = scope.trackCount ?? 1;
    if ((params.Track as number) + (params.TrackCount as number) > (await ops.tracks()).length)
      throw new Error('trackCount exceeds the available tracks');
  }
  if (scope.start !== undefined || scope.end !== undefined) {
    if (scope.track === undefined) {
      params.Start = scope.start ?? 0;
      params.End = scope.end ?? (await ops.projectEnd());
    }
  }
  if (params.Track === undefined) {
    const tracks = await ops.tracks();
    if (!tracks.length) throw new Error('the project has no tracks to select');
    params.Track = 0;
    params.TrackCount = tracks.length;
    params.Start = params.Start ?? 0;
    params.End = params.End ?? (await ops.projectEnd());
  }
  if (params.Start === undefined) {
    // Only the tracks' own extent: an effect over empty timeline would fill it with silence clips.
    const tracks = (await ops.tracks()).slice(
      params.Track as number,
      (params.Track as number) + (params.TrackCount as number),
    );
    params.Start = scope.start ?? Math.min(...tracks.map((t) => t.start ?? 0));
    params.End = scope.end ?? Math.max(...tracks.map((t) => t.end ?? 0));
  }
  if ((params.End as number) < (params.Start as number))
    throw new Error('end must be at least start within the selected tracks');
  if (!Number.isFinite(params.Start) || !Number.isFinite(params.End))
    throw new Error('selected tracks have invalid time extents');
  catalogueCommand('Select', params);
  return params;
}
