// Original TypeScript measurement code. The researched servers informed the
// reporting rules: unavailable metrics never pass a target, true peak is never
// replaced by sample peak, and quiet-block statistics are explicitly estimates.
import { spawn } from 'node:child_process';
import { mkdtemp, open, rm, stat, type FileHandle } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { dirname, extname, join, resolve } from 'node:path';
import { z } from 'zod';
import { SafeString } from './catalogue.js';
import { catalogueCommand } from './format.js';
import type { Ops, TrackInfo, TrackRef } from './ops.js';

export interface WavFormat {
  channels: number;
  sampleRate: number;
  bits: number;
  floatingPoint: boolean;
  blockAlign: number;
  dataOffset: number;
  dataBytes: number;
}

export interface ChannelMeasurement {
  peak: number;
  peakDbfs: number | null;
  rms: number;
  rmsDbfs: number | null;
  dcOffset: number;
  clippedSamples: number;
  discontinuities: number;
}

export interface Measurement {
  duration: number;
  sampleRate: number;
  channels: number;
  frames: number;
  peak: number;
  peakDbfs: number | null;
  rms: number;
  rmsDbfs: number | null;
  crestDb: number | null;
  dcOffset: number;
  clippedSamples: number;
  discontinuities: number;
  silenceGaps: { start: number; end: number; duration: number }[];
  silenceGapCount: number;
  quietRmsDbfsEstimate: number | null;
  dynamicRangeDbEstimate: number | null;
  perChannel: ChannelMeasurement[];
  integratedLufs: number | null;
  truePeakDbtp: number | null;
  loudnessRangeLu: number | null;
  unavailable: Record<string, string>;
  notes: string[];
  backend: string;
  dualMono: boolean;
  file?: string;
}

const unavailableLoudness = 'Install ffmpeg on PATH, or set AUDACITY_FFMPEG, for integrated LUFS, LRA and true peak.';
const round = (value: number, decimals = 6) => Number(value.toFixed(decimals));
export const amplitudeDb = (value: number): number | null => Number.isFinite(value) && value > 0 ? round(20 * Math.log10(value)) : null;

export const SilenceSchema = z.object({
  thresholdDb: z.number().finite().min(-120).max(0).default(-60),
  minimumSeconds: z.number().finite().min(0.001).max(3600).default(0.5),
  maxRegions: z.number().int().min(1).max(1000).default(100),
}).strict();
export type SilenceOptions = z.input<typeof SilenceSchema>;

/** A percentile over sorted linear levels. Interpolation happens before dB conversion. */
export function percentile(values: readonly number[], percent: number): number | null {
  if (!(percent >= 0 && percent <= 100)) throw new Error('percentile must be between 0 and 100');
  if (!values.length) return null;
  const position = (values.length - 1) * percent / 100;
  const index = Math.floor(position);
  const a = values[index]!;
  const b = values[Math.min(index + 1, values.length - 1)]!;
  return a + (b - a) * (position - index);
}

function readFormat(fmt: Buffer, dataOffset: number, dataBytes: number): WavFormat {
  if (fmt.length < 16) throw new Error('WAV fmt chunk is truncated');
  let encoding = fmt.readUInt16LE(0);
  const channels = fmt.readUInt16LE(2);
  const sampleRate = fmt.readUInt32LE(4);
  const blockAlign = fmt.readUInt16LE(12);
  const bits = fmt.readUInt16LE(14);
  if (fmt.readUInt32LE(8) !== sampleRate * blockAlign) throw new Error('invalid WAV byte rate');
  if (encoding === 0xfffe) {
    if (fmt.length < 40 || fmt.readUInt16LE(16) < 22) throw new Error('WAV extensible fmt chunk is truncated');
    const validBits = fmt.readUInt16LE(18);
    if (validBits !== 0 && validBits !== bits) throw new Error('WAV valid bits differ from container bits; use ffmpeg');
    const guid = fmt.subarray(24, 40);
    if (!guid.subarray(4).equals(Buffer.from('00001000800000aa00389b71', 'hex'))) {
      throw new Error('unsupported WAV extensible subformat; use ffmpeg');
    }
    encoding = guid.readUInt32LE(0);
  }
  if (encoding !== 1 && encoding !== 3) throw new Error(`WAV encoding ${encoding} is not PCM or IEEE float; use ffmpeg`);
  const floatingPoint = encoding === 3;
  if (floatingPoint ? ![32, 64].includes(bits) : ![8, 16, 24, 32].includes(bits)) {
    throw new Error(`unsupported WAV ${floatingPoint ? 'float' : 'PCM'} sample width ${bits}; use ffmpeg`);
  }
  if (channels < 1 || channels > 32 || sampleRate < 1 || sampleRate > 768_000 || blockAlign !== channels * bits / 8) {
    throw new Error('invalid WAV channels, sample rate or block alignment');
  }
  if (dataBytes % blockAlign !== 0) throw new Error('WAV data contains a partial sample frame');
  return { channels, sampleRate, bits, floatingPoint, blockAlign, dataOffset, dataBytes };
}

/** Parse RIFF PCM/IEEE-float WAV, including odd-sized metadata and extensible fmt chunks. */
export function parseWavHeader(buffer: Buffer): WavFormat {
  if (buffer.length < 12 || buffer.toString('ascii', 0, 4) !== 'RIFF' || buffer.toString('ascii', 8, 12) !== 'WAVE') {
    throw new Error('native measurement requires RIFF WAV; use ffmpeg for other containers');
  }
  const limit = buffer.readUInt32LE(4) + 8;
  if (limit < 12) throw new Error('WAV RIFF body is invalid');
  if (limit > buffer.length) throw new Error('WAV RIFF body is truncated');
  let fmt: Buffer | undefined;
  let dataOffset: number | undefined;
  let dataBytes = 0;
  let offset = 12;
  for (; offset + 8 <= limit;) {
    const id = buffer.toString('ascii', offset, offset + 4);
    const size = buffer.readUInt32LE(offset + 4);
    const start = offset + 8;
    if (start + size + (size & 1) > limit) throw new Error(`WAV ${id} chunk is truncated`);
    if (id === 'fmt ') {
      if (fmt) throw new Error('WAV contains multiple fmt chunks; use ffmpeg');
      if (size > 4096) throw new Error('WAV fmt chunk is unreasonably large');
      fmt = buffer.subarray(start, start + size);
    }
    if (id === 'data') {
      if (dataOffset !== undefined) throw new Error('WAV contains multiple data chunks; use ffmpeg');
      dataOffset = start; dataBytes = size;
    }
    offset = start + size + (size & 1);
  }
  if (offset !== limit) throw new Error('WAV ends with a truncated chunk header');
  if (!fmt || dataOffset === undefined) throw new Error('WAV requires fmt and data chunks');
  return readFormat(fmt, dataOffset, dataBytes);
}

async function readExactly(handle: FileHandle, size: number, position: number): Promise<Buffer> {
  const buffer = Buffer.alloc(size);
  let read = 0;
  while (read < size) {
    const result = await handle.read(buffer, read, size - read, position + read);
    if (!result.bytesRead) throw new Error('WAV is truncated');
    read += result.bytesRead;
  }
  return buffer;
}

async function fileHeader(handle: FileHandle): Promise<WavFormat> {
  const header = await readExactly(handle, 12, 0);
  if (header.toString('ascii', 0, 4) !== 'RIFF' || header.toString('ascii', 8, 12) !== 'WAVE') {
    throw new Error('native measurement requires RIFF WAV; use ffmpeg for other containers');
  }
  const limit = header.readUInt32LE(4) + 8;
  if (limit < 12) throw new Error('WAV RIFF body is invalid');
  if (limit > (await handle.stat()).size) throw new Error('WAV RIFF body is truncated');
  let fmt: Buffer | undefined;
  let dataOffset: number | undefined;
  let dataBytes = 0;
  let offset = 12;
  for (; offset + 8 <= limit;) {
    const chunk = await readExactly(handle, 8, offset);
    const id = chunk.toString('ascii', 0, 4);
    const size = chunk.readUInt32LE(4);
    const start = offset + 8;
    if (start + size + (size & 1) > limit) throw new Error(`WAV ${id} chunk is truncated`);
    if (id === 'fmt ') {
      if (fmt) throw new Error('WAV contains multiple fmt chunks; use ffmpeg');
      if (size > 4096) throw new Error('WAV fmt chunk is unreasonably large');
      fmt = await readExactly(handle, size, start);
    }
    if (id === 'data') {
      if (dataOffset !== undefined) throw new Error('WAV contains multiple data chunks; use ffmpeg');
      dataOffset = start; dataBytes = size;
    }
    offset = start + size + (size & 1);
  }
  if (offset !== limit) throw new Error('WAV ends with a truncated chunk header');
  if (!fmt || dataOffset === undefined) throw new Error('WAV requires fmt and data chunks');
  return readFormat(fmt, dataOffset, dataBytes);
}

function sampleAt(buffer: Buffer, offset: number, format: WavFormat): number {
  if (format.floatingPoint) return format.bits === 32 ? buffer.readFloatLE(offset) : buffer.readDoubleLE(offset);
  switch (format.bits) {
    case 8: return (buffer.readUInt8(offset) - 128) / 128;
    case 16: return buffer.readInt16LE(offset) / 32768;
    case 24: return buffer.readIntLE(offset, 3) / 8388608;
    default: return buffer.readInt32LE(offset) / 2147483648;
  }
}

class Metrics {
  private readonly channels: { peak: number; squares: number; sum: number; clipped: number; jumps: number; previous: number }[];
  private frames = 0;
  private silenceStart: number | undefined;
  private silenceGapCount = 0;
  private readonly gaps: Measurement['silenceGaps'] = [];
  private readonly blockRms: number[] = [];
  private blockSquares = 0;
  private blockFrames = 0;
  private readonly silence: z.infer<typeof SilenceSchema>;
  private readonly silenceAmplitude: number;

  constructor(private readonly format: WavFormat, silence: SilenceOptions = {}) {
    this.silence = SilenceSchema.parse(silence);
    this.silenceAmplitude = 10 ** (this.silence.thresholdDb / 20);
    this.channels = Array.from({ length: format.channels }, () => ({ peak: 0, squares: 0, sum: 0, clipped: 0, jumps: 0, previous: 0 }));
  }

  add(buffer: Buffer): void {
    const width = this.format.bits / 8;
    for (let offset = 0; offset + this.format.blockAlign <= buffer.length; offset += this.format.blockAlign) {
      let silent = true;
      for (const [index, channel] of this.channels.entries()) {
        const sample = sampleAt(buffer, offset + index * width, this.format);
        if (!Number.isFinite(sample) || !Number.isFinite(sample * sample)) throw new Error('WAV contains non-finite or overflowing float samples');
        const magnitude = Math.abs(sample);
        channel.peak = Math.max(channel.peak, magnitude);
        channel.sum += sample;
        channel.squares += sample * sample;
        this.blockSquares += sample * sample;
        if (![channel.sum, channel.squares, this.blockSquares].every(Number.isFinite)) {
          throw new Error('WAV sample accumulation overflowed; audio levels cannot be measured reliably');
        }
        // This threshold is an advisory count, not proof that clipping occurred.
        if (magnitude >= 0.999) channel.clipped++;
        if (this.frames > 0 && Math.abs(sample - channel.previous) > 0.3) channel.jumps++;
        channel.previous = sample;
        if (magnitude >= this.silenceAmplitude) silent = false;
      }
      if (silent && this.silenceStart === undefined) this.silenceStart = this.frames;
      if (!silent) this.closeSilence();
      this.frames++;
      this.blockFrames++;
      if (this.blockFrames === this.format.sampleRate) this.closeBlock();
    }
  }

  private closeSilence(): void {
    if (this.silenceStart !== undefined) {
      const length = this.frames - this.silenceStart;
      if (length / this.format.sampleRate >= this.silence.minimumSeconds) {
        this.silenceGapCount++;
        if (this.gaps.length < this.silence.maxRegions) this.gaps.push({ start: this.silenceStart / this.format.sampleRate,
          end: this.frames / this.format.sampleRate, duration: length / this.format.sampleRate });
      }
      this.silenceStart = undefined;
    }
  }

  private closeBlock(): void {
    if (this.blockFrames && (!this.blockRms.length || this.blockFrames >= this.format.sampleRate / 2)) {
      this.blockRms.push(Math.sqrt(this.blockSquares / (this.blockFrames * this.format.channels)));
    }
    this.blockFrames = 0;
    this.blockSquares = 0;
  }

  finish(): Measurement {
    this.closeSilence();
    this.closeBlock();
    const perChannel: ChannelMeasurement[] = this.channels.map((channel) => {
      const rms = this.frames ? Math.sqrt(channel.squares / this.frames) : 0;
      return { peak: round(channel.peak), peakDbfs: amplitudeDb(channel.peak), rms: round(rms), rmsDbfs: amplitudeDb(rms),
        dcOffset: this.frames ? round(channel.sum / this.frames) : 0, clippedSamples: channel.clipped, discontinuities: channel.jumps };
    });
    const count = this.frames * this.format.channels;
    const rms = count ? Math.sqrt(this.channels.reduce((sum, c) => sum + c.squares / count, 0)) : 0;
    const peak = Math.max(...this.channels.map((c) => c.peak));
    const quiet = percentile(this.blockRms.sort((a, b) => a - b), 10);
    const loud = percentile(this.blockRms, 95);
    const quietDb = quiet === null ? null : amplitudeDb(quiet);
    const loudDb = loud === null ? null : amplitudeDb(loud);
    return { duration: this.frames / this.format.sampleRate, sampleRate: this.format.sampleRate, channels: this.format.channels,
      frames: this.frames, peak: round(peak), peakDbfs: amplitudeDb(peak), rms: round(rms), rmsDbfs: amplitudeDb(rms),
      crestDb: rms > 0 ? amplitudeDb(peak / rms) : null,
      dcOffset: count ? round(this.channels.reduce((sum, c) => sum + c.sum / count, 0)) : 0,
      clippedSamples: perChannel.reduce((sum, c) => sum + c.clippedSamples, 0),
      discontinuities: perChannel.reduce((sum, c) => sum + c.discontinuities, 0),
      silenceGaps: this.gaps, silenceGapCount: this.silenceGapCount, quietRmsDbfsEstimate: quietDb,
      dynamicRangeDbEstimate: this.blockRms.length >= 2 && quietDb !== null && loudDb !== null ? round(loudDb - quietDb) : null,
      perChannel, integratedLufs: null, truePeakDbtp: null, loudnessRangeLu: null,
      unavailable: { integratedLufs: unavailableLoudness, truePeakDbtp: unavailableLoudness, loudnessRangeLu: unavailableLoudness },
      notes: [`Silence gaps require every channel below ${this.silence.thresholdDb} dBFS for at least ${this.silence.minimumSeconds} seconds; at most ${this.silence.maxRegions} positions are returned.`,
        'Near-full-scale samples (>= 0.999) and jumps (> 0.3 full scale) are advisory counts, not confirmed defects.',
        'Quiet RMS is an estimate from the 10th percentile of one-second RMS blocks; dynamic range is the estimated p95 minus p10. Neither is a certified noise-floor or DR meter.'],
      backend: 'native-wav', dualMono: false };
  }
}

export function measureWavBuffer(buffer: Buffer, silence: SilenceOptions = {}): Measurement {
  const format = parseWavHeader(buffer);
  const metrics = new Metrics(format, silence);
  metrics.add(buffer.subarray(format.dataOffset, format.dataOffset + format.dataBytes));
  return metrics.finish();
}

export async function measureWavFile(file: string, silence: SilenceOptions = {}): Promise<Measurement> {
  const handle = await open(file, 'r');
  try {
    const format = await fileHeader(handle);
    const metrics = new Metrics(format, silence);
    const blockBytes = Math.max(format.blockAlign, Math.floor(1_048_576 / format.blockAlign) * format.blockAlign);
    for (let read = 0; read < format.dataBytes;) {
      const size = Math.min(blockBytes, format.dataBytes - read);
      metrics.add(await readExactly(handle, size, format.dataOffset + read));
      read += size;
    }
    return metrics.finish();
  } finally { await handle.close(); }
}

export interface FfmpegMeasurement {
  integratedLufs: number | null;
  truePeakDbtp: number | null;
  loudnessRangeLu: number | null;
  peakDbfs: number | null;
  rmsDbfs: number | null;
}

/** Read only the final summary and overall statistics, never intermediate frame/channel readings. */
export function parseFfmpegMeasurement(text: string): FfmpegMeasurement {
  const summaryIndex = text.lastIndexOf('Summary:');
  if (summaryIndex < 0) throw new Error('ffmpeg did not return an EBU R128 summary');
  const summary = text.slice(summaryIndex);
  const overallIndex = text.lastIndexOf('Overall');
  const overall = overallIndex < 0 ? '' : text.slice(overallIndex);
  const value = (body: string, expression: RegExp) => {
    const match = expression.exec(body);
    if (!match) return null;
    const number = Number(match[1]);
    return Number.isFinite(number) ? number : null;
  };
  return {
    integratedLufs: value(summary, /Integrated loudness:[\s\S]*?\bI:\s*([-+\d.e]+)\s*LUFS/),
    loudnessRangeLu: value(summary, /Loudness range:[\s\S]*?\bLRA:\s*([-+\d.e]+)\s*LU/),
    truePeakDbtp: value(summary, /True peak:[\s\S]*?Peak:\s*([-+\d.e]+)\s*dBFS/),
    peakDbfs: value(overall, /Peak level dB:\s*([-+\d.e]+)/),
    rmsDbfs: value(overall, /RMS level dB:\s*([-+\d.e]+)/),
  };
}

/** Spawn a fixed executable with argument arrays. Bounds both runtime and captured diagnostic output. */
export function runFfmpeg(args: readonly string[], timeoutMs = 300_000, executable = process.env.AUDACITY_FFMPEG ?? 'ffmpeg'): Promise<string> {
  if (!Number.isInteger(timeoutMs) || timeoutMs < 1 || timeoutMs > 600_000) return Promise.reject(new Error('ffmpeg timeoutMs must be between 1 and 600000'));
  return new Promise((resolveResult, reject) => {
    const child = spawn(executable, [...args], { windowsHide: true, stdio: ['ignore', 'ignore', 'pipe'], shell: false });
    let output = '';
    let failure: Error | undefined;
    const timer = setTimeout(() => { failure = new Error(`ffmpeg exceeded ${timeoutMs} ms`); child.kill(); }, timeoutMs);
    child.stderr.setEncoding('utf8');
    child.stderr.on('data', (chunk: string) => {
      if (output.length + chunk.length > 1_048_576) {
        failure = new Error('ffmpeg diagnostic output exceeded 1 MiB'); child.kill();
      } else output += chunk;
    });
    child.on('error', (error) => { clearTimeout(timer); reject(new Error(`ffmpeg unavailable: ${error.message}. ${unavailableLoudness}`)); });
    child.on('close', (code) => {
      clearTimeout(timer);
      if (failure) reject(failure);
      else if (code !== 0) reject(new Error(`ffmpeg exited ${code}: ${output.trim().slice(-8000)}`));
      else resolveResult(output);
    });
  });
}

export function parseProbe(text: string): { format: Record<string, unknown>; streams: Record<string, unknown>[] } {
  const raw: unknown = JSON.parse(text);
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) throw new Error('ffprobe returned invalid metadata');
  const object = raw as Record<string, unknown>;
  const format = object.format;
  if (!format || typeof format !== 'object' || Array.isArray(format) || !Array.isArray(object.streams)) throw new Error('ffprobe returned no format or streams');
  const pick = (value: Record<string, unknown>, keys: readonly string[]) => Object.fromEntries(keys.flatMap((key) =>
    value[key] === undefined ? [] : [[key, value[key]]]));
  return { format: pick(format as Record<string, unknown>, ['format_name', 'format_long_name', 'duration', 'size', 'bit_rate', 'tags']),
    streams: object.streams.map((stream: unknown) => {
      if (!stream || typeof stream !== 'object' || Array.isArray(stream)) throw new Error('ffprobe returned an invalid stream');
      return pick(stream as Record<string, unknown>, ['index', 'codec_name', 'codec_long_name', 'codec_type', 'sample_fmt', 'sample_rate',
        'channels', 'channel_layout', 'duration', 'bit_rate', 'width', 'height', 'r_frame_rate', 'tags']);
    }) };
}

export async function probeFile(file: string, timeoutMs = 30_000): Promise<{ file: string; format: Record<string, unknown>; streams: Record<string, unknown>[] }> {
  if (!Number.isInteger(timeoutMs) || timeoutMs < 1000 || timeoutMs > 120_000) throw new Error('ffprobe timeoutMs must be between 1000 and 120000');
  const path = resolve(file);
  if (!(await stat(path)).isFile()) throw new Error(`${path} is not a file`);
  const ffmpeg = process.env.AUDACITY_FFMPEG;
  const executable = process.env.AUDACITY_FFPROBE ?? (ffmpeg && /[\\/]/.test(ffmpeg) ?
    join(dirname(ffmpeg), `ffprobe${extname(ffmpeg)}`) : 'ffprobe');
  const output = await new Promise<string>((resolveResult, reject) => {
    const child = spawn(executable, ['-v', 'error', '-show_format', '-show_streams', '-print_format', 'json', '-i', path],
      { windowsHide: true, stdio: ['ignore', 'pipe', 'pipe'], shell: false });
    let stdout = ''; let stderr = ''; let failure: Error | undefined;
    const timer = setTimeout(() => { failure = new Error(`ffprobe exceeded ${timeoutMs} ms`); child.kill(); }, timeoutMs);
    const capture = (text: string, stdoutStream: boolean) => {
      if (stdout.length + stderr.length + text.length > 1_048_576) { failure = new Error('ffprobe output exceeded 1 MiB'); child.kill(); }
      else if (stdoutStream) stdout += text; else stderr += text;
    };
    child.stdout.setEncoding('utf8'); child.stderr.setEncoding('utf8');
    child.stdout.on('data', (text: string) => capture(text, true)); child.stderr.on('data', (text: string) => capture(text, false));
    child.on('error', (error) => { clearTimeout(timer); reject(new Error(`ffprobe unavailable: ${error.message}. Install ffmpeg/ffprobe or set AUDACITY_FFPROBE.`)); });
    child.on('close', (code) => { clearTimeout(timer);
      if (failure) reject(failure);
      else if (code !== 0) reject(new Error(`ffprobe exited ${code}: ${stderr.trim().slice(-8000)}`));
      else resolveResult(stdout);
    });
  });
  return { file: path, ...parseProbe(output) };
}

export interface MeasureOptions {
  backend?: 'auto' | 'wav' | 'ffmpeg';
  dualMono?: boolean;
  timeoutMs?: number;
  silence?: SilenceOptions;
}

export async function measureFile(file: string, options: MeasureOptions = {}): Promise<Measurement> {
  const validated = MeasureOptionsSchema.parse(options);
  const path = resolve(file);
  if (!(await stat(path)).isFile()) throw new Error(`${path} is not a file`);
  const { backend, dualMono, timeoutMs } = validated;
  let result: Measurement;
  try { result = await measureWavFile(path, validated.silence); }
  catch (nativeError) {
    if (backend === 'wav') throw nativeError;
    const directory = await mkdtemp(join(tmpdir(), 'gizmos-audacity-measure-'));
    try {
      const decoded = join(directory, 'decoded.wav');
      await runFfmpeg(['-nostdin', '-hide_banner', '-loglevel', 'error', '-i', path, '-map', '0:a:0', '-vn', '-c:a', 'pcm_f32le', decoded], timeoutMs);
      result = await measureWavFile(decoded, validated.silence);
      result.backend = 'ffmpeg-decode+native-wav';
      result.notes.push('ffmpeg decoded the first audio stream without changing its sample rate or channel count.');
    } catch (error) {
      throw new Error(`Native WAV measurement: ${nativeError instanceof Error ? nativeError.message : String(nativeError)}. ${error instanceof Error ? error.message : String(error)}`);
    } finally { await rm(directory, { recursive: true, force: true }); }
  }
  result.file = path;
  result.dualMono = dualMono;
  if (backend === 'wav') return result;
  try {
    const output = await runFfmpeg(['-nostdin', '-hide_banner', '-loglevel', 'info', '-i', path, '-map', '0:a:0', '-vn', '-af',
      `ebur128=peak=true:dualmono=${dualMono ? 'true' : 'false'}:framelog=quiet,astats=metadata=0:reset=0:measure_perchannel=none:measure_overall=Peak_level+RMS_level`,
      '-f', 'null', '-'], timeoutMs);
    const measured = parseFfmpegMeasurement(output);
    for (const key of ['integratedLufs', 'truePeakDbtp', 'loudnessRangeLu'] as const) {
      const metric = measured[key];
      // ebur128 returns a -70 LUFS sentinel for silence and short clips; a
      // sentinel cannot establish that a publishing target has passed.
      if (metric !== null && (key !== 'integratedLufs' || (result.duration >= 0.4 && result.rms > 0 && metric > -70)) &&
          (key !== 'loudnessRangeLu' || result.duration >= 3)) {
        result[key] = metric;
        delete result.unavailable[key];
      } else result.unavailable[key] = `${key} could not be established by ffmpeg (silence, short audio or absent summary).`;
    }
    result.backend += '+ffmpeg-ebur128';
    result.notes.push(`Integrated LUFS uses EBU R128 gating. Mono ${dualMono ? 'uses dual-mono compensation, matching Audacity LoudnessNormalization defaults' : 'uses its actual channel count without dual-mono compensation'}.`);
  } catch (error) {
    if (backend === 'ffmpeg') throw error;
    const reason = error instanceof Error ? error.message : String(error);
    for (const key of ['integratedLufs', 'truePeakDbtp', 'loudnessRangeLu']) result.unavailable[key] = reason;
  }
  return result;
}

const Bound = z.object({ min: z.number().finite().optional(), max: z.number().finite().optional() }).strict()
  .refine((b) => b.min !== undefined || b.max !== undefined, 'a target needs min or max')
  .refine((b) => b.min === undefined || b.max === undefined || b.max >= b.min, 'target max must be >= min');
export const TargetSchema = z.object({
  integratedLufs: Bound.optional(), truePeakDbtp: Bound.optional(), rmsDbfs: Bound.optional(), peakDbfs: Bound.optional(),
  noiseFloorDbfs: Bound.optional(),
}).strict().refine((value) => Object.values(value).some((v) => v !== undefined), 'supply at least one target');
export type Targets = z.infer<typeof TargetSchema>;

/** Numeric house references, not certification or promises about a platform's playback policy. */
export const TARGETS = {
  podcast: { integratedLufs: { min: -17, max: -15 }, truePeakDbtp: { max: -1 } },
  video: { integratedLufs: { min: -15, max: -13 }, truePeakDbtp: { max: -1 } },
  broadcast: { integratedLufs: { min: -23.5, max: -22.5 }, truePeakDbtp: { max: -1 } },
  audiobook: { rmsDbfs: { min: -23, max: -18 }, peakDbfs: { max: -3 }, noiseFloorDbfs: { max: -60 } },
  premaster: { integratedLufs: { min: -19, max: -17 }, truePeakDbtp: { max: -1 } },
} as const satisfies Record<string, Targets>;

export interface TargetCheck { status: 'met' | 'missed' | 'unknown'; actual: number | null; target: { min?: number; max?: number }; reason?: string; gap?: number }
export function checkTargets(measurement: Measurement, targets: Targets): { status: 'met' | 'missed' | 'unknown'; checks: Record<string, TargetCheck> } {
  const validated = TargetSchema.parse(targets);
  const checks: Record<string, TargetCheck> = {};
  for (const [metric, target] of Object.entries(validated)) {
    if (target === undefined) continue;
    const value = metric === 'noiseFloorDbfs' ? null : measurement[metric as keyof Measurement];
    const actual = typeof value === 'number' && Number.isFinite(value) ? value : null;
    if (actual === null) checks[metric] = { status: 'unknown', actual, target,
      reason: metric === 'noiseFloorDbfs' ? 'Quiet-block RMS is an estimate; it cannot certify the recording noise floor. Measure isolated room tone separately.' :
        measurement.unavailable[metric] ?? 'No finite measurement (silence or empty audio).' };
    else if ((target.min !== undefined && actual < target.min) || (target.max !== undefined && actual > target.max)) {
      checks[metric] = { status: 'missed', actual, target, gap: round(target.min !== undefined && actual < target.min ? actual - target.min : actual - target.max!) };
    } else checks[metric] = { status: 'met', actual, target };
  }
  const statuses = Object.values(checks).map((c) => c.status);
  return { status: statuses.includes('missed') ? 'missed' : statuses.includes('unknown') ? 'unknown' : 'met', checks };
}

export function compareMeasurements(before: Measurement, after: Measurement): Record<string, { before: number; after: number; change: number }> {
  const delta: Record<string, { before: number; after: number; change: number }> = {};
  for (const key of ['duration', 'peakDbfs', 'rmsDbfs', 'crestDb', 'dcOffset', 'clippedSamples', 'discontinuities', 'silenceGapCount',
    'quietRmsDbfsEstimate', 'dynamicRangeDbEstimate', 'integratedLufs', 'truePeakDbtp', 'loudnessRangeLu'] as const) {
    const a = before[key]; const b = after[key];
    if (a !== null && b !== null && Number.isFinite(a) && Number.isFinite(b)) delta[key] = { before: a, after: b, change: round(b - a) };
  }
  return delta;
}

export const LoudnessTargetShape = {
  targetLufs: z.number().finite().min(-50).max(-5).default(-16),
  truePeakCeilingDbtp: z.number().finite().min(-20).max(0).default(-1),
  maxBoostDb: z.number().finite().min(0).max(36).default(18),
  toleranceLu: z.number().finite().min(0.1).max(3).default(0.5),
};
export const LoudnessTargetSchema = z.object(LoudnessTargetShape).strict();

/** Plan static sample gain from established LUFS/true peak; never infer either from RMS/sample peak. */
export function planLoudnessTarget(before: Measurement, input: z.input<typeof LoudnessTargetSchema> = {}) {
  const args = LoudnessTargetSchema.parse(input);
  if (before.integratedLufs === null || !Number.isFinite(before.integratedLufs) ||
      before.truePeakDbtp === null || !Number.isFinite(before.truePeakDbtp) || before.rms <= 0) {
    throw new Error('Loudness targeting requires established integrated LUFS and true peak from non-silent audio; install ffmpeg and measure a longer selection.');
  }
  const requestedGainDb = args.targetLufs - before.integratedLufs;
  // ffmpeg's text summary rounds true peak to 0.1 dB. Retain that much
  // additional headroom rather than pretend its printed peak is exact.
  const peakHeadroomDb = args.truePeakCeilingDbtp - before.truePeakDbtp - 0.1;
  const gainDb = Math.min(requestedGainDb, peakHeadroomDb, args.maxBoostDb);
  if (gainDb < -60) throw new Error('The requested true-peak ceiling needs more than 60 dB attenuation; choose a sensible source/ceiling.');
  const limits = [
    ...(peakHeadroomDb < requestedGainDb ? ['true-peak ceiling'] : []),
    ...(args.maxBoostDb < requestedGainDb ? ['maximum boost'] : []),
  ];
  return { ...args, requestedGainDb: round(requestedGainDb), peakHeadroomDb: round(peakHeadroomDb), gainDb: round(gainDb),
    ratio: 10 ** (gainDb / 20), predictedLufs: round(before.integratedLufs + gainDb),
    predictedTruePeakDbtp: round(before.truePeakDbtp + gainDb),
    achievable: Math.abs(before.integratedLufs + gainDb - args.targetLufs) <= args.toleranceLu, limits };
}

export interface MeasureScope { track?: TrackRef; trackCount?: number; start?: number; end?: number; currentSelection?: boolean }
interface SelectionSnapshot { start: number; end: number; selected: number[]; tracks: TrackInfo[] }
export function selectionTimes(info: unknown): { start: number; end: number } {
  const object = Array.isArray(info) ? info[0] : info;
  if (!object || typeof object !== 'object') throw new Error('Audacity returned no readable selection');
  const value = object as Record<string, unknown>;
  const start = value.start ?? value.Start;
  const end = value.end ?? value.End;
  if (typeof start !== 'number' || typeof end !== 'number' || !Number.isFinite(start) || !Number.isFinite(end) || start < 0 || end < start) {
    throw new Error('Audacity returned invalid selection start/end');
  }
  return { start, end };
}

async function snapshotSelection(ops: Ops): Promise<SelectionSnapshot> {
  const tracks = await ops.tracks();
  return { ...selectionTimes(await ops.info('Selection')), tracks,
    selected: tracks.flatMap((track, index) => track.selected ? [index] : []) };
}

async function restoreSelection(ops: Ops, selection: SelectionSnapshot): Promise<void> {
  await ops.run('SelectNone');
  for (const track of selection.selected) await ops.command('SelectTracks', { Track: track, TrackCount: 1, Mode: 'Add' });
  await ops.command('SelectTime', { Start: selection.start, End: selection.end, RelativeTo: 'ProjectStart' });
}

/** Export the selected rendered mix without altering track gain, pan, mute, solo or envelopes. */
export async function measureScope(ops: Ops, scope: MeasureScope = {}, options: MeasureOptions = {}): Promise<Measurement & { scope: unknown }> {
  scope = MeasureScopeSchema.parse(scope);
  options = MeasureOptionsSchema.parse(options);
  const previous = await snapshotSelection(ops);
  const directory = await mkdtemp(join(tmpdir(), 'gizmos-audacity-measure-'));
  let operationError: unknown;
  let restorationError: unknown;
  let selectionChanged = false;
  try {
    let selected: number[];
    let start: number;
    let end: number;
    if (scope.currentSelection) {
      selected = previous.selected;
      start = previous.start; end = previous.end;
      if (!selected.some((i) => previous.tracks[i]?.kind === 'wave')) throw new Error('select at least one audio track first');
    } else {
      const first = scope.track === undefined ? 0 : await ops.trackIndex(scope.track);
      const count = scope.track === undefined ? previous.tracks.length : scope.trackCount ?? 1;
      if (!count || first + count > previous.tracks.length) throw new Error('measurement track range is empty or outside the project');
      selected = Array.from({ length: count }, (_, i) => first + i);
      const audio = selected.map((i) => previous.tracks[i]!).filter((track) => track.kind === 'wave');
      if (!audio.length) throw new Error('measurement needs an audio track');
      start = scope.start ?? (scope.track === undefined ? 0 : Math.min(...audio.map((t) => t.start)));
      end = scope.end ?? Math.max(...audio.map((t) => t.end));
    }
    if (!Number.isFinite(start) || !Number.isFinite(end) || start < 0 || !(end > start)) {
      throw new Error(`measurement needs a finite non-empty time selection (${start}s to ${end}s)`);
    }
    // Resolve and validate the entire range before changing selection.
    selectionChanged = true;
    if (scope.currentSelection) {
      // Clear label text editing by explicitly reselecting the same tracks/time.
      await ops.run('SelectNone');
      for (const track of selected) await ops.command('SelectTracks', { Track: track, TrackCount: 1, Mode: 'Add' });
      await ops.command('SelectTime', { Start: start, End: end, RelativeTo: 'ProjectStart' });
    } else {
      await ops.command('Select', { Track: selected[0]!, TrackCount: selected.length, Start: start, End: end, Mode: 'Set' });
    }
    const file = join(directory, 'selection.wav');
    const audio = selected.map((i) => previous.tracks[i]!).filter((track) => track.kind === 'wave');
    const channels = audio.some((t) => (t.channels ?? 1) > 1) || audio.length > 1 ? 2 : 1;
    await ops.command('Export2', { Filename: file, NumChannels: channels }, 600_000);
    const measured = await measureFile(file, options);
    delete measured.file;
    measured.notes.push('Measures the rendered Export2 selection, including existing track gain, pan, mute, solo and envelopes. Track controls are never changed.');
    if (selected.some((i) => previous.tracks[i]?.mute)) measured.notes.push('The selected tracks include a muted track; rendered measurements reflect its current mute state.');
    return { ...measured, scope: { tracks: selected, start, end } };
  } catch (error) {
    operationError = error;
    throw error;
  } finally {
    try { if (selectionChanged && !ops.pipe?.needsRecovery) await restoreSelection(ops, previous); }
    catch (restoreError) {
      restorationError = restoreError;
      if (operationError !== undefined) {
        const message = `${operationError instanceof Error ? operationError.message : String(operationError)}. Selection restoration also failed: ${restoreError instanceof Error ? restoreError.message : String(restoreError)}`;
        if (restoreError instanceof Error) { restoreError.message = message; throw restoreError; }
        throw new Error(message);
      }
      throw restoreError;
    }
    finally {
      // A timed-out Export2 may still write its destination. Retain scratch
      // and the timeout/recovery error class, including restoration failures.
      if (ops.pipe?.needsRecovery) {
        const error = restorationError ?? operationError;
        if (error instanceof Error) error.message += `. Selection restoration is incomplete. Measurement scratch retained at ${directory}; inspect after audacity_recover`;
      } else await rm(directory, { recursive: true, force: true });
    }
  }
}

const Seconds = z.number().finite().min(0).max(86_400);
const Track = z.union([z.number().int().nonnegative(), SafeString.min(1)]);
export const MeasureScopeShape = { track: Track.optional(), trackCount: z.number().int().min(1).max(256).optional(),
  start: Seconds.optional(), end: Seconds.optional(), currentSelection: z.boolean().default(false) };
export const MeasureOptionsShape = { backend: z.enum(['auto', 'wav', 'ffmpeg']).default('auto'), dualMono: z.boolean().default(true),
  timeoutMs: z.number().int().min(1000).max(600_000).default(300_000) };
export const MeasureOptionsSchema = z.object({ ...MeasureOptionsShape, silence: SilenceSchema.optional() }).strict();
export const MeasureScopeSchema = z.object(MeasureScopeShape).strict().superRefine((scope, ctx) => {
  if (scope.trackCount !== undefined && scope.track === undefined) ctx.addIssue({ code: 'custom', message: 'trackCount requires track' });
  if (scope.currentSelection && [scope.track, scope.trackCount, scope.start, scope.end].some((v) => v !== undefined)) {
    ctx.addIssue({ code: 'custom', message: 'currentSelection cannot be combined with track or time arguments' });
  }
  if (scope.start !== undefined && scope.end !== undefined && scope.end <= scope.start) ctx.addIssue({ code: 'custom', message: 'end must be after start' });
});
export const LoudnessApplySchema = z.object({ track: Track, start: Seconds.optional(), end: Seconds.optional(),
  ...LoudnessTargetShape, dryRun: z.boolean().default(false) }).strict();

/** Measurement injection keeps planning/orchestration testable without spawning Audacity or ffmpeg. */
export async function loudnessTarget(ops: Ops, input: unknown, measure = measureScope): Promise<unknown> {
  const { track, start, end, dryRun, ...targets } = LoudnessApplySchema.parse(input);
  const index = await ops.trackIndex(track);
  const info = (await ops.tracks())[index]!;
  if (info.kind !== 'wave') throw new Error('loudness targeting needs an audio track');
  const scope = { track: index, start: start ?? info.start, end: end ?? info.end };
  MeasureScopeSchema.parse(scope);
  const before = await measure(ops, scope, { backend: 'ffmpeg' });
  const plan = planLoudnessTarget(before, targets);
  const steps = [{ command: 'Amplify', params: { Ratio: plan.ratio, AllowClipping: true }, scope }];
  catalogueCommand('Amplify', steps[0]!.params);
  if (dryRun) return { dryRun, before, plan, steps };
  await ops.select(scope);
  // Current track gain/pan/envelopes may lower the rendered level, so
  // Audacity's float samples may exceed full scale while the rendered
  // true peak stays within the measured ceiling. Verify the export again.
  await ops.command('Amplify', steps[0]!.params, 600_000);
  const after = await measure(ops, scope, { backend: 'ffmpeg' });
  const targetCheck = checkTargets(after, { integratedLufs: { min: plan.targetLufs - plan.toleranceLu, max: plan.targetLufs + plan.toleranceLu },
    truePeakDbtp: { max: plan.truePeakCeilingDbtp } });
  return { dryRun, before, after, plan, steps, targetCheck,
    samplePeakDbfs: after.peakDbfs, clippedSamples: after.clippedSamples,
    notes: ['Static gain preserves dynamics; a peak-limited source may require a separately reviewed limiter/compressor pipeline to reach the requested LUFS.'] };
}
type RegisterTool = <S extends z.ZodRawShape>(name: string, description: string, shape: S,
  handler: (args: z.infer<z.ZodObject<S>>) => Promise<unknown>, readOnly?: boolean) => void;

export function registerAnalysisTools(tool: RegisterTool, ops: Ops): void {
  tool('audacity_loudness_target',
    'Measure then apply static gain to approach targetLufs while preserving measured true-peak headroom and respecting maxBoostDb. Requires ffmpeg and a non-silent audio track; default scope is its own extent. dryRun returns before measurement and the Amplify plan. Reports before/after and whether the target was achievable; it never compresses or guesses absent LUFS/true peak.',
    LoudnessApplySchema.shape, (args) => loudnessTarget(ops, args));
  tool('audacity_silence',
    'Find quiet regions without deleting audio: every channel must stay below thresholdDb for minimumSeconds. Scan an optional file, or rendered tracks/currentSelection with selection restored. Times are absolute project seconds for Audacity ranges and file seconds for files. Returns capped regions plus the total count; current mute/gain/envelopes affect rendered silence.',
    { file: SafeString.min(1).optional(), ...MeasureScopeShape, ...SilenceSchema.shape },
    async ({ file, thresholdDb, minimumSeconds, maxRegions, ...scope }) => {
      if (file !== undefined && (scope.currentSelection || [scope.track, scope.trackCount, scope.start, scope.end].some((v) => v !== undefined))) {
        throw new Error('file cannot be combined with Audacity track or time arguments');
      }
      const silence = { thresholdDb, minimumSeconds, maxRegions };
      const measured = file === undefined ? await measureScope(ops, scope, { backend: 'wav', silence }) : await measureFile(file, { silence });
      const start = 'scope' in measured ? (measured.scope as { start: number }).start : 0;
      return { regions: measured.silenceGaps.map((gap) => ({ ...gap, start: round(gap.start + start), end: round(gap.end + start) })),
        count: measured.silenceGapCount, truncated: measured.silenceGapCount > measured.silenceGaps.length,
        thresholdDb, minimumSeconds, ...(file !== undefined ? { file: measured.file } : { scope: 'scope' in measured ? measured.scope : undefined }),
        notes: measured.notes };
    });
  tool('audacity_probe_file',
    'Inspect an audio/video file before importing or exporting: container, duration, audio codecs, sample rate, channels and stream metadata. Requires optional ffprobe (installed with ffmpeg); reads the file without changing Audacity.',
    { file: SafeString.min(1), timeoutMs: z.number().int().min(1000).max(120_000).default(30_000) },
    ({ file, timeoutMs }) => probeFile(file, timeoutMs), true);
  tool('audacity_measure',
    'Measure tracks, a time range, or currentSelection using a temporary export; restores selection and preserves track controls. Reports peak/RMS/DC/crest, advisory defects and silence. Optional ffmpeg adds integrated LUFS/LRA/true peak. Reads rendered gain/mute/solo/envelopes, so use file measurement for unprocessed source levels.',
    { ...MeasureScopeShape, ...MeasureOptionsShape, targets: TargetSchema.optional() },
    async ({ targets, backend, dualMono, timeoutMs, ...scope }) => {
      const measurement = await measureScope(ops, scope, { backend, dualMono, timeoutMs });
      return targets ? { measurement, targetCheck: checkTargets(measurement, targets) } : measurement;
    });
  tool('audacity_measure_file',
    'Measure an exported/source audio file without touching Audacity. Native PCM/float WAV peak/RMS/DC/crest and advisory defects need no dependencies; ffmpeg on PATH adds EBU R128 LUFS/LRA/true peak and decodes other containers. Unavailable targets report unknown.',
    { file: SafeString.min(1), ...MeasureOptionsShape, targets: TargetSchema.optional() },
    async ({ file, targets, ...options }) => {
      const measurement = await measureFile(file, options);
      return targets ? { measurement, targetCheck: checkTargets(measurement, targets) } : measurement;
    }, true);
  tool('audacity_compare_files',
    'Compare before/after audio files with the same measurement settings. Returns both reports and numeric changes only for metrics established on both sides; missing LUFS or true peak never becomes a zero change.',
    { before: SafeString.min(1), after: SafeString.min(1), ...MeasureOptionsShape, targets: TargetSchema.optional() },
    async ({ before, after, targets, ...options }) => {
      const a = await measureFile(before, options); const b = await measureFile(after, options);
      return { before: a, after: b, delta: compareMeasurements(a, b), ...(targets ? { targetCheck: checkTargets(b, targets) } : {}) };
    }, true);
  tool('audacity_targets', 'List numeric house reference targets for podcast, video, broadcast, audiobook and premaster; use these with measurement targets. These references are not publishing certification. Recording noise floor requires isolated room tone.',
    {}, async () => ({ presets: TARGETS, note: 'All bounds must be measured to pass. Quiet-block RMS cannot certify a noise-floor target.' }), true);
  tool('audacity_contrast',
    'Measure the RMS level difference between foreground speech and background room tone without opening Audacity Contrast. Each range is exported with current track controls and selection restored. This is a numeric contrast check, not full accessibility certification.',
    { foreground: z.object({ track: Track, start: Seconds, end: Seconds }).strict(),
      background: z.object({ track: Track, start: Seconds, end: Seconds }).strict(), minimumDb: z.number().finite().min(0).max(100).default(20) },
    async ({ foreground, background, minimumDb }) => {
      // Both nested intervals must pass before the first temporary export.
      MeasureScopeSchema.parse(foreground);
      MeasureScopeSchema.parse(background);
      const foregroundIndex = await ops.trackIndex(foreground.track);
      const backgroundIndex = await ops.trackIndex(background.track);
      const tracks = await ops.tracks();
      if (tracks[foregroundIndex]?.kind !== 'wave' || tracks[backgroundIndex]?.kind !== 'wave') throw new Error('contrast ranges require audio tracks');
      const a = await measureScope(ops, foreground, { backend: 'wav' });
      const b = await measureScope(ops, background, { backend: 'wav' });
      const differenceDb = a.rmsDbfs === null || b.rmsDbfs === null ? null : round(a.rmsDbfs - b.rmsDbfs);
      return { foregroundRmsDbfs: a.rmsDbfs, backgroundRmsDbfs: b.rmsDbfs, differenceDb, minimumDb,
        status: differenceDb === null ? 'unknown' : differenceDb >= minimumDb ? 'met' : 'missed',
        ...(differenceDb === null ? { reason: 'A silent or empty range has no finite RMS level.' } : {}) };
    });
}
