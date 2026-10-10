import { z } from 'zod';
import { pipeExists } from './app.js';
import { COMMAND_IDS, describeCommand, MENU_IDS } from './catalogue.js';
import { requireEffectSelection } from './effect-safety.js';
import { type Ops, preflightCommand } from './ops.js';
import { Params } from './tool-input.js';
import type { ToolRegistrar } from './tools.js';

export function registerCatalogueTools(tool: ToolRegistrar, ops: Ops): void {
  tool(
    'audacity_status',
    'Whether Audacity answers, and its tracks with name, kind, start/end, volume, pan, mute and solo.',
    {},
    async () => (pipeExists() ? { running: true, tracks: await ops.tracks() } : { running: false }),
    true,
  );

  tool(
    'audacity_info',
    'Read project state: Tracks, Clips, Envelopes (points as t/y), Labels, Boxes, Commands (full catalogue with parameters) or Menus.',
    {
      type: z.enum([
        'Tracks',
        'Clips',
        'Envelopes',
        'Labels',
        'Boxes',
        'Commands',
        'Menus',
        'Selection',
        'Preferences',
      ]),
    },
    ({ type }) => ops.info(type),
    true,
  );

  tool(
    'audacity_describe',
    'Parameters of one scripting command or effect from the bundled English Audacity 3.7.8 catalogue.',
    { command: z.enum(COMMAND_IDS as [string, ...string[]]) },
    async ({ command }) => describeCommand(command),
    true,
  );

  tool(
    'audacity_command',
    "Run a catalogue scripting command or effect on the current selection (Amplify, Compressor, Limiter, LoudnessNormalization, Normalize, High-passFilter, FilterCurve, AutoDuck, FadeIn, …). Parameters follow Audacity's own list; see audacity_describe. Native Set* setters use selected tracks: call audacity_select first. NoiseReduction requires a captured profile.",
    { command: z.enum(COMMAND_IDS as [string, ...string[]]), params: Params.default({}) },
    async ({ command, params }) => {
      preflightCommand(command, params); // Refuse invalid input before reading the selection.
      await requireEffectSelection(ops, command);
      return ops.command(command, params, 600_000);
    },
  );

  tool(
    'audacity_menu',
    'Run a menu command that needs no dialog (Play, Stop, Undo, Redo, SelectAll, SelectNone, NewMonoTrack, NewStereoTrack, NewLabelTrack, AddLabel, ZoomSel, FitInWindow, CursProjectStart, …). Use audacity_transport for guarded recording.',
    { command: z.enum(MENU_IDS as [string, ...string[]]) },
    async ({ command }) => {
      // Batch dispatch resolves effect IDs before menu items (Audacity-3.7.8
      // src/BatchCommands.cpp:579-592): the Silence menu item runs the Silence generator.
      await requireEffectSelection(ops, command);
      return ops.run(command);
    },
  );
}
