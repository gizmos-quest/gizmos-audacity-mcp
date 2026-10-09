import { writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { measureFile } from '../../src/analysis/measurement.js';
import { temporary, wav } from '../helpers/audio-fixture.js';

const backend = vi.hoisted(() => ({ run: vi.fn() }));
vi.mock('../../src/analysis/executables.js', async (original) => ({
  ...(await original<typeof import('../../src/analysis/executables.js')>()),
  runFfmpeg: backend.run,
}));
const summary = (lufs = '-16', lra = '3', peak = '-2') => `Summary:
Integrated loudness:
I: ${lufs} LUFS
Loudness range:
LRA: ${lra} LU
True peak:
Peak: ${peak} dBFS`;

beforeEach(() => {
  backend.run.mockReset().mockResolvedValue(summary());
});
async function source(samples = Array(40).fill(0.25)): Promise<string> {
  const file = join(await temporary(), 'audio.wav');
  await writeFile(file, wav(samples));
  return file;
}

describe('bounded file measurement backends', () => {
  it('adds established LUFS, true peak and LRA while preserving native sample metrics', async () => {
    const file = await source();
    const result = await measureFile(file);
    expect(result).toMatchObject({
      integratedLufs: -16,
      truePeakDbtp: -2,
      loudnessRangeLu: 3,
      rms: 0.25,
      dualMono: true,
    });
    expect(result.unavailable).toEqual({});
    expect(result.notes.join(' ')).toContain('dual-mono compensation');
    expect(backend.run.mock.calls[0]![1]).toBeGreaterThan(0);
    expect(backend.run.mock.calls[0]![1]).toBeLessThanOrEqual(300000);
  });
  it('decodes the first stream with an output cap and then measures its full output', async () => {
    const file = join(await temporary(), 'source.mp3');
    await writeFile(file, 'synthetic compressed input');
    backend.run.mockImplementation(async (args: string[]) => {
      if (args.includes('-c:a')) {
        await writeFile(args.at(-1)!, wav(Array(40).fill(0.5)));
        return '';
      }
      return summary();
    });
    expect(await measureFile(file, { dualMono: false })).toMatchObject({
      rms: 0.5,
      backend: 'ffmpeg-decode+native-wav+ffmpeg-ebur128',
      dualMono: false,
    });
    expect(backend.run.mock.calls[0]![0]).toContain('-fs');
    expect(backend.run.mock.calls[0]![0]).toContain('4294967295');
  });
  it.each([
    { samples: Array(40).fill(0), lufs: '-70', lra: 'nan', peak: '-inf' },
    { samples: [0.25], lufs: '-16', lra: '3', peak: '-2' },
  ])('keeps absent or ineligible loudness metrics unknown %#', async ({ samples, lufs, lra, peak }) => {
    backend.run.mockResolvedValue(summary(lufs, lra, peak));
    const result = await measureFile(await source(samples));
    expect(result.integratedLufs).toBeNull();
    expect(result.loudnessRangeLu).toBeNull();
    expect(result.unavailable.integratedLufs).toContain('could not be established');
  });
  it('keeps a backend failure unavailable in automatic mode and propagates it when required', async () => {
    const file = await source();
    backend.run.mockRejectedValue(new Error('synthetic backend failure'));
    const result = await measureFile(file);
    expect(result.unavailable.truePeakDbtp).toContain('synthetic backend failure');
    await expect(measureFile(file, { backend: 'ffmpeg' })).rejects.toThrow('synthetic backend failure');
  });
  it('reports both native format failure and decoder rejection', async () => {
    const file = join(await temporary(), 'bad.mp3');
    await writeFile(file, Buffer.alloc(44));
    backend.run.mockRejectedValue(new Error('decoder rejected input'));
    await expect(measureFile(file)).rejects.toThrow(/Native WAV measurement:.*RIFF WAV.*decoder rejected input/);
  });
});
