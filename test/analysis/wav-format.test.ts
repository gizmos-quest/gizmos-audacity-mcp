import { describe, expect, it } from 'vitest';
import { change, chunk, measureBuffer, riff, wav, wavHeader } from '../helpers/audio-fixture.js';

describe('RIFF WAV chunk reader', () => {
  it('skips odd-length metadata and accepts data before fmt', async () => {
    const buffer = wav([0.5], { metadata: true, dataFirst: true });
    expect((await wavHeader(buffer)).dataOffset).toBe(32);
    expect((await measureBuffer(buffer)).peak).toBe(0.5);
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
    [
      'zero sample rate',
      change(ordinary, (b) => {
        b.writeUInt32LE(0, 24);
        b.writeUInt32LE(0, 28);
      }),
      /sample rate/,
    ],
    [
      'excess sample rate',
      change(ordinary, (b) => {
        b.writeUInt32LE(768001, 24);
        b.writeUInt32LE(1536002, 28);
      }),
      /sample rate/,
    ],
    [
      'bad alignment',
      change(ordinary, (b) => {
        b.writeUInt16LE(3, 32);
        b.writeUInt32LE(30, 28);
      }),
      /alignment/,
    ],
    ['bad byte rate', change(ordinary, (b) => b.writeUInt32LE(1, 28)), /byte rate/],
    ['partial frame', riff([chunk('fmt ', fmt), chunk('data', Buffer.alloc(3))]), /partial sample frame/],
    ['duplicate fmt', riff([chunk('fmt ', fmt), chunk('fmt ', fmt), chunk('data', Buffer.alloc(4))]), /multiple fmt/],
    [
      'duplicate data',
      riff([chunk('fmt ', fmt), chunk('data', Buffer.alloc(4)), chunk('data', Buffer.alloc(4))]),
      /multiple data/,
    ],
    [
      'partial chunk header',
      riff([chunk('fmt ', fmt), chunk('data', Buffer.alloc(4)), Buffer.alloc(3)]),
      /truncated chunk header/,
    ],
    [
      'missing odd chunk padding',
      change(riff([chunk('fmt ', fmt), chunk('data', Buffer.alloc(1))]).subarray(0, 45), (b) => b.writeUInt32LE(37, 4)),
      /chunk is truncated/,
    ],
    ['short extensible format', change(ordinary, (b) => b.writeUInt16LE(0xfffe, 20)), /extensible fmt/],
    [
      'extensible valid-bit mismatch',
      change(wav([0], { extensible: true }), (b) => b.writeUInt16LE(15, 38)),
      /valid bits/,
    ],
    [
      'extensible wrong GUID',
      change(wav([0], { extensible: true }), (b) => {
        b[49] = 7;
      }),
      /subformat/,
    ],
  ] as const;
  it.each(invalid)('refuses %s', async (_name, buffer, error) => {
    await expect(wavHeader(buffer)).rejects.toThrow(error);
  });
});
