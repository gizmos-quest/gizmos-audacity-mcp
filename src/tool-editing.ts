import { z } from 'zod';
import { EFFECT_IDS, SafeString } from './catalogue.js';
import { catalogueCommand } from './format.js';
import { type Ops, trackPanPercent, validateProjectFile } from './ops.js';
import { Params, Scope, Seconds, TrackRef } from './tool-input.js';
import type { ToolRegistrar } from './tools.js';

export function registerEditingTools(tool: ToolRegistrar, ops: Ops): void {
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
      if ([name, gainDb, pan, mute, solo].every((value) => value === undefined))
        throw new Error('supply at least one track property');
      // SetTrack's Volume is in dB (live 3.7.8: -6 reads back as ~0.501 linear).
      // Native Pan is percent (live 3.7.8: Pan=-0.4 reads back as -0.004).
      const params = {
        Name: name,
        Volume: gainDb,
        Pan: pan === undefined ? undefined : trackPanPercent(pan),
        Mute: mute,
        Solo: solo,
      };
      catalogueCommand('SetTrack', params); // Refuse untransmittable text before selecting.
      const index = await ops.trackIndex(track);
      // Live 3.7.8 ignores Track on SetTrack; its target is the track selection.
      await ops.run('SelectTracks', { Track: index, TrackCount: 1, Mode: 'Set' });
      await ops.run('SetTrack', params);
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
      points: z
        .array(z.object({ time: Seconds, value: z.number().finite().min(0).max(2) }).strict())
        .min(1)
        .max(2000),
      replace: z.boolean().default(true),
    },
    async ({ track, points, replace }) => ({ points: await ops.setEnvelope(track, points, replace) }),
  );

  tool(
    'audacity_labels_set',
    'Write labels (point or region) into a named label track, creating it if needed. Use them to mark picture events or script lines.',
    {
      labels: z
        .array(z.object({ start: Seconds, end: Seconds.optional(), text: SafeString }).strict())
        .min(1)
        .max(500),
      trackName: SafeString.min(1).default('Labels'),
    },
    async ({ labels, trackName }) => ({ labels: await ops.setLabels(labels, trackName) }),
  );

  tool(
    'audacity_effect',
    'Select a track/range and apply an effect using the bundled English Audacity 3.7.8 catalogue parameters. Default time scope is the track extent, avoiding silent gap clips. NoiseReduction requires a captured profile on this same track and params={}; it uses saved UI settings. Scripted effects add no undo entry: save a project backup first.',
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
    {
      file: SafeString.min(1),
      channels: z.number().int().min(1).max(2).default(2),
      start: Seconds.optional(),
      end: Seconds.optional(),
    },
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
      if (action === 'open' && (await ops.tracks()).length)
        throw new Error('open requires an empty project; use audacity_fresh with backupTo first');
      return ops.run(
        action === 'open' ? 'OpenProject2' : 'SaveProject2',
        { Filename: file, AddToHistory: false },
        300_000,
      );
    },
  );
}
