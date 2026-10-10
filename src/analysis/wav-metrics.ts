import { open } from 'node:fs/promises';
import type { z } from 'zod';
import { AnalysisBudget } from './budget.js';
import {
  amplitudeDb,
  type ChannelMeasurement,
  type Measurement,
  percentile,
  round,
  type SilenceOptions,
  SilenceSchema,
  unavailableLoudness,
  type WavFormat,
} from './types.js';
import { fileHeader, readExactly } from './wav-format.js';

function sampleAt(buffer: Buffer, offset: number, format: WavFormat): number {
  if (format.floatingPoint) return format.bits === 32 ? buffer.readFloatLE(offset) : buffer.readDoubleLE(offset);
  switch (format.bits) {
    case 8:
      return (buffer.readUInt8(offset) - 128) / 128;
    case 16:
      return buffer.readInt16LE(offset) / 32768;
    case 24:
      return buffer.readIntLE(offset, 3) / 8388608;
    default:
      return buffer.readInt32LE(offset) / 2147483648;
  }
}

class Metrics {
  private readonly channels: {
    peak: number;
    squares: number;
    sum: number;
    clipped: number;
    jumps: number;
    previous: number;
  }[];
  private frames = 0;
  private silenceStart: number | undefined;
  private silenceGapCount = 0;
  private readonly gaps: Measurement['silenceGaps'] = [];
  private readonly blockRms: number[] = [];
  private blockSquares = 0;
  private blockFrames = 0;
  private readonly silence: z.infer<typeof SilenceSchema>;
  private readonly silenceAmplitude: number;

  constructor(
    private readonly format: WavFormat,
    silence: SilenceOptions = {},
  ) {
    this.silence = SilenceSchema.parse(silence);
    this.silenceAmplitude = 10 ** (this.silence.thresholdDb / 20);
    this.channels = Array.from({ length: format.channels }, () => ({
      peak: 0,
      squares: 0,
      sum: 0,
      clipped: 0,
      jumps: 0,
      previous: 0,
    }));
  }

  add(buffer: Buffer, budget?: AnalysisBudget): void {
    const width = this.format.bits / 8;
    for (let offset = 0; offset + this.format.blockAlign <= buffer.length; offset += this.format.blockAlign) {
      if (this.frames % 4096 === 0) budget?.check();
      let silent = true;
      for (const [index, channel] of this.channels.entries()) {
        const sample = sampleAt(buffer, offset + index * width, this.format);
        if (!Number.isFinite(sample) || !Number.isFinite(sample * sample))
          throw new Error('WAV contains non-finite or overflowing float samples');
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
        if (this.gaps.length < this.silence.maxRegions)
          this.gaps.push({
            start: this.silenceStart / this.format.sampleRate,
            end: this.frames / this.format.sampleRate,
            duration: length / this.format.sampleRate,
          });
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
      return {
        peak: round(channel.peak),
        peakDbfs: amplitudeDb(channel.peak),
        rms: round(rms),
        rmsDbfs: amplitudeDb(rms),
        dcOffset: this.frames ? round(channel.sum / this.frames) : 0,
        clippedSamples: channel.clipped,
        discontinuities: channel.jumps,
      };
    });
    const count = this.frames * this.format.channels;
    const rms = count ? Math.sqrt(this.channels.reduce((sum, c) => sum + c.squares / count, 0)) : 0;
    const peak = Math.max(...this.channels.map((c) => c.peak));
    const quiet = percentile(
      this.blockRms.sort((a, b) => a - b),
      10,
    );
    const loud = percentile(this.blockRms, 95);
    const quietDb = quiet === null ? null : amplitudeDb(quiet);
    const loudDb = loud === null ? null : amplitudeDb(loud);
    return {
      duration: this.frames / this.format.sampleRate,
      sampleRate: this.format.sampleRate,
      channels: this.format.channels,
      frames: this.frames,
      peak: round(peak),
      peakDbfs: amplitudeDb(peak),
      rms: round(rms),
      rmsDbfs: amplitudeDb(rms),
      crestDb: rms > 0 ? amplitudeDb(peak / rms) : null,
      dcOffset: count ? round(this.channels.reduce((sum, c) => sum + c.sum / count, 0)) : 0,
      clippedSamples: perChannel.reduce((sum, c) => sum + c.clippedSamples, 0),
      discontinuities: perChannel.reduce((sum, c) => sum + c.discontinuities, 0),
      silenceGaps: this.gaps,
      silenceGapCount: this.silenceGapCount,
      quietRmsDbfsEstimate: quietDb,
      dynamicRangeDbEstimate:
        this.blockRms.length >= 2 && quietDb !== null && loudDb !== null ? round(loudDb - quietDb) : null,
      perChannel,
      integratedLufs: null,
      truePeakDbtp: null,
      loudnessRangeLu: null,
      unavailable: {
        integratedLufs: unavailableLoudness,
        truePeakDbtp: unavailableLoudness,
        loudnessRangeLu: unavailableLoudness,
      },
      notes: [
        `Silence gaps require every channel below ${this.silence.thresholdDb} dBFS for at least ${this.silence.minimumSeconds} seconds; at most ${this.silence.maxRegions} positions are returned.`,
        'Near-full-scale samples (>= 0.999) and jumps (> 0.3 full scale) are advisory counts, not confirmed defects.',
        'Quiet RMS is an estimate from the 10th percentile of one-second RMS blocks; dynamic range is the estimated p95 minus p10. Neither is a certified noise-floor or DR meter.',
      ],
      backend: 'native-wav',
      dualMono: false,
    };
  }
}

export async function measureWavFile(
  file: string,
  silence: SilenceOptions = {},
  timeout: number | AnalysisBudget = 300_000,
): Promise<Measurement> {
  const budget = typeof timeout === 'number' ? new AnalysisBudget(timeout) : timeout;
  budget.check();
  const handle = await open(file, 'r');
  try {
    const format = await fileHeader(handle, budget);
    const metrics = new Metrics(format, silence);
    const blockBytes = Math.max(format.blockAlign, Math.floor(65_536 / format.blockAlign) * format.blockAlign);
    for (let read = 0; read < format.dataBytes; ) {
      const size = Math.min(blockBytes, format.dataBytes - read);
      metrics.add(await readExactly(handle, size, format.dataOffset + read, budget), budget);
      read += size;
    }
    budget.check();
    return metrics.finish();
  } finally {
    await handle.close();
  }
}
