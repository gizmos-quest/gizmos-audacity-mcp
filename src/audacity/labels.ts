import { z } from 'zod';
import { SafeString } from '../catalogue.js';
import { catalogueCommand } from '../format.js';
import type { Ops } from '../ops.js';

const Seconds = z.number().finite().min(0).max(86400);
const LabelsInput = z
  .array(
    z
      .object({ start: Seconds, end: Seconds.optional(), text: SafeString })
      .strict()
      .refine((label) => label.end === undefined || label.end >= label.start, 'label end must be at least start'),
  )
  .min(1);

export function preflightLabels(
  unsorted: { start: number; end?: number; text: string }[],
  trackName = 'Labels',
): { start: number; end?: number; text: string }[] {
  // SetLabel uses a flat index across label tracks. Audacity sorts insertions
  // by time, so identify the added tuple rather than assuming an append index.
  const labels = LabelsInput.parse(unsorted).sort((a, b) => a.start - b.start);
  SafeString.min(1).parse(trackName);
  catalogueCommand('SetTrack', { Name: trackName });
  // A later oversized label must be refused before creating or adding labels.
  // Reserve a conservative index width because insertion changes flat indices.
  for (const label of labels)
    catalogueCommand('SetLabel', {
      Label: Number.MAX_SAFE_INTEGER,
      Text: label.text,
      Start: label.start,
      End: label.end ?? label.start,
      Selected: false,
    });
  return labels;
}

export async function setLabels(
  ops: Ops,
  unsorted: { start: number; end?: number; text: string }[],
  trackName = 'Labels',
): Promise<number> {
  const labels = preflightLabels(unsorted, trackName);
  const tracks = await ops.tracks();
  const matchingTracks = tracks.flatMap((t, i) => (t.kind === 'label' && t.name === trackName ? [i] : []));
  if (matchingTracks.length > 1) throw new Error(`multiple label tracks named ${trackName}; rename them uniquely`);
  let labelTrack = matchingTracks[0] ?? -1;
  if (labelTrack < 0) {
    await ops.run('NewLabelTrack');
    labelTrack = tracks.length;
    await ops.run('SelectTracks', { Track: labelTrack, TrackCount: 1, Mode: 'Set' });
    await ops.run('SetTrack', { Name: trackName });
  }
  for (const label of labels) {
    const end = label.end ?? label.start;
    const before = (await ops.info('Labels')) as [number, [number, number, string][]][];
    await ops.run('Select', { Track: labelTrack, TrackCount: 1, Start: label.start, End: end, Mode: 'Set' });
    await ops.run('AddLabel');
    const after = (await ops.info('Labels')) as [number, [number, number, string][]][];
    let offset = 0;
    let inserted = -1;
    for (const [track, values] of after) {
      if (track === labelTrack) {
        const old = before.find(([t]) => t === track)?.[1] ?? [];
        // Find the added tuple as a multiset difference, including identical times.
        const remaining = [...old];
        const added: number[] = [];
        for (const [i, value] of values.entries()) {
          const prior = remaining.findIndex((v) => JSON.stringify(v) === JSON.stringify(value));
          if (prior >= 0) remaining.splice(prior, 1);
          else added.push(i);
        }
        // The one added tuple is authoritative; printed times may round high-precision selections.
        if (added.length === 1) inserted = offset + added[0]!;
      }
      if (inserted >= 0) break;
      offset += values.length;
    }
    if (inserted < 0) throw new Error('Audacity did not expose the newly added label');
    await ops.run('SetLabel', { Label: inserted, Text: label.text, Start: label.start, End: end, Selected: false });
  }
  // AddLabel leaves the last label in text editing, where Select All would select its text.
  await ops.run('SelectNone');
  return labels.length;
}
