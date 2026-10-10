import { readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it, vi } from 'vitest';
import {
  directory,
  input,
  output,
  registeredBatch,
  secondInput,
  secondOutput,
  useBatchFiles,
} from './helpers/batch-fixture.js';

vi.mock('../src/source-rate.js', () => ({ measureSourceRate: vi.fn(async () => 48_000) }));

useBatchFiles();

describe('batch path preflight', () => {
  it('preflights later missing inputs before examining or mutating Audacity', async () => {
    const tool = registeredBatch();
    await expect(
      tool.call({
        jobs: [
          { file: input, output },
          { file: join(directory, 'missing.wav'), output: secondOutput },
        ],
      }),
    ).rejects.toThrow(/does not exist|not an existing audio file/);
    expect(tool.accesses).toEqual([]);
  });

  it('refuses a later project or list input before the first job reaches Audacity', async () => {
    const project = join(directory, 'later.aup3');
    writeFileSync(project, 'project fixture');
    const tool = registeredBatch();
    await expect(
      tool.call({
        jobs: [
          { file: input, output },
          { file: project, output: secondOutput },
        ],
      }),
    ).rejects.toThrow('imports audio');
    expect(tool.accesses).toEqual([]);
  });

  it('refuses a directory as a source before Ops access', async () => {
    const tool = registeredBatch();
    await expect(tool.call({ jobs: [{ file: directory, output }] })).rejects.toThrow(
      /not an existing audio file|not a regular file/,
    );
    expect(tool.accesses).toEqual([]);
  });

  it('refuses an existing output without altering source or destination files', async () => {
    writeFileSync(secondOutput, 'existing destination fixture');
    const tool = registeredBatch();
    await expect(
      tool.call({
        jobs: [
          { file: input, output },
          { file: secondInput, output: secondOutput },
        ],
      }),
    ).rejects.toThrow('use new outputs');
    expect(tool.accesses).toEqual([]);
    expect(readFileSync(input, 'utf8')).toBe('first source fixture');
    expect(readFileSync(secondOutput, 'utf8')).toBe('existing destination fixture');
  });

  it('refuses overwriting an input file before Ops access', async () => {
    const tool = registeredBatch();
    await expect(tool.call({ jobs: [{ file: input, output: input }] })).rejects.toThrow(
      /exists|must differ from input/,
    );
    expect(tool.accesses).toEqual([]);
  });

  it('refuses a job overwriting another job input before Ops access', async () => {
    const tool = registeredBatch();
    await expect(
      tool.call({
        jobs: [
          { file: input, output: secondInput },
          { file: secondInput, output },
        ],
      }),
    ).rejects.toThrow('use new outputs');
    expect(tool.accesses).toEqual([]);
  });

  it.each(['identical', 'normalized', 'case variant'])(
    'refuses %s duplicate output paths before Ops access',
    async (variation) => {
      const repeated =
        variation === 'normalized'
          ? `${directory}/unused/../output.wav`
          : variation === 'case variant'
            ? join(directory, 'OUTPUT.wav')
            : output;
      const tool = registeredBatch();
      await expect(
        tool.call({
          jobs: [
            { file: input, output },
            { file: secondInput, output: repeated },
          ],
        }),
      ).rejects.toThrow('use new outputs');
      expect(tool.accesses).toEqual([]);
    },
  );

  it.each(['output.opus', 'output.txt', 'missing/output.wav'])(
    'refuses an unsupported or unavailable destination %s before Ops access',
    async (destination) => {
      const tool = registeredBatch();
      await expect(tool.call({ jobs: [{ file: input, output: join(directory, destination) }] })).rejects.toThrow();
      expect(tool.accesses).toEqual([]);
    },
  );
});

describe('batch dry-run', () => {
  it('plans every job with the right step count and zero Ops calls', async () => {
    const tool = registeredBatch();
    const result = (await tool.call({
      dryRun: true,
      jobs: [
        { file: input, output, options: { preset: 'voice' } },
        { file: secondInput, output: secondOutput, options: { preset: 'lofi', loudness: 'peak' } },
      ],
    })) as {
      dryRun: boolean;
      jobs: {
        file: string;
        output: string;
        plan: { preset: string; steps: { command: string; scope: { track: string } }[] };
      }[];
    };
    expect(result.dryRun).toBe(true);
    expect(result.jobs).toHaveLength(2);
    expect(result.jobs.map((job) => job.plan.steps.length)).toEqual([3, 6]);
    expect(result.jobs.map((job) => job.plan.preset)).toEqual(['voice', 'lofi']);
    expect(result.jobs.map((job) => [job.file, job.output])).toEqual([
      [input, output],
      [secondInput, secondOutput],
    ]);
    expect(
      result.jobs.every((job) => job.plan.steps.every((step) => step.scope.track === '(temporary imported track)')),
    ).toBe(true);
    expect(tool.accesses).toEqual([]);
  });

  it('uses reviewed default processing options when a job omits options', async () => {
    const tool = registeredBatch();
    const result = (await tool.call({ dryRun: true, jobs: [{ file: input, output }] })) as {
      jobs: { plan: { preset: string; steps: { command: string }[] } }[];
    };
    expect(result.jobs[0]!.plan.preset).toBe('voice');
    expect(result.jobs[0]!.plan.steps.map((step) => step.command)).toEqual([
      'Normalize',
      'High-passFilter',
      'Compressor',
    ]);
    expect(tool.accesses).toEqual([]);
  });

  it('reports that timing edits require an empty project without touching Audacity', async () => {
    const tool = registeredBatch();
    expect(
      await tool.call({ dryRun: true, jobs: [{ file: input, output, options: { shortenPauses: {} } }] }),
    ).toMatchObject({ requiresEmptyProject: true, notes: expect.any(Array) });
    expect(tool.accesses).toEqual([]);
  });
});
