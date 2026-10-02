import { existsSync, statSync } from 'node:fs';
import { resolve } from 'node:path';
import { z } from 'zod';
import { SafeString } from './catalogue.js';
import { measureFile, measureScope, compareMeasurements, selectionTimes } from './analysis.js';
import { validateExportFile, type Ops } from './ops.js';
import { PipelineSchema, pipeline, planPipeline } from './tasks.js';
import type { ToolRegistrar } from './tools.js';

// Keep full pipeline validation, including its refinements, without exposing track/dryRun overrides.
const Options = z.object(Object.fromEntries(Object.entries(PipelineSchema.shape).filter(([key]) => !['track', 'start', 'end', 'dryRun', 'noiseProfile'].includes(key)))).strict();
export const BatchSchema = z.object({
  jobs: z.array(z.object({ file: SafeString.min(1), output: SafeString.min(1), options: Options.default({}) }).strict()).min(1).max(50),
  dryRun: z.boolean().default(false), measure: z.boolean().default(true), channels: z.number().int().min(1).max(2).default(2),
}).strict();

export function registerBatchTool(tool: ToolRegistrar, ops: Ops): void {
  tool('audacity_batch', 'Clean/master audio files in Audacity using isolated temporary tracks and the reviewed pipeline. Preflights all paths/steps, dryRun lists jobs, and original tracks stay intact. Stops at the first failure; completed outputs are retained. Optional before/after reports measure the rendered result. Current solo tracks are refused because they could silence temporary-track exports.',
    BatchSchema.shape, async (input) => {
      const args = BatchSchema.parse(input);
      const outputs = new Set<string>();
      const plans = args.jobs.map((job) => {
        if (!existsSync(job.file) || !statSync(job.file).isFile()) throw new Error(`${job.file} is not an existing audio file`);
        validateExportFile(job.output);
        const output = resolve(job.output).toLowerCase();
        if (outputs.has(output) || existsSync(job.output)) throw new Error(`${job.output} exists or is repeated; use new outputs`);
        if (resolve(job.file).toLowerCase() === output) throw new Error('batch output must differ from input');
        outputs.add(output);
        return { file: job.file, output: job.output, plan: planPipeline({ ...job.options, track: '(temporary imported track)', dryRun: true }) };
      });
      if (args.dryRun) return { dryRun: true, jobs: plans };
      const previous = await ops.tracks();
      if (previous.some((t) => t.solo)) throw new Error('clear track solo before batch; temporary exports must not be silenced by other tracks');
      const selection = selectionTimes(await ops.info('Selection'));
      const results: unknown[] = [];
      try {
        for (const job of args.jobs) {
          let imported: number | undefined;
          try {
            imported = (await ops.importTrack(job.file, 'Batch temporary')).track;
            const before = args.measure ? await measureScope(ops, { track: imported }) : undefined;
            const applied = await pipeline(ops, { ...job.options, track: imported });
            await ops.select({ track: imported });
            await ops.command('Export2', { Filename: job.output, NumChannels: args.channels }, 600_000);
            const after = args.measure ? await measureFile(job.output) : undefined;
            results.push({ file: job.file, output: job.output, applied, ...(before && after ? { before, after, delta: compareMeasurements(before, after) } : {}) });
          } catch (error) {
            throw new Error(`batch stopped on ${job.file} after ${results.length} completed jobs: ${(error as Error).message}`);
          } finally {
            if (imported !== undefined && !ops.pipe.needsRecovery) {
              await ops.command('SelectTracks', { Track: imported, TrackCount: 1, Mode: 'Set' }); await ops.run('RemoveTracks');
            }
          }
        }
      } finally {
        if (!ops.pipe.needsRecovery) {
          await ops.run('SelectNone');
          for (const [i, track] of previous.entries()) if (track.selected) await ops.command('SelectTracks', { Track: i, TrackCount: 1, Mode: 'Add' });
          await ops.command('SelectTime', { Start: selection.start, End: selection.end, RelativeTo: 'ProjectStart' });
        }
      }
      return { dryRun: false, completed: results.length, results };
    });
}
