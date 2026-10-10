import { writeFile } from 'node:fs/promises';
import { vi } from 'vitest';
import type { Ops, TrackInfo } from '../../src/ops.js';
import { wav } from './audio-fixture.js';

export function fakeOps(tracks: TrackInfo[], selected = { start: 0.25, end: 0.75 }, exportFailure?: string) {
  const command = vi.fn(async (id: string, params: Record<string, unknown>, _timeout?: number) => {
    if (id === 'Export2') {
      if (exportFailure) throw new Error(exportFailure);
      await writeFile(String(params.Filename), wav([0, 0, 0, 0, 0, 0.5, 0.5, 0.5, 0.5, 0.5]));
    }
    return '';
  });
  const mock = {
    pipe: { needsRecovery: false },
    tracks: vi.fn(async () => tracks),
    info: vi.fn(async () => selected),
    trackIndex: vi.fn(async (ref: number | string) => {
      const index = typeof ref === 'number' ? ref : tracks.findIndex((track) => track.name === ref);
      if (index < 0 || index >= tracks.length) throw new Error('track does not exist');
      return index;
    }),
    command,
    run: vi.fn(async () => ''),
    select: vi.fn(async () => undefined),
  };
  return { mock, ops: mock as unknown as Ops };
}

export const voice: TrackInfo = { name: 'Voice', kind: 'wave', start: 2, end: 3, channels: 1, selected: 1 };
export const label: TrackInfo = { name: 'Labels', kind: 'label', start: 0, end: 10, selected: 1 };
export const bed: TrackInfo = { name: 'Bed', kind: 'wave', start: 0, end: 6, channels: 2, selected: 0 };
