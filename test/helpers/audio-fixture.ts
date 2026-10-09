import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, vi } from 'vitest';

export const directories: string[] = [];
afterEach(async () => {
  vi.unstubAllEnvs();
  await Promise.all(directories.splice(0).map((directory) => rm(directory, { recursive: true, force: true })));
});

export async function temporary(): Promise<string> {
  const directory = await mkdtemp(join(tmpdir(), 'gizmos-analysis-test-'));
  directories.push(directory);
  return directory;
}

export function chunk(id: string, content: Buffer): Buffer {
  const header = Buffer.alloc(8);
  header.write(id);
  header.writeUInt32LE(content.length, 4);
  return Buffer.concat([header, content, Buffer.alloc(content.length & 1)]);
}

export function riff(chunks: readonly Buffer[]): Buffer {
  const body = Buffer.concat(chunks);
  const header = Buffer.alloc(12);
  header.write('RIFF');
  header.writeUInt32LE(body.length + 4, 4);
  header.write('WAVE', 8);
  return Buffer.concat([header, body]);
}

interface WavOptions {
  bits?: number;
  float?: boolean;
  sampleRate?: number;
  channels?: number;
  extensible?: boolean;
  metadata?: boolean;
  dataFirst?: boolean;
}
export function wav(samples: readonly number[], options: WavOptions = {}): Buffer {
  const bits = options.bits ?? 16;
  const channels = options.channels ?? 1;
  const rate = options.sampleRate ?? 10;
  const width = bits / 8;
  const format = Buffer.alloc(options.extensible ? 40 : 16);
  format.writeUInt16LE(options.extensible ? 0xfffe : options.float ? 3 : 1, 0);
  format.writeUInt16LE(channels, 2);
  format.writeUInt32LE(rate, 4);
  format.writeUInt32LE(rate * channels * width, 8);
  format.writeUInt16LE(channels * width, 12);
  format.writeUInt16LE(bits, 14);
  if (options.extensible) {
    format.writeUInt16LE(22, 16);
    format.writeUInt16LE(bits, 18);
    Buffer.from('0000000000001000800000aa00389b71', 'hex').copy(format, 24);
    format.writeUInt32LE(options.float ? 3 : 1, 24);
  }
  const audio = Buffer.alloc(samples.length * width);
  samples.forEach((sample, index) => {
    const offset = index * width;
    if (options.float) {
      if (bits === 32) audio.writeFloatLE(sample, offset);
      else audio.writeDoubleLE(sample, offset);
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

export function change(buffer: Buffer, apply: (buffer: Buffer) => void): Buffer {
  const result = Buffer.from(buffer);
  apply(result);
  return result;
}
