import { existsSync, statSync } from 'node:fs';
import { resolve } from 'node:path';
import { z } from 'zod';
import { compareMeasurements, measureFile, measureScope, selectionTimes } from './analysis.js';
import { SafeString } from './catalogue.js';
import { catalogueCommand } from './format.js';
import { errorWithContext, type Ops, validateExportFile } from './ops.js';
import { PipelineSchema, pipeline, planPipeline } from './tasks.js';
import type { ToolRegistrar } from './tools.js';

// Keep full pipeline validation, including its refinements, without exposing track/dryRun overrides.
const Options = z
  .object(
    Object.fromEntries(
      Object.entries(PipelineSchema.shape).filter(
        ([key]) => !['track', 'start', 'end', 'dryRun', 'noiseProfile'].includes(key),
      ),
    ),
  )
  .strict();
export const BatchSchema = z
  .object({
    jobs: z
      .array(z.object({ file: SafeString.min(1), output: SafeString.min(1), options: Options.default({}) }).strict())
      .min(1)
      .max(50),
    dryRun: z.boolean().default(false),
    measure: z.boolean().default(true),
    channels: z.number().int().min(1).max(2).default(2),
  })
  .strict();

export function registerBatchTool(tool: ToolRegistrar, ops: Ops): void {
  tool(
    'audacity_batch',
    'Clean/master audio files in Audacity using isolated temporary tracks and the reviewed pipeline. Preflights all paths/steps, dryRun lists jobs, and original tracks stay intact. Pause shortening requires an empty project because sync-lock may shift other tracks. Stops at the first failure; completed outputs are retained. Optional before/after reports measure the rendered result. Current solo tracks are refused because they could silence temporary-track exports.',
    BatchSchema.shape,
    async (input, progress) => {
      const args = BatchSchema.parse(input);
      const outputs = new Set<string>();
      const plans = args.jobs.map((job) => {
        if (!existsSync(job.file) || !statSync(job.file).isFile())
          throw new Error(`${job.file} is not an existing audio file`);
        validateExportFile(job.output);
        catalogueCommand('Import2', { Filename: job.file });
        catalogueCommand('Export2', { Filename: job.output, NumChannels: args.channels });
        const output = resolve(job.output).toLowerCase();
        if (outputs.has(output) || existsSync(job.output))
          throw new Error(`${job.output} exists or is repeated; use new outputs`);
        if (resolve(job.file).toLowerCase() === output) throw new Error('batch output must differ from input');
        outputs.add(output);
        return {
          file: job.file,
          output: job.output,
          plan: planPipeline({ ...job.options, track: '(temporary imported track)', dryRun: true }),
        };
      });
      const requiresEmptyProject = args.jobs.some((job) => job.options.shortenPauses !== undefined);
      if (args.dryRun)
        return {
          dryRun: true,
          jobs: plans,
          requiresEmptyProject,
          ...(requiresEmptyProject
            ? {
                notes: [
                  'Pause shortening requires an empty project; sync-lock can shift existing tracks. Use audacity_fresh with backupTo before processing.',
                ],
              }
            : {}),
        };
      const previous = await ops.tracks();
      if (requiresEmptyProject && previous.length)
        throw new Error(
          'batch pause shortening requires an empty project because sync-lock can shift existing tracks; use audacity_fresh with backupTo first',
        );
      if (previous.some((t) => t.solo))
        throw new Error('clear track solo before batch; temporary exports must not be silenced by other tracks');
      const selection = selectionTimes(await ops.info('Selection'));
      const results: unknown[] = [];
      let operationError: unknown;
      try {
        for (const job of args.jobs) {
          await progress?.(
            results.length,
            args.jobs.length,
            `Processing file ${results.length + 1} of ${args.jobs.length}`,
          );
          const firstTemporary = (await ops.tracks()).length;
          let jobError: unknown;
          try {
            const imported = (await ops.importTrack(job.file, 'Batch temporary')).track;
            const before = args.measure ? await measureScope(ops, { track: imported }) : undefined;
            const applied = await pipeline(ops, { ...job.options, track: imported });
            await ops.select({ track: imported });
            await ops.command('Export2', { Filename: job.output, NumChannels: args.channels }, 600_000);
            const after = args.measure ? await measureFile(job.output) : undefined;
            results.push({
              file: job.file,
              output: job.output,
              applied,
              ...(before && after ? { before, after, delta: compareMeasurements(before, after) } : {}),
            });
            await progress?.(
              results.length,
              args.jobs.length,
              `Completed file ${results.length} of ${args.jobs.length}`,
            );
          } catch (error) {
            jobError = errorWithContext(
              error,
              `batch stopped on ${job.file} after ${results.length} completed jobs: ${error instanceof Error ? error.message : String(error)}`,
            );
            throw jobError;
          } finally {
            try {
              if (!ops.pipe.needsRecovery) {
                // A multi-stream Import2 can add several tracks before the
                // single-track helper refuses it. Remove every known temporary
                // track after a certain reply, including a failed pipeline.
                const temporaryCount = (await ops.tracks()).length - firstTemporary;
                if (temporaryCount > 0) {
                  await ops.command('SelectTracks', { Track: firstTemporary, TrackCount: temporaryCount, Mode: 'Set' });
                  await ops.run('RemoveTracks');
                }
              }
            } catch (error) {
              if (jobError !== undefined)
                // biome-ignore lint/correctness/noUnsafeFinally: A failed restoration must replace success and retain the original failure context.
                throw errorWithContext(
                  error,
                  `${(jobError as Error).message}. Temporary-track cleanup also failed: ${error instanceof Error ? error.message : String(error)}`,
                );
              // biome-ignore lint/correctness/noUnsafeFinally: A failed restoration must replace success and retain the original failure context.
              throw error;
            }
          }
        }
      } catch (error) {
        operationError = error;
        throw error;
      } finally {
        try {
          if (!ops.pipe.needsRecovery) {
            const focused = previous.findIndex((track) => track.focused);
            const currentFocus = focused >= 0 ? focused : (await ops.tracks()).findIndex((track) => track.focused);
            if (currentFocus >= 0) {
              await ops.command('SelectTracks', { Track: currentFocus, TrackCount: 1, Mode: 'Set' });
              await ops.command('SetTrackStatus', { Focused: focused >= 0 });
            }
            await ops.run('SelectNone');
            for (const [i, track] of previous.entries())
              if (track.selected) await ops.command('SelectTracks', { Track: i, TrackCount: 1, Mode: 'Add' });
            await ops.command('SelectTime', { Start: selection.start, End: selection.end, RelativeTo: 'ProjectStart' });
          }
        } catch (error) {
          if (operationError !== undefined)
            // biome-ignore lint/correctness/noUnsafeFinally: A failed restoration must replace success and retain the original failure context.
            throw errorWithContext(
              error,
              `${operationError instanceof Error ? operationError.message : String(operationError)}. Selection restoration also failed: ${error instanceof Error ? error.message : String(error)}`,
            );
          // biome-ignore lint/correctness/noUnsafeFinally: A failed restoration must replace success and retain the original failure context.
          throw error;
        }
      }
      return { dryRun: false, completed: results.length, results };
    },
  );
}
