// Real stdio MCP integration against Audacity 3.7.x. Only AUDACITY_LIVE=1
// enables process or pipe access. User projects are backed up persistently;
// every test edit happens in the hidden, disposable test project.

import { expect, it } from 'vitest';
import { type LiveContext, type Measurement, testTimeout } from './session.js';

export function registerEditing(context: LiveContext) {
  const { call, refuse, tracks, clearTracks, importVoice } = context;
  it(
    'edits clips with split/trim/duplicate/delete/copy/silence/join',
    async () => {
      await importVoice();
      await call('audacity_edit', { action: 'split', track: 'Voice', start: 1, end: 1 });
      expect((await call<unknown[]>('audacity_info', { type: 'Clips' })).length).toBe(2);
      await call('audacity_edit', { action: 'join', track: 'Voice', start: 0, end: 2 });
      expect((await call<unknown[]>('audacity_info', { type: 'Clips' })).length).toBe(1);
      await call('audacity_edit', { action: 'copy', track: 'Voice', start: 0.25, end: 0.5 });
      await expect(refuse('audacity_edit', { action: 'paste', track: 'Voice', start: 2, end: 2 })).rejects.toThrow();
      await call('audacity_edit', { action: 'silence', track: 'Voice', start: 0.5, end: 0.75 });
      expect(
        (await call<Measurement>('audacity_measure', { track: 'Voice', start: 0.5, end: 0.75, backend: 'wav' })).rms,
      ).toBeLessThanOrEqual(1e-4);
      await call('audacity_edit', { action: 'duplicate', track: 'Voice', start: 0, end: 1 });
      expect((await tracks()).length).toBe(2);
      await call('audacity_track_edit', { action: 'remove', track: 1 });
      await call('audacity_edit', { action: 'trim', track: 'Voice', start: 0.25, end: 1.75 });
      expect((await tracks())[0]).toMatchObject({ start: 0.25, end: 1.75 });
      await call('audacity_edit', { action: 'split_delete', track: 'Voice', start: 0.5, end: 0.75 });
      expect((await tracks())[0]?.end).toBeCloseTo(1.75, 3);
      await call('audacity_edit', { action: 'delete', track: 'Voice', start: 1, end: 1.25 });
      expect((await tracks())[0]?.end).toBeCloseTo(1.5, 3);
      await expect(refuse('audacity_edit', { action: 'trim', track: 'Voice', start: 1, end: 1 })).rejects.toThrow(
        /non-empty/,
      );
    },
    testTimeout,
  );

  it(
    'adds/removes tracks, aligns audio tracks and mixes to existing/new tracks',
    async () => {
      const { fixture } = context;
      for (const [action, name] of [
        ['add_mono', 'Empty mono'],
        ['add_stereo', 'Empty stereo'],
        ['add_label', 'Empty labels'],
      ]) {
        await call('audacity_track_edit', { action, name });
      }
      expect((await tracks()).map((track) => track.name)).toEqual(['Empty mono', 'Empty stereo', 'Empty labels']);
      await clearTracks();
      await importVoice('One', fixture, 1);
      await importVoice('Two', fixture, 2);
      await call('audacity_track_edit', { action: 'align_start_zero', track: 'One', trackCount: 2 });
      // Native Align_StartToZero shifts the selected group by its earliest start;
      // it preserves the one-second offset rather than aligning each track.
      expect((await tracks()).map((track) => track.start)).toEqual([0, 1]);
      await call('audacity_track_edit', { action: 'align_end_to_end', track: 'One', trackCount: 2 });
      expect((await tracks())[1]?.start).toBeCloseTo(2, 3);
      await call('audacity_track_edit', { action: 'align_together', track: 'One', trackCount: 2 });
      const together = await tracks();
      expect(together[0]?.start).toBeCloseTo(together[1]!.start, 3);
      await call('audacity_track_edit', { action: 'mix_new', track: 'One', trackCount: 2 });
      expect((await tracks()).length).toBe(3);
      await call('audacity_track_edit', { action: 'mix', track: 'One', trackCount: 2 });
      expect((await tracks()).length).toBe(2);
    },
    testTimeout,
  );

  it(
    'splits to a new track, cuts with/without ripple and disjoins silenced audio',
    async () => {
      await importVoice();
      await call('audacity_edit', { action: 'split_new', track: 'Voice', start: 0.5, end: 1 });
      expect((await tracks()).length).toBe(2);
      await clearTracks();
      await importVoice();
      await call('audacity_edit', { action: 'cut', track: 'Voice', start: 0.5, end: 0.75 });
      expect((await tracks())[0]?.end).toBeCloseTo(1.75, 3);
      await clearTracks();
      await importVoice();
      await call('audacity_edit', { action: 'split_cut', track: 'Voice', start: 0.5, end: 0.75 });
      expect((await tracks())[0]?.end).toBeCloseTo(2, 3);
      expect((await call<unknown[]>('audacity_info', { type: 'Clips' })).length).toBe(2);
      await clearTracks();
      await importVoice();
      await call('audacity_edit', { action: 'silence', track: 'Voice', start: 0.5, end: 0.75 });
      await call('audacity_edit', { action: 'disjoin', track: 'Voice', start: 0, end: 2 });
      expect((await call<unknown[]>('audacity_info', { type: 'Clips' })).length).toBeGreaterThanOrEqual(2);
    },
    testTimeout,
  );
}
