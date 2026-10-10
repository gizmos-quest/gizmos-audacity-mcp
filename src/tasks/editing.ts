import { z } from 'zod';
import { clipsInfo } from '../audacity/info.js';
import { SafeString } from '../catalogue.js';
import { catalogueCommand } from '../format.js';
import type { Ops } from '../ops.js';
import { Seconds, Track, TrackCount } from '../tool-input.js';
import { audioTrack, Gain, resolveRange, Scope, safeMenu, validRange } from './scope.js';

const EDIT_COMMANDS = {
  split: 'Split',
  split_new: 'SplitNew',
  trim: 'Trim',
  duplicate: 'Duplicate',
  delete: 'Delete',
  split_delete: 'SplitDelete',
  cut: 'Cut',
  split_cut: 'SplitCut',
  copy: 'Copy',
  silence: 'Silence',
  join: 'Join',
  disjoin: 'Disjoin',
} as const;

export const EditSchema = z
  .object({
    action: z.enum(Object.keys(EDIT_COMMANDS) as [keyof typeof EDIT_COMMANDS, ...(keyof typeof EDIT_COMMANDS)[]]),
    ...Scope,
    trackCount: TrackCount.default(1),
  })
  .strict()
  .refine((a) => a.start === undefined || a.end === undefined || a.end >= a.start, {
    message: 'end must not be before start',
  });

export async function edit(ops: Ops, input: unknown): Promise<unknown> {
  const args = EditSchema.parse(input);
  const command = EDIT_COMMANDS[args.action];
  safeMenu(command);
  if (args.action === 'trim') safeMenu('SplitDelete');
  const target = await audioTrack(ops, args.track);
  const tracks = await ops.tracks();
  const selected = tracks.slice(target.index, target.index + args.trackCount);
  if (selected.length !== args.trackCount || selected.some((t) => t.kind !== 'wave'))
    throw new Error('edit scope must contain existing audio tracks only');
  const start = args.start ?? Math.min(...selected.map((t) => t.start));
  const end = args.end ?? Math.max(...selected.map((t) => t.end));
  if (!Number.isFinite(start) || !Number.isFinite(end) || end < start || (end === start && args.action !== 'split'))
    throw new Error(`${args.action} requires a finite non-empty time range`);
  if (args.action === 'trim') {
    const clips = clipsInfo(await ops.info('Clips'));
    if (
      !clips.some(
        (clip) =>
          clip.track >= target.index &&
          clip.track < target.index + args.trackCount &&
          clip.start < end &&
          clip.end > start,
      )
    ) {
      throw new Error('trim range must overlap audio on the selected tracks');
    }
    const trackStart = Math.min(...selected.map((track) => track.start));
    const trackEnd = Math.max(...selected.map((track) => track.end));
    if (!Number.isFinite(trackStart) || !Number.isFinite(trackEnd))
      throw new Error('selected audio tracks have invalid extents');
    // Native Trim only trims clips intersecting the selection and leaves separate
    // earlier/later clips (live 3.7.8, 2026-10-02). SplitDelete removes those
    // outside regions without moving the retained audio or unselected tracks.
    if (end < trackEnd) {
      await ops.select({ track: target.index, trackCount: args.trackCount, start: end, end: trackEnd });
      await ops.run('SplitDelete', {}, 600_000);
    }
    if (start > trackStart) {
      await ops.select({ track: target.index, trackCount: args.trackCount, start: trackStart, end: start });
      await ops.run('SplitDelete', {}, 600_000);
    }
  }
  await ops.select({ track: target.index, trackCount: args.trackCount, start, end });
  const reply = await ops.run(command, {}, 600_000);
  return { action: args.action, track: target.index, start, end, reply };
}

export const ClipSetSchema = z
  .object({
    track: Track,
    at: Seconds.describe(
      'time inside the clip; name/color require a point strictly after its start and before its end',
    ),
    name: SafeString.optional(),
    gainDb: Gain.optional().describe('relative sample gain applied destructively with Amplify to this clip'),
    color: z.enum(['Color0', 'Color1', 'Color2', 'Color3']).optional(),
  })
  .strict()
  .refine((a) => a.name !== undefined || a.gainDb !== undefined || a.color !== undefined, {
    message: 'supply name, gainDb or color',
  });

export async function clipSet(ops: Ops, input: unknown): Promise<unknown> {
  const args = ClipSetSchema.parse(input);
  const { index } = await audioTrack(ops, args.track);
  const clips = clipsInfo(await ops.info('Clips'));
  const matches = clips.filter((clip) => clip.track === index && clip.start <= args.at && args.at < clip.end);
  if (matches.length !== 1)
    throw new Error(
      `time ${args.at}s identifies ${matches.length} clips on track ${index}; choose a point inside one clip`,
    );
  const clip = matches[0]!;
  // SetClip can match both adjoining clips at their shared boundary (live
  // 3.7.8, 2026-10-02). Reject boundary metadata changes before applying gain.
  if ((args.name !== undefined || args.color !== undefined) && !(args.at > clip.start && args.at < clip.end)) {
    throw new Error('name/color changes require at strictly inside one clip, away from its start and end boundaries');
  }
  const gainParams = args.gainDb === undefined ? undefined : { Ratio: 10 ** (args.gainDb / 20) };
  const clipParams = { At: args.at, Name: args.name, Color: args.color };
  if (gainParams) catalogueCommand('Amplify', gainParams);
  if (args.name !== undefined || args.color !== undefined) catalogueCommand('SetClip', clipParams);
  await ops.select({ track: index, start: clip.start, end: clip.end });
  if (gainParams) await ops.command('Amplify', gainParams, 600_000);
  if (args.name !== undefined || args.color !== undefined) await ops.command('SetClip', clipParams);
  return {
    track: index,
    start: clip.start,
    end: clip.end,
    name: args.name ?? clip.name,
    gainDbApplied: args.gainDb,
    color: args.color,
  };
}

const TRACK_COMMANDS = {
  remove: 'RemoveTracks',
  mix: 'MixAndRender',
  mix_new: 'MixAndRenderToNewTrack',
  align_end_to_end: 'Align_EndToEnd',
  align_together: 'Align_Together',
  align_start_zero: 'Align_StartToZero',
  align_start_cursor: 'Align_StartToSelStart',
  align_start_end: 'Align_StartToSelEnd',
  align_end_cursor: 'Align_EndToSelStart',
  align_end_end: 'Align_EndToSelEnd',
} as const;

export const TrackEditSchema = z
  .object({
    action: z.enum([
      'add_mono',
      'add_stereo',
      'add_label',
      'remove',
      'mix',
      'mix_new',
      'align_end_to_end',
      'align_together',
      'align_start_zero',
      'align_start_cursor',
      'align_start_end',
      'align_end_cursor',
      'align_end_end',
    ]),
    track: Track.optional(),
    trackCount: TrackCount.default(1),
    name: SafeString.min(1).optional(),
    start: Seconds.optional(),
    end: Seconds.optional(),
  })
  .strict()
  .superRefine((a, ctx) => {
    const add = a.action.startsWith('add_');
    if (!add && a.track === undefined)
      ctx.addIssue({ code: 'custom', path: ['track'], message: 'track is required for this action' });
    if (add && (a.track !== undefined || a.start !== undefined || a.end !== undefined))
      ctx.addIssue({ code: 'custom', message: 'add actions accept no existing track or time range' });
    if (add && a.trackCount !== 1)
      ctx.addIssue({ code: 'custom', path: ['trackCount'], message: 'add actions create exactly one track' });
    if (!add && a.name !== undefined)
      ctx.addIssue({ code: 'custom', path: ['name'], message: 'name is only used when adding a track' });
    if (a.start !== undefined && a.end !== undefined && a.end < a.start)
      ctx.addIssue({ code: 'custom', message: 'end must not be before start' });
  });

export async function trackEdit(ops: Ops, input: unknown): Promise<unknown> {
  const args = TrackEditSchema.parse(input);
  if (args.action === 'add_mono' || args.action === 'add_stereo' || args.action === 'add_label') {
    if (args.name !== undefined) catalogueCommand('SetTrack', { Name: args.name });
    const before = (await ops.tracks()).length;
    const command = { add_mono: 'NewMonoTrack', add_stereo: 'NewStereoTrack', add_label: 'NewLabelTrack' }[args.action];
    safeMenu(command);
    await ops.run(command);
    if (args.name !== undefined) {
      await ops.command('SelectTracks', { Track: before, TrackCount: 1, Mode: 'Set' });
      await ops.command('SetTrack', { Name: args.name });
    }
    return { track: before, tracks: await ops.tracks() };
  }
  const command = TRACK_COMMANDS[args.action];
  safeMenu(command);
  const index = await ops.trackIndex(args.track!);
  const tracks = await ops.tracks();
  const selected = tracks.slice(index, index + args.trackCount);
  if (selected.length !== args.trackCount) throw new Error('trackCount extends beyond the project');
  if (args.action !== 'remove' && selected.some((t) => t.kind !== 'wave'))
    throw new Error('mix and alignment require audio tracks');
  // GetInfo omits start/end for label tracks (live 3.7.8, 2026-10-02).
  // Removal only needs track selection; use a finite zero-time fallback.
  const start = args.start ?? Math.min(...selected.map((t) => t.start ?? 0));
  const end = args.end ?? Math.max(...selected.map((t) => t.end ?? 0));
  await ops.select({ track: index, trackCount: args.trackCount, start, end });
  const reply = await ops.run(command, {}, 600_000);
  return { action: args.action, reply, tracks: await ops.tracks() };
}

export const FadeSchema = z
  .object({
    ...Scope,
    direction: z.enum(['in', 'out']),
  })
  .strict()
  .refine(validRange, { message: 'end must be after start' });

export async function fade(ops: Ops, input: unknown): Promise<unknown> {
  const args = FadeSchema.parse(input);
  const command = args.direction === 'in' ? 'FadeIn' : 'FadeOut';
  catalogueCommand(command, {});
  const range = await resolveRange(ops, args);
  await ops.select(range);
  await ops.command(command, {}, 600_000);
  return { ...range, direction: args.direction };
}
