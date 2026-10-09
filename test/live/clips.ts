// Real stdio MCP integration against Audacity 3.7.x. Only AUDACITY_LIVE=1
// enables process or pipe access. User projects are backed up persistently;
// every test edit happens in the hidden, disposable test project.

import { expect, it } from 'vitest';
import { type LiveContext, type Measurement, testTimeout } from './session.js';

export function registerClips(context: LiveContext) {
  const { call, tracks, importVoice } = context;
  it(
    'aligns track starts and ends to either selection edge',
    async () => {
      await importVoice();
      await call('audacity_track_edit', { action: 'align_start_cursor', track: 'Voice', start: 0.5, end: 1 });
      expect((await tracks())[0]?.start).toBeCloseTo(0.5, 3);
      await call('audacity_track_edit', { action: 'align_start_end', track: 'Voice', start: 0.5, end: 1 });
      expect((await tracks())[0]?.start).toBeCloseTo(1, 3);
      await call('audacity_track_edit', { action: 'align_end_cursor', track: 'Voice', start: 3, end: 3 });
      expect((await tracks())[0]?.end).toBeCloseTo(3, 3);
      await call('audacity_track_edit', { action: 'align_end_end', track: 'Voice', start: 3, end: 4 });
      expect((await tracks())[0]?.end).toBeCloseTo(4, 3);
    },
    testTimeout,
  );

  it(
    'renames/colors clips, applies clip gain and both fades',
    async () => {
      await importVoice();
      const before = await call<Measurement>('audacity_measure', { track: 'Voice', backend: 'wav' });
      await call('audacity_clip_set', { track: 'Voice', at: 1.5, name: 'Spoken clip', color: 'Color1', gainDb: -6 });
      expect(await call('audacity_info', { type: 'Clips' })).toEqual(
        expect.arrayContaining([expect.objectContaining({ name: 'Spoken clip' })]),
      );
      const after = await call<Measurement>('audacity_measure', { track: 'Voice', backend: 'wav' });
      expect(after.rmsDbfs! - before.rmsDbfs!).toBeCloseTo(-6, 2);
      await call('audacity_fade', { track: 'Voice', direction: 'in', start: 0, end: 0.5 });
      await call('audacity_fade', { track: 'Voice', direction: 'out', start: 1.5, end: 2 });
      const beginning = await call<Measurement>('audacity_measure', {
        track: 'Voice',
        start: 0,
        end: 0.05,
        backend: 'wav',
      });
      const middle = await call<Measurement>('audacity_measure', {
        track: 'Voice',
        start: 0.75,
        end: 1,
        backend: 'wav',
      });
      expect(beginning.rms).toBeLessThan(middle.rms * 0.15);
    },
    testTimeout,
  );
}
