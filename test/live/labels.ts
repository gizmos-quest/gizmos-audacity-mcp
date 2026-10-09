import { readFileSync, writeFileSync } from 'node:fs';
import { expect, it } from 'vitest';
import { type Label, type LiveContext, type Measurement, testTimeout } from './session.js';

export function registerLabels(context: LiveContext) {
  const { call, refuse, importVoice, output } = context;
  it(
    'finds/edits/deletes overlapping labels and preserves other label tracks',
    async () => {
      await importVoice();
      await call('audacity_labels_set', {
        trackName: 'Chapters',
        labels: [
          { start: 0, end: 1.5, text: 'Outer' },
          { start: 0.5, end: 1, text: 'Inner' },
          { start: 1.25, text: 'Point' },
          { start: 0.123456789, text: 'Precision' },
        ],
      });
      await call('audacity_labels_set', {
        trackName: 'Subtitles',
        labels: [{ start: 0.25, end: 0.75, text: 'Preserve me' }],
      });
      const precise = (await call<Label[]>('audacity_labels', { action: 'find', query: 'precision' }))[0]!;
      expect(precise.start).toBeCloseTo(0.123456789, 5);
      expect((await call<Label[]>('audacity_labels', { action: 'list' })).some((label) => label.text === '')).toBe(
        false,
      );
      const inner = (await call<Label[]>('audacity_labels', { action: 'find', query: 'inner' }))[0]!;
      expect(inner.text).toBe('Inner');
      await call('audacity_labels', { action: 'edit', index: inner.index, text: 'Edited inner', start: 0.4 });
      const edited = (await call<Label[]>('audacity_labels', { action: 'find', query: 'edited' }))[0]!;
      expect(edited.start).toBeCloseTo(0.4, 3);
      await call('audacity_labels', { action: 'delete', index: edited.index });
      const remaining = await call<Label[]>('audacity_labels', { action: 'list' });
      expect(remaining.map((label) => label.text).sort()).toEqual(['Outer', 'Point', 'Precision', 'Preserve me']);
      expect(remaining.find((label) => label.text === 'Outer')).toMatchObject({ start: 0, end: 1.5 });
      await call('audacity_labels', {
        action: 'regular',
        trackName: 'Markers',
        start: 0,
        end: 1,
        interval: 0.5,
        text: 'Beat',
      });
      expect(
        (await call<Label[]>('audacity_labels', { action: 'list', trackName: 'Markers' })).map((label) => label.start),
      ).toEqual([0, 0.5, 1]);
    },
    testTimeout,
  );

  it(
    'imports TSV/JSON labels, exports all sidecars and renders labeled audio regions',
    async () => {
      await importVoice();
      const tsv = output('import-labels', 'tsv');
      writeFileSync(tsv, '0\t0.5\tFirst\n0.5\t1\tSecond\n');
      expect(await call('audacity_labels_file', { action: 'import', file: tsv, trackName: 'Chapters' })).toMatchObject({
        imported: 2,
      });
      const json = output('import-json', 'json');
      writeFileSync(json, JSON.stringify([{ start: 1, end: 1.5, text: 'Third' }]));
      await call('audacity_labels_file', { action: 'import', file: json, format: 'json', trackName: 'Chapters' });
      for (const format of ['tsv', 'json', 'srt', 'vtt', 'chapters', 'cue', 'podlove', 'ffmetadata']) {
        const file = output(`labels-${format}`, format);
        expect(
          await call('audacity_labels_file', { action: 'export', file, format, trackName: 'Chapters' }),
        ).toMatchObject({ count: 3 });
        expect(readFileSync(file, 'utf8')).toContain('First');
        await expect(
          refuse('audacity_labels_file', { action: 'export', file, format, trackName: 'Chapters' }),
        ).rejects.toThrow(/exists/);
      }
      const rendered = await call<{ files: string[]; count: number }>('audacity_label_regions_export', {
        directory: output('regions', 'folder'),
        trackName: 'Chapters',
        channels: 1,
      });
      expect(rendered.count).toBe(3);
      for (const file of rendered.files)
        expect((await call<Measurement>('audacity_measure_file', { file, backend: 'wav' })).rms).toBeGreaterThan(0);
    },
    testTimeout,
  );
}
