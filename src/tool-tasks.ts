import type { Ops } from './ops.js';
import {
  AutoDuckSchema,
  autoDuck,
  ClipSetSchema,
  clipSet,
  EditSchema,
  edit,
  FadeSchema,
  fade,
  GenerateSchema,
  generate,
  PipelineSchema,
  pipeline,
  TrackEditSchema,
  trackEdit,
} from './tasks.js';
import type { ToolRegistrar } from './tools.js';

export function registerTaskTools(tool: ToolRegistrar, ops: Ops): void {
  tool(
    'audacity_pipeline',
    'Preview or run a reviewed cleanup/mastering chain on one track: voice, podcast, interview, audiobook, vocal, live, music, lo-fi or cleanup. dryRun lists exact ordered commands without changing selection. Noise reduction requires supplied room tone; normalization and limiting are explicit. Default range is the track extent, recalculated after edits.',
    PipelineSchema.shape,
    (args, progress) => pipeline(ops, args, progress),
  );

  tool(
    'audacity_edit',
    'Split, split-new, trim, duplicate, delete, cut/copy/paste, silence or join/disjoin audio on explicit tracks and time range. split/paste accept a cursor; delete closes the gap while split_delete retains timing.',
    EditSchema.shape,
    (args) => edit(ops, args),
  );

  tool(
    'audacity_generate',
    'Generate tone/noise/silence/chirp/DTMF/rhythm in a new mono/stereo track, or replace a range of an existing track. Uses a time selection for duration and validates kind-specific parameters before adding tracks.',
    GenerateSchema.shape,
    (args) => generate(ops, args),
  );

  tool(
    'audacity_clip_set',
    'Rename/color a clip or apply a relative gain in dB destructively to its samples. For name/color, at must lie strictly inside exactly one clip, avoiding shared boundaries. Use audacity_track_set gainDb for a reversible track slider, audacity_clip_move for timing.',
    ClipSetSchema.shape,
    (args) => clipSet(ops, args),
  );

  tool(
    'audacity_track_edit',
    'Add mono/stereo/label tracks, remove tracks, mix/render, or align selected tracks by start/end/selection. Track scope is explicit; add actions can name the new track.',
    TrackEditSchema.shape,
    (args) => trackEdit(ops, args),
  );

  tool(
    'audacity_fade',
    'Apply sample FadeIn or FadeOut on one track and time range. Omitting time applies to the track extent; use envelope_set for editable automation.',
    FadeSchema.shape,
    (args) => fade(ops, args),
  );

  tool(
    'audacity_auto_duck',
    'Duck a bed under speech using native AutoDuck. The unselected voice must be the immediately following track below the selected bed; checks topology before editing. dryRun lists exact parameters/range.',
    AutoDuckSchema.shape,
    (args) => autoDuck(ops, args),
  );
}
