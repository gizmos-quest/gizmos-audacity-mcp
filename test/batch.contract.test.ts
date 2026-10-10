import { describe, expect, it, vi } from 'vitest';
import { BatchSchema } from '../src/batch.js';
import { input, output, registeredBatch, secondInput, secondOutput, useBatchFiles } from './helpers/batch-fixture.js';

vi.mock('../src/source-rate.js', () => ({ measureSourceRate: vi.fn(async () => 48_000) }));

useBatchFiles();

describe('batch strict registration', () => {
  it('registers audacity_batch with the complete strict public schema', () => {
    const tool = registeredBatch();
    expect(tool.name).toBe('audacity_batch');
    const args = { jobs: [{ file: input, output }], dryRun: true };
    expect(tool.schema.parse(args)).toEqual(BatchSchema.parse(args));
    expect(tool.accesses).toEqual([]);
  });

  it.each([{ unknown: true }, { channels: 0 }, { channels: 3 }, { channels: 1.5 }, { dryRun: 'true' }, { measure: 1 }])(
    'rejects unknown or invalid root settings before Ops access %#',
    async (settings) => {
      const tool = registeredBatch();
      await expect(tool.call({ jobs: [{ file: input, output }], ...settings })).rejects.toThrow();
      expect(tool.accesses).toEqual([]);
    },
  );

  it.each([
    { typo: true },
    { file: 'bad"path.wav' },
    { output: 'bad\npath.wav' },
    { options: { typo: true } },
    { options: { shortenPauses: { minimum: 1, typo: true } } },
  ])('rejects unknown or unsafe nested job values before Ops access %#', async (settings) => {
    const tool = registeredBatch();
    await expect(tool.call({ jobs: [{ file: input, output, ...settings }] })).rejects.toThrow();
    expect(tool.accesses).toEqual([]);
  });

  it.each([
    { noiseProfile: { start: 0, end: 0.25 } },
    { track: 0 },
    { start: 0 },
    { end: 1 },
    { dryRun: true },
    { params: { Ratio: 1 } },
  ])('rejects scope, room-tone and arbitrary command overrides inside batch options %#', async (options) => {
    const tool = registeredBatch();
    await expect(tool.call({ jobs: [{ file: input, output, options }] })).rejects.toThrow();
    expect(tool.accesses).toEqual([]);
  });

  it.each([
    { removeClicks: true },
    { ratio: 0 },
    { attackMs: Number.NaN },
    { lufs: Number.POSITIVE_INFINITY },
    { preset: 'guessed' },
    { shortenPauses: { minimum: 0.2, truncateTo: 0.3 } },
  ])('rejects unsafe effects or invalid pipeline parameters for every job before Ops access %#', async (options) => {
    const tool = registeredBatch();
    await expect(
      tool.call({
        jobs: [
          { file: input, output },
          { file: secondInput, output: secondOutput, options },
        ],
      }),
    ).rejects.toThrow();
    expect(tool.accesses).toEqual([]);
  });

  it.each([{ jobs: [] }, { jobs: Array.from({ length: 51 }, () => ({ file: 'input.wav', output: 'output.wav' })) }])(
    'bounds the batch job count before Ops access %#',
    async ({ jobs }) => {
      const tool = registeredBatch();
      await expect(tool.call({ jobs })).rejects.toThrow();
      expect(tool.accesses).toEqual([]);
    },
  );
});
