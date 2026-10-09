import { z } from 'zod';

const NumberValue = z.number().finite();
const JsonObject = z.record(z.string(), z.json());
const Strings = z.array(z.string());
const Track = z.object({ name: z.string(), kind: z.string() }).passthrough();
const Window = z
  .object({ title: z.string(), dialog: z.boolean(), closed: z.boolean(), visible: z.boolean() })
  .passthrough();
const Process = z
  .object({
    pid: NumberValue,
    executable: z.string().nullable(),
    fileVersion: z.string().nullable(),
    productVersion: z.string().nullable(),
  })
  .passthrough();
const Launch = { started: z.boolean(), visible: z.boolean(), processes: z.array(Process) };
const Scope = z
  .object({
    track: z.union([NumberValue, z.string()]),
    trackCount: NumberValue.optional(),
    start: NumberValue.optional(),
    end: NumberValue.optional(),
  })
  .passthrough();
const Step = z
  .object({
    name: z.string().optional(),
    command: z.string(),
    params: JsonObject,
    scope: Scope,
    captureProfile: z.literal(true).optional(),
  })
  .passthrough();
const Plan = { preset: z.string(), steps: z.array(Step), notes: Strings };

/** Schemas preserve existing action variants and add no result envelope. */
export const taskOutputs: Record<string, z.ZodType> = {
  audacity_launch: z.object(Launch).passthrough(),
  audacity_fresh: z.object({ ...Launch, backedUpTo: z.string().nullable() }).passthrough(),
  audacity_quit: z.object({ savedTo: z.string().optional() }).passthrough(),
  audacity_window: z.object({ windows: NumberValue }).passthrough(),
  audacity_dialogs: z.object({ windows: z.array(Window) }).passthrough(),
  audacity_import: z.object({ track: NumberValue, name: z.string() }).passthrough(),
  audacity_envelope_set: z.object({ points: NumberValue }).passthrough(),
  audacity_labels_set: z.object({ labels: NumberValue }).passthrough(),
  audacity_export: z.object({ file: z.string() }).passthrough(),
  audacity_pipeline: z.object({ dryRun: z.boolean(), ...Plan, applied: Strings.optional() }).passthrough(),
  audacity_edit: z
    .object({ action: z.string(), track: NumberValue, start: NumberValue, end: NumberValue, reply: z.string() })
    .passthrough(),
  audacity_generate: z
    .object({ kind: z.string(), track: NumberValue, start: NumberValue, end: NumberValue, name: z.string().optional() })
    .passthrough(),
  audacity_clip_set: z
    .object({
      track: NumberValue,
      start: NumberValue,
      end: NumberValue,
      name: z.string().optional(),
      gainDbApplied: NumberValue.optional(),
      color: z.string().optional(),
    })
    .passthrough(),
  audacity_track_edit: z
    .object({
      track: NumberValue.optional(),
      action: z.string().optional(),
      reply: z.string().optional(),
      tracks: z.array(Track),
    })
    .passthrough(),
  audacity_fade: z
    .object({ track: NumberValue, start: NumberValue, end: NumberValue, direction: z.enum(['in', 'out']) })
    .passthrough(),
  audacity_auto_duck: z
    .object({
      dryRun: z.boolean(),
      bed: NumberValue.optional(),
      voice: NumberValue,
      command: z.string().optional(),
      params: JsonObject,
      scope: Scope,
    })
    .passthrough(),
  audacity_transport: z
    .object({
      state: z.enum(['playing', 'paused', 'recording', 'stopped']),
      positionSeconds: NumberValue,
      positionSource: z.string(),
      selection: z.json(),
    })
    .passthrough(),
  audacity_history: z.object({ action: z.enum(['undo', 'redo']), completed: NumberValue }).passthrough(),
  audacity_macros: z
    .object({
      directory: z.string().optional(),
      macros: z.array(JsonObject).optional(),
      name: z.string().optional(),
      dryRun: z.boolean().optional(),
      steps: z.array(JsonObject).optional(),
      completed: NumberValue.optional(),
    })
    .passthrough(),
  audacity_recover: z
    .object({
      running: z.boolean(),
      entries: Strings,
      windows: z.array(Window),
      discarded: z.json(),
      needsRecovery: z.boolean().optional(),
      tracks: z.array(Track).optional(),
      synchronized: z.boolean().optional(),
      previousOutcome: z.string().optional(),
      note: z.string().optional(),
    })
    .passthrough(),
  audacity_labels_file: z
    .object({
      imported: NumberValue.optional(),
      trackName: z.string().optional(),
      file: z.string().optional(),
      format: z.string().optional(),
      count: NumberValue.optional(),
    })
    .passthrough(),
  audacity_label_regions_export: z.object({ files: Strings, count: NumberValue }).passthrough(),
  audacity_batch: z
    .object({
      dryRun: z.boolean(),
      jobs: z.array(JsonObject).optional(),
      requiresEmptyProject: z.boolean().optional(),
      notes: Strings.optional(),
      completed: NumberValue.optional(),
      results: z.array(JsonObject).optional(),
    })
    .passthrough(),
};
