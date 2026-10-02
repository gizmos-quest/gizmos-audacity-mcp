import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { isAbsolute, join, relative, resolve } from 'node:path';
import { z } from 'zod';
import { BatchSchema, registerBatchTool } from '../src/batch.js';
import type { Ops } from '../src/ops.js';
import type { ToolRegistrar } from '../src/tools.js';

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
  if (!descendant || descendant.startsWith('..') || isAbsolute(descendant) || !descendant.startsWith('gizmos-audacity-batch-unit-')) {
    throw new Error('refusing to remove a batch fixture outside the expected temporary directory');
  }
  rmSync(directory, { recursive: true, force: true });
});

/** Exercise the same strict shape registration and handler validation as the server. */
function registeredBatch() {
  const accesses: string[] = [];
  const ops = new Proxy({}, { get: (_target, key) => {
    accesses.push(String(key));
    throw new Error(`batch touched Ops.${String(key)} before preflight completed`);
  } }) as Ops;
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
  return { accesses, name, schema: schema!,
    call: async (args: unknown) => handler!(schema!.parse(args)) };
}

describe('batch strict registration', () => {
  it('registers audacity_batch with the complete strict public schema', () => {
    const tool = registeredBatch();
    expect(tool.name).toBe('audacity_batch');
    const args = { jobs: [{ file: input, output }], dryRun: true };
    expect(tool.schema.parse(args)).toEqual(BatchSchema.parse(args));
    expect(tool.accesses).toEqual([]);
  });

  it.each([
    { unknown: true }, { channels: 0 }, { channels: 3 }, { channels: 1.5 }, { dryRun: 'true' }, { measure: 1 },
  ])('rejects unknown or invalid root settings before Ops access %#', async (settings) => {
    const tool = registeredBatch();
    await expect(tool.call({ jobs: [{ file: input, output }], ...settings })).rejects.toThrow();
    expect(tool.accesses).toEqual([]);
  });

  it.each([
    { typo: true }, { file: 'bad"path.wav' }, { output: 'bad\npath.wav' }, { options: { typo: true } },
    { options: { shortenPauses: { minimum: 1, typo: true } } },
  ])('rejects unknown or unsafe nested job values before Ops access %#', async (settings) => {
    const tool = registeredBatch();
    await expect(tool.call({ jobs: [{ file: input, output, ...settings }] })).rejects.toThrow();
    expect(tool.accesses).toEqual([]);
  });

  it.each([
    { noiseProfile: { start: 0, end: 0.25 } }, { track: 0 }, { start: 0 }, { end: 1 }, { dryRun: true }, { params: { Ratio: 1 } },
  ])('rejects scope, room-tone and arbitrary command overrides inside batch options %#', async (options) => {
    const tool = registeredBatch();
    await expect(tool.call({ jobs: [{ file: input, output, options }] })).rejects.toThrow();
    expect(tool.accesses).toEqual([]);
  });

  it.each([
    { removeClicks: true }, { ratio: 0 }, { attackMs: Number.NaN }, { lufs: Number.POSITIVE_INFINITY },
    { preset: 'guessed' }, { shortenPauses: { minimum: 0.2, truncateTo: 0.3 } },
  ])('rejects unsafe effects or invalid pipeline parameters for every job before Ops access %#', async (options) => {
    const tool = registeredBatch();
    await expect(tool.call({ jobs: [{ file: input, output }, { file: secondInput, output: secondOutput, options }] })).rejects.toThrow();
    expect(tool.accesses).toEqual([]);
  });

  it.each([{ jobs: [] }, { jobs: Array.from({ length: 51 }, () => ({ file: 'input.wav', output: 'output.wav' })) }])('bounds the batch job count before Ops access %#', async ({ jobs }) => {
    const tool = registeredBatch();
    await expect(tool.call({ jobs })).rejects.toThrow();
    expect(tool.accesses).toEqual([]);
  });
});

describe('batch path preflight', () => {
  it('preflights later missing inputs before examining or mutating Audacity', async () => {
    const tool = registeredBatch();
    await expect(tool.call({ jobs: [
      { file: input, output }, { file: join(directory, 'missing.wav'), output: secondOutput },
    ] })).rejects.toThrow(/does not exist|not an existing audio file/);
    expect(tool.accesses).toEqual([]);
  });

  it('refuses a directory as a source before Ops access', async () => {
    const tool = registeredBatch();
    await expect(tool.call({ jobs: [{ file: directory, output }] })).rejects.toThrow(/not an existing audio file|not a regular file/);
    expect(tool.accesses).toEqual([]);
  });

  it('refuses an existing output without altering source or destination files', async () => {
    writeFileSync(secondOutput, 'existing destination fixture');
    const tool = registeredBatch();
    await expect(tool.call({ jobs: [{ file: input, output }, { file: secondInput, output: secondOutput }] })).rejects.toThrow('use new outputs');
    expect(tool.accesses).toEqual([]);
    expect(readFileSync(input, 'utf8')).toBe('first source fixture');
    expect(readFileSync(secondOutput, 'utf8')).toBe('existing destination fixture');
  });

  it('refuses overwriting an input file before Ops access', async () => {
    const tool = registeredBatch();
    await expect(tool.call({ jobs: [{ file: input, output: input }] })).rejects.toThrow(/exists|must differ from input/);
    expect(tool.accesses).toEqual([]);
  });

  it('refuses a job overwriting another job input before Ops access', async () => {
    const tool = registeredBatch();
    await expect(tool.call({ jobs: [{ file: input, output: secondInput }, { file: secondInput, output }] })).rejects.toThrow('use new outputs');
    expect(tool.accesses).toEqual([]);
  });

  it.each(['identical', 'normalized', 'case variant'])('refuses %s duplicate output paths before Ops access', async (variation) => {
    const repeated = variation === 'normalized' ? `${directory}/unused/../output.wav`
      : variation === 'case variant' ? join(directory, 'OUTPUT.wav') : output;
    const tool = registeredBatch();
    await expect(tool.call({ jobs: [{ file: input, output }, { file: secondInput, output: repeated }] })).rejects.toThrow('use new outputs');
    expect(tool.accesses).toEqual([]);
  });

  it.each(['output.opus', 'output.txt', 'missing/output.wav'])('refuses an unsupported or unavailable destination %s before Ops access', async (destination) => {
    const tool = registeredBatch();
    await expect(tool.call({ jobs: [{ file: input, output: join(directory, destination) }] })).rejects.toThrow();
    expect(tool.accesses).toEqual([]);
  });
});

describe('batch dry-run', () => {
  it('plans every job with the right step count and zero Ops calls', async () => {
    const tool = registeredBatch();
    const result = await tool.call({ dryRun: true, jobs: [
      { file: input, output, options: { preset: 'voice' } },
      { file: secondInput, output: secondOutput, options: { preset: 'lofi', loudness: 'peak' } },
    ] }) as { dryRun: boolean; jobs: { file: string; output: string; plan: { preset: string; steps: { command: string; scope: { track: string } }[] } }[] };
    expect(result.dryRun).toBe(true);
    expect(result.jobs).toHaveLength(2);
    expect(result.jobs.map((job) => job.plan.steps.length)).toEqual([3, 6]);
    expect(result.jobs.map((job) => job.plan.preset)).toEqual(['voice', 'lofi']);
    expect(result.jobs.map((job) => [job.file, job.output])).toEqual([[input, output], [secondInput, secondOutput]]);
    expect(result.jobs.every((job) => job.plan.steps.every((step) => step.scope.track === '(temporary imported track)'))).toBe(true);
    expect(tool.accesses).toEqual([]);
  });

  it('uses reviewed default processing options when a job omits options', async () => {
    const tool = registeredBatch();
    const result = await tool.call({ dryRun: true, jobs: [{ file: input, output }] }) as { jobs: { plan: { preset: string; steps: { command: string }[] } }[] };
    expect(result.jobs[0]!.plan.preset).toBe('voice');
    expect(result.jobs[0]!.plan.steps.map((step) => step.command)).toEqual(['Normalize', 'High-passFilter', 'Compressor']);
    expect(tool.accesses).toEqual([]);
  });
});
