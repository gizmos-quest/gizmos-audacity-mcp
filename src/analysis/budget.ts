import type { WavFormat } from './types.js';

// Chunked reads alone do not bound low-rate files or retained one-second RMS
// blocks. These limits cap decoded data and percentile storage independently.
export const MAX_AUDIO_BYTES = 512 * 1024 * 1024;
export const MAX_AUDIO_SECONDS = 86_400;

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
  if (format.dataBytes > MAX_AUDIO_BYTES)
    throw new AnalysisBudgetError('native measurement audio data exceeds 512 MiB; select a shorter range');
  if (format.dataBytes / format.blockAlign / format.sampleRate > MAX_AUDIO_SECONDS) {
    throw new AnalysisBudgetError('native measurement duration exceeds 24 hours; select a shorter range');
  }
}
