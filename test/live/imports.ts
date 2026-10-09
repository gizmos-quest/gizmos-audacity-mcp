// Real stdio MCP integration against Audacity 3.7.x. Only AUDACITY_LIVE=1
// enables process or pipe access. User projects are backed up persistently;
// every test edit happens in the hidden, disposable test project.

import { existsSync, statSync } from 'node:fs';
import { expect, it } from 'vitest';
import { type LiveContext, type Measurement, type Track, testTimeout, type Windows } from './session.js';

export function registerImports(context: LiveContext) {
  const { call, refuse, tracks, importVoice, output } = context;
  it(
    'rejects incomplete properties and invalid later measurement ranges without changing the project',
    async () => {
      await importVoice('Voice');
      await call('audacity_select', { track: 'Voice', start: 0.25, end: 0.75 });
      const previousTracks = await tracks();
      const previousSelection = await call('audacity_info', { type: 'Selection' });
      await expect(refuse('audacity_track_set', { track: 'Voice' })).rejects.toThrow(/at least one track property/);
      await expect(
        refuse('audacity_transport', { action: 'play', track: 'Voice', start: 0.5, end: 0.5 }),
      ).rejects.toThrow(/positive.duration/);
      await expect(
        refuse('audacity_labels_set', { trackName: '', labels: [{ start: 0, text: 'Invalid' }] }),
      ).rejects.toThrow();
      await expect(
        refuse('audacity_envelope_set', {
          track: 'Voice',
          points: [
            { time: 0.1, value: 1 },
            { time: 0.2, value: 2.1 },
          ],
        }),
      ).rejects.toThrow();
      await expect(refuse('audacity_command', { command: 'SetTrack', params: { Pan: 101 } })).rejects.toThrow();
      await expect(refuse('audacity_generate', { kind: 'tone', track: 'Voice', channels: 2 })).rejects.toThrow(
        /existing tracks retain their channels/,
      );
      await expect(refuse('audacity_measure', { track: 'Voice', start: 3, backend: 'wav' })).rejects.toThrow(
        /non-empty time selection/,
      );
      await expect(
        refuse('audacity_contrast', {
          foreground: { track: 'Voice', start: 0, end: 1 },
          background: { track: 'Voice', start: 1, end: 0 },
        }),
      ).rejects.toThrow(/end must be after start/);
      expect(await tracks()).toEqual(previousTracks);
      expect(await call('audacity_info', { type: 'Selection' })).toEqual(previousSelection);
      expect((await call<Windows>('audacity_dialogs')).windows.filter((window) => window.dialog)).toEqual([]);
    },
    testTimeout,
  );

  it(
    'reports multi-track imports explicitly and cleans every confirmed batch temporary track',
    async () => {
      const { multichannelFixture } = context;
      await importVoice('Original');
      const previous = await tracks();
      await expect(
        refuse('audacity_import', { file: multichannelFixture, name: 'Unsupported multi-track' }),
      ).rejects.toThrow(/import added.*tracks/);
      const imported = await tracks();
      expect(imported.length).toBeGreaterThan(previous.length + 1);
      const { focused: _focused, selected: _selected, ...originalAudio } = previous[0]!;
      expect(imported[0]).toMatchObject(originalAudio);
      await call('audacity_track_edit', {
        action: 'remove',
        track: previous.length,
        trackCount: imported.length - previous.length,
      });
      await call('audacity_select', { track: 'Original', start: 0.1, end: 0.2 });
      const selection = await call('audacity_info', { type: 'Selection' });
      const beforeBatch = await tracks();
      const file = output('multi-track-batch-refusal');
      await expect(
        refuse('audacity_batch', { jobs: [{ file: multichannelFixture, output: file }], measure: false }),
      ).rejects.toThrow(/import added.*tracks/);
      expect(await tracks()).toEqual(beforeBatch);
      expect(await call('audacity_info', { type: 'Selection' })).toEqual(selection);
      expect(existsSync(file)).toBe(false);
      expect((await call<Windows>('audacity_dialogs')).windows.filter((window) => window.dialog)).toEqual([]);
    },
    testTimeout,
  );

  it(
    'preserves production argument shapes, boolean encoding and explicit export selection',
    async () => {
      const { fixture } = context;
      await importVoice('Voice', fixture, 1.5);
      expect((await tracks())[0]).toMatchObject({ name: 'Voice', start: 1.5 });
      const changed = await call<Track>('audacity_track_set', {
        track: 'Voice',
        gainDb: -6,
        pan: 0.25,
        mute: true,
        solo: false,
      });
      expect(changed.volume).toBeCloseTo(10 ** (-6 / 20), 4);
      expect(changed.mute).toBe(1);
      await call('audacity_track_set', { track: 'Voice', mute: false, solo: true });
      expect((await tracks())[0]?.solo).toBe(1);
      await call('audacity_track_set', { track: 'Voice', gainDb: 0, pan: 0, solo: false });
      await call('audacity_clip_move', { track: 'Voice', at: 2, start: 1 });
      expect((await tracks())[0]?.start).toBeCloseTo(1, 4);
      await call('audacity_envelope_set', {
        track: 'Voice',
        points: [
          { time: 1, value: 1 },
          { time: 2, value: 0.25 },
        ],
      });
      const envelopes = await call<{ points: { t: number; y: number }[] }[]>('audacity_info', { type: 'Envelopes' });
      expect(envelopes.flatMap((entry) => entry.points).map((point) => point.y)).toEqual([1, 0.25]);
      await call('audacity_labels_set', {
        labels: [
          { start: 1, text: 'line one' },
          { start: 1.5, end: 2.5, text: 'region' },
        ],
      });
      await call('audacity_effect', { effect: 'Amplify', params: { Ratio: 0.5 }, track: 'Voice' });
      const audio = output('mix');
      await call('audacity_export', { file: audio, channels: 1 });
      expect(statSync(audio).size).toBeGreaterThan(48_000 * 2 * 2.9);
      expect(await call<Measurement>('audacity_measure_file', { file: audio, backend: 'wav' })).toMatchObject({
        sampleRate: 48000,
      });
      expect((await call<Measurement>('audacity_measure_file', { file: audio, backend: 'wav' })).rms).toBeGreaterThan(
        0,
      );
      expect((await tracks())[0]?.end).toBeCloseTo(3, 4);
    },
    testTimeout,
  );
}
