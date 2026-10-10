import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { withCleanupFailure } from '../errors.js';
import { catalogueCommand } from '../format.js';
import type { Ops, TrackInfo, TrackRef } from '../ops.js';
import { measureFile } from './measurement.js';
import { type MeasureOptions, MeasureOptionsSchema, MeasureScopeSchema } from './options.js';
import type { Measurement } from './types.js';

export interface MeasureScope {
  track?: TrackRef;
  trackCount?: number;
  start?: number;
  end?: number;
  currentSelection?: boolean;
}
interface SelectionSnapshot {
  start: number;
  end: number;
  selected: number[];
  tracks: TrackInfo[];
}
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

async function snapshotSelection(ops: Ops): Promise<SelectionSnapshot> {
  const tracks = await ops.tracks();
  return {
    ...selectionTimes(await ops.info('Selection')),
    tracks,
    selected: tracks.flatMap((track, index) => (track.selected ? [index] : [])),
  };
}

async function restoreSelection(ops: Ops, selection: SelectionSnapshot): Promise<void> {
  await ops.run('SelectNone');
  for (const track of selection.selected)
    await ops.command('SelectTracks', { Track: track, TrackCount: 1, Mode: 'Add' });
  await ops.command('SelectTime', { Start: selection.start, End: selection.end, RelativeTo: 'ProjectStart' });
}

/** Export the selected rendered mix without altering track gain, pan, mute, solo or envelopes. */
export async function measureScope(
  ops: Ops,
  scope: MeasureScope = {},
  options: MeasureOptions = {},
): Promise<Measurement & { scope: unknown }> {
  scope = MeasureScopeSchema.parse(scope);
  options = MeasureOptionsSchema.parse(options);
  const previous = await snapshotSelection(ops);
  const directory = await mkdtemp(join(tmpdir(), 'gizmos-audacity-measure-'));
  let operationError: unknown;
  let restorationError: unknown;
  let selectionChanged = false;
  try {
    let selected: number[];
    let start: number;
    let end: number;
    if (scope.currentSelection) {
      selected = previous.selected;
      start = previous.start;
      end = previous.end;
      if (!selected.some((i) => previous.tracks[i]?.kind === 'wave'))
        throw new Error('select at least one audio track first');
    } else {
      const first = scope.track === undefined ? 0 : await ops.trackIndex(scope.track);
      const count = scope.track === undefined ? previous.tracks.length : (scope.trackCount ?? 1);
      if (!count || first + count > previous.tracks.length)
        throw new Error('measurement track range is empty or outside the project');
      selected = Array.from({ length: count }, (_, i) => first + i);
      const audio = selected.map((i) => previous.tracks[i]!).filter((track) => track.kind === 'wave');
      if (!audio.length) throw new Error('measurement needs an audio track');
      start = scope.start ?? (scope.track === undefined ? 0 : Math.min(...audio.map((t) => t.start)));
      end = scope.end ?? Math.max(...audio.map((t) => t.end));
    }
    if (!Number.isFinite(start) || !Number.isFinite(end) || start < 0 || !(end > start)) {
      throw new Error(`measurement needs a finite non-empty time selection (${start}s to ${end}s)`);
    }
    const file = join(directory, 'selection.wav');
    const audio = selected.map((i) => previous.tracks[i]!).filter((track) => track.kind === 'wave');
    const channels = audio.some((t) => (t.channels ?? 1) > 1) || audio.length > 1 ? 2 : 1;
    catalogueCommand('Export2', { Filename: file, NumChannels: channels });
    // Resolve and validate the entire range before changing selection.
    selectionChanged = true;
    if (scope.currentSelection) {
      // Clear label text editing by explicitly reselecting the same tracks/time.
      await ops.run('SelectNone');
      for (const track of selected) await ops.command('SelectTracks', { Track: track, TrackCount: 1, Mode: 'Add' });
      await ops.command('SelectTime', { Start: start, End: end, RelativeTo: 'ProjectStart' });
    } else {
      await ops.command('Select', {
        Track: selected[0]!,
        TrackCount: selected.length,
        Start: start,
        End: end,
        Mode: 'Set',
      });
    }
    await ops.command('Export2', { Filename: file, NumChannels: channels }, 600_000);
    const measured = await measureFile(file, options);
    delete measured.file;
    measured.notes.push(
      'Measures the rendered Export2 selection, including existing track gain, pan, mute, solo and envelopes. Track controls are never changed.',
    );
    if (selected.some((i) => previous.tracks[i]?.mute))
      measured.notes.push(
        'The selected tracks include a muted track; rendered measurements reflect its current mute state.',
      );
    return { ...measured, scope: { tracks: selected, start, end } };
  } catch (error) {
    operationError = error;
    throw error;
  } finally {
    try {
      if (selectionChanged && !ops.pipe?.needsRecovery) await restoreSelection(ops, previous);
    } catch (restoreError) {
      restorationError = withCleanupFailure(restoreError, operationError, 'Selection restoration');
      // biome-ignore lint/correctness/noUnsafeFinally: A failed restoration must replace success and retain the original failure context.
      throw restorationError;
    } finally {
      // A timed-out Export2 may still write its destination. Retain scratch
      // and the timeout/recovery error class, including restoration failures.
      if (ops.pipe?.needsRecovery) {
        const error = restorationError ?? operationError;
        if (error instanceof Error)
          error.message += `. Selection restoration is incomplete. Measurement scratch retained at ${directory}; inspect after audacity_recover`;
      } else await rm(directory, { recursive: true, force: true });
    }
  }
}
