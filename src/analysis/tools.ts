import { z } from 'zod';
import { SafeString } from '../catalogue.js';
import type { Ops } from '../ops.js';
import type { ToolRegistrar } from '../tools.js';
import { probeFile } from './executables.js';
import { LoudnessApplySchema, loudnessTarget } from './loudness.js';
import { measureFile } from './measurement.js';
import { MeasureOptionsShape, MeasureScopeSchema, MeasureScopeShape } from './options.js';
import { measureScope } from './render.js';
import { checkTargets, compareMeasurements, TARGETS, TargetSchema } from './targets.js';
import { round, SilenceSchema } from './types.js';

const Track = z.union([z.number().int().nonnegative(), SafeString.min(1)]);
const Seconds = z.number().finite().min(0).max(86400);

export function registerAnalysisTools(tool: ToolRegistrar, ops: Ops): void {
  tool(
    'audacity_loudness_target',
    'Measure then apply static gain to approach targetLufs while preserving measured true-peak headroom and respecting maxBoostDb. Requires ffmpeg and a non-silent audio track; default scope is its own extent. dryRun returns before measurement and the Amplify plan. Reports before/after and whether the target was achievable; it never compresses or guesses absent LUFS/true peak.',
    LoudnessApplySchema.shape,
    (args) => loudnessTarget(ops, args),
  );
  tool(
    'audacity_silence',
    'Find quiet regions without deleting audio: every channel must stay below thresholdDb for minimumSeconds. Scan an optional file, or rendered tracks/currentSelection with selection restored. Times are absolute project seconds for Audacity ranges and file seconds for files. Returns capped regions plus the total count; current mute/gain/envelopes affect rendered silence.',
    { file: SafeString.min(1).optional(), ...MeasureScopeShape, ...SilenceSchema.shape },
    async ({ file, thresholdDb, minimumSeconds, maxRegions, ...scope }) => {
      if (
        file !== undefined &&
        (scope.currentSelection || [scope.track, scope.trackCount, scope.start, scope.end].some((v) => v !== undefined))
      ) {
        throw new Error('file cannot be combined with Audacity track or time arguments');
      }
      const silence = { thresholdDb, minimumSeconds, maxRegions };
      const measured =
        file === undefined
          ? await measureScope(ops, scope, { backend: 'wav', silence })
          : await measureFile(file, { silence });
      const start = 'scope' in measured ? (measured.scope as { start: number }).start : 0;
      return {
        regions: measured.silenceGaps.map((gap) => ({
          ...gap,
          start: round(gap.start + start),
          end: round(gap.end + start),
        })),
        count: measured.silenceGapCount,
        truncated: measured.silenceGapCount > measured.silenceGaps.length,
        thresholdDb,
        minimumSeconds,
        ...(file !== undefined ? { file: measured.file } : { scope: 'scope' in measured ? measured.scope : undefined }),
        notes: measured.notes,
      };
    },
  );
  tool(
    'audacity_probe_file',
    'Inspect an audio/video file before importing or exporting: container, duration, audio codecs, sample rate, channels and stream metadata. Requires optional ffprobe (installed with ffmpeg); reads the file without changing Audacity.',
    { file: SafeString.min(1), timeoutMs: z.number().int().min(1000).max(120_000).default(30_000) },
    ({ file, timeoutMs }) => probeFile(file, timeoutMs),
    true,
  );
  tool(
    'audacity_measure',
    'Measure tracks, a time range, or currentSelection using a temporary export; restores selection and preserves track controls. Reports peak/RMS/DC/crest, advisory defects and silence. Optional ffmpeg adds integrated LUFS/LRA/true peak. Reads rendered gain/mute/solo/envelopes, so use file measurement for unprocessed source levels.',
    { ...MeasureScopeShape, ...MeasureOptionsShape, targets: TargetSchema.optional() },
    async ({ targets, backend, dualMono, timeoutMs, ...scope }) => {
      const measurement = await measureScope(ops, scope, { backend, dualMono, timeoutMs });
      return targets ? { measurement, targetCheck: checkTargets(measurement, targets) } : measurement;
    },
  );
  tool(
    'audacity_measure_file',
    'Measure an exported/source audio file without touching Audacity. Native PCM/float WAV peak/RMS/DC/crest and advisory defects need no dependencies; ffmpeg on PATH adds EBU R128 LUFS/LRA/true peak and decodes other containers. Unavailable targets report unknown.',
    { file: SafeString.min(1), ...MeasureOptionsShape, targets: TargetSchema.optional() },
    async ({ file, targets, ...options }) => {
      const measurement = await measureFile(file, options);
      return targets ? { measurement, targetCheck: checkTargets(measurement, targets) } : measurement;
    },
    true,
  );
  tool(
    'audacity_compare_files',
    'Compare before/after audio files with the same measurement settings. Returns both reports and numeric changes only for metrics established on both sides; missing LUFS or true peak never becomes a zero change.',
    { before: SafeString.min(1), after: SafeString.min(1), ...MeasureOptionsShape, targets: TargetSchema.optional() },
    async ({ before, after, targets, ...options }) => {
      const a = await measureFile(before, options);
      const b = await measureFile(after, options);
      return {
        before: a,
        after: b,
        delta: compareMeasurements(a, b),
        ...(targets ? { targetCheck: checkTargets(b, targets) } : {}),
      };
    },
    true,
  );
  tool(
    'audacity_targets',
    'List numeric house reference targets for podcast, video, broadcast, audiobook and premaster; use these with measurement targets. These references are not publishing certification. Recording noise floor requires isolated room tone.',
    {},
    async () => ({
      presets: TARGETS,
      note: 'All bounds must be measured to pass. Quiet-block RMS cannot certify a noise-floor target.',
    }),
    true,
  );
  tool(
    'audacity_contrast',
    'Measure the RMS level difference between foreground speech and background room tone without opening Audacity Contrast. Each range is exported with current track controls and selection restored. This is a numeric contrast check, not full accessibility certification.',
    {
      foreground: z.object({ track: Track, start: Seconds, end: Seconds }).strict(),
      background: z.object({ track: Track, start: Seconds, end: Seconds }).strict(),
      minimumDb: z.number().finite().min(0).max(100).default(20),
    },
    async ({ foreground, background, minimumDb }) => {
      // Both nested intervals must pass before the first temporary export.
      MeasureScopeSchema.parse(foreground);
      MeasureScopeSchema.parse(background);
      const foregroundIndex = await ops.trackIndex(foreground.track);
      const backgroundIndex = await ops.trackIndex(background.track);
      const tracks = await ops.tracks();
      if (tracks[foregroundIndex]?.kind !== 'wave' || tracks[backgroundIndex]?.kind !== 'wave')
        throw new Error('contrast ranges require audio tracks');
      const a = await measureScope(ops, foreground, { backend: 'wav' });
      const b = await measureScope(ops, background, { backend: 'wav' });
      const differenceDb = a.rmsDbfs === null || b.rmsDbfs === null ? null : round(a.rmsDbfs - b.rmsDbfs);
      return {
        foregroundRmsDbfs: a.rmsDbfs,
        backgroundRmsDbfs: b.rmsDbfs,
        differenceDb,
        minimumDb,
        status: differenceDb === null ? 'unknown' : differenceDb >= minimumDb ? 'met' : 'missed',
        ...(differenceDb === null ? { reason: 'A silent or empty range has no finite RMS level.' } : {}),
      };
    },
  );
}
