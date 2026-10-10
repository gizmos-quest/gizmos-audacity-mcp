import type { WavFormat } from './types.js';

// Streaming reads keep native measurement memory constant except for one RMS
// value per second of audio, so the duration cap bounds memory (including at
// very low sample rates) and the deadline bounds work. Size alone needs no cap:
// RIFF data cannot exceed 4 GiB. Optional ffmpeg decoding writes a temporary
// WAV, bounded at that same limit, so hour-long podcast files remain measurable.
export const MAX_DECODED_BYTES = 0xffff_ffff;
const MAX_AUDIO_SECONDS = 86_400;

export class AnalysisBudgetError extends Error {}

export class AnalysisBudget {
  private readonly deadline: number;
  constructor(readonly timeoutMs = 300_000) {
    if (!Number.isInteger(timeoutMs) || timeoutMs < 1 || timeoutMs > 600_000) {
      throw new Error('native measurement timeoutMs must be between 1 and 600000');
    }
    this.deadline = performance.now() + timeoutMs;
  }
  check(): void {
    if (performance.now() >= this.deadline) throw new AnalysisBudgetError(`measurement exceeded ${this.timeoutMs} ms`);
  }
  remaining(): number {
    this.check();
    return Math.max(1, Math.floor(this.deadline - performance.now()));
  }
}

export function assertAudioBudget(format: WavFormat): void {
  if (format.dataBytes / format.blockAlign / format.sampleRate > MAX_AUDIO_SECONDS) {
    throw new AnalysisBudgetError('native measurement duration exceeds 24 hours; select a shorter range');
  }
}
