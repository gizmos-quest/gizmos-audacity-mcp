import type { FileHandle } from 'node:fs/promises';
import { type AnalysisBudget, assertAudioBudget } from './budget.js';
import type { WavFormat } from './types.js';

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
  if (encoding !== 1 && encoding !== 3)
    throw new Error(`WAV encoding ${encoding} is not PCM or IEEE float; use ffmpeg`);
  const floatingPoint = encoding === 3;
  if (floatingPoint ? ![32, 64].includes(bits) : ![8, 16, 24, 32].includes(bits)) {
    throw new Error(`unsupported WAV ${floatingPoint ? 'float' : 'PCM'} sample width ${bits}; use ffmpeg`);
  }
  if (channels < 1 || channels > 32 || sampleRate < 1 || sampleRate > 768_000 || blockAlign !== (channels * bits) / 8) {
    throw new Error('invalid WAV channels, sample rate or block alignment');
  }
  if (dataBytes % blockAlign !== 0) throw new Error('WAV data contains a partial sample frame');
  const format = { channels, sampleRate, bits, floatingPoint, blockAlign, dataOffset, dataBytes };
  assertAudioBudget(format);
  return format;
}

export async function readExactly(
  handle: FileHandle,
  size: number,
  position: number,
  budget?: AnalysisBudget,
): Promise<Buffer> {
  const buffer = Buffer.alloc(size);
  let read = 0;
  while (read < size) {
    budget?.check();
    const result = await handle.read(buffer, read, size - read, position + read);
    if (!result.bytesRead) throw new Error('WAV is truncated');
    read += result.bytesRead;
  }
  return buffer;
}

/** Parse RIFF PCM/IEEE-float WAV chunk headers, including odd-sized metadata and extensible fmt chunks. */
export async function fileHeader(handle: FileHandle, budget?: AnalysisBudget): Promise<WavFormat> {
  const fileBytes = (await handle.stat()).size;
  const header = fileBytes < 12 ? undefined : await readExactly(handle, 12, 0, budget);
  if (header?.toString('ascii', 0, 4) !== 'RIFF' || header.toString('ascii', 8, 12) !== 'WAVE') {
    throw new Error('native measurement requires RIFF WAV; use ffmpeg for other containers');
  }
  const limit = header.readUInt32LE(4) + 8;
  if (limit < 12) throw new Error('WAV RIFF body is invalid');
  if (limit > fileBytes) throw new Error('WAV RIFF body is truncated');
  let fmt: Buffer | undefined;
  let dataOffset: number | undefined;
  let dataBytes = 0;
  let offset = 12;
  for (; offset + 8 <= limit; ) {
    const chunk = await readExactly(handle, 8, offset, budget);
    const id = chunk.toString('ascii', 0, 4);
    const size = chunk.readUInt32LE(4);
    const start = offset + 8;
    if (start + size + (size & 1) > limit) throw new Error(`WAV ${id} chunk is truncated`);
    if (id === 'fmt ') {
      if (fmt) throw new Error('WAV contains multiple fmt chunks; use ffmpeg');
      if (size > 4096) throw new Error('WAV fmt chunk is unreasonably large');
      fmt = await readExactly(handle, size, start, budget);
    }
    if (id === 'data') {
      if (dataOffset !== undefined) throw new Error('WAV contains multiple data chunks; use ffmpeg');
      dataOffset = start;
      dataBytes = size;
    }
    offset = start + size + (size & 1);
  }
  if (offset !== limit) throw new Error('WAV ends with a truncated chunk header');
  if (!fmt || dataOffset === undefined) throw new Error('WAV requires fmt and data chunks');
  return readFormat(fmt, dataOffset, dataBytes);
}
