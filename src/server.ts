// MCP tools for a running Audacity. The generic tools cover every command
// Audacity reports about itself; the task tools bundle the steps an editor
// actually takes (import at a position, envelope, labels, effect on a range).
import { McpServer, LATEST_PROTOCOL_VERSION } from '@modelcontextprotocol/server';
import { z } from 'zod';
import { COMMAND_IDS, EFFECT_IDS, MENU_IDS, SafeString, describeCommand } from './catalogue.js';
import { AudacityPipe, AudacityTimeout, AudacityUnavailable } from './pipe.js';
import { Ops, trackPanPercent, validateProjectFile } from './ops.js';
import { launch, listWindows, quit, setWindowVisible, pipeExists } from './app.js';
import { SerialQueue } from './queue.js';
import { registerAnalysisTools } from './analysis.js';
import { registerControlTools } from './controls.js';
import { registerLabelTools } from './labels.js';
import { registerBatchTool } from './batch.js';
import { PipelineSchema, EditSchema, GenerateSchema, ClipSetSchema, TrackEditSchema, FadeSchema, AutoDuckSchema,
  pipeline, edit, generate, clipSet, trackEdit, fade, autoDuck } from './tasks.js';

const Seconds = z.number().finite().min(0).max(86_400);
const TrackRef = z.union([z.number().int().min(0), SafeString.min(1)]).describe('track index (0-based) or unique track name');
const Scope = {
  track: TrackRef.optional(),
  trackCount: z.number().int().min(1).max(256).optional(),
  start: Seconds.optional(),
  end: Seconds.optional(),
};
const Params = z.record(z.string(), z.union([SafeString, z.number().finite(), z.boolean()]));

type Result = { content: { type: 'text'; text: string }[]; isError?: boolean };

function ok(value: unknown): Result {
  const text = typeof value === 'string' ? value : JSON.stringify(value, null, 1);
  return { content: [{ type: 'text', text }] };
}

function fail(error: unknown): Result {
  const message = error instanceof z.ZodError ? z.prettifyError(error) : error instanceof Error ? error.message : String(error);
  return { content: [{ type: 'text', text: message }], isError: true };
}

export function buildServer(pipe = new AudacityPipe()): McpServer {
  const ops = new Ops(pipe);
  const operations = new SerialQueue();
  const server = new McpServer(
    { name: 'gizmos-audacity-mcp', version: '0.1.0' },
    { capabilities: { tools: {} }, supportedProtocolVersions: [LATEST_PROTOCOL_VERSION] },
  );

  const tool = <S extends z.ZodRawShape>(
    name: string,
    description: string,
    shape: S,
    handler: (args: z.infer<z.ZodObject<S>>) => Promise<unknown>,
    readOnly = false,
  ) => {
    server.registerTool(
      name,
      { description, inputSchema: z.object(shape).strict(), annotations: { readOnlyHint: readOnly } },
      async (args: unknown) => {
        try {
          const parsed = z.object(shape).strict().parse(args) as z.infer<z.ZodObject<S>>;
          // Dialog closure must be available while a pipe command is blocked. No pipe I/O in these tools.
          return ok(await (['audacity_dialogs', 'audacity_window'].includes(name) ? handler(parsed) : operations.run(() => handler(parsed))));
        } catch (error) {
          if (error instanceof AudacityUnavailable) return fail(`${error.message} ${error.uncertainOutcome ? 'Use audacity_dialogs and audacity_recover; do not replay edits blindly.' : 'Use audacity_launch.'}`);
          if (error instanceof AudacityTimeout) {
            return fail(`${error.message}. A modal dialog may be blocking Audacity: check audacity_dialogs.`);
          }
          return fail(error);
        }
      },
    );
  };

  tool(
    'audacity_launch',
    'Start Audacity if it is not running, visible (live, the user watches) or hidden (headless-style work nobody needs to see). Waits until the script pipe answers.',
    { visible: z.boolean().default(true) },
    async ({ visible }) => { const result = await launch(visible); if (result.started) ops.freshApplication(); return result; },
  );

  tool(
    'audacity_window',
    'Show or hide the Audacity window. A hidden Audacity keeps working through the pipe.',
    { show: z.boolean() },
    async ({ show }) => ({ windows: await setWindowVisible(show) }),
  );

  tool(
    'audacity_quit',
    'Quit Audacity without a save prompt. Without saveTo the project is discarded (saved to a temporary file that is then deleted).',
    { saveTo: SafeString.optional().describe('keep the project at this .aup3 path') },
    async ({ saveTo }) => { await ops.restoreImportPreferences(); return quit(pipe, saveTo); },
  );

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
    { type: z.enum(['Tracks', 'Clips', 'Envelopes', 'Labels', 'Boxes', 'Commands', 'Menus', 'Selection', 'Preferences']) },
    ({ type }) => ops.info(type),
    true,
  );

  tool(
    'audacity_describe',
    "Parameters of one scripting command or effect, from Audacity's own catalogue.",
    { command: z.enum(COMMAND_IDS as [string, ...string[]]) },
    async ({ command }) => describeCommand(command),
    true,
  );

  tool(
    'audacity_command',
    'Run a catalogue scripting command or effect on the current selection (Amplify, Compressor, Limiter, LoudnessNormalization, Normalize, High-passFilter, FilterCurve, AutoDuck, FadeIn, …). Parameters follow Audacity\'s own list; see audacity_describe. Native Set* setters use selected tracks: call audacity_select first. NoiseReduction requires a captured profile.',
    { command: z.enum(COMMAND_IDS as [string, ...string[]]), params: Params.default({}) },
    ({ command, params }) => ops.command(command, params, 600_000),
  );

  tool(
    'audacity_menu',
    'Run a menu command that needs no dialog (Play, Stop, Undo, Redo, SelectAll, SelectNone, NewMonoTrack, NewStereoTrack, NewLabelTrack, AddLabel, ZoomSel, FitInWindow, CursProjectStart, …). Use audacity_transport for guarded recording.',
    { command: z.enum(MENU_IDS as [string, ...string[]]) },
    ({ command }) => ops.run(command),
  );

  tool(
    'audacity_select',
    'Select a time range on one or more tracks (all tracks when track is omitted; the whole project when start/end are omitted).',
    Scope,
    async (scope) => {
      await ops.select(scope);
      return 'selected';
    },
  );

  tool(
    'audacity_import',
    'Import an audio (or video, for its sound) file as a new track, name it and place it at start seconds.',
    { file: SafeString.min(1), name: SafeString.optional(), start: Seconds.default(0) },
    ({ file, name, start }) => ops.importTrack(file, name, start),
  );

  tool(
    'audacity_track_set',
    "Set track properties: name, gain in dB (the track's volume slider; status reports it back as a linear factor), pan (-1..1), mute, solo.",
    {
      track: TrackRef,
      name: SafeString.optional(),
      gainDb: z.number().min(-36).max(36).optional(),
      pan: z.number().min(-1).max(1).optional().describe('normalized pan: -1 full left, 0 center, 1 full right'),
      mute: z.boolean().optional(),
      solo: z.boolean().optional(),
    },
    async ({ track, name, gainDb, pan, mute, solo }) => {
      const index = await ops.trackIndex(track);
      // SetTrack's Volume is in dB (live 3.7.8: -6 reads back as ~0.501 linear).
      // Native Pan is percent (live 3.7.8: Pan=-0.4 reads back as -0.004).
      // Live 3.7.8 ignores Track on SetTrack; its target is the track selection.
      await ops.run('SelectTracks', { Track: index, TrackCount: 1, Mode: 'Set' });
      await ops.run('SetTrack', { Name: name, Volume: gainDb, Pan: pan === undefined ? undefined : trackPanPercent(pan), Mute: mute, Solo: solo });
      return (await ops.tracks())[index];
    },
  );

  tool(
    'audacity_clip_move',
    'Move the clip that covers time `at` on a track so it starts at `start` seconds.',
    { track: TrackRef, at: Seconds, start: Seconds },
    async ({ track, at, start }) => {
      await ops.moveClip(track, at, start);
      return 'moved';
    },
  );

  tool(
    'audacity_envelope_set',
    'Write a volume envelope on a track: points of time (s) and linear gain (1 = unchanged, 0.5 = -6 dB, 0.25 = -12 dB). Visible as the volume curve in Audacity. replace=true clears the old points first.',
    {
      track: TrackRef,
      points: z.array(z.object({ time: Seconds, value: z.number().finite().min(0).max(4) }).strict()).min(1).max(2000),
      replace: z.boolean().default(true),
    },
    async ({ track, points, replace }) => ({ points: await ops.setEnvelope(track, points, replace) }),
  );

  tool(
    'audacity_labels_set',
    'Write labels (point or region) into a named label track, creating it if needed. Use them to mark picture events or script lines.',
    {
      labels: z.array(z.object({ start: Seconds, end: Seconds.optional(), text: SafeString }).strict()).min(1).max(500),
      trackName: SafeString.default('Labels'),
    },
    async ({ labels, trackName }) => ({ labels: await ops.setLabels(labels, trackName) }),
  );

  tool(
    'audacity_effect',
    'Select a track/range and apply one installed effect with exact catalogue parameters. Default time scope is the track extent, avoiding silent gap clips. NoiseReduction requires a captured profile on this same track and params={}; it uses saved UI settings. Scripted effects add no undo entry: save a project backup first.',
    { effect: z.enum(EFFECT_IDS as [string, ...string[]]), params: Params.default({}), ...Scope },
    ({ effect, params, ...scope }) => ops.applyEffect(effect, params, scope),
  );

  tool(
    'audacity_noise_profile',
    'Capture room tone in a fresh Audacity process, then apply NoiseReduction with params={}. Audacity 3.7.8 uses saved UI settings, ignores effect parameters and cannot reset its profile through scripting. Repeating this exact interval reuses its profile; a different interval requires audacity_fresh with backupTo.',
    { track: TrackRef, start: Seconds, end: Seconds },
    async ({ track, start, end }) => {
      await ops.captureNoiseProfile(track, start, end);
      return 'noise profile captured';
    },
  );

  tool(
    'audacity_export',
    'Export the rendered mix or an explicit time range to WAV/FLAC/MP3/OGG by file extension, honoring gain, pan, mute, solo and envelopes. Selects time and tracks explicitly, including after label editing; channels is 1 or 2.',
    { file: SafeString.min(1), channels: z.number().int().min(1).max(2).default(2), start: Seconds.optional(), end: Seconds.optional() },
    async ({ file, channels, start, end }) => {
      await ops.exportMix(file, channels, start, end);
      return { file };
    },
  );

  tool(
    'audacity_project',
    'Open an existing .aup3 into an empty project or save to a new .aup3 path. Existing save destinations are refused to prevent a blocking modal. Use audacity_fresh with backupTo before opening when tracks are present.',
    { action: z.enum(['open', 'save']), file: SafeString.min(1) },
    async ({ action, file }) => {
      // Saving over an existing project makes Audacity show a modal error that blocks the pipe.
      validateProjectFile(file, action === 'save');
      if (action === 'open' && (await ops.tracks()).length) throw new Error('open requires an empty project; use audacity_fresh with backupTo first');
      return ops.run(action === 'open' ? 'OpenProject2' : 'SaveProject2', { Filename: file, AddToHistory: false }, 300_000);
    },
  );

  tool(
    'audacity_dialogs',
    "List Audacity's open windows and dialogs; close=true closes the dialogs (WM_CLOSE, like the window's X; Cancel for questions). Use it when a call times out: a modal dialog blocks the pipe.",
    { close: z.boolean().default(false) },
    async ({ close }) => ({ windows: await listWindows(close) }),
  );

  tool(
    'audacity_fresh',
    'Get an empty project in a single window. If the open project has tracks it is saved to backupTo (required then), Audacity quits without a prompt and starts again. Never use the New menu: a second project window has crashed Audacity 3.7 under scripting.',
    { visible: z.boolean().default(true), backupTo: SafeString.optional().describe('.aup3 path for the current project') },
    async ({ visible, backupTo }) => {
      if (!pipeExists()) { const result = await launch(visible); if (result.started) ops.freshApplication(); return { ...result, backedUpTo: null }; }
      const tracks = await ops.tracks();
      if (tracks.length === 0) {
        await ops.restoreImportPreferences();
        await quit(pipe);
        const result = await launch(visible); ops.freshApplication();
        return { ...result, backedUpTo: null };
      }
      if (!backupTo) throw new Error(`the open project has ${tracks.length} tracks; pass backupTo to keep them`);
      await ops.restoreImportPreferences();
      await quit(pipe, backupTo);
      const result = await launch(visible); ops.freshApplication();
      return { ...result, backedUpTo: backupTo };
    },
  );

  tool('audacity_pipeline', 'Preview or run a reviewed cleanup/mastering chain on one track: voice, podcast, interview, audiobook, vocal, live, music, lo-fi or cleanup. dryRun lists exact ordered commands without changing selection. Noise reduction requires supplied room tone; normalization and limiting are explicit. Default range is the track extent, recalculated after edits.', PipelineSchema.shape, (args) => pipeline(ops, args));
  tool('audacity_edit', 'Split, split-new, trim, duplicate, delete, cut/copy/paste, silence or join/disjoin audio on explicit tracks and time range. split/paste accept a cursor; delete closes the gap while split_delete retains timing.', EditSchema.shape, (args) => edit(ops, args));
  tool('audacity_generate', 'Generate tone/noise/silence/chirp/DTMF/rhythm in a new mono/stereo track, or replace a range of an existing track. Uses a time selection for duration and validates kind-specific parameters before adding tracks.', GenerateSchema.shape, (args) => generate(ops, args));
  tool('audacity_clip_set', 'Rename/color a clip or apply a relative gain in dB destructively to its samples. For name/color, at must lie strictly inside exactly one clip, avoiding shared boundaries. Use audacity_track_set gainDb for a reversible track slider, audacity_clip_move for timing.', ClipSetSchema.shape, (args) => clipSet(ops, args));
  tool('audacity_track_edit', 'Add mono/stereo/label tracks, remove tracks, mix/render, or align selected tracks by start/end/selection. Track scope is explicit; add actions can name the new track.', TrackEditSchema.shape, (args) => trackEdit(ops, args));
  tool('audacity_fade', 'Apply sample FadeIn or FadeOut on one track and time range. Omitting time applies to the track extent; use envelope_set for editable automation.', FadeSchema.shape, (args) => fade(ops, args));
  tool('audacity_auto_duck', 'Duck a bed under speech using native AutoDuck. The unselected voice must be the next audio track below the selected bed; checks topology before editing. dryRun lists exact parameters/range.', AutoDuckSchema.shape, (args) => autoDuck(ops, args));
  registerAnalysisTools(tool, ops);
  registerControlTools(tool, ops);
  registerLabelTools(tool, ops);
  registerBatchTool(tool, ops);

  return server;
}
