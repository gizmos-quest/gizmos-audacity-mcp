import { expect, vi } from 'vitest';
import type { Ops, TrackInfo, TrackRef } from '../../src/ops.js';

export function wave(name = 'Voice', start = 2, end = 10): TrackInfo {
  return { name, kind: 'wave', start, end, channels: 1 };
}

export function mockOps(trackList = [wave()]) {
  const tracks = vi.fn(async () => trackList);
  const trackIndex = vi.fn(async (ref: TrackRef) => {
    const indexes = trackList.flatMap((track, index) =>
      typeof ref === 'number' ? (ref === index ? [index] : []) : ref === track.name ? [index] : [],
    );
    if (indexes.length !== 1) throw new Error(`track ${ref} does not identify one track`);
    return indexes[0]!;
  });
  const select = vi.fn(
    async (_scope: { track?: TrackRef; trackCount?: number; start?: number; end?: number }) => undefined,
  );
  const command = vi.fn(async (_id: string, _params?: Record<string, unknown>, _timeout?: number) => 'Audacity reply');
  const run = vi.fn(async (_id: string, _params?: Record<string, unknown>, _timeout?: number) => 'Audacity reply');
  const info = vi.fn(
    async (type: string): Promise<unknown> =>
      type === 'Clips'
        ? trackList.flatMap((track, index) =>
            track.kind === 'wave' && track.end > track.start
              ? [{ track: index, start: track.start, end: track.end }]
              : [],
          )
        : [],
  );
  const mocks = { tracks, trackIndex, select, command, run, info };
  return { ...mocks, ops: mocks as unknown as Ops, trackList };
}

export function expectNoMutation(mocks: ReturnType<typeof mockOps>): void {
  expect(mocks.select).not.toHaveBeenCalled();
  expect(mocks.command).not.toHaveBeenCalled();
  expect(mocks.run).not.toHaveBeenCalled();
}
