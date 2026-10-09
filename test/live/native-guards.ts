// Real stdio MCP integration against Audacity 3.7.x. Only AUDACITY_LIVE=1
// enables process or pipe access. User projects are backed up persistently;
// every test edit happens in the hidden, disposable test project.

import { expect, it } from 'vitest';
import { type LiveContext, type Measurement, testTimeout, tone, type Windows } from './session.js';

export function registerNativeGuards(context: LiveContext) {
  const { call, refuse, tracks, importVoice, output } = context;
  it(
    'validates noise-profile clip continuity and source frames independently of project rate',
    async () => {
      await call('audacity_fresh', { visible: false });
      await call('audacity_command', { command: 'SetProject', params: { Rate: 48000 } });
      const lowRate = output('source-rate-8000');
      tone(lowRate, 1, 12000, 0, 8000);
      await importVoice('Low 8k', lowRate);
      await importVoice('Distractor 48k');
      await call('audacity_edit', { action: 'split_delete', track: 'Distractor 48k', start: 0.5, end: 1.5 });
      await call('audacity_select', { track: 'Distractor 48k', start: 0.75, end: 1.25 });
      const originalTracks = await tracks();
      const originalSelection = await call('audacity_info', { type: 'Selection' });
      const originalClips = await call('audacity_info', { type: 'Clips' });
      const originalAudio = await call<Measurement>('audacity_measure', { track: 'Low 8k', backend: 'wav' });
      await expect(
        refuse('audacity_noise_profile', { track: 'Distractor 48k', start: 0.25, end: 1.75 }),
      ).rejects.toThrow(/one audio clip/);
      expect(await tracks()).toEqual(originalTracks);
      expect(await call('audacity_info', { type: 'Selection' })).toEqual(originalSelection);
      expect(await call('audacity_info', { type: 'Clips' })).toEqual(originalClips);
      // The project render has 4800 frames in 0.1 seconds. Its 8 kHz source has
      // only 800, which would make native profiling open a blocking error dialog.
      expect(await call('audacity_measure', { track: 'Low 8k', start: 0, end: 0.1, backend: 'wav' })).toMatchObject({
        sampleRate: 48000,
        frames: 4800,
      });
      await expect(refuse('audacity_noise_profile', { track: 'Low 8k', start: 0, end: 0.1 })).rejects.toThrow(
        /4096 source samples/,
      );
      expect(await tracks()).toEqual(originalTracks);
      expect(await call('audacity_info', { type: 'Selection' })).toEqual(originalSelection);
      expect(await call('audacity_info', { type: 'Clips' })).toEqual(originalClips);
      expect((await call<Measurement>('audacity_measure', { track: 'Low 8k', backend: 'wav' })).rms).toBeCloseTo(
        originalAudio.rms,
        5,
      );
      expect((await call<Windows>('audacity_dialogs')).windows.filter((window) => window.dialog)).toEqual([]);
      await call('audacity_noise_profile', { track: 'Low 8k', start: 0, end: 0.6 });
      await call('audacity_effect', { effect: 'NoiseReduction', track: 'Low 8k', params: {} });
      expect((await tracks()).find((track) => track.name === 'Low 8k')).toMatchObject({ start: 0, end: 1 });
      expect((await call<Windows>('audacity_dialogs')).windows.filter((window) => window.dialog)).toEqual([]);
      await call('audacity_recover');
      await expect(
        refuse('audacity_effect', { effect: 'NoiseReduction', track: 'Low 8k', params: {} }),
      ).rejects.toThrow(/fresh Audacity process/);
    },
    testTimeout,
  );

  it(
    'preflights native source-rate filter failures before changing selection or earlier pipeline samples',
    async () => {
      const lowRate = output('filter-source-8000');
      tone(lowRate, 1, 12_000, 0, 8000);
      await importVoice('Low 8k', lowRate);
      await importVoice('Unrelated');
      await call('audacity_command', { command: 'SetProject', params: { Rate: 48000 } });
      await call('audacity_select', { track: 'Unrelated', start: 0.25, end: 0.5 });
      const previous = await tracks();
      const selection = await call('audacity_info', { type: 'Selection' });
      const clips = await call('audacity_info', { type: 'Clips' });
      const before = await call<Measurement>('audacity_measure', { track: 'Low 8k', backend: 'wav' });
      for (const effect of ['High-passFilter', 'Low-passFilter', 'NotchFilter']) {
        await expect(
          refuse('audacity_effect', { effect, track: 'Low 8k', params: { FREQUENCY: 5000 } }),
        ).rejects.toThrow(/source|Nyquist|sample rate/i);
      }
      await expect(
        refuse('audacity_effect', { effect: 'Low-passFilter', track: 'Low 8k', params: {} }),
      ).rejects.toThrow(/explicit|FREQUENCY/);
      await expect(
        refuse('audacity_effect', { effect: 'Tremolo', track: 'Low 8k', start: 0, end: 0.000001, params: {} }),
      ).rejects.toThrow(/source frame/);
      await expect(refuse('audacity_pipeline', { preset: 'lofi', track: 'Low 8k' })).rejects.toThrow(
        /source|Nyquist|sample rate/i,
      );
      expect(await tracks()).toEqual(previous);
      expect(await call('audacity_info', { type: 'Selection' })).toEqual(selection);
      expect(await call('audacity_info', { type: 'Clips' })).toEqual(clips);
      expect((await call<Measurement>('audacity_measure', { track: 'Low 8k', backend: 'wav' })).rms).toBeCloseTo(
        before.rms,
        5,
      );
      await call('audacity_effect', {
        effect: 'Low-passFilter',
        track: 'Low 8k',
        params: { FREQUENCY: 1000, ROLLOFF: 'dB12' },
      });
      expect((await call<Windows>('audacity_dialogs')).windows.filter((window) => window.dialog)).toEqual([]);
    },
    testTimeout,
  );
}
