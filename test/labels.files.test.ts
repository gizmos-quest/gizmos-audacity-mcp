import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { registerLabelTools } from '../src/labels.js';
import type { Ops, TrackInfo } from '../src/ops.js';
import { toolRecorder } from './helpers/tool-recorder.js';

let directory: string;
beforeEach(async () => {
  directory = await mkdtemp(join(tmpdir(), 'gizmos-audacity-labels-'));
});
afterEach(async () => {
  await rm(directory, { recursive: true, force: true });
});

function session(
  labelTracks: [number, [number, number, string][]][] = [
    [
      1,
      [
        [0.5, 1.5, 'Intro: welcome'],
        [2, 2, 'Cue'],
      ],
    ],
  ],
  tracks: TrackInfo[] = [
    { name: 'Voice', kind: 'wave', start: 0, end: 4 },
    { name: 'Labels', kind: 'label', start: 0, end: 0 },
  ],
) {
  const ops = {
    tracks: vi.fn(async () => tracks),
    info: vi.fn(async () => labelTracks),
    projectEnd: vi.fn(async () => 4),
    setLabels: vi.fn(async (labels: unknown[]) => labels.length),
    exportMix: vi.fn(async (file: string) => writeFile(file, 'rendered audio')),
  };
  const tools = toolRecorder();
  registerLabelTools(tools.register, ops as unknown as Ops);
  return { ops, call: tools.call };
}

describe('label files', () => {
  it('exports the named track once and refuses to overwrite the output', async () => {
    const { call } = session();
    const file = join(directory, 'labels.tsv');
    expect(await call('audacity_labels_file', { action: 'export', file })).toEqual({ file, format: 'tsv', count: 2 });
    expect(await readFile(file, 'utf8')).toBe('0.5\t1.5\tIntro: welcome\n2\t2\tCue\n');
    await expect(call('audacity_labels_file', { action: 'export', file, format: 'srt' })).rejects.toThrow('exists');
    expect(await readFile(file, 'utf8')).toContain('Intro');
  });

  it.each<{ labels: [number, [number, number, string][]][] }>([{ labels: [] }, { labels: [[1, []]] }])(
    'refuses an export without labels %#',
    async ({ labels }) => {
      const { call } = session(labels);
      const file = join(directory, 'none.tsv');
      await expect(call('audacity_labels_file', { action: 'export', file })).rejects.toThrow('has no labels');
    },
  );

  it('requires one label track with the exported name', async () => {
    const twins: TrackInfo[] = [
      { name: 'Labels', kind: 'label', start: 0, end: 0 },
      { name: 'Labels', kind: 'label', start: 0, end: 0 },
    ];
    const { call } = session(undefined, twins);
    await expect(call('audacity_labels_file', { action: 'export', file: join(directory, 'x.tsv') })).rejects.toThrow(
      'unique label track',
    );
  });

  it('imports Audacity TSV and JSON labels into the requested track', async () => {
    const { call, ops } = session();
    const tsv = join(directory, 'in.txt');
    await writeFile(tsv, '0\t1\tFirst\n\n2.5\t2.5\tSecond\n');
    expect(await call('audacity_labels_file', { action: 'import', file: tsv, trackName: 'Script' })).toEqual({
      imported: 2,
      trackName: 'Script',
    });
    expect(ops.setLabels).toHaveBeenCalledWith(
      [
        { start: 0, end: 1, text: 'First' },
        { start: 2.5, end: 2.5, text: 'Second' },
      ],
      'Script',
    );
    const json = join(directory, 'in.json');
    await writeFile(json, JSON.stringify([{ start: 3, text: 'Point' }]));
    expect(await call('audacity_labels_file', { action: 'import', file: json, format: 'json' })).toEqual({
      imported: 1,
      trackName: 'Labels',
    });
  });

  it('refuses unsupported, oversized or overlong label imports before writing labels', async () => {
    const { call, ops } = session();
    const file = join(directory, 'in.txt');
    await writeFile(file, '0\t1\tFirst\n');
    await expect(call('audacity_labels_file', { action: 'import', file, format: 'srt' })).rejects.toThrow('tsv/json');
    await writeFile(file, 'x'.repeat(1_048_577));
    await expect(call('audacity_labels_file', { action: 'import', file })).rejects.toThrow('1 MiB');
    await writeFile(file, Array.from({ length: 501 }, (_, i) => `${i}\t${i}\tL${i}`).join('\n'));
    await expect(call('audacity_labels_file', { action: 'import', file })).rejects.toThrow('at most 500');
    expect(ops.setLabels).not.toHaveBeenCalled();
  });
});

describe('label region export', () => {
  it('exports each positive-duration region to a new numbered file with a safe name', async () => {
    const { call, ops } = session();
    const output = join(directory, 'regions');
    const result = await call('audacity_label_regions_export', { directory: output, format: 'flac', channels: 1 });
    const file = join(output, '001-Intro__welcome.flac');
    expect(result).toEqual({ files: [file], count: 1 });
    expect(ops.exportMix).toHaveBeenCalledExactlyOnceWith(file, 1, 0.5, 1.5);
  });

  it('checks every destination before the first export', async () => {
    const { call, ops } = session([
      [
        1,
        [
          [0, 1, 'One'],
          [1, 2, 'Two'],
        ],
      ],
    ]);
    await writeFile(join(directory, '002-Two.wav'), 'keep');
    await expect(call('audacity_label_regions_export', { directory })).rejects.toThrow('already exists');
    expect(ops.exportMix).not.toHaveBeenCalled();
    expect(await readFile(join(directory, '002-Two.wav'), 'utf8')).toBe('keep');
  });

  it('refuses a track with only point labels', async () => {
    const { call, ops } = session([[1, [[2, 2, 'Cue']]]]);
    await expect(call('audacity_label_regions_export', { directory })).rejects.toThrow('positive-duration');
    expect(ops.exportMix).not.toHaveBeenCalled();
  });
});
