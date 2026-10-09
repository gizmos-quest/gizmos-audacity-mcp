import { expect, it } from 'vitest';
import { selectionTimes } from '../../src/analysis.js';
import { available, type LiveContext, type Measurement, testTimeout } from './session.js';

export function registerAnalysis(context: LiveContext) {
  const { call, refuse, tracks, importVoice } = context;
  it(
    'measures selections/files and contrast, finds silence and checks numeric targets',
    async () => {
      const { fixture, quietFixture, lowFixture } = context;
      await importVoice('Voice', quietFixture, 1);
      await importVoice('Room tone', lowFixture, 1);
      await call('audacity_select', { track: 'Room tone', start: 1.5, end: 2 });
      const selection = selectionTimes(await call('audacity_info', { type: 'Selection' }));
      const selected = (await tracks()).map((track) => track.selected);
      const measured = await call<Measurement>('audacity_measure', {
        track: 'Voice',
        start: 1.5,
        end: 2,
        backend: 'wav',
      });
      expect(measured.rmsDbfs).toBeCloseTo(20 * Math.log10(12000 / 32768 / Math.SQRT2), 2);
      expect(selectionTimes(await call('audacity_info', { type: 'Selection' }))).toEqual(selection);
      expect((await tracks()).map((track) => track.selected)).toEqual(selected);
      const current = await call<Measurement>('audacity_measure', { currentSelection: true, backend: 'wav' });
      expect(current.rms).toBeLessThan(measured.rms * 0.02);
      const checked = await call('audacity_measure_file', {
        file: fixture,
        backend: 'wav',
        targets: { peakDbfs: { max: 0 }, truePeakDbtp: { max: -1 } },
      });
      expect(checked).toMatchObject({ targetCheck: { status: 'unknown' } });
      expect(await call('audacity_targets')).toHaveProperty('presets.video');
      expect(
        await call('audacity_contrast', {
          foreground: { track: 'Voice', start: 1.5, end: 2 },
          background: { track: 'Room tone', start: 1.5, end: 2 },
          minimumDb: 20,
        }),
      ).toMatchObject({ status: 'met' });
      const silence = await call<{ regions: { start: number; end: number }[] }>('audacity_silence', {
        track: 'Voice',
        thresholdDb: -60,
        minimumSeconds: 0.25,
      });
      expect(silence.regions[0]!.start).toBeCloseTo(1, 4);
      // The tone starts with a zero sample, so the detected boundary can differ by one frame.
      expect(silence.regions[0]!.end).toBeCloseTo(1.5, 4);
      expect(await call('audacity_silence', { file: quietFixture, minimumSeconds: 0.25 })).toMatchObject({ count: 1 });
      const comparison = await call<{ delta: { rmsDbfs: { change: number } } }>('audacity_compare_files', {
        before: fixture,
        after: lowFixture,
        backend: 'wav',
      });
      expect(comparison.delta.rmsDbfs.change).toBeCloseTo(-40, 1);
    },
    testTimeout,
  );

  it(
    'uses optional ffmpeg/ffprobe for real loudness and file metadata',
    async () => {
      const { fixture } = context;
      const ffmpeg = process.env.AUDACITY_FFMPEG ?? 'ffmpeg';
      const ffprobe = process.env.AUDACITY_FFPROBE ?? 'ffprobe';
      if (available(ffmpeg)) {
        const measured = await call<Measurement>('audacity_measure_file', { file: fixture, backend: 'ffmpeg' });
        expect(Number.isFinite(measured.integratedLufs)).toBe(true);
        expect(Number.isFinite(measured.truePeakDbtp)).toBe(true);
      } else
        await expect(refuse('audacity_measure_file', { file: fixture, backend: 'ffmpeg' })).rejects.toThrow(
          /ffmpeg unavailable/,
        );
      if (available(ffprobe)) {
        expect(await call('audacity_probe_file', { file: fixture })).toMatchObject({
          streams: [expect.objectContaining({ codec_type: 'audio', sample_rate: '48000', channels: 1 })],
        });
      } else {
        context.unavailable.add('audacity_probe_file');
        await expect(refuse('audacity_probe_file', { file: fixture })).rejects.toThrow(/ffprobe unavailable/);
      }
    },
    testTimeout,
  );

  it(
    'previews and verifies a bounded loudness target on a real track',
    async () => {
      await importVoice();
      const args = { track: 'Voice', targetLufs: -18, truePeakCeilingDbtp: -1, maxBoostDb: 18, toleranceLu: 0.5 };
      const before = await call<Measurement>('audacity_measure', { track: 'Voice', backend: 'wav' });
      if (available(process.env.AUDACITY_FFMPEG ?? 'ffmpeg')) {
        expect(await call('audacity_loudness_target', { ...args, dryRun: true })).toMatchObject({ dryRun: true });
        expect((await call<Measurement>('audacity_measure', { track: 'Voice', backend: 'wav' })).rms).toBeCloseTo(
          before.rms,
          6,
        );
        await call('audacity_loudness_target', args);
        const measured = await call<Measurement>('audacity_measure', { track: 'Voice', backend: 'ffmpeg' });
        expect(Math.abs(measured.integratedLufs! + 18)).toBeLessThanOrEqual(0.6);
        expect(measured.truePeakDbtp!).toBeLessThanOrEqual(-0.9);
      } else {
        context.unavailable.add('audacity_loudness_target');
        await expect(refuse('audacity_loudness_target', args)).rejects.toThrow(/ffmpeg unavailable/);
      }
    },
    testTimeout,
  );
}
