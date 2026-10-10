import { existsSync, mkdirSync, writeFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

export const SAMPLE_RATE = 48_000;
export const DURATION = 12;
export const VOICE_REGIONS = [
  [1, 3],
  [4, 6],
  [7, 10],
];

/** Original deterministic synthesis: voiced pulses, not speech or a transcript. */
export function voiceSample(time) {
  const region = VOICE_REGIONS.find(([start, end]) => time >= start && time < end);
  let voice = 0;
  if (region) {
    const [start, end] = region;
    const edge = Math.min(1, (time - start) / 0.03, (end - time) / 0.03);
    const syllable = 0.65 + 0.35 * Math.sin(2 * Math.PI * 3 * (time - start)) ** 2;
    voice =
      edge *
      syllable *
      (0.2 * Math.sin(2 * Math.PI * 180 * time) +
        0.06 * Math.sin(2 * Math.PI * 360 * time) +
        0.04 * Math.sin(2 * Math.PI * 720 * time));
  }
  // Deliberate DC offset and low rumble give cleanup a measurable job.
  return voice + 0.008 + 0.02 * Math.sin(2 * Math.PI * 35 * time);
}

export function bedSample(time, channel) {
  const frequencies = channel === 0 ? [220, 330, 440] : [220, 349, 523];
  const edge = Math.min(1, time / 0.25, (DURATION - time) / 0.25);
  return edge * frequencies.reduce((sum, hz) => sum + 0.012 * Math.sin(2 * Math.PI * hz * time), 0);
}

export function renderWav(channels, sample) {
  const frames = DURATION * SAMPLE_RATE;
  const dataBytes = frames * channels * 2;
  const wav = Buffer.alloc(44 + dataBytes);
  wav.write('RIFF', 0);
  wav.writeUInt32LE(36 + dataBytes, 4);
  wav.write('WAVEfmt ', 8);
  wav.writeUInt32LE(16, 16);
  wav.writeUInt16LE(1, 20);
  wav.writeUInt16LE(channels, 22);
  wav.writeUInt32LE(SAMPLE_RATE, 24);
  wav.writeUInt32LE(SAMPLE_RATE * channels * 2, 28);
  wav.writeUInt16LE(channels * 2, 32);
  wav.writeUInt16LE(16, 34);
  wav.write('data', 36);
  wav.writeUInt32LE(dataBytes, 40);
  for (let frame = 0; frame < frames; frame++) {
    for (let channel = 0; channel < channels; channel++) {
      const value = sample(frame / SAMPLE_RATE, channel);
      if (!Number.isFinite(value) || Math.abs(value) >= 1) throw new Error('Synthesis exceeded PCM sample range');
      wav.writeInt16LE(Math.round(value * 32767), 44 + (frame * channels + channel) * 2);
    }
  }
  return wav;
}

export function generateSource(directory) {
  const source = resolve(directory);
  mkdirSync(source, { recursive: true });
  const bed = resolve(source, 'bed.wav');
  const voice = resolve(source, 'voice.wav');
  if ([bed, voice].some(existsSync)) throw new Error('Source audio already exists; use a new directory.');
  writeFileSync(bed, renderWav(2, bedSample), { flag: 'wx' });
  writeFileSync(voice, renderWav(1, voiceSample), { flag: 'wx' });
  return { bed, voice };
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const directory = process.argv[2] ?? '.work/voiceover-source';
  console.log(JSON.stringify(generateSource(directory), null, 2));
}
