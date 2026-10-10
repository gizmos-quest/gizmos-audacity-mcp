import { z } from 'zod';

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

export const unavailableLoudness =
  'Install ffmpeg on PATH, or set AUDACITY_FFMPEG, for integrated LUFS, LRA and true peak.';
export const round = (value: number, decimals = 6) => Number(value.toFixed(decimals));
export const amplitudeDb = (value: number): number | null =>
  Number.isFinite(value) && value > 0 ? round(20 * Math.log10(value)) : null;

export const SilenceSchema = z
  .object({
    thresholdDb: z.number().min(-120).max(0).default(-60),
    minimumSeconds: z.number().min(0.001).max(3600).default(0.5),
    maxRegions: z.number().int().min(1).max(1000).default(100),
  })
  .strict();
export type SilenceOptions = z.input<typeof SilenceSchema>;

/** A percentile over sorted linear levels. Interpolation happens before dB conversion. */
export function percentile(values: readonly number[], percent: number): number | null {
  if (!(percent >= 0 && percent <= 100)) throw new Error('percentile must be between 0 and 100');
  if (!values.length) return null;
  const position = ((values.length - 1) * percent) / 100;
  const index = Math.floor(position);
  const a = values[index]!;
  const b = values[Math.min(index + 1, values.length - 1)]!;
  return a + (b - a) * (position - index);
}
