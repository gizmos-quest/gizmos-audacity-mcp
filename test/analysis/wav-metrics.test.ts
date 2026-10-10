import { describe, expect, it } from 'vitest';
import { amplitudeDb } from '../../src/analysis/types.js';
import { measureBuffer, wav } from '../helpers/audio-fixture.js';

describe('native WAV measurements', () => {
  it.each([8, 16, 24, 32])('measures signed full-scale PCM boundaries at %i bits', async (bits) => {
    const measured = await measureBuffer(wav([-0.5, 0.5], { bits }));
    expect(measured).toMatchObject({ frames: 2, duration: 0.2, peak: 0.5, rms: 0.5, dcOffset: 0, channels: 1 });
    expect(measured.peakDbfs).toBeCloseTo(-6.0206, 5);
    expect(measured.crestDb).toBe(0);
  });

  it.each([32, 64])('measures IEEE float %i including values beyond full scale', async (bits) => {
    const measured = await measureBuffer(wav([-1.25, 1.25], { bits, float: true }));
    expect(measured).toMatchObject({ peak: 1.25, rms: 1.25, clippedSamples: 2, discontinuities: 1 });
    expect(measured.peakDbfs).toBeGreaterThan(0);
  });

  it.each([
    { float: false, bits: 24 },
    { float: true, bits: 32 },
  ])('accepts extensible fmt $bits, float=$float', async (options) => {
    expect((await measureBuffer(wav([0.25, -0.25], { ...options, extensible: true }))).rms).toBe(0.25);
  });

  it('returns finite zero levels and unavailable dB for empty audio', async () => {
    const measured = await measureBuffer(wav([]));
    expect(measured).toMatchObject({
      duration: 0,
      frames: 0,
      peak: 0,
      rms: 0,
      dcOffset: 0,
      peakDbfs: null,
      rmsDbfs: null,
      crestDb: null,
    });
    expect(measured.silenceGapCount).toBe(0);
    expect(measured.unavailable.integratedLufs).toContain('ffmpeg');
  });

  it.each([NaN, Infinity, -Infinity, 1e200])('refuses non-finite or overflowing floating audio %s', async (sample) => {
    await expect(measureBuffer(wav([sample], { float: true, bits: 64 }))).rejects.toThrow(/non-finite or overflowing/);
  });

  it('refuses cumulative float overflow rather than reporting nonfinite RMS as an absent metric', async () => {
    await expect(measureBuffer(wav([1e154, -1e154], { float: true, bits: 64 }))).rejects.toThrow(
      /accumulation overflowed/,
    );
  });

  it('keeps channels separate while calculating aggregate RMS and DC', async () => {
    const measured = await measureBuffer(wav([0.5, 0, 0.5, -0.5], { channels: 2 }));
    expect(measured.perChannel[0]).toMatchObject({ peak: 0.5, rms: 0.5, dcOffset: 0.5 });
    expect(measured.perChannel[1]).toMatchObject({ peak: 0.5, rms: 0.353553, dcOffset: -0.25 });
    expect(measured.rms).toBeCloseTo(Math.sqrt(0.1875), 6);
    expect(measured.dcOffset).toBe(0.125);
  });

  it('reports quiet blocks as estimates and interpolates linear percentiles before converting to dB', async () => {
    const measured = await measureBuffer(
      wav([...Array(10).fill(0.01), ...Array(10).fill(0.1), ...Array(10).fill(1)], { float: true, bits: 64 }),
    );
    expect(measured.quietRmsDbfsEstimate).toBe(amplitudeDb(0.028));
    expect(measured.dynamicRangeDbEstimate).toBeCloseTo(amplitudeDb(0.91)! - amplitudeDb(0.028)!, 5);
    expect(measured.notes.join(' ')).toContain('estimate');
  });

  it('counts terminal silence and requires every stereo channel to be quiet', async () => {
    const measured = await measureBuffer(wav([...Array(10).fill(0), 0.5, 0, ...Array(10).fill(0)], { channels: 2 }));
    expect(measured.silenceGaps).toEqual([
      { start: 0, end: 0.5, duration: 0.5 },
      { start: 0.6, end: 1.1, duration: 0.5 },
    ]);
  });

  it('supports a configurable silence threshold, minimum duration and capped output', async () => {
    const measured = await measureBuffer(
      wav([0.01, 0.01, 0.5, 0.01, 0.01, 0.5, 0.01, 0.01], { float: true, bits: 64 }),
      { thresholdDb: -30, minimumSeconds: 0.2, maxRegions: 2 },
    );
    expect(measured.silenceGapCount).toBe(3);
    expect(measured.silenceGaps).toEqual([
      { start: 0, end: 0.2, duration: 0.2 },
      { start: 0.3, end: 0.5, duration: 0.2 },
    ]);
  });

  it('does not classify a sample at the silence threshold or a shorter interval as silence', async () => {
    const measured = await measureBuffer(wav([0, 0, 0, 0, 0.001, 0, 0, 0, 0], { float: true, bits: 64 }));
    expect(measured.silenceGapCount).toBe(0);
  });

  it('streams across 64 KiB read blocks without losing samples or the trailing silence', async () => {
    // 308000 float frames span 19 read blocks; the silence starts inside one of them.
    const measured = await measureBuffer(
      wav([...Array(260000).fill(0.25), ...Array(48000).fill(0)], { float: true, bits: 32, sampleRate: 48000 }),
    );
    expect(measured).toMatchObject({ frames: 308000, peak: 0.25, rms: 0.229695, silenceGapCount: 1 });
    expect(measured.silenceGaps).toEqual([{ start: 260000 / 48000, end: 308000 / 48000, duration: 1 }]);
  });
});
