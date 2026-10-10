import { existsSync } from 'node:fs';
import { mkdir, readFile, stat, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { z } from 'zod';
import { preflightLabels } from './audacity/labels.js';
import { SafeString } from './catalogue.js';
import { catalogueCommand } from './format.js';
import type { Ops } from './ops.js';
import { Seconds } from './tool-input.js';
import type { ToolRegistrar } from './tools.js';

export interface Label {
  index: number;
  track: number;
  trackName: string;
  start: number;
  end: number;
  text: string;
}
export const LabelInput = z
  .object({
    start: Seconds,
    end: Seconds.optional(),
    text: SafeString,
  })
  .strict()
  .refine((v) => v.end === undefined || v.end >= v.start, 'label end must be at least start');

export async function labels(ops: Ops): Promise<Label[]> {
  const tracks = await ops.tracks();
  let index = 0;
  return ((await ops.info('Labels')) as [number, [number, number, string][]][]).flatMap(([track, values]) =>
    values.map(([start, end, text]) => ({
      index: index++,
      track,
      trackName: tracks[track]?.name ?? '',
      start,
      end,
      text,
    })),
  );
}

export const LabelFormat = z.enum(['tsv', 'json', 'srt', 'vtt', 'chapters', 'cue', 'podlove', 'ffmetadata']);
type LabelFormat = z.infer<typeof LabelFormat>;
export function timestamp(seconds: number, separator = '.'): string {
  const millis = Math.round(seconds * 1000);
  return `${String(Math.floor(millis / 3600000)).padStart(2, '0')}:${String(Math.floor(millis / 60000) % 60).padStart(2, '0')}:${String(Math.floor(millis / 1000) % 60).padStart(2, '0')}${separator}${String(millis % 1000).padStart(3, '0')}`;
}

export function formatLabels(
  input: { start: number; end?: number; text: string }[],
  format: LabelFormat,
  projectEnd: number,
): string {
  const sorted = input.map((l) => LabelInput.parse(l)).sort((a, b) => a.start - b.start);
  const regions = sorted.map((l, i) => ({
    ...l,
    end: l.end !== undefined && l.end > l.start ? l.end : (sorted[i + 1]?.start ?? projectEnd),
  }));
  if (format === 'tsv')
    return `${sorted.map((l) => `${l.start}\t${l.end ?? l.start}\t${l.text.replace(/\t/g, ' ')}`).join('\n')}\n`;
  if (format === 'json') return `${JSON.stringify(sorted, null, 2)}\n`;
  if (format === 'chapters') return `${sorted.map((l) => `${timestamp(l.start)} ${l.text}`).join('\n')}\n`;
  if (format === 'podlove')
    return `${JSON.stringify({ version: '1.2.0', chapters: sorted.map((l) => ({ start: l.start, title: l.text })) }, null, 2)}\n`;
  if (format === 'cue')
    return `${sorted
      .map((l, i) => {
        const frames = Math.round(l.start * 75);
        return `  TRACK ${String(i + 1).padStart(2, '0')} AUDIO\n    TITLE "${l.text}"\n    INDEX 01 ${String(Math.floor(frames / 4500)).padStart(2, '0')}:${String(Math.floor(frames / 75) % 60).padStart(2, '0')}:${String(frames % 75).padStart(2, '0')}`;
      })
      .join('\n')}\n`;
  if (regions.some((l) => l.end <= l.start))
    throw new Error(`${format} needs a positive end for the last point label; supply projectEnd`);
  if (format === 'ffmetadata') {
    const escapeTitle = (s: string) => s.replace(/[\\=;#]/g, '\\$&');
    return `;FFMETADATA1\n${regions.map((l) => `[CHAPTER]\nTIMEBASE=1/1000\nSTART=${Math.round(l.start * 1000)}\nEND=${Math.round(l.end * 1000)}\ntitle=${escapeTitle(l.text)}`).join('\n')}\n`;
  }
  return `${
    (format === 'vtt' ? 'WEBVTT\n\n' : '') +
    regions
      .map(
        (l, i) =>
          `${i + 1}\n${timestamp(l.start, format === 'srt' ? ',' : '.')} --> ${timestamp(l.end, format === 'srt' ? ',' : '.')}\n${l.text}`,
      )
      .join('\n\n')
  }\n`;
}

export function parseLabelsFile(text: string, format: 'tsv' | 'json'): z.infer<typeof LabelInput>[] {
  text = text.replace(/^\uFEFF/, '');
  if (format === 'json') return z.array(LabelInput).max(5000).parse(JSON.parse(text));
  return text.split(/\r?\n/).flatMap((line, i) => {
    if (!line.trim()) return [];
    const parts = line.split('\t');
    if (parts.length < 3 || !parts[0]?.trim() || !parts[1]?.trim())
      throw new Error(`invalid TSV label at line ${i + 1}`);
    return [LabelInput.parse({ start: Number(parts[0]), end: Number(parts[1]), text: parts.slice(2).join(' ') })];
  });
}

export function registerLabelTools(tool: ToolRegistrar, ops: Ops): void {
  tool(
    'audacity_labels',
    'List/find labels by text, edit one flat zero-based label index, delete one label, or create regular markers. Delete safely reconstructs only its label track at the bottom of the project, preserving every other label including overlaps; returned indices reflect the new order.',
    {
      action: z.enum(['list', 'find', 'edit', 'delete', 'regular']),
      index: z.number().int().nonnegative().optional(),
      query: SafeString.optional(),
      trackName: SafeString.min(1).optional(),
      start: Seconds.optional(),
      end: Seconds.optional(),
      text: SafeString.optional(),
      interval: z.number().positive().max(86400).optional(),
    },
    async (args) => {
      const { action, index, query, trackName, start, end, text, interval } = args;
      const fields = {
        list: ['trackName'],
        find: ['query', 'trackName'],
        edit: ['index', 'start', 'end', 'text'],
        delete: ['index'],
        regular: ['trackName', 'start', 'end', 'text', 'interval'],
      }[action];
      for (const [key, value] of Object.entries(args)) {
        if (key !== 'action' && value !== undefined && !fields.includes(key))
          throw new Error(`${key} is not used by label ${action}`);
      }
      if (action === 'find' && query === undefined) throw new Error('find requires query');
      if (['edit', 'delete'].includes(action) && index === undefined) throw new Error(`${action} requires index`);
      if (action === 'edit' && start === undefined && end === undefined && text === undefined)
        throw new Error('edit requires start, end or text');
      if (action === 'regular' && (interval === undefined || start === undefined || end === undefined || end < start))
        throw new Error('regular needs start, end >= start, and interval');
      const current = await labels(ops);
      if (action === 'list' || action === 'find') {
        return current.filter(
          (l) =>
            (trackName === undefined || l.trackName === trackName) &&
            (query === undefined || l.text.toLowerCase().includes(query.toLowerCase())),
        );
      }
      if (action === 'regular') {
        const count = Math.floor((end! - start!) / interval! + 1e-9) + 1;
        if (count > 500) throw new Error('regular markers exceed 500 labels');
        await ops.setLabels(
          Array.from({ length: count }, (_, i) => ({
            start: Math.min(end!, start! + i * interval!),
            text: `${text ?? 'Marker'} ${i + 1}`,
          })),
          trackName ?? 'Labels',
        );
        return labels(ops);
      }
      const target = current.find((l) => l.index === index);
      if (!target) throw new Error('label index does not exist; use list');
      if (action === 'edit') {
        const parsed = LabelInput.parse({
          start: start ?? target.start,
          end: end ?? target.end,
          text: text ?? target.text,
        });
        await ops.command('SetLabel', {
          Label: target.index,
          Start: parsed.start,
          End: parsed.end,
          Text: parsed.text,
          Selected: false,
        });
        await ops.run('SelectNone');
      } else {
        const kept = current.filter((l) => l.track === target.track && l.index !== target.index);
        SafeString.min(1).parse(target.trackName);
        if ((await ops.tracks()).filter((t) => t.kind === 'label' && t.name === target.trackName).length !== 1) {
          throw new Error('label deletion requires a unique label track name');
        }
        for (const label of kept) LabelInput.parse({ start: label.start, end: label.end, text: label.text });
        catalogueCommand('SetTrack', { Name: target.trackName });
        if (kept.length)
          preflightLabels(
            kept.map(({ start, end, text }) => ({ start, end, text })),
            target.trackName,
          );
        await ops.command('SelectTracks', { Track: target.track, TrackCount: 1, Mode: 'Set' });
        await ops.run('RemoveTracks');
        await ops.run('NewLabelTrack');
        const newTrack = (await ops.tracks()).length - 1;
        await ops.command('SelectTracks', { Track: newTrack, TrackCount: 1, Mode: 'Set' });
        await ops.run('SetTrack', { Name: target.trackName });
        if (kept.length)
          await ops.setLabels(
            kept.map(({ start, end, text }) => ({ start, end, text })),
            target.trackName,
          );
      }
      return labels(ops);
    },
  );
  tool(
    'audacity_labels_file',
    'Import Audacity TSV or JSON labels into a named track; export labels as TSV/JSON, SRT/VTT subtitles, timestamp chapters, CUE, Podlove or ffmetadata. Point-label subtitle ends come from the next marker or project end. Existing output files are refused.',
    {
      action: z.enum(['import', 'export']),
      file: SafeString.min(1),
      format: LabelFormat.default('tsv'),
      trackName: SafeString.min(1).default('Labels'),
    },
    async ({ action, file, format, trackName }) => {
      if (action === 'import') {
        if (!['tsv', 'json'].includes(format)) throw new Error('label import supports tsv/json');
        if ((await stat(file)).size > 1_048_576) throw new Error('label input exceeds 1 MiB');
        const values = parseLabelsFile(await readFile(file, 'utf8'), format as 'tsv' | 'json');
        if (values.length > 500) throw new Error('one import supports at most 500 labels');
        if (values.length) await ops.setLabels(values, trackName);
        return { imported: values.length, trackName };
      }
      if (existsSync(file)) throw new Error(`${file} exists; use a new label output path`);
      if ((await ops.tracks()).filter((t) => t.kind === 'label' && t.name === trackName).length !== 1)
        throw new Error('label export requires a unique label track name');
      const values = (await labels(ops)).filter((l) => l.trackName === trackName);
      if (!values.length) throw new Error('label track has no labels');
      await writeFile(
        file,
        formatLabels(
          values.map(({ start, end, text }) => ({ start, end, text })),
          format,
          await ops.projectEnd(),
        ),
        { flag: 'wx' },
      );
      return { file, format, count: values.length };
    },
  );
  tool(
    'audacity_label_regions_export',
    'Export every positive-duration region in one label track as numbered audio files, using the current mix and explicit time/track selections. Point labels are skipped. Existing outputs are refused and all destinations are checked before export.',
    {
      directory: SafeString.min(1),
      trackName: SafeString.min(1).default('Labels'),
      format: z.enum(['wav', 'flac', 'mp3']).default('wav'),
      channels: z.number().int().min(1).max(2).default(2),
    },
    async ({ directory, trackName, format, channels }) => {
      if ((await ops.tracks()).filter((t) => t.kind === 'label' && t.name === trackName).length !== 1)
        throw new Error('region export requires a unique label track name');
      const values = (await labels(ops)).filter((l) => l.trackName === trackName && l.end > l.start);
      if (!values.length) throw new Error('label track has no positive-duration regions');
      const files = values.map((l, i) =>
        join(
          directory,
          `${String(i + 1).padStart(3, '0')}-${l.text.replace(/[^A-Za-z0-9_-]/g, '_').slice(0, 80) || 'region'}.${format}`,
        ),
      );
      if (files.some(existsSync)) throw new Error('a region output already exists; use a new directory');
      for (const file of files) catalogueCommand('Export2', { Filename: file, NumChannels: channels });
      await mkdir(directory, { recursive: true });
      for (const [i, label] of values.entries()) await ops.exportMix(files[i]!, channels, label.start, label.end);
      return { files, count: files.length };
    },
  );
}
