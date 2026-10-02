import { afterEach, describe, expect, it, vi } from 'vitest';
import { mkdtemp, rm, writeFile, access } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { z } from 'zod';
import {
  amplitudeDb, percentile, parseWavHeader, measureWavBuffer, measureWavFile,
  parseFfmpegMeasurement, parseProbe, runFfmpeg, probeFile, measureFile,
  SilenceSchema, MeasureScopeSchema, MeasureOptionsSchema, TargetSchema, TARGETS,
  checkTargets, compareMeasurements, selectionTimes, measureScope, registerAnalysisTools,
  LoudnessTargetSchema, planLoudnessTarget, loudnessTarget,
} from '../src/analysis.js';
import type { Ops, TrackInfo } from '../src/ops.js';
import { AudacityTimeout } from '../src/pipe.js';

const directories: string[] = [];
afterEach(async () => {
  vi.unstubAllEnvs();
  await Promise.all(directories.splice(0).map((directory) => rm(directory, { recursive: true, force: true })));
});

async function temporary(): Promise<string> {
  const directory = await mkdtemp(join(tmpdir(), 'gizmos-analysis-test-'));
  directories.push(directory);
  return directory;
}

function chunk(id: string, content: Buffer): Buffer {
  const header = Buffer.alloc(8);
  header.write(id); header.writeUInt32LE(content.length, 4);
  return Buffer.concat([header, content, Buffer.alloc(content.length & 1)]);
}

function riff(chunks: readonly Buffer[]): Buffer {
  const body = Buffer.concat(chunks);
  const header = Buffer.alloc(12);
  header.write('RIFF'); header.writeUInt32LE(body.length + 4, 4); header.write('WAVE', 8);
  return Buffer.concat([header, body]);
}

interface WavOptions { bits?: number; float?: boolean; sampleRate?: number; channels?: number; extensible?: boolean; metadata?: boolean; dataFirst?: boolean }
function wav(samples: readonly number[], options: WavOptions = {}): Buffer {
  const bits = options.bits ?? 16;
  const channels = options.channels ?? 1;
  const rate = options.sampleRate ?? 10;
  const width = bits / 8;
  const format = Buffer.alloc(options.extensible ? 40 : 16);
  format.writeUInt16LE(options.extensible ? 0xfffe : options.float ? 3 : 1, 0);
  format.writeUInt16LE(channels, 2); format.writeUInt32LE(rate, 4);
  format.writeUInt32LE(rate * channels * width, 8); format.writeUInt16LE(channels * width, 12); format.writeUInt16LE(bits, 14);
  if (options.extensible) {
    format.writeUInt16LE(22, 16); format.writeUInt16LE(bits, 18);
    Buffer.from('0000000000001000800000aa00389b71', 'hex').copy(format, 24);
    format.writeUInt32LE(options.float ? 3 : 1, 24);
  }
  const audio = Buffer.alloc(samples.length * width);
  samples.forEach((sample, index) => {
    const offset = index * width;
    if (options.float) {
      if (bits === 32) audio.writeFloatLE(sample, offset); else audio.writeDoubleLE(sample, offset);
    } else if (bits === 8) audio.writeUInt8(Math.max(0, Math.min(255, Math.round(sample * 128 + 128))), offset);
    else {
      const scale = 2 ** (bits - 1);
      audio.writeIntLE(Math.max(-scale, Math.min(scale - 1, Math.round(sample * scale))), offset, width);
    }
  });
  const parts = [chunk('fmt ', format), chunk('data', audio)];
  if (options.dataFirst) parts.reverse();
  if (options.metadata) parts.unshift(chunk('JUNK', Buffer.from([1, 2, 3])));
  return riff(parts);
}

function change(buffer: Buffer, apply: (buffer: Buffer) => void): Buffer {
  const result = Buffer.from(buffer); apply(result); return result;
}

describe('RIFF WAV parser and native measurements', () => {
  it.each([8, 16, 24, 32])('measures signed full-scale PCM boundaries at %i bits', (bits) => {
    const measured = measureWavBuffer(wav([-0.5, 0.5], { bits }));
    expect(measured).toMatchObject({ frames: 2, duration: 0.2, peak: 0.5, rms: 0.5, dcOffset: 0, channels: 1 });
    expect(measured.peakDbfs).toBeCloseTo(-6.0206, 5);
    expect(measured.crestDb).toBe(0);
  });

  it.each([32, 64])('measures IEEE float %i including values beyond full scale', (bits) => {
    const measured = measureWavBuffer(wav([-1.25, 1.25], { bits, float: true }));
    expect(measured).toMatchObject({ peak: 1.25, rms: 1.25, clippedSamples: 2, discontinuities: 1 });
    expect(measured.peakDbfs).toBeGreaterThan(0);
  });

  it.each([{ float: false, bits: 24 }, { float: true, bits: 32 }])('accepts extensible fmt $bits, float=$float', (options) => {
    expect(measureWavBuffer(wav([0.25, -0.25], { ...options, extensible: true })).rms).toBe(0.25);
  });

  it('skips odd-length metadata and accepts data before fmt', () => {
    const buffer = wav([0.5], { metadata: true, dataFirst: true });
    expect(parseWavHeader(buffer).dataOffset).toBe(32);
    expect(measureWavBuffer(buffer).peak).toBe(0.5);
  });

  it('returns finite zero levels and unavailable dB for empty audio', () => {
    const measured = measureWavBuffer(wav([]));
    expect(measured).toMatchObject({ duration: 0, frames: 0, peak: 0, rms: 0, dcOffset: 0, peakDbfs: null, rmsDbfs: null, crestDb: null });
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
    ['zero sample rate', change(ordinary, (b) => { b.writeUInt32LE(0, 24); b.writeUInt32LE(0, 28); }), /sample rate/],
    ['excess sample rate', change(ordinary, (b) => { b.writeUInt32LE(768001, 24); b.writeUInt32LE(1536002, 28); }), /sample rate/],
    ['bad alignment', change(ordinary, (b) => { b.writeUInt16LE(3, 32); b.writeUInt32LE(30, 28); }), /alignment/],
    ['bad byte rate', change(ordinary, (b) => b.writeUInt32LE(1, 28)), /byte rate/],
    ['partial frame', riff([chunk('fmt ', fmt), chunk('data', Buffer.alloc(3))]), /partial sample frame/],
    ['duplicate fmt', riff([chunk('fmt ', fmt), chunk('fmt ', fmt), chunk('data', Buffer.alloc(4))]), /multiple fmt/],
    ['duplicate data', riff([chunk('fmt ', fmt), chunk('data', Buffer.alloc(4)), chunk('data', Buffer.alloc(4))]), /multiple data/],
    ['partial chunk header', riff([chunk('fmt ', fmt), chunk('data', Buffer.alloc(4)), Buffer.alloc(3)]), /truncated chunk header/],
    ['missing odd chunk padding', change(riff([chunk('fmt ', fmt), chunk('data', Buffer.alloc(1))]).subarray(0, 45), (b) => b.writeUInt32LE(37, 4)), /chunk is truncated/],
    ['short extensible format', change(ordinary, (b) => b.writeUInt16LE(0xfffe, 20)), /extensible fmt/],
    ['extensible valid-bit mismatch', change(wav([0], { extensible: true }), (b) => b.writeUInt16LE(15, 38)), /valid bits/],
    ['extensible wrong GUID', change(wav([0], { extensible: true }), (b) => b[49] = 7), /subformat/],
  ] as const;
  it.each(invalid)('refuses %s', (_name, buffer, error) => expect(() => parseWavHeader(buffer)).toThrow(error));

  it.each([NaN, Infinity, -Infinity, 1e200])('refuses non-finite or overflowing floating audio %s', (sample) => {
    expect(() => measureWavBuffer(wav([sample], { float: true, bits: 64 }))).toThrow(/non-finite or overflowing/);
  });

  it('refuses cumulative float overflow rather than reporting nonfinite RMS as an absent metric', () => {
    expect(() => measureWavBuffer(wav([1e154, -1e154], { float: true, bits: 64 }))).toThrow(/accumulation overflowed/);
  });

  it('keeps channels separate while calculating aggregate RMS and DC', () => {
    const measured = measureWavBuffer(wav([0.5, 0, 0.5, -0.5], { channels: 2 }));
    expect(measured.perChannel[0]).toMatchObject({ peak: 0.5, rms: 0.5, dcOffset: 0.5 });
    expect(measured.perChannel[1]).toMatchObject({ peak: 0.5, rms: 0.353553, dcOffset: -0.25 });
    expect(measured.rms).toBeCloseTo(Math.sqrt(0.1875), 6);
    expect(measured.dcOffset).toBe(0.125);
  });

  it('reports quiet blocks as estimates and interpolates linear percentiles before converting to dB', () => {
    const measured = measureWavBuffer(wav([...Array(10).fill(0.01), ...Array(10).fill(0.1), ...Array(10).fill(1)], { float: true, bits: 64 }));
    expect(measured.quietRmsDbfsEstimate).toBe(amplitudeDb(0.028));
    expect(measured.dynamicRangeDbEstimate).toBeCloseTo(amplitudeDb(0.91)! - amplitudeDb(0.028)!, 5);
    expect(measured.notes.join(' ')).toContain('estimate');
  });

  it('counts terminal silence and requires every stereo channel to be quiet', () => {
    const measured = measureWavBuffer(wav([
      ...Array(10).fill(0), 0.5, 0, ...Array(10).fill(0),
    ], { channels: 2 }));
    expect(measured.silenceGaps).toEqual([{ start: 0, end: 0.5, duration: 0.5 }, { start: 0.6, end: 1.1, duration: 0.5 }]);
  });

  it('supports a configurable silence threshold, minimum duration and capped output', () => {
    const measured = measureWavBuffer(wav([0.01, 0.01, 0.5, 0.01, 0.01, 0.5, 0.01, 0.01], { float: true, bits: 64 }),
      { thresholdDb: -30, minimumSeconds: 0.2, maxRegions: 2 });
    expect(measured.silenceGapCount).toBe(3);
    expect(measured.silenceGaps).toEqual([{ start: 0, end: 0.2, duration: 0.2 }, { start: 0.3, end: 0.5, duration: 0.2 }]);
  });

  it('does not classify a sample at the silence threshold or a shorter interval as silence', () => {
    const measured = measureWavBuffer(wav([0, 0, 0, 0, 0.001, 0, 0, 0, 0], { float: true, bits: 64 }));
    expect(measured.silenceGapCount).toBe(0);
  });

  it('streams files across read blocks without changing measurements or dropping boundary silence', async () => {
    const file = join(await temporary(), 'large.wav');
    const buffer = wav([...Array(260000).fill(0.25), ...Array(48000).fill(0)], { float: true, bits: 32, sampleRate: 48000 });
    await writeFile(file, buffer);
    expect(await measureWavFile(file)).toEqual(measureWavBuffer(buffer));
  });

  it.each(invalid.slice(0, 7))('the streamed parser also refuses %s', async (_name, buffer, _error) => {
    const file = join(await temporary(), 'invalid.wav'); await writeFile(file, buffer);
    await expect(measureWavFile(file)).rejects.toThrow();
  });
});

describe('numeric and schema helpers', () => {
  it('returns percentiles at endpoints and linearly interpolates', () => {
    expect(percentile([1, 2, 4], 0)).toBe(1); expect(percentile([1, 2, 4], 100)).toBe(4);
    expect(percentile([1, 2, 4], 75)).toBe(3); expect(percentile([], 50)).toBeNull();
  });
  it.each([-1, 101, NaN, Infinity])('refuses invalid percentile %s even for empty input', (percent) => {
    expect(() => percentile([], percent)).toThrow();
  });
  it.each([0, -1, NaN, Infinity])('returns unavailable dB for nonpositive or nonfinite amplitude %s', (value) => expect(amplitudeDb(value)).toBeNull());
  it('computes finite amplitude dB', () => expect(amplitudeDb(0.1)).toBe(-20));
  it.each([
    { thresholdDb: -121 }, { thresholdDb: 1 }, { thresholdDb: NaN }, { minimumSeconds: 0 }, { minimumSeconds: 3601 },
    { maxRegions: 0 }, { maxRegions: 1001 }, { maxRegions: 1.5 }, { bogus: 1 },
  ])('refuses invalid silence options %j', (options) => expect(SilenceSchema.safeParse(options).success).toBe(false));
  it.each([
    { trackCount: 2 }, { currentSelection: true, track: 0 }, { currentSelection: true, start: 0 }, { start: 2, end: 1 },
    { start: 1, end: 1 }, { track: -1 }, { track: 1.2 }, { track: 'bad"name' }, { start: NaN }, { bogus: 1 },
  ])('refuses invalid scope %j', (scope) => expect(MeasureScopeSchema.safeParse(scope).success).toBe(false));
  it('accepts track count, ranged scope, default scope and current selection', () => {
    expect(MeasureScopeSchema.parse({ track: 'Voice', trackCount: 2, start: 0, end: 1 })).toMatchObject({ currentSelection: false });
    expect(MeasureScopeSchema.parse({ currentSelection: true })).toEqual({ currentSelection: true });
    expect(MeasureScopeSchema.parse({})).toEqual({ currentSelection: false });
  });
  it.each([{ backend: 'other' }, { dualMono: 1 }, { timeoutMs: 0 }, { timeoutMs: 600001 }, { surprise: 1 }])('refuses invalid measurement options %j', (options) => {
    expect(MeasureOptionsSchema.safeParse(options).success).toBe(false);
  });
  it('reads selection objects and Audacity casing variants', () => {
    expect(selectionTimes([{ start: 0.2, end: 1.2 }])).toEqual({ start: 0.2, end: 1.2 });
    expect(selectionTimes({ Start: 0.2, End: 1.2 })).toEqual({ start: 0.2, end: 1.2 });
  });
  it.each([null, [], {}, { start: '0', end: 1 }, { start: -1, end: 1 }, { start: 2, end: 1 }, { start: 0, end: Infinity }])('refuses unreadable selection %j', (selection) => {
    expect(() => selectionTimes(selection)).toThrow();
  });
});

describe('optional process backends and output parsers', () => {
  it('reads only the final EBU R128 summary and overall astats', () => {
    const output = `Summary:
      Integrated loudness:
        I: -1 LUFS
      Loudness range:
        LRA: 99 LU
      True peak:
        Peak: 0 dBFS
      [astats] Channel: 1
      [astats] Peak level dB: -2
      [astats] RMS level dB: -3
      [astats] Overall
      [astats] Peak level dB: -4.2
      [astats] RMS level dB: -19.9
      [ebur128] t: 1 I: -99 LUFS
      [ebur128] Summary:
      Integrated loudness:
        I: -16.0 LUFS
      Loudness range:
        LRA: 3.5 LU
      True peak:
        Peak: -1.2 dBFS`;
    expect(parseFfmpegMeasurement(output)).toEqual({ integratedLufs: -16, loudnessRangeLu: 3.5, truePeakDbtp: -1.2, peakDbfs: -4.2, rmsDbfs: -19.9 });
  });
  it('returns null for absent or nonfinite readings rather than a passing zero', () => {
    expect(parseFfmpegMeasurement('Summary:\nIntegrated loudness:\nI: -inf LUFS\nTrue peak:\nPeak: nan dBFS')).toEqual({
      integratedLufs: null, loudnessRangeLu: null, truePeakDbtp: null, peakDbfs: null, rmsDbfs: null,
    });
  });
  it('refuses ffmpeg output without a loudness summary', () => expect(() => parseFfmpegMeasurement('Overall\nRMS level dB: -20')).toThrow(/summary/));
  it('filters probe output to useful audio and video metadata', () => {
    expect(parseProbe(JSON.stringify({ format: { format_name: 'wav', duration: '2', ignored: 'junk' },
      streams: [{ index: 0, codec_name: 'pcm_s16le', sample_rate: '48000', channels: 1, codec_type: 'audio', ignored: 'junk' }] }))).toEqual({
      format: { format_name: 'wav', duration: '2' }, streams: [{ index: 0, codec_name: 'pcm_s16le', sample_rate: '48000', channels: 1, codec_type: 'audio' }],
    });
  });
  it.each(['null', '[]', '{}', '{"format":[],"streams":[]}', '{"format":{},"streams":[null]}', '{"format":{},"streams":[[]]}', 'not json'])('refuses invalid probe output %s', (text) => {
    expect(() => parseProbe(text)).toThrow();
  });
  it('spawns an argument array and captures process diagnostics', async () => {
    expect(await runFfmpeg(['-e', 'process.stderr.write(process.argv[1])', 'spaces; $(do-not-execute)'], 1000, process.execPath)).toBe('spaces; $(do-not-execute)');
  });
  it('preserves failed-process diagnostics', async () => {
    await expect(runFfmpeg(['-e', 'process.stderr.write("codec failed");process.exit(7)'], 1000, process.execPath)).rejects.toThrow(/exited 7: codec failed/);
  });
  it('reports unavailable executables with an installation hint', async () => {
    await expect(runFfmpeg([], 1000, join(await temporary(), 'absent-ffmpeg'))).rejects.toThrow(/ffmpeg unavailable.*Install ffmpeg/);
  });
  it('bounds process runtime and terminates timed-out helper processes', async () => {
    await expect(runFfmpeg(['-e', 'setTimeout(()=>{},10000)'], 100, process.execPath)).rejects.toThrow(/exceeded 100 ms/);
  });
  it('bounds diagnostic output', async () => {
    await expect(runFfmpeg(['-e', 'process.stderr.write("x".repeat(1048577))'], 1000, process.execPath)).rejects.toThrow(/exceeded 1 MiB/);
  });
  it.each([0, -1, NaN, 600001, 1.5])('rejects invalid helper timeout %s', async (timeout) => {
    await expect(runFfmpeg([], timeout, process.execPath)).rejects.toThrow(/timeoutMs/);
  });
  it('measures WAV without ffmpeg as a hard dependency', async () => {
    const file = join(await temporary(), 'audio.wav'); await writeFile(file, wav([0.5, -0.5]));
    vi.stubEnv('AUDACITY_FFMPEG', join(await temporary(), 'absent-ffmpeg'));
    const native = await measureFile(file, { backend: 'wav' });
    expect(native).toMatchObject({ file, rms: 0.5, backend: 'native-wav' });
    const automatic = await measureFile(file);
    expect(automatic.rms).toBe(0.5); expect(automatic.integratedLufs).toBeNull();
    expect(automatic.unavailable.integratedLufs).toContain('ffmpeg unavailable');
    await expect(measureFile(file, { backend: 'ffmpeg' })).rejects.toThrow(/ffmpeg unavailable/);
  });
  it('reports both native and optional decoder failures for non-WAV files', async () => {
    const file = join(await temporary(), 'invalid.mp3'); await writeFile(file, Buffer.alloc(44));
    vi.stubEnv('AUDACITY_FFMPEG', join(await temporary(), 'absent-ffmpeg'));
    await expect(measureFile(file)).rejects.toThrow(/Native WAV measurement:.*RIFF WAV.*ffmpeg unavailable/);
    await expect(measureFile(file, { backend: 'wav' })).rejects.toThrow(/RIFF WAV/);
  });
  it('rejects directories, missing paths and invalid options before measuring', async () => {
    const directory = await temporary();
    await expect(measureFile(directory)).rejects.toThrow(/not a file/);
    await expect(measureFile(join(directory, 'missing.wav'))).rejects.toThrow();
    await expect(measureFile(directory, { timeoutMs: 0 })).rejects.toThrow();
  });
  it('probe reports missing optional tools and rejects unsafe timeouts', async () => {
    const file = join(await temporary(), 'audio.wav'); await writeFile(file, wav([0]));
    vi.stubEnv('AUDACITY_FFPROBE', join(await temporary(), 'absent-ffprobe'));
    await expect(probeFile(file)).rejects.toThrow(/ffprobe unavailable/);
    await expect(probeFile(file, 0)).rejects.toThrow(/timeoutMs/);
    await expect(probeFile(await temporary())).rejects.toThrow(/not a file/);
  });
});

describe('measurement targets and comparisons', () => {
  it('plans loudness gain from LUFS while retaining true-peak headroom', () => {
    const measured = { ...measureWavBuffer(wav([0.1])), integratedLufs: -20, truePeakDbtp: -10 };
    expect(planLoudnessTarget(measured, { targetLufs: -16 })).toMatchObject({ gainDb: 4, ratio: 10 ** (4 / 20), predictedLufs: -16, achievable: true, limits: [] });
  });
  it('reports a peak-limited LUFS target as unachievable and reserves rounding headroom', () => {
    const measured = { ...measureWavBuffer(wav([0.1])), integratedLufs: -20, truePeakDbtp: -3 };
    expect(planLoudnessTarget(measured, { targetLufs: -14, truePeakCeilingDbtp: -1 })).toMatchObject({ gainDb: 1.9, predictedLufs: -18.1,
      predictedTruePeakDbtp: -1.1, achievable: false, limits: ['true-peak ceiling'] });
  });
  it('caps boost and attenuates when the current peak already exceeds the ceiling', () => {
    const measured = { ...measureWavBuffer(wav([0.1])), integratedLufs: -30, truePeakDbtp: -20 };
    expect(planLoudnessTarget(measured, { maxBoostDb: 3 })).toMatchObject({ gainDb: 3, achievable: false, limits: ['maximum boost'] });
    measured.truePeakDbtp = 0;
    expect(planLoudnessTarget(measured)).toMatchObject({ gainDb: -1.1, achievable: false });
  });
  it('attenuates to a lower LUFS target without using available peak headroom', () => {
    const measured = { ...measureWavBuffer(wav([0.1])), integratedLufs: -12, truePeakDbtp: -2 };
    expect(planLoudnessTarget(measured, { targetLufs: -16 })).toMatchObject({ gainDb: -4, predictedLufs: -16, achievable: true });
  });
  it.each([{ integratedLufs: null, truePeakDbtp: -2 }, { integratedLufs: -16, truePeakDbtp: null },
    { integratedLufs: NaN, truePeakDbtp: -2 }, { integratedLufs: -16, truePeakDbtp: Infinity }])('refuses absent or nonfinite loudness %j', (metrics) => {
    expect(() => planLoudnessTarget({ ...measureWavBuffer(wav([0.1])), ...metrics })).toThrow(/established integrated LUFS and true peak/);
  });
  it('refuses silent audio and nonsensical attenuation before mutation', () => {
    expect(() => planLoudnessTarget({ ...measureWavBuffer(wav([0])), integratedLufs: -70, truePeakDbtp: -100 })).toThrow(/non-silent/);
    expect(() => planLoudnessTarget({ ...measureWavBuffer(wav([0.1])), integratedLufs: -16, truePeakDbtp: 70 })).toThrow(/60 dB/);
  });
  it.each([{ targetLufs: -51 }, { targetLufs: -4 }, { truePeakCeilingDbtp: 1 }, { maxBoostDb: -1 }, { toleranceLu: 0 }, { bogus: 1 }])('refuses invalid loudness settings %j', (settings) => {
    expect(LoudnessTargetSchema.safeParse(settings).success).toBe(false);
  });
  it.each([{}, { peakDbfs: undefined }, { peakDbfs: {} }, { peakDbfs: { min: 1, max: 0 } }, { peakDbfs: { max: Infinity } },
    { peakDbfs: { max: NaN } }, { peakDbfs: { max: 0, bogus: 1 } }, { bogus: { max: 0 } }])('refuses invalid targets %j', (targets) => {
    expect(TargetSchema.safeParse(targets).success).toBe(false);
  });
  it.each(Object.entries(TARGETS))('validates the %s house reference', (_name, targets) => expect(TargetSchema.safeParse(targets).success).toBe(true));
  it('accepts inclusive target bounds and reports signed gaps', () => {
    const measurement = measureWavBuffer(wav([0.5]));
    expect(checkTargets(measurement, { peakDbfs: { min: measurement.peakDbfs!, max: measurement.peakDbfs! } }).status).toBe('met');
    const low = checkTargets(measurement, { peakDbfs: { min: -5 } });
    expect(low.status).toBe('missed'); expect(low.checks.peakDbfs!.gap).toBeCloseTo(-1.0206, 5);
    const high = checkTargets(measurement, { peakDbfs: { max: -7 } });
    expect(high.checks.peakDbfs!.gap).toBeCloseTo(0.9794, 5);
  });
  it('never substitutes sample peak for unavailable true peak or estimates for noise floor', () => {
    const measurement = measureWavBuffer(wav([0.1]));
    const check = checkTargets(measurement, { truePeakDbtp: { max: -1 }, noiseFloorDbfs: { max: -60 } });
    expect(check.status).toBe('unknown');
    expect(check.checks.truePeakDbtp!.actual).toBeNull();
    expect(check.checks.noiseFloorDbfs!.reason).toContain('cannot certify');
  });
  it('reports missed over unknown when an available metric already fails', () => {
    const measurement = measureWavBuffer(wav([0.5]));
    expect(checkTargets(measurement, { peakDbfs: { max: -20 }, truePeakDbtp: { max: -1 } }).status).toBe('missed');
  });
  it('ignores explicitly undefined optional targets when valid bounds are present', () => {
    expect(checkTargets(measureWavBuffer(wav([0.1])), { peakDbfs: { max: 0 }, truePeakDbtp: undefined }).status).toBe('met');
  });
  it('keeps nonfinite measurement values unavailable', () => {
    const measured = measureWavBuffer(wav([0.1])); measured.integratedLufs = NaN;
    expect(checkTargets(measured, { integratedLufs: { max: -1 } }).status).toBe('unknown');
  });
  it('compares only metrics established on both sides', () => {
    const before = measureWavBuffer(wav([0.5])); const after = measureWavBuffer(wav([0.25]));
    expect(compareMeasurements(before, after).peakDbfs!.change).toBeCloseTo(-6.0206, 5);
    expect(compareMeasurements(before, after)).not.toHaveProperty('integratedLufs');
    after.rmsDbfs = Infinity; expect(compareMeasurements(before, after)).not.toHaveProperty('rmsDbfs');
  });
});

function fakeOps(tracks: TrackInfo[], selected = { start: 0.25, end: 0.75 }, exportFailure?: string) {
  const command = vi.fn(async (id: string, params: Record<string, unknown>, _timeout?: number) => {
    if (id === 'Export2') {
      if (exportFailure) throw new Error(exportFailure);
      await writeFile(String(params.Filename), wav([0, 0, 0, 0, 0, 0.5, 0.5, 0.5, 0.5, 0.5]));
    }
    return '';
  });
  const mock = { tracks: vi.fn(async () => tracks), info: vi.fn(async () => selected),
    trackIndex: vi.fn(async (ref: number | string) => {
      const index = typeof ref === 'number' ? ref : tracks.findIndex((track) => track.name === ref);
      if (index < 0 || index >= tracks.length) throw new Error('track does not exist');
      return index;
    }), command, run: vi.fn(async () => ''), select: vi.fn(async () => undefined) };
  return { mock, ops: mock as unknown as Ops };
}

const voice: TrackInfo = { name: 'Voice', kind: 'wave', start: 2, end: 3, channels: 1, selected: 1 };
const label: TrackInfo = { name: 'Labels', kind: 'label', start: 0, end: 10, selected: 1 };
const bed: TrackInfo = { name: 'Bed', kind: 'wave', start: 0, end: 6, channels: 2, selected: 0 };

describe('rendered measurement selection transactions and tool registration', () => {
  it('returns the loudness dry-run plan without selecting or changing samples', async () => {
    const { ops, mock } = fakeOps([voice]);
    const measured = { ...measureWavBuffer(wav([0.1])), integratedLufs: -20, truePeakDbtp: -10, scope: { tracks: [0], start: 2, end: 3 } };
    const measure = vi.fn<typeof measureScope>().mockResolvedValue(measured);
    expect(await loudnessTarget(ops, { track: 'Voice', dryRun: true }, measure)).toMatchObject({ dryRun: true, before: measured, plan: { gainDb: 4 },
      steps: [{ command: 'Amplify', scope: { track: 0, start: 2, end: 3 } }] });
    expect(measure).toHaveBeenCalledWith(ops, { track: 0, start: 2, end: 3 }, { backend: 'ffmpeg' });
    expect(mock.select).not.toHaveBeenCalled(); expect(mock.command).not.toHaveBeenCalled();
  });
  it('applies the planned loudness gain and verifies both loudness and native sample peaks', async () => {
    const { ops, mock } = fakeOps([voice]);
    const before = { ...measureWavBuffer(wav([0.1])), integratedLufs: -20, truePeakDbtp: -10, scope: {} };
    const after = { ...measureWavBuffer(wav([0.1 * 10 ** (4 / 20)])), integratedLufs: -16, truePeakDbtp: -6, scope: {} };
    const measure = vi.fn<typeof measureScope>().mockResolvedValueOnce(before).mockResolvedValueOnce(after);
    expect(await loudnessTarget(ops, { track: 0 }, measure)).toMatchObject({ dryRun: false, before, after,
      targetCheck: { status: 'met' }, samplePeakDbfs: after.peakDbfs, clippedSamples: 0 });
    expect(mock.select).toHaveBeenCalledWith({ track: 0, start: 2, end: 3 });
    expect(mock.command).toHaveBeenCalledWith('Amplify', { Ratio: 10 ** (4 / 20), AllowClipping: true }, 600_000);
    expect(measure).toHaveBeenCalledTimes(2);
  });
  it('refuses missing loudness or label targeting before mutation', async () => {
    const { ops, mock } = fakeOps([voice, label]);
    const measure = vi.fn<typeof measureScope>().mockResolvedValue({ ...measureWavBuffer(wav([0.1])), scope: {} });
    await expect(loudnessTarget(ops, { track: 0 }, measure)).rejects.toThrow(/established integrated LUFS/);
    await expect(loudnessTarget(ops, { track: 1 }, measure)).rejects.toThrow(/audio track/);
    expect(mock.command).not.toHaveBeenCalled(); expect(mock.select).not.toHaveBeenCalled();
  });
  it('refuses a loudness gain outside native Amplify bounds before changing selection', async () => {
    const { ops, mock } = fakeOps([voice]);
    const measure = vi.fn<typeof measureScope>().mockResolvedValue({ ...measureWavBuffer(wav([0.1])), integratedLufs: 50, truePeakDbtp: 60, scope: {} });
    await expect(loudnessTarget(ops, { track: 0 }, measure)).rejects.toThrow();
    expect(mock.command).not.toHaveBeenCalled(); expect(mock.select).not.toHaveBeenCalled();
  });
  it('reports unknown when post-gain loudness cannot be established', async () => {
    const { ops } = fakeOps([voice]);
    const before = { ...measureWavBuffer(wav([0.1])), integratedLufs: -20, truePeakDbtp: -10, scope: {} };
    const after = { ...measureWavBuffer(wav([0.1])), scope: {} };
    const measure = vi.fn<typeof measureScope>().mockResolvedValueOnce(before).mockResolvedValueOnce(after);
    expect(await loudnessTarget(ops, { track: 0 }, measure)).toMatchObject({ targetCheck: { status: 'unknown' } });
  });
  it('preserves Audacity gain errors and does not continue to verification', async () => {
    const { ops, mock } = fakeOps([voice]);
    const before = { ...measureWavBuffer(wav([0.1])), integratedLufs: -20, truePeakDbtp: -10, scope: {} };
    const measure = vi.fn<typeof measureScope>().mockResolvedValue(before);
    mock.command.mockRejectedValue(new Error('Audacity Amplify error'));
    await expect(loudnessTarget(ops, { track: 0 }, measure)).rejects.toThrow('Audacity Amplify error');
    expect(measure).toHaveBeenCalledTimes(1);
  });
  it('uses a track extent, preserves controls and restores original noncontiguous selection', async () => {
    const { ops, mock } = fakeOps([voice, bed, label]);
    const measured = await measureScope(ops, { track: 'Voice' }, { backend: 'wav' });
    expect(mock.command).toHaveBeenCalledWith('Select', { Track: 0, TrackCount: 1, Start: 2, End: 3, Mode: 'Set' });
    expect(measured.scope).toEqual({ tracks: [0], start: 2, end: 3 });
    expect(measured).not.toHaveProperty('file');
    expect(mock.command.mock.calls.map(([id]) => id)).toEqual(['Select', 'Export2', 'SelectTracks', 'SelectTracks', 'SelectTime']);
    expect(mock.run).toHaveBeenCalledWith('SelectNone');
    expect(mock.command).toHaveBeenCalledWith('SelectTracks', { Track: 0, TrackCount: 1, Mode: 'Add' });
    expect(mock.command).toHaveBeenCalledWith('SelectTracks', { Track: 2, TrackCount: 1, Mode: 'Add' });
    expect(mock.command).toHaveBeenLastCalledWith('SelectTime', { Start: 0.25, End: 0.75, RelativeTo: 'ProjectStart' });
    const exported = String(mock.command.mock.calls.find(([id]) => id === 'Export2')![1].Filename);
    await expect(access(exported)).rejects.toThrow();
    expect(mock.command.mock.calls.some(([id]) => id.startsWith('SetTrack'))).toBe(false);
  });
  it('exports mono even when a label track is also selected', async () => {
    const { ops, mock } = fakeOps([voice, label]); await measureScope(ops, {}, { backend: 'wav' });
    expect(mock.command.mock.calls.find(([id]) => id === 'Export2')![1].NumChannels).toBe(1);
  });
  it('exports stereo when the selected audio includes a stereo track', async () => {
    const { ops, mock } = fakeOps([voice, bed]); await measureScope(ops, { track: 1 }, { backend: 'wav' });
    expect(mock.command.mock.calls.find(([id]) => id === 'Export2')![1].NumChannels).toBe(2);
  });
  it('explicitly reselects current tracks and time to clear label text editing', async () => {
    const { ops, mock } = fakeOps([voice, bed, label], { start: 0.25, end: 0.75 });
    const measured = await measureScope(ops, { currentSelection: true }, { backend: 'wav' });
    expect(measured.scope).toEqual({ tracks: [0, 2], start: 0.25, end: 0.75 });
    expect(mock.run).toHaveBeenCalledTimes(2);
    expect(mock.command.mock.calls.findIndex(([id]) => id === 'SelectTime')).toBeLessThan(mock.command.mock.calls.findIndex(([id]) => id === 'Export2'));
  });
  it('warns when measuring rendered muted audio without changing mute', async () => {
    const { ops, mock } = fakeOps([{ ...voice, mute: 1 }]);
    expect((await measureScope(ops, { track: 0 }, { backend: 'wav' })).notes.join(' ')).toContain('muted track');
    expect(mock.command.mock.calls.some(([id]) => id === 'SetTrack')).toBe(false);
  });
  it('restores selection even after Audacity export fails and preserves its error', async () => {
    const { ops, mock } = fakeOps([voice], undefined, 'Audacity own Export2 error');
    await expect(measureScope(ops, { track: 0 }, { backend: 'wav' })).rejects.toThrow('Audacity own Export2 error');
    expect(mock.command).toHaveBeenLastCalledWith('SelectTime', { Start: 0.25, End: 0.75, RelativeTo: 'ProjectStart' });
  });
  it('reports both the original Audacity error and a failed selection restoration', async () => {
    const { ops, mock } = fakeOps([voice], undefined, 'Audacity own Export2 error');
    mock.run.mockRejectedValue(new Error('Audacity own SelectNone error'));
    await expect(measureScope(ops, { track: 0 }, { backend: 'wav' })).rejects.toThrow(/Audacity own Export2 error.*Selection restoration also failed: Audacity own SelectNone error/);
  });
  it.each([
    ['empty project', [], {}], ['label-only project', [label], {}], ['label-only selection', [label], { currentSelection: true }],
    ['out-of-range count', [voice], { track: 0, trackCount: 2 }],
  ])('refuses %s without exporting', async (_name, tracks, scope) => {
    const { ops, mock } = fakeOps(tracks as TrackInfo[]);
    await expect(measureScope(ops, scope, { backend: 'wav' })).rejects.toThrow();
    expect(mock.command.mock.calls.some(([id]) => id === 'Export2')).toBe(false);
    expect(mock.command).not.toHaveBeenCalled();
    expect(mock.run).not.toHaveBeenCalled();
  });
  it.each([
    { track: 0, start: 4 }, { track: 0, end: 1 }, { currentSelection: true },
  ])('does not change selection for an empty resolved measurement range %j', async (scope) => {
    const { ops, mock } = fakeOps([voice], { start: 1, end: 1 });
    await expect(measureScope(ops, scope, { backend: 'wav' })).rejects.toThrow(/non-empty time selection/);
    expect(mock.command).not.toHaveBeenCalled(); expect(mock.run).not.toHaveBeenCalled();
  });
  it('retains scratch and the original timeout class without sending restoration commands after an uncertain export', async () => {
    const { ops, mock } = fakeOps([voice]);
    const pipe = { needsRecovery: false };
    Object.assign(ops, { pipe });
    const timeout = new AudacityTimeout('unknown Export2 outcome');
    mock.command.mockImplementation(async (id) => {
      if (id === 'Export2') { pipe.needsRecovery = true; throw timeout; }
      return '';
    });
    await expect(measureScope(ops, { track: 0 }, { backend: 'wav' })).rejects.toBe(timeout);
    expect(timeout.message).toContain('Measurement scratch retained at');
    expect(mock.command.mock.calls.map(([id]) => id)).toEqual(['Select', 'Export2']);
    expect(mock.run).not.toHaveBeenCalled();
    const exported = String(mock.command.mock.calls.find(([id]) => id === 'Export2')![1].Filename);
    const directory = join(exported, '..');
    await expect(access(directory)).resolves.toBeUndefined();
    directories.push(directory);
  });
  it('preserves a restoration timeout class and the native export error while retaining scratch', async () => {
    const { ops, mock } = fakeOps([voice], undefined, 'Native export failure');
    const pipe = { needsRecovery: false };
    Object.assign(ops, { pipe });
    const timeout = new AudacityTimeout('no restoration reply');
    mock.run.mockImplementation(async () => { pipe.needsRecovery = true; throw timeout; });
    await expect(measureScope(ops, { track: 0 }, { backend: 'wav' })).rejects.toBe(timeout);
    expect(timeout.message).toMatch(/Native export failure.*no restoration reply.*scratch retained/);
    const exported = String(mock.command.mock.calls.find(([id]) => id === 'Export2')![1].Filename);
    directories.push(join(exported, '..'));
  });
  it('validates incompatible scope before contacting Audacity', async () => {
    const { ops, mock } = fakeOps([voice]);
    await expect(measureScope(ops, { currentSelection: true, track: 0 })).rejects.toThrow();
    expect(mock.tracks).not.toHaveBeenCalled();
  });
  it('registers eight strictly typed analysis tools with useful descriptions', async () => {
    const tools = new Map<string, { shape: z.ZodRawShape; handler: (args: never) => Promise<unknown>; description: string }>();
    const register: Parameters<typeof registerAnalysisTools>[0] = (name, description, shape, handler) => {
      tools.set(name, { shape, handler: handler as (args: never) => Promise<unknown>, description });
    };
    const { ops } = fakeOps([voice]); registerAnalysisTools(register, ops);
    expect([...tools.keys()]).toEqual(['audacity_loudness_target', 'audacity_silence', 'audacity_probe_file', 'audacity_measure', 'audacity_measure_file', 'audacity_compare_files', 'audacity_targets', 'audacity_contrast']);
    for (const { shape, description } of tools.values()) {
      expect(description.length).toBeGreaterThan(80);
      expect(z.object(shape).strict().safeParse({ arbitrary: 1 }).success).toBe(false);
    }
    const targetTool = tools.get('audacity_targets')!;
    expect(await targetTool.handler({} as never)).toMatchObject({ presets: TARGETS });
    const silence = tools.get('audacity_silence')!;
    const args = z.object(silence.shape).strict().parse({ track: 0 });
    expect(await silence.handler(args as never)).toMatchObject({ regions: [{ start: 2, end: 2.5, duration: 0.5 }], count: 1, truncated: false });
    const invalidArgs = z.object(silence.shape).strict().parse({ file: 'source.wav', track: 0 });
    await expect(silence.handler(invalidArgs as never)).rejects.toThrow(/file cannot be combined/);
  });
  it('validates both contrast ranges before contacting Audacity or changing selection', async () => {
    const handlers = new Map<string, (args: unknown) => Promise<unknown>>();
    const register: Parameters<typeof registerAnalysisTools>[0] = (name, _description, shape, handler) => {
      handlers.set(name, (args) => handler(z.object(shape).strict().parse(args)));
    };
    const { ops, mock } = fakeOps([voice]); registerAnalysisTools(register, ops);
    await expect(handlers.get('audacity_contrast')!({ foreground: { track: 0, start: 2, end: 3 },
      background: { track: 0, start: 3, end: 2 } })).rejects.toThrow(/end must be after start/);
    expect(mock.tracks).not.toHaveBeenCalled(); expect(mock.command).not.toHaveBeenCalled();
  });
  it.each([1, 2])('preflights nonexistent or non-audio background track %i before exporting the foreground', async (track) => {
    const handlers = new Map<string, (args: unknown) => Promise<unknown>>();
    const register: Parameters<typeof registerAnalysisTools>[0] = (name, _description, shape, handler) => {
      handlers.set(name, (args) => handler(z.object(shape).strict().parse(args)));
    };
    const { ops, mock } = fakeOps([voice, label]); registerAnalysisTools(register, ops);
    await expect(handlers.get('audacity_contrast')!({ foreground: { track: 0, start: 2, end: 3 },
      background: { track, start: 2, end: 3 } })).rejects.toThrow();
    expect(mock.command).not.toHaveBeenCalled(); expect(mock.run).not.toHaveBeenCalled();
  });
});
