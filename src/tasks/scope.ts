import { z } from 'zod';
import { MENU_IDS } from '../catalogue.js';
import type { Ops, TrackInfo, TrackRef } from '../ops.js';
import { Seconds, Track } from '../tool-input.js';

export const Gain = z.number().min(-50).max(36);
export const Frequency = z.number().min(1).max(20_000);
export const Amplitude = z.number().min(0).max(1);
export const Waveform = z.enum(['Sine', 'Square', 'Sawtooth', 'Square, no alias', 'Triangle']);
export const Scope = { track: Track, start: Seconds.optional(), end: Seconds.optional() };

export function validRange(value: { start?: number; end?: number }): boolean {
  return value.start === undefined || value.end === undefined || value.end > value.start;
}

export function safeMenu(command: string): void {
  if (!MENU_IDS.includes(command)) throw new Error(`task command is not a safe catalogue menu item: ${command}`);
}

export async function audioTrack(ops: Ops, ref: TrackRef): Promise<{ index: number; info: TrackInfo }> {
  const index = await ops.trackIndex(ref);
  const info = (await ops.tracks())[index]!;
  if (info.kind !== 'wave') throw new Error(`track ${index} is ${info.kind}, not an audio track`);
  return { index, info };
}

export async function resolveRange(
  ops: Ops,
  scope: { track: TrackRef; start?: number; end?: number },
): Promise<{ track: number; start: number; end: number }> {
  const { index, info } = await audioTrack(ops, scope.track);
  const start = scope.start ?? info.start;
  const end = scope.end ?? info.end;
  if (!(end > start)) throw new Error(`nothing to process between ${start}s and ${end}s on track ${index}`);
  return { track: index, start, end };
}
