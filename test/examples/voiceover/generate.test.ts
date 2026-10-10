import { createHash } from 'node:crypto';
import { readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { expect, it } from 'vitest';
import { measureBuffer, temporary, wavHeader } from '../../helpers/audio-fixture.js';

interface Generator {
  SAMPLE_RATE: number;
  DURATION: number;
  voiceSample: (time: number) => number;
  bedSample: (time: number, channel: number) => number;
  renderWav: (channels: number, sample: (time: number, channel: number) => number) => Buffer;
  generateSource: (directory: string) => { bed: string; voice: string };
}
const generator = (await import(
  new URL('../../../examples/voiceover/generate.mjs', import.meta.url).href
)) as Generator;
const hash = (buffer: Buffer) => createHash('sha256').update(buffer).digest('hex');

it('generates reproducible 12-second nonclipping PCM sources with independent stereo bed channels', async () => {
  const first = generator.generateSource(await temporary());
  const second = generator.generateSource(await temporary());
  for (const kind of ['bed', 'voice'] as const) {
    const bytes = readFileSync(first[kind]);
    expect(hash(bytes)).toBe(hash(readFileSync(second[kind])));
    const format = await wavHeader(bytes);
    expect(format).toMatchObject({ sampleRate: 48_000, channels: kind === 'bed' ? 2 : 1, bits: 16 });
    const measured = await measureBuffer(bytes);
    expect(measured.duration).toBe(12);
    expect(measured.rms).toBeGreaterThan(0);
    expect(measured.clippedSamples).toBe(0);
  }
  expect(generator.bedSample(1.123, 0)).not.toBe(generator.bedSample(1.123, 1));
});

it('provides a measurable cleanup fixture and separated voiced bursts for ducking', async () => {
  const voice = generator.renderWav(1, generator.voiceSample);
  const measured = await measureBuffer(voice);
  expect(measured.dcOffset).toBeCloseTo(0.008, 4);
  const rangeRms = (start: number, end: number) => {
    let sum = 0;
    let count = 0;
    for (let frame = Math.round(start * 48_000); frame < Math.round(end * 48_000); frame++) {
      sum += (voice.readInt16LE(44 + frame * 2) / 32768) ** 2;
      count++;
    }
    return Math.sqrt(sum / count);
  };
  expect(rangeRms(1.1, 2.9)).toBeGreaterThan(rangeRms(3.1, 3.9) * 5);
  expect(rangeRms(4.1, 5.9)).toBeGreaterThan(rangeRms(6.1, 6.9) * 5);
  expect(rangeRms(7.1, 9.9)).toBeGreaterThan(rangeRms(10.1, 11.9) * 5);
});

it('refuses existing source destinations before replacing or writing either WAV', async () => {
  const directory = await temporary();
  const voice = join(directory, 'voice.wav');
  writeFileSync(voice, 'retain this input');
  expect(() => generator.generateSource(directory)).toThrow(/already exists/);
  expect(readFileSync(voice, 'utf8')).toBe('retain this input');
  expect(() => readFileSync(join(directory, 'bed.wav'))).toThrow(/ENOENT/);
  expect(() => generator.renderWav(1, () => Number.NaN)).toThrow(/sample range/);
  expect(() => generator.renderWav(1, () => 1)).toThrow(/sample range/);
});
