import { existsSync, statSync } from 'node:fs';
import { z } from 'zod';
import { SafeString } from '../catalogue.js';
import { catalogueCommand } from '../format.js';
import type { Ops, TrackRef } from '../ops.js';
import { validateExportFile } from './files.js';

const Seconds = z.number().finite().min(0).max(86400);
const Track = z.union([z.number().int().nonnegative(), SafeString.min(1)]);
const EnvelopePoints = z
  .array(z.object({ time: Seconds, value: z.number().finite().min(0).max(2) }).strict())
  .min(1)
  .max(2000);

export async function importTrack(
  ops: Ops,
  file: string,
  name?: string,
  start = 0,
): Promise<{ track: number; name: string }> {
  SafeString.min(1).parse(file);
  Seconds.parse(start);
  if (name !== undefined) catalogueCommand('SetTrack', { Name: name });
  catalogueCommand('Import2', { Filename: file });
  catalogueCommand('SetClip', { At: 0, Start: start });
  if (!existsSync(file) || !statSync(file).isFile()) throw new Error(`${file} is not an existing audio file`);
  const before = (await ops.tracks()).length;
  await ops.run('Import2', { Filename: file }, 300_000);
  const after = await ops.tracks();
  if (after.length <= before) throw new Error(`import added no track: ${file}`);
  if (after.length !== before + 1)
    throw new Error(
      `import added ${after.length - before} tracks; this tool requires one audio track. Imported tracks remain in the project; inspect them before continuing.`,
    );
  if (after[before]!.kind !== 'wave')
    throw new Error('import did not add an audio track; inspect the imported track before continuing');
  const track = before; // a stereo file is one track
  if (name !== undefined) {
    await ops.run('SelectTracks', { Track: track, TrackCount: 1, Mode: 'Set' });
    await ops.run('SetTrack', { Name: name });
  }
  if (start !== 0) {
    await ops.run('Select', { Track: track, TrackCount: 1, Start: 0, End: 0.001, Mode: 'Set' });
    await ops.run('SetClip', { At: 0, Start: start });
  }
  return { track, name: (await ops.tracks())[track]?.name ?? name ?? '' };
}

export async function moveClip(ops: Ops, track: TrackRef, at: number, start: number): Promise<void> {
  Track.parse(track);
  Seconds.parse(at);
  Seconds.parse(start);
  const index = await ops.trackIndex(track);
  const clips = (await ops.info('Clips')) as { track: number; start: number; end: number }[];
  const matches = clips.filter((clip) => clip.track === index && clip.start <= at && at < clip.end);
  if (matches.length !== 1)
    throw new Error(`time ${at}s identifies ${matches.length} clips on track ${index}; choose a point inside one clip`);
  const clip = matches[0]!;
  // Native SetClip includes both ends (live 3.7.8). Resolve the half-open
  // public range first, then use an interior point to avoid moving neighbors.
  const interior = at > clip.start ? at : clip.start + (clip.end - clip.start) / 2;
  catalogueCommand('SetClip', { At: interior, Start: start });
  // Live 3.7.8: SetClip ignores a Track wire key and visits selected tracks.
  await ops.run('SelectTracks', { Track: index, TrackCount: 1, Mode: 'Set' });
  await ops.run('SetClip', { At: interior, Start: start });
}

export async function setEnvelope(
  ops: Ops,
  track: TrackRef,
  points: { time: number; value: number }[],
  replace = true,
): Promise<number> {
  Track.parse(track);
  EnvelopePoints.parse(points);
  z.boolean().parse(replace);
  for (const point of points) catalogueCommand('SetEnvelope', { Time: point.time, Value: point.value });
  const index = await ops.trackIndex(track);
  if ((await ops.tracks())[index]!.kind !== 'wave') throw new Error('envelope target must be an audio track');
  const end = await ops.projectEnd();
  await ops.run('Select', { Track: index, TrackCount: 1, Start: 0, End: Math.max(end, 0.001), Mode: 'Set' });
  if (replace) await ops.run('SetEnvelope', { Delete: true });
  for (const point of points) {
    await ops.run('SetEnvelope', { Time: point.time, Value: point.value });
  }
  return points.length;
}

export async function exportMix(ops: Ops, file: string, channels = 2, start?: number, end?: number): Promise<void> {
  z.union([z.literal(1), z.literal(2)]).parse(channels);
  Seconds.optional().parse(start);
  Seconds.optional().parse(end);
  validateExportFile(file);
  catalogueCommand('Export2', { Filename: file, NumChannels: channels });
  // An explicit time and track selection, never Select All: with a label in text editing
  // Select All selects the label's text and the export comes out empty.
  const tracks = await ops.tracks();
  if (tracks.length === 0) throw new Error('the project has no tracks to export');
  const from = start ?? 0;
  const to = end ?? (await ops.projectEnd());
  if (!(to > from)) throw new Error(`nothing to export between ${from}s and ${to}s`);
  await ops.run('Select', { Start: from, End: to, Track: 0, TrackCount: tracks.length, Mode: 'Set' });
  await ops.run('Export2', { Filename: file, NumChannels: channels }, 600_000);
}
