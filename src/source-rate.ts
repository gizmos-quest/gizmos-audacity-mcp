import { mkdtemp, open, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, resolve, sep } from 'node:path';
import { z } from 'zod';
import { selectionTimes } from './analysis/render.js';
import { withCleanupFailure } from './errors.js';
import { catalogueCommand } from './format.js';
import type { Ops } from './ops.js';
import { Seconds } from './tool-input.js';

const HEADER_BYTES = 4096;
const MAX_OUTPUT_BYTES = 65_536;
const SourceScope = z
  .object({
    track: z.number().int().nonnegative(),
    start: Seconds,
    end: Seconds,
  })
  .strict()
  .refine((scope) => scope.end > scope.start, 'source measurement needs a non-empty interval');

/** Read the English header produced by the installed Sample Data Export tool. */
export function parseSampleDataRate(header: string): number {
  z.string().max(HEADER_BYTES).parse(header);
  const matches = [...header.matchAll(/^Sample Rate:[ \t]+([0-9]+)[ \t]+Hz\.(?:[ \t].*)?\r?$/gm)];
  if (matches.length !== 1) throw new Error('Sample Data Export returned no unambiguous source sample rate');
  const rate = Number(matches[0]![1]);
  if (!Number.isSafeInteger(rate) || rate < 1 || rate > 768_000)
    throw new Error('source sample rate must be an integer from 1 to 768000 Hz');
  return rate;
}

async function readRate(file: string): Promise<number> {
  const handle = await open(file, 'r');
  try {
    const stat = await handle.stat();
    if (!stat.isFile() || stat.size <= 0 || stat.size > MAX_OUTPUT_BYTES)
      throw new Error('Sample Data Export output must be a non-empty regular file of at most 65536 bytes');
    const buffer = Buffer.alloc(Math.min(HEADER_BYTES, stat.size));
    const { bytesRead } = await handle.read(buffer, 0, buffer.length, 0);
    return parseSampleDataRate(buffer.subarray(0, bytesRead).toString('utf8'));
  } finally {
    await handle.close();
  }
}

/** Query the native source-track rate, which can differ from a project-rate WAV render. */
export async function measureSourceRate(ops: Ops, input: z.input<typeof SourceScope>): Promise<number> {
  const scope = SourceScope.parse(input);
  const tracks = await ops.tracks();
  const target = tracks[scope.track];
  if (
    target?.kind !== 'wave' ||
    !Number.isFinite(target.start) ||
    !Number.isFinite(target.end) ||
    target.start < 0 ||
    !(target.end > target.start) ||
    scope.start < target.start ||
    scope.end > target.end
  ) {
    throw new Error('source measurement needs an interval inside one audio track');
  }
  const previous = selectionTimes(await ops.info('Selection'));
  const selected = tracks.flatMap((track, index) => (track.selected ? [index] : []));
  const focused = tracks.findIndex((track) => track.focused);
  const directory = await mkdtemp(join(tmpdir(), 'gizmos-audacity-source-rate-'));
  let operationError: unknown;
  try {
    const file = join(directory, 'source-rate.txt');
    const params = {
      NUMBER: 1,
      UNITS: 'Linear',
      FILENAME: file,
      FILEFORMAT: 'None',
      HEADER: 'Standard',
      OPTEXT: '',
      'CHANNEL-LAYOUT': 'SameLine',
      MESSAGES: 'None',
    };
    catalogueCommand('SampleDataExport', params); // Bound path bytes before selection.
    // Full track extent contains at least one source sample even when the
    // requested profile interval is shorter than one sample at a low rate.
    await ops.select({ track: scope.track, start: target.start, end: target.end });
    // Official 3.7.8 sample-data-export.ny puts *sound-srate* in the header;
    // NyquistBase::ProcessOne receives the selected WaveTrack's source rate.
    // Live 3.7.8, 2026-10-02: 8 kHz and 48 kHz sources rendered in a 48 kHz
    // project report their own source rates in this silent one-sample header.
    // One sample, a text header, and MESSAGES=None avoid result/error dialogs.
    // This internal full-track query is the source-rate proof used by public
    // analyzer guards. run validates the fixed catalogue fields and bytes;
    // using generic command here would recursively query its own source rate.
    await ops.run('SampleDataExport', params);
    return await readRate(file);
  } catch (error) {
    operationError = error;
    throw error;
  } finally {
    let restorationError: unknown;
    try {
      // SampleDataExport focuses its source track. SetTrackStatus acts on
      // selected tracks; Focused=false only clears an already-focused target.
      // Restore focus before sparse selection, including an originally
      // focused track that was not selected. No unlisted setter scope keys.
      if (!ops.pipe?.needsRecovery) {
        await ops.command('SelectTracks', { Track: focused >= 0 ? focused : scope.track, TrackCount: 1, Mode: 'Set' });
        await ops.command('SetTrackStatus', { Focused: focused >= 0 });
        await ops.run('SelectNone');
        for (const track of selected) await ops.command('SelectTracks', { Track: track, TrackCount: 1, Mode: 'Add' });
        await ops.command('SelectTime', { Start: previous.start, End: previous.end, RelativeTo: 'ProjectStart' });
      }
    } catch (restoreError) {
      restorationError = withCleanupFailure(restoreError, operationError, 'Selection restoration');
      // biome-ignore lint/correctness/noUnsafeFinally: A failed restoration must replace success and retain the original failure context.
      throw restorationError;
    } finally {
      const scratch = resolve(directory);
      if (!scratch.startsWith(resolve(tmpdir()) + sep) || !scratch.includes('gizmos-audacity-source-rate-')) {
        // biome-ignore lint/correctness/noUnsafeFinally: Cleanup path containment overrides any successful return to prevent unsafe deletion.
        throw new Error(`refusing unsafe source-rate scratch cleanup: ${scratch}`);
      }
      if (ops.pipe?.needsRecovery) {
        // A blocked SampleDataExport may still create its output after the
        // client times out. Keep its directory and avoid further pipe edits.
        const error = restorationError ?? operationError;
        if (error instanceof Error)
          error.message += `. Selection restoration is incomplete; scratch retained for inspection after audacity_recover: ${scratch}`;
      } else await rm(scratch, { recursive: true, force: true });
    }
  }
}

/** Count source-track frames using the same strict scope and silent native query. */
export async function measureSourceFrames(ops: Ops, input: z.input<typeof SourceScope>): Promise<number> {
  const scope = SourceScope.parse(input);
  return Math.floor((scope.end - scope.start) * (await measureSourceRate(ops, scope)));
}
