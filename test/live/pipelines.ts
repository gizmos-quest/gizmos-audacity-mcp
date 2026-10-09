// Real stdio MCP integration against Audacity 3.7.x. Only AUDACITY_LIVE=1
// enables process or pipe access. User projects are backed up persistently;
// every test edit happens in the hidden, disposable test project.

import { expect, it } from 'vitest';
import { type LiveContext, type Measurement, testTimeout } from './session.js';

export function registerPipelines(context: LiveContext) {
  const { call, refuse, tracks, importVoice } = context;
  it(
    'previews and applies auto-duck only with the required bed/voice topology',
    async () => {
      await importVoice('Bed');
      await importVoice('Voice');
      const before = await call<Measurement>('audacity_measure', { track: 'Bed', backend: 'wav' });
      expect(await call('audacity_auto_duck', { bed: 'Bed', voice: 'Voice', dryRun: true })).toMatchObject({
        dryRun: true,
        command: 'AutoDuck',
      });
      await call('audacity_auto_duck', {
        bed: 'Bed',
        voice: 'Voice',
        duckDb: -12,
        thresholdDb: -30,
        fadeDown: 0.1,
        fadeUp: 0.1,
      });
      const after = await call<Measurement>('audacity_measure', { track: 'Bed', backend: 'wav' });
      expect(after.rms).toBeLessThan(before.rms * 0.6);
      await expect(refuse('audacity_auto_duck', { bed: 'Voice', voice: 'Bed' })).rejects.toThrow(
        /immediately following audio track/,
      );
    },
    testTimeout,
  );

  it(
    'refuses generic and typed AutoDuck with an intervening label without opening a dialog',
    async () => {
      await importVoice('Bed');
      await call('audacity_track_edit', { action: 'add_label', name: 'Cues' });
      await importVoice('Voice');
      await call('audacity_select', { track: 'Voice', start: 0.25, end: 0.5 });
      const before = await call('audacity_info', { type: 'Selection' });
      await expect(refuse('audacity_auto_duck', { bed: 'Bed', voice: 'Voice' })).rejects.toThrow(
        /immediately following/,
      );
      expect(await call('audacity_info', { type: 'Selection' })).toEqual(before);
      await call('audacity_select', { track: 'Bed' });
      await expect(refuse('audacity_command', { command: 'AutoDuck', params: {} })).rejects.toThrow(
        /immediately below/,
      );
      await expect(refuse('audacity_effect', { effect: 'AutoDuck', params: {}, track: 'Bed' })).rejects.toThrow(
        /immediately below/,
      );
      const windows = await call<{ windows: { dialog: boolean }[] }>('audacity_dialogs');
      expect(windows.windows.some((window) => window.dialog)).toBe(false);
    },
    testTimeout,
  );

  it.each(['cleanup', 'voice', 'podcast', 'interview', 'audiobook', 'vocal', 'live', 'music', 'lofi'])(
    'previews and applies the %s pipeline within the target extent',
    async (preset) => {
      const { fixture } = context;
      await importVoice('Voice', fixture, 1);
      await importVoice('Long bed', fixture, 4);
      await call('audacity_select', { track: 'Long bed', start: 4.25, end: 4.5 });
      const selection = await call('audacity_info', { type: 'Selection' });
      const plan = await call<{ dryRun: boolean; steps: { command: string; params: unknown }[] }>('audacity_pipeline', {
        preset,
        track: 'Voice',
        dryRun: true,
      });
      expect(plan.dryRun).toBe(true);
      expect(plan.steps.length).toBeGreaterThan(1);
      expect(await call('audacity_info', { type: 'Selection' })).toEqual(selection);
      const result = await call<{ applied: unknown[]; steps: unknown[] }>('audacity_pipeline', {
        preset,
        track: 'Voice',
      });
      expect(result.applied.length).toBe(result.steps.length);
      const voice = (await tracks()).find((track) => track.name === 'Voice')!;
      expect(voice.start).toBeCloseTo(1, 3);
      expect(voice.end).toBeCloseTo(3, 3);
      expect((await call<Measurement>('audacity_measure', { track: 'Voice', backend: 'wav' })).rms).toBeGreaterThan(0);
    },
    testTimeout,
  );
}
