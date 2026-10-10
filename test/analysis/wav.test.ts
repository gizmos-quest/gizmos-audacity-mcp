import { describe, expect, it } from 'vitest';
import { amplitudeDb } from '../../src/analysis/types.js';
import { change, chunk, measureBuffer, riff, wav, wavHeader } from '../helpers/audio-fixture.js';

describe('RIFF WAV parser and native measurements', () => {
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

  it('skips odd-length metadata and accepts data before fmt', async () => {
    const buffer = wav([0.5], { metadata: true, dataFirst: true });
    expect((await wavHeader(buffer)).dataOffset).toBe(32);
    expect((await measureBuffer(buffer)).peak).toBe(0.5);
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

  const ordinary = wav([0, 0]);
  const fmt = ordinary.subarray(20, 36);
  const invalid = [
    ['short header', Buffer.alloc(8), /RIFF WAV/],
    ['wrong RIFF signature', change(ordinary, (b) => b.write('RF64')), /RIFF WAV/],
    ['wrong WAVE signature', change(ordinary, (b) => b.write('AVI ', 8)), /RIFF WAV/],
    ['invalid RIFF body size', change(ordinary, (b) => b.writeUInt32LE(0, 4)), /body is invalid/],
    ['truncated RIFF body', ordinary.subarray(0, ordinary.length - 1), /body is truncated/],
    ['truncated chunk', change(ordinary, (b) => b.writeUInt32LE(1000, 40)), /chunk is truncated/],
    ['missing fmt', riff([chunk('data', Buffer.alloc(4))]), /requires fmt and data/],
    ['missing data', riff([chunk('fmt ', fmt)]), /requires fmt and data/],
    ['short fmt', riff([chunk('fmt ', fmt.subarray(0, 15)), chunk('data', Buffer.alloc(4))]), /fmt chunk is truncated/],
    ['huge fmt', riff([chunk('fmt ', Buffer.alloc(4097)), chunk('data', Buffer.alloc(4))]), /unreasonably large/],
    ['unsupported encoding', change(ordinary, (b) => b.writeUInt16LE(6, 20)), /not PCM or IEEE float/],
    ['unsupported width', change(ordinary, (b) => b.writeUInt16LE(20, 34)), /sample width/],
    ['float at 16 bits', change(ordinary, (b) => b.writeUInt16LE(3, 20)), /sample width/],
    ['zero channels', change(ordinary, (b) => b.writeUInt16LE(0, 22)), /channels/],
    ['excess channels', change(ordinary, (b) => b.writeUInt16LE(33, 22)), /channels/],
    [
      'zero sample rate',
      change(ordinary, (b) => {
        b.writeUInt32LE(0, 24);
        b.writeUInt32LE(0, 28);
      }),
      /sample rate/,
    ],
    [
      'excess sample rate',
      change(ordinary, (b) => {
        b.writeUInt32LE(768001, 24);
        b.writeUInt32LE(1536002, 28);
      }),
      /sample rate/,
    ],
    [
      'bad alignment',
      change(ordinary, (b) => {
        b.writeUInt16LE(3, 32);
        b.writeUInt32LE(30, 28);
      }),
      /alignment/,
    ],
    ['bad byte rate', change(ordinary, (b) => b.writeUInt32LE(1, 28)), /byte rate/],
    ['partial frame', riff([chunk('fmt ', fmt), chunk('data', Buffer.alloc(3))]), /partial sample frame/],
    ['duplicate fmt', riff([chunk('fmt ', fmt), chunk('fmt ', fmt), chunk('data', Buffer.alloc(4))]), /multiple fmt/],
    [
      'duplicate data',
      riff([chunk('fmt ', fmt), chunk('data', Buffer.alloc(4)), chunk('data', Buffer.alloc(4))]),
      /multiple data/,
    ],
    [
      'partial chunk header',
      riff([chunk('fmt ', fmt), chunk('data', Buffer.alloc(4)), Buffer.alloc(3)]),
      /truncated chunk header/,
    ],
    [
      'missing odd chunk padding',
      change(riff([chunk('fmt ', fmt), chunk('data', Buffer.alloc(1))]).subarray(0, 45), (b) => b.writeUInt32LE(37, 4)),
      /chunk is truncated/,
    ],
    ['short extensible format', change(ordinary, (b) => b.writeUInt16LE(0xfffe, 20)), /extensible fmt/],
    [
      'extensible valid-bit mismatch',
      change(wav([0], { extensible: true }), (b) => b.writeUInt16LE(15, 38)),
      /valid bits/,
    ],
    [
      'extensible wrong GUID',
      change(wav([0], { extensible: true }), (b) => {
        b[49] = 7;
      }),
      /subformat/,
    ],
  ] as const;
  it.each(invalid)('refuses %s', async (_name, buffer, error) => {
    await expect(wavHeader(buffer)).rejects.toThrow(error);
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
