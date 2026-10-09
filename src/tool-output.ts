import { z } from 'zod';
import { taskOutputs } from './tool-task-output.js';

const NumberValue = z.number().finite();
const MaybeNumber = NumberValue.nullable();
const Strings = z.array(z.string());
const JsonObject = z.record(z.string(), z.json());
export const TrackOutput = z
  .object({
    name: z.string(),
    kind: z.string(),
    start: NumberValue.optional(),
    end: NumberValue.optional(),
    volume: NumberValue.optional(),
    pan: NumberValue.optional(),
    mute: NumberValue.optional(),
    solo: NumberValue.optional(),
    channels: NumberValue.optional(),
    selected: NumberValue.optional(),
    focused: NumberValue.optional(),
  })
  .passthrough();
const ScopeOutput = z.object({ tracks: z.array(z.number().int().nonnegative()), start: NumberValue, end: NumberValue });
const Region = z.object({ start: NumberValue, end: NumberValue, duration: NumberValue });
const Channel = z.object({
  peak: NumberValue,
  peakDbfs: MaybeNumber,
  rms: NumberValue,
  rmsDbfs: MaybeNumber,
  dcOffset: NumberValue,
  clippedSamples: NumberValue,
  discontinuities: NumberValue,
});
const MeasurementShape = {
  duration: NumberValue,
  sampleRate: NumberValue,
  channels: NumberValue,
  frames: NumberValue,
  peak: NumberValue,
  peakDbfs: MaybeNumber,
  rms: NumberValue,
  rmsDbfs: MaybeNumber,
  crestDb: MaybeNumber,
  dcOffset: NumberValue,
  clippedSamples: NumberValue,
  discontinuities: NumberValue,
  silenceGaps: z.array(Region),
  silenceGapCount: NumberValue,
  quietRmsDbfsEstimate: MaybeNumber,
  dynamicRangeDbEstimate: MaybeNumber,
  perChannel: z.array(Channel),
  integratedLufs: MaybeNumber,
  truePeakDbtp: MaybeNumber,
  loudnessRangeLu: MaybeNumber,
  unavailable: z.record(z.string(), z.string()),
  notes: Strings,
  backend: z.string(),
  dualMono: z.boolean(),
  file: z.string().optional(),
  scope: ScopeOutput.optional(),
};
export const MeasurementOutput = z.object(MeasurementShape).passthrough();
const Bounds = z.object({ min: NumberValue.optional(), max: NumberValue.optional() }).passthrough();
const TargetCheck = z
  .object({
    status: z.enum(['met', 'missed', 'unknown']),
    checks: z.record(
      z.string(),
      z
        .object({
          status: z.enum(['met', 'missed', 'unknown']),
          actual: MaybeNumber,
          target: Bounds,
          reason: z.string().optional(),
          gap: NumberValue.optional(),
        })
        .passthrough(),
    ),
  })
  .passthrough();
// Existing measurement tools return a flat report, or {measurement,targetCheck}
// when targets are supplied. Keep both shapes without an incompatible envelope.
const MeasurementReport = z
  .object(MeasurementShape)
  .partial()
  .extend({ measurement: MeasurementOutput.optional(), targetCheck: TargetCheck.optional() })
  .passthrough()
  .superRefine((value, ctx) => {
    if (value.measurement === undefined && !MeasurementOutput.safeParse(value).success) {
      ctx.addIssue({ code: 'custom', message: 'expected a measurement report' });
    }
  });
const Delta = z.record(z.string(), z.object({ before: NumberValue, after: NumberValue, change: NumberValue }));
const outputs: Record<string, z.ZodType> = {
  audacity_status: z.object({ running: z.boolean(), tracks: z.array(TrackOutput).optional() }).passthrough(),
  audacity_track_set: TrackOutput,
  audacity_project_info: z
    .object({
      tracks: z.array(TrackOutput),
      clips: z.json(),
      selection: z.json(),
      lengthSeconds: NumberValue,
      rate: MaybeNumber,
      defaultRate: NumberValue,
      activeProjectFiles: Strings,
      fileSource: z.string(),
    })
    .passthrough(),
  audacity_describe: z
    .object({
      id: z.string(),
      name: z.string(),
      url: z.string().optional(),
      tip: z.string().optional(),
      params: z.array(
        z
          .object({
            key: z.string(),
            type: z.string(),
            default: z.json().optional(),
            enum: Strings.optional(),
            minimum: NumberValue.optional(),
            maximum: NumberValue.optional(),
          })
          .passthrough(),
      ),
    })
    .passthrough(),
  audacity_measure: MeasurementReport,
  audacity_measure_file: MeasurementReport,
  audacity_compare_files: z
    .object({ before: MeasurementOutput, after: MeasurementOutput, delta: Delta, targetCheck: TargetCheck.optional() })
    .passthrough(),
  audacity_probe_file: z.object({ file: z.string(), format: JsonObject, streams: z.array(JsonObject) }).passthrough(),
  audacity_silence: z
    .object({
      regions: z.array(Region),
      count: NumberValue,
      truncated: z.boolean(),
      thresholdDb: NumberValue,
      minimumSeconds: NumberValue,
      file: z.string().optional(),
      scope: ScopeOutput.optional(),
      notes: Strings,
    })
    .passthrough(),
  audacity_contrast: z
    .object({
      foregroundRmsDbfs: MaybeNumber,
      backgroundRmsDbfs: MaybeNumber,
      differenceDb: MaybeNumber,
      minimumDb: NumberValue,
      status: z.enum(['met', 'missed', 'unknown']),
      reason: z.string().optional(),
    })
    .passthrough(),
  audacity_targets: z
    .object({ presets: z.record(z.string(), z.record(z.string(), Bounds)), note: z.string() })
    .passthrough(),
  audacity_loudness_target: z
    .object({
      dryRun: z.boolean(),
      before: MeasurementOutput,
      after: MeasurementOutput.optional(),
      plan: JsonObject,
      steps: z.array(JsonObject),
      targetCheck: TargetCheck.optional(),
      samplePeakDbfs: MaybeNumber.optional(),
      clippedSamples: NumberValue.optional(),
      notes: Strings.optional(),
    })
    .passthrough(),
};

export function outputSchema(name: string): z.ZodType | undefined {
  return outputs[name] ?? taskOutputs[name];
}
