import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { AnalysisBudget, AnalysisBudgetError, assertAudioBudget, MAX_DECODED_BYTES } from '../src/analysis/budget.js';
import { measureFile } from '../src/analysis/measurement.js';
import { measureWavFile } from '../src/analysis/wav-metrics.js';

const directories: string[] = [];
afterEach(async () => {
  vi.restoreAllMocks();
  await Promise.all(directories.splice(0).map((dir) => rm(dir, { recursive: true, force: true })));
});
function wav(): Buffer {
  const buffer = Buffer.alloc(48);
  buffer.write('RIFF');
  buffer.writeUInt32LE(40, 4);
  buffer.write('WAVEfmt ', 8);
  buffer.writeUInt32LE(16, 16);
  buffer.writeUInt16LE(1, 20);
  buffer.writeUInt16LE(1, 22);
  buffer.writeUInt32LE(8000, 24);
  buffer.writeUInt32LE(16000, 28);
  buffer.writeUInt16LE(2, 32);
  buffer.writeUInt16LE(16, 34);
  buffer.write('data', 36);
  buffer.writeUInt32LE(4, 40);
  return buffer;
}
async function audioFile(): Promise<string> {
  const dir = await mkdtemp(join(tmpdir(), 'gizmos-budget-test-'));
  directories.push(dir);
  const file = join(dir, 'audio.wav');
  await writeFile(file, wav());
  return file;
}

describe('bounded native measurement', () => {
  it.each([0, 600001, NaN, 1.5])('refuses invalid native timeout %s', (timeout) =>
    expect(() => new AnalysisBudget(timeout)).toThrow('timeoutMs'),
  );
  it('enforces a deadline before reading a file', async () => {
    const clock = vi.spyOn(performance, 'now').mockReturnValue(0);
    const budget = new AnalysisBudget(1);
    clock.mockReturnValue(2);
    await expect(measureWavFile('never-opened.wav', {}, budget)).rejects.toBeInstanceOf(AnalysisBudgetError);
  });
  it('checks a shared deadline while reading native headers and does not decode on budget failure', async () => {
    const file = await audioFile();
    let now = 0;
    vi.spyOn(performance, 'now').mockImplementation(() => {
      now += 600;
      return now;
    });
    await expect(measureFile(file, { timeoutMs: 1000 })).rejects.toThrow('measurement exceeded 1000 ms');
  });
  it('rejects low-rate duration budgets but measures hour-long full-rate audio', () => {
    const format = {
      channels: 1,
      sampleRate: 1,
      bits: 8,
      floatingPoint: false,
      blockAlign: 1,
      dataOffset: 44,
      dataBytes: 86401,
    };
    expect(() => assertAudioBudget(format)).toThrow('duration exceeds 24 hours');
    expect(() => assertAudioBudget({ ...format, dataBytes: 86400 })).not.toThrow();
    // One hour of stereo 48 kHz 32-bit float: 1.38 GB, streamed in constant memory.
    const hour = { ...format, channels: 2, sampleRate: 48_000, bits: 32, floatingPoint: true, blockAlign: 8 };
    expect(() => assertAudioBudget({ ...hour, dataBytes: 3600 * 48_000 * 8 })).not.toThrow();
    expect(MAX_DECODED_BYTES).toBe(2 ** 32 - 1);
  });
  it('refuses a valid long low-rate WAV before scanning or attempting optional decoding', async () => {
    const file = await audioFile();
    const buffer = Buffer.alloc(44 + 86401 * 2);
    wav().copy(buffer, 0, 0, 44);
    buffer.writeUInt32LE(buffer.length - 8, 4);
    buffer.writeUInt32LE(1, 24);
    buffer.writeUInt32LE(2, 28);
    buffer.writeUInt32LE(buffer.length - 44, 40);
    await writeFile(file, buffer);
    await expect(measureFile(file)).rejects.toBeInstanceOf(AnalysisBudgetError);
  });
  it('reports the remaining shared budget accurately', () => {
    const clock = vi.spyOn(performance, 'now').mockReturnValue(0);
    const budget = new AnalysisBudget(100);
    clock.mockReturnValue(25);
    expect(budget.remaining()).toBe(75);
    clock.mockReturnValue(100);
    expect(() => budget.remaining()).toThrow('exceeded 100 ms');
  });
});
