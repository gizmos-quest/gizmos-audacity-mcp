import { expect, it } from 'vitest';
import { type LiveContext, type Measurement, testTimeout, type Windows } from './session.js';

export function registerGeneration(context: LiveContext) {
  const { call, tracks } = context;
  it.each([
    { kind: 'tone', frequency: 220, amplitude: 0.1, waveform: 'Sine' },
    { kind: 'noise', noiseType: 'Pink', amplitude: 0.1 },
    { kind: 'silence' },
    {
      kind: 'chirp',
      frequency: 220,
      endFrequency: 880,
      amplitude: 0.1,
      endAmplitude: 0.05,
      interpolation: 'Logarithmic',
    },
    { kind: 'rhythm', tempo: 120, beatsPerBar: 4, swing: 0.1, clickSound: 'Metronome' },
  ])(
    'generates $kind without dialogs',
    async (parameters) => {
      await call('audacity_generate', { ...parameters, name: parameters.kind, start: 0.25, duration: 0.75 });
      const generated = (await tracks())[0]!;
      expect(generated.name).toBe(parameters.kind);
      expect(generated.start).toBeCloseTo(0.25, 3);
      expect(generated.end).toBeGreaterThan(generated.start);
      const measured = await call<Measurement>('audacity_measure', { track: parameters.kind, backend: 'wav' });
      // Audacity's 16-bit PCM export can dither digital silence by one LSB.
      if (parameters.kind === 'silence') expect(measured.rms).toBeLessThanOrEqual(1e-4);
      else expect(measured.rms).toBeGreaterThan(0);
      expect((await call<Windows>('audacity_dialogs')).windows.some((window) => window.dialog)).toBe(false);
    },
    testTimeout,
  );

  it(
    'replaces a range of an existing stereo track with generated audio',
    async () => {
      await call('audacity_generate', { kind: 'tone', name: 'Stereo', channels: 2, duration: 2, amplitude: 0.1 });
      expect(await call('audacity_measure', { track: 'Stereo', backend: 'wav' })).toMatchObject({ channels: 2 });
      await call('audacity_generate', { kind: 'silence', track: 'Stereo', start: 0.5, duration: 0.25 });
      expect((await tracks()).length).toBe(1);
      expect(
        (await call<Measurement>('audacity_measure', { track: 'Stereo', start: 0.5, end: 0.75, backend: 'wav' })).rms,
      ).toBeLessThanOrEqual(1e-4);
    },
    testTimeout,
  );
}
