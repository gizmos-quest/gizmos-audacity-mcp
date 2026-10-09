import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { isAbsolute, join, relative, resolve } from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { z } from 'zod';
import { BatchSchema, registerBatchTool } from '../src/batch.js';
import type { Ops } from '../src/ops.js';
import type { ToolRegistrar } from '../src/tools.js';

vi.mock('../src/source-rate.js', () => ({ measureSourceRate: vi.fn(async () => 48_000) }));

let directory: string;
let input: string;
let secondInput: string;
let output: string;
let secondOutput: string;

beforeEach(() => {
  directory = mkdtempSync(join(tmpdir(), 'gizmos-audacity-batch-unit-'));
  input = join(directory, 'input.wav');
  secondInput = join(directory, 'second.wav');
  output = join(directory, 'output.wav');
  secondOutput = join(directory, 'second-output.wav');
  // File preflight does not decode audio; rendering belongs to live tests.
  writeFileSync(input, 'first source fixture');
  writeFileSync(secondInput, 'second source fixture');
});

afterEach(() => {
  const descendant = relative(resolve(tmpdir()), resolve(directory));
  if (
    !descendant ||
    descendant.startsWith('..') ||
    isAbsolute(descendant) ||
    !descendant.startsWith('gizmos-audacity-batch-unit-')
  ) {
    throw new Error('refusing to remove a batch fixture outside the expected temporary directory');
  }
  rmSync(directory, { recursive: true, force: true });
});

/** Exercise the same strict shape registration and handler validation as the server. */
function registeredBatch() {
  const accesses: string[] = [];
  const ops = new Proxy(
    {},
    {
      get: (_target, key) => {
        accesses.push(String(key));
        throw new Error(`batch touched Ops.${String(key)} before preflight completed`);
      },
    },
  ) as Ops;
  let name: string | undefined;
  let schema: z.ZodType | undefined;
  let handler: ((args: unknown) => Promise<unknown>) | undefined;
  const register: ToolRegistrar = (toolName, _description, shape, action) => {
    if (name) throw new Error('batch registered more than one tool');
    name = toolName;
    schema = z.object(shape).strict();
    handler = action as (args: unknown) => Promise<unknown>;
  };
  registerBatchTool(register, ops);
  return { accesses, name, schema: schema!, call: async (args: unknown) => handler!(schema!.parse(args)) };
}

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
