import { readFileSync, writeFileSync } from 'node:fs';
import { expect, it } from 'vitest';
import { formatCommand } from '../../src/format.js';
import { AudacityPipe } from '../../src/pipe.js';
import { type Label, type LiveContext, type Measurement, testTimeout, type Windows } from './session.js';

export function registerLabels(context: LiveContext) {
  const { call, refuse, tracks, importVoice, output } = context;
  it(
    'adds labels to an existing named track independently of earlier track focus',
    async () => {
      await importVoice();
      for (const trackName of ['Earlier', 'Later'])
        await call('audacity_labels_set', { trackName, labels: [{ start: 0, text: `Keep ${trackName}` }] });
      await call('audacity_select', { track: 'Voice' });
      await call('audacity_command', { command: 'SetTrackStatus', params: { Focused: true } });
      await call('audacity_labels_set', { trackName: 'Later', labels: [{ start: 1, text: 'Later cue' }] });
      await call('audacity_labels_set', { trackName: 'Earlier', labels: [{ start: 1, text: 'Earlier cue' }] });
      for (const trackName of ['Earlier', 'Later'])
        expect(
          (await call<Label[]>('audacity_labels', { action: 'list', trackName })).map((label) => label.text),
        ).toEqual([`Keep ${trackName}`, `${trackName} cue`]);
      expect((await call<Windows>('audacity_dialogs')).windows.filter((window) => window.dialog)).toEqual([]);
    },
    testTimeout,
  );

  it(
    'refuses label naming dialogs before edits and restores the native preference',
    async () => {
      await importVoice();
      const name = '/GUI/DialogForNameNewLabel';
      const pipe = new AudacityPipe(undefined, 10_000);
      let original: string | undefined;
      let handoffFailed = false;
      const configure = async (value: string, capture = false) => {
        // Only one client owns the pipe, including these test-only preference writes.
        await context.closeClient();
        try {
          if (capture) {
            const previous = await pipe.send(formatCommand('GetPreference', { Name: name }));
            if (previous.ok && ['0', '1'].includes(previous.body)) original = previous.body;
            else if (!previous.ok && previous.status === 'Failed!' && previous.body === '') original = '0';
            else throw new Error('Cannot establish the original label naming preference; no preference was changed');
          }
          expect(
            (await pipe.send(formatCommand('SetPreference', { Name: name, Value: value, Reload: false }))).ok,
          ).toBe(true);
          expect(await pipe.send(formatCommand('GetPreference', { Name: name }))).toMatchObject({
            ok: true,
            body: value,
            status: 'OK',
          });
        } finally {
          if (pipe.needsRecovery) {
            // Preserve uncertainty on this same pipe across handoffs. Only a
            // correlated barrier permits restoration or a new SDK client; a
            // failed barrier leaves the client disconnected for inspection.
            handoffFailed = true;
            expect((await pipe.reconnect()).ok).toBe(true);
            expect(pipe.needsRecovery).toBe(false);
            handoffFailed = false;
          }
          pipe.release();
          await context.connectClient();
        }
      };
      try {
        await configure('1', true);
        const previousTracks = await tracks();
        const previousSelection = await call('audacity_info', { type: 'Selection' });
        for (const command of ['AddLabel', 'AddLabelPlaying'])
          await expect(refuse('audacity_menu', { command })).rejects.toThrow(/DialogForNameNewLabel/);
        await expect(
          refuse('audacity_labels_set', { trackName: 'Refused', labels: [{ start: 0, text: 'Refused' }] }),
        ).rejects.toThrow(/DialogForNameNewLabel/);
        expect(await tracks()).toEqual(previousTracks);
        expect(await call('audacity_info', { type: 'Selection' })).toEqual(previousSelection);
        expect(await call('audacity_info', { type: 'Labels' })).toEqual([]);
        expect((await call<Windows>('audacity_dialogs')).windows.filter((window) => window.dialog)).toEqual([]);
      } finally {
        // An absent entry is restored as its explicit native false default;
        // Audacity's scripting API has no operation to remove a preference.
        if (original !== undefined && !handoffFailed) await configure(original);
      }
    },
    testTimeout,
  );

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
