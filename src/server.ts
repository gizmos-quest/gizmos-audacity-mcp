// MCP tools for a running Audacity. The generic tools cover every command
// Audacity reports about itself; the task tools bundle the steps an editor
// actually takes (import at a position, envelope, labels, effect on a range).
import { McpServer, LATEST_PROTOCOL_VERSION } from '@modelcontextprotocol/server';
import { z } from 'zod';
import { COMMAND_IDS, MENU_IDS, SafeString, describeCommand } from './catalogue.js';
import { AudacityPipe, AudacityUnavailable } from './pipe.js';
import { Ops } from './ops.js';
import { launch, quit, setWindowVisible, pipeExists } from './app.js';

const Seconds = z.number().finite().min(0).max(86_400);
const TrackRef = z.union([z.number().int().min(0), SafeString.min(1)]).describe('track index (0-based) or unique track name');
const Scope = {
  track: TrackRef.optional(),
  trackCount: z.number().int().min(1).max(256).optional(),
  start: Seconds.optional(),
  end: Seconds.optional(),
};
const Params = z.record(z.string(), z.union([z.string(), z.number(), z.boolean()]));

type Result = { content: { type: 'text'; text: string }[]; isError?: boolean };

function ok(value: unknown): Result {
  const text = typeof value === 'string' ? value : JSON.stringify(value, null, 1);
  return { content: [{ type: 'text', text: text.length > 60_000 ? text.slice(0, 60_000) + '\n…(truncated)' : text }] };
}

function fail(error: unknown): Result {
  const message = error instanceof z.ZodError ? z.prettifyError(error) : error instanceof Error ? error.message : String(error);
  return { content: [{ type: 'text', text: message }], isError: true };
}

export function buildServer(pipe = new AudacityPipe()): McpServer {
  const ops = new Ops(pipe);
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
          return ok(await handler(z.object(shape).strict().parse(args) as z.infer<z.ZodObject<S>>));
        } catch (error) {
          if (error instanceof AudacityUnavailable) return fail(`${error.message} Use audacity_launch.`);
          return fail(error);
        }
      },
    );
  };

  tool(
    'audacity_launch',
    'Start Audacity if it is not running, visible (live, the user watches) or hidden (headless-style work nobody needs to see). Waits until the script pipe answers.',
    { visible: z.boolean().default(true) },
    ({ visible }) => launch(visible),
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
    ({ saveTo }) => quit(pipe, saveTo),
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
    { type: z.enum(['Tracks', 'Clips', 'Envelopes', 'Labels', 'Boxes', 'Commands', 'Menus']) },
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
    'Run any scripting command or effect from the catalogue on the current selection (effects: Amplify, Compressor, Limiter, LoudnessNormalization, Normalize, NoiseReduction, High-passFilter, FilterCurve, AutoDuck, FadeIn, …). Parameters are validated against Audacity\'s own list; see audacity_describe.',
    { command: z.enum(COMMAND_IDS as [string, ...string[]]), params: Params.default({}) },
    ({ command, params }) => ops.command(command, params, 600_000),
  );

  tool(
    'audacity_menu',
    'Run a menu command that needs no dialog (Play, Stop, Record1stChoice, Undo, Redo, SelectAll, SelectNone, NewMonoTrack, NewStereoTrack, NewLabelTrack, AddLabel, ZoomSel, FitInWindow, CursProjectStart, …).',
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
    'Set track properties: name, volume (linear gain), pan (-1..1), mute, solo.',
    {
      track: TrackRef,
      name: SafeString.optional(),
      volume: z.number().min(0).max(10).optional(),
      pan: z.number().min(-1).max(1).optional(),
      mute: z.boolean().optional(),
      solo: z.boolean().optional(),
    },
    async ({ track, name, volume, pan, mute, solo }) => {
      const index = await ops.trackIndex(track);
      await ops.run('SetTrack', { Track: index, Name: name, Volume: volume, Pan: pan, Mute: mute, Solo: solo });
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
      points: z.array(z.object({ time: Seconds, value: z.number().min(0).max(4) })).min(1).max(2000),
      replace: z.boolean().default(true),
    },
    async ({ track, points, replace }) => ({ points: await ops.setEnvelope(track, points, replace) }),
  );

  tool(
    'audacity_labels_set',
    'Write labels (point or region) into a named label track, creating it if needed. Use them to mark picture events or script lines.',
    {
      labels: z.array(z.object({ start: Seconds, end: Seconds.optional(), text: SafeString })).min(1).max(500),
      trackName: SafeString.default('Labels'),
    },
    async ({ labels, trackName }) => ({ labels: await ops.setLabels(labels, trackName) }),
  );

  tool(
    'audacity_effect',
    'Select a range and apply one effect in one step (see audacity_command for the effect list).',
    { effect: z.enum(COMMAND_IDS as [string, ...string[]]), params: Params.default({}), ...Scope },
    ({ effect, params, ...scope }) => ops.applyEffect(effect, params, scope),
  );

  tool(
    'audacity_noise_profile',
    'Capture the noise profile for Noise Reduction from a stretch of pure noise (room tone). Then apply NoiseReduction with Reduction/Sensitivity/Smoothing via audacity_effect.',
    { track: TrackRef, start: Seconds, end: Seconds },
    async ({ track, start, end }) => {
      await ops.captureNoiseProfile(track, start, end);
      return 'noise profile captured';
    },
  );

  tool(
    'audacity_export',
    'Export the mix of all unmuted tracks (optionally a time range) to WAV/FLAC/MP3 by file extension.',
    { file: SafeString.min(1), channels: z.number().int().min(1).max(2).default(2), start: Seconds.optional(), end: Seconds.optional() },
    async ({ file, channels, start, end }) => {
      await ops.exportMix(file, channels, start, end);
      return { file };
    },
  );

  tool(
    'audacity_project',
    'New, open or save an .aup3 project.',
    { action: z.enum(['new', 'open', 'save']), file: SafeString.optional() },
    async ({ action, file }) => {
      if (action === 'new') return ops.run('New');
      if (!file) throw new Error(`${action} needs file`);
      return ops.run(action === 'open' ? 'OpenProject2' : 'SaveProject2', { Filename: file, AddToHistory: false }, 300_000);
    },
  );

  return server;
}
