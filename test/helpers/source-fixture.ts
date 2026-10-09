import { writeFile } from 'node:fs/promises';
import { vi } from 'vitest';
import { catalogueCommand } from '../../src/format.js';
import type { Ops, TrackInfo } from '../../src/ops.js';
import { measureSourceFrames, measureSourceRate } from '../../src/source-rate.js';

export function fixture(
  options: {
    rate?: number;
    header?: string;
    exportError?: Error;
    restoreError?: Error;
    focusError?: Error;
    missingFile?: boolean;
    tracks?: TrackInfo[];
    recoveryOnExport?: boolean;
    recoveryOnRestore?: boolean;
  } = {},
) {
  const calls: { command: string; params?: Record<string, unknown> }[] = [];
  const files: string[] = [];
  const setterSelections: number[][] = [];
  const tracks: TrackInfo[] = (
    options.tracks ?? [
      { name: 'Source target', kind: 'wave', start: 0, end: 10, selected: 0, focused: 0 },
      { name: 'Previously selected music', kind: 'wave', start: 0, end: 10, selected: 1, focused: 1 },
      { name: 'Previously selected labels', kind: 'label', start: 0, end: 10, selected: 1, focused: 0 },
    ]
  ).map((track) => ({ ...track }));
  let selection = { Start: 2, End: 4 };
  let needsRecovery = false;
  const setFocus = (index: number) =>
    tracks.forEach((track, current) => {
      track.focused = Number(current === index);
    });
  const ops = {
    pipe: {
      get needsRecovery() {
        return needsRecovery;
      },
    },
    tracks: vi.fn(async () => tracks.map((track) => ({ ...track }))),
    info: vi.fn(async () => ({ ...selection })),
    select: vi.fn(async (scope: { track: number; start: number; end: number }) => {
      calls.push({ command: 'select', params: scope });
      tracks.forEach((track, index) => {
        track.selected = Number(index === scope.track);
      });
      selection = { Start: scope.start, End: scope.end };
    }),
    run: vi.fn(async (command: string, params?: Record<string, unknown>) => {
      if (params) catalogueCommand(command, params);
      calls.push(params ? { command, params } : { command });
      if (command === 'SampleDataExport') {
        setFocus(tracks.findIndex((track) => track.selected));
        const file = String(params!.FILENAME);
        files.push(file);
        if (options.exportError) {
          needsRecovery = options.recoveryOnExport ?? false;
          throw options.exportError;
        }
        if (!options.missingFile)
          await writeFile(
            file,
            options.header ??
              `source-rate.txt   1 channel (mono)\nSample Rate: ${options.rate ?? 8000} Hz. Sample values on linear scale.\nLength processed: 1 samples 0.000125 seconds.\n\n0.00000\n`,
          );
      }
      if (options.restoreError && command === 'SelectNone') throw options.restoreError;
      if (command === 'SelectNone')
        tracks.forEach((track) => {
          track.selected = 0;
        });
      return '';
    }),
    command: vi.fn(async (command: string, params: Record<string, unknown>) => {
      catalogueCommand(command, params); // Actual strict catalogue parameter contracts.
      calls.push({ command, params });
      if (command === 'SelectTracks') {
        const first = Number(params.Track);
        const count = Number(params.TrackCount);
        if (params.Mode === 'Set')
          tracks.forEach((track) => {
            track.selected = 0;
          });
        tracks.slice(first, first + count).forEach((track) => {
          track.selected = 1;
        });
      }
      if (command === 'SetTrackStatus') {
        setterSelections.push(tracks.flatMap((track, index) => (track.selected ? [index] : [])));
        if (options.focusError) {
          needsRecovery = options.recoveryOnRestore ?? false;
          throw options.focusError;
        }
        for (const [index, track] of tracks.entries()) {
          if (!track.selected) continue;
          if (params.Focused === true) setFocus(index);
          else if (params.Focused === false && track.focused) setFocus(-1);
        }
      }
      if (command === 'SelectTime') selection = { Start: Number(params.Start), End: Number(params.End) };
      return '';
    }),
  };
  return {
    ops,
    calls,
    files,
    tracks,
    setterSelections,
    selection: () => ({ ...selection }),
    measure: (scope: Parameters<typeof measureSourceFrames>[1] = { track: 0, start: 0, end: 0.1 }) =>
      measureSourceFrames(ops as unknown as Ops, scope),
    rate: (scope: Parameters<typeof measureSourceRate>[1] = { track: 0, start: 0, end: 0.1 }) =>
      measureSourceRate(ops as unknown as Ops, scope),
  };
}
