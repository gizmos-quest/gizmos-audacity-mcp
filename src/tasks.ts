// Reviewed editing and processing tasks built from Audacity's own catalogue.
// Pipeline ideas were independently implemented after studying xDarkzx/Audacity-MCP
// and FFriends/MCP-Audacity; parameter names come from this host's 3.7.8 catalogue.
import { z } from 'zod';
import { MENU_IDS, SafeString } from './catalogue.js';
import { catalogueCommand, type ParamValue } from './format.js';
import { Ops, type TrackRef, type TrackInfo } from './ops.js';

const Seconds = z.number().finite().min(0).max(86_400);
const Track = z.union([z.number().int().min(0).max(255), SafeString.min(1)]);
const Gain = z.number().finite().min(-60).max(36);
const Frequency = z.number().finite().min(1).max(20_000);
const Amplitude = z.number().finite().min(0).max(1);
const Waveform = z.enum(['Sine', 'Square', 'Sawtooth', 'Square, no alias', 'Triangle']);
const Scope = { track: Track, start: Seconds.optional(), end: Seconds.optional() };

function validRange(value: { start?: number; end?: number }): boolean {
  return value.start === undefined || value.end === undefined || value.end > value.start;
}

const NoiseProfile = z.object({
  start: Seconds,
  end: Seconds,
}).strict().refine(validRange, { message: 'noise profile end must be after start' });

const ShortenPauses = z.object({
  thresholdDb: z.number().finite().min(-80).max(-10).default(-40),
  minimum: z.number().finite().min(0.01).max(60).default(0.5),
  truncateTo: z.number().finite().min(0).max(60).default(0.3),
}).strict().refine((a) => a.truncateTo <= a.minimum, { message: 'truncateTo must not exceed minimum' });

export const PipelineSchema = z.object({
  preset: z.enum(['cleanup', 'voice', 'podcast', 'interview', 'audiobook', 'vocal', 'live', 'music', 'lofi']).default('voice'),
  ...Scope,
  dryRun: z.boolean().default(false),
  noiseProfile: NoiseProfile.optional().describe('explicit room-tone interval; omitting it skips noise reduction'),
  shortenPauses: ShortenPauses.optional().describe('optional destructive silence truncation; changes timing and video sync'),
  removeDc: z.boolean().default(true),
  highPassHz: Frequency.optional(),
  lowPassHz: Frequency.optional(),
  removeClicks: z.boolean().default(false).refine((enabled) => !enabled, {
    message: 'Click removal is unavailable: Audacity 3.7.8 opens a blocking modal dialog when no clicks are found.',
  }).describe('must remain false: native Click Removal can open a blocking result dialog'),
  clickThreshold: z.number().int().min(0).max(900).default(200),
  clickWidth: z.number().int().min(0).max(40).default(20),
  compress: z.boolean().optional(),
  thresholdDb: z.number().finite().min(-60).max(0).optional(),
  ratio: z.number().finite().min(1).max(20).optional(),
  attackMs: z.number().finite().min(0).max(1000).optional(),
  releaseMs: z.number().finite().min(1).max(10_000).optional(),
  bassDb: z.number().finite().min(-20).max(20).optional(),
  trebleDb: z.number().finite().min(-20).max(20).optional(),
  loudness: z.enum(['none', 'peak', 'lufs', 'rms']).default('none').describe('normalization can raise quiet audio; select it explicitly'),
  peakDb: z.number().finite().min(-60).max(0).default(-1),
  lufs: z.number().finite().min(-50).max(-5).default(-16),
  rmsDb: z.number().finite().min(-50).max(-5).default(-20),
  limitPeakDb: z.number().finite().min(-20).max(0).optional().describe('optional limiter after normalization; measure the result'),
}).strict().refine(validRange, { message: 'end must be after start' });

export type PipelineArgs = z.input<typeof PipelineSchema>;
export interface PipelineStep {
  name: string;
  command: string;
  params: Record<string, ParamValue>;
  scope: { track: TrackRef; start?: number; end?: number };
  captureProfile?: true;
}

interface Preset {
  highPassHz: number;
  lowPassHz?: number;
  thresholdDb: number;
  ratio: number;
  attackMs: number;
  releaseMs: number;
  bassDb?: number;
  trebleDb?: number;
}

// Conservative starting points, not promises of platform/ACX compliance.
const PRESETS: Record<z.infer<typeof PipelineSchema>['preset'], Preset> = {
  cleanup: { highPassHz: 80, thresholdDb: -18, ratio: 1, attackMs: 30, releaseMs: 200 },
  voice: { highPassHz: 80, thresholdDb: -18, ratio: 3, attackMs: 20, releaseMs: 200 },
  podcast: { highPassHz: 80, thresholdDb: -18, ratio: 3, attackMs: 30, releaseMs: 200 },
  interview: { highPassHz: 80, thresholdDb: -20, ratio: 2, attackMs: 20, releaseMs: 200 },
  audiobook: { highPassHz: 80, thresholdDb: -18, ratio: 2.5, attackMs: 10, releaseMs: 1000 },
  vocal: { highPassHz: 100, thresholdDb: -16, ratio: 3, attackMs: 10, releaseMs: 500, bassDb: -1, trebleDb: 2 },
  live: { highPassHz: 100, thresholdDb: -14, ratio: 4, attackMs: 10, releaseMs: 500 },
  music: { highPassHz: 30, thresholdDb: -16, ratio: 1.5, attackMs: 100, releaseMs: 300 },
  lofi: { highPassHz: 100, lowPassHz: 8000, thresholdDb: -16, ratio: 2, attackMs: 100, releaseMs: 300, bassDb: 2, trebleDb: -2 },
};

/** Pure planning: validate every command before any selection or audio mutation. */
export function planPipeline(input: unknown): { preset: string; steps: PipelineStep[]; notes: string[] } {
  const args = PipelineSchema.parse(input);
  const preset = PRESETS[args.preset];
  const scope = { track: args.track, start: args.start, end: args.end };
  const steps: PipelineStep[] = [];
  const add = (name: string, command: string, params: Record<string, ParamValue>, stepScope = scope) => {
    catalogueCommand(command, params);
    steps.push({ name, command, params, scope: stepScope });
  };
  if (args.noiseProfile) {
    const { start, end } = args.noiseProfile;
    add('Capture or reuse supplied room-tone noise profile', 'NoiseReduction', {}, { track: args.track, start, end });
    steps.at(-1)!.captureProfile = true;
    add('Reduce profiled background noise using saved Audacity settings', 'NoiseReduction', {});
  }
  if (args.removeDc) add('Remove DC offset without normalization', 'Normalize', { RemoveDcOffset: true, ApplyVolume: false, StereoIndependent: false, PeakLevel: -1 });
  add('Remove low-frequency rumble', 'High-passFilter', { FREQUENCY: args.highPassHz ?? preset.highPassHz, ROLLOFF: 'dB12' });
  const lowPassHz = args.lowPassHz ?? preset.lowPassHz;
  if (lowPassHz !== undefined) add('Low-pass filtering', 'Low-passFilter', { FREQUENCY: lowPassHz, ROLLOFF: 'dB12' });
  if (args.shortenPauses) {
    // Exact catalogue parameters ran without a dialog on live Audacity 3.7.8 (2026-10-02).
    add('Shorten detected pauses (changes timing)', 'TruncateSilence', {
      Threshold: args.shortenPauses.thresholdDb, Minimum: args.shortenPauses.minimum, Truncate: args.shortenPauses.truncateTo,
      Action: 'Truncate Detected Silence', Independent: false, TruncateStart: true, TruncateMiddle: true, TruncateEnd: true,
    });
  }
  if (args.compress ?? args.preset !== 'cleanup') {
    add('Compress dynamics without makeup gain', 'Compressor', {
      thresholdDb: args.thresholdDb ?? preset.thresholdDb,
      compressionRatio: args.ratio ?? preset.ratio,
      attackMs: args.attackMs ?? preset.attackMs,
      releaseMs: args.releaseMs ?? preset.releaseMs,
      makeupGainDb: 0, kneeWidthDb: 5, lookaheadMs: 1,
    });
  }
  const bass = args.bassDb ?? preset.bassDb ?? 0;
  const treble = args.trebleDb ?? preset.trebleDb ?? 0;
  if (bass !== 0 || treble !== 0) add('Shape bass and treble', 'BassAndTreble', { Bass: bass, Treble: treble, Gain: 0 });
  if (args.loudness === 'peak') add('Normalize sample peak', 'Normalize', { PeakLevel: args.peakDb, ApplyVolume: true, RemoveDcOffset: false, StereoIndependent: false });
  if (args.loudness === 'lufs' || args.loudness === 'rms') {
    add(`Normalize ${args.loudness.toUpperCase()}`, 'LoudnessNormalization', {
      NormalizeTo: args.loudness === 'lufs' ? 0 : 1,
      LUFSLevel: args.lufs, RMSLevel: args.rmsDb, StereoIndependent: false, DualMono: true,
    });
  }
  if (args.limitPeakDb !== undefined) add('Limit peaks without makeup boost', 'Limiter', {
    thresholdDb: args.limitPeakDb, makeupTargetDb: args.limitPeakDb, kneeWidthDb: 0, lookaheadMs: 5, releaseMs: 50,
  });
  const notes = ['Default scope is the target track\'s own extent, recalculated before each step.', 'Processing changes samples; save a project backup and measure the result.'];
  if (!args.noiseProfile) notes.push('Noise reduction skipped: no room-tone interval was supplied.');
  else notes.push('Audacity 3.7.8 uses saved noise-reduction settings. Only one profile can be captured per fresh process; the exact same interval can reuse it. Scripting cannot change reduction, sensitivity or smoothing.');
  if (args.loudness !== 'none') notes.push('Normalization may boost quiet audio and background noise.');
  if (args.limitPeakDb !== undefined) notes.push('Limiting can alter the requested LUFS/RMS; verify loudness and true peak after processing.');
  if (args.shortenPauses) notes.push('Silence truncation changes duration and alignment with video and other tracks.');
  return { preset: args.preset, steps, notes };
}

export async function pipeline(ops: Ops, input: unknown): Promise<unknown> {
  const args = PipelineSchema.parse(input);
  const plan = planPipeline(args);
  if (args.dryRun) return { dryRun: true, ...plan };
  // Preflight the processing range before capturing a profile (which changes
  // Audacity's effect state). Subsequent steps still recalculate track extents.
  await resolveRange(ops, args);
  if (args.noiseProfile) {
    const { info } = await audioTrack(ops, args.track);
    if (args.noiseProfile.start < info.start || args.noiseProfile.end > info.end) throw new Error('noise profile must be inside the target track extent');
  }
  const applied: string[] = [];
  for (const step of plan.steps) {
    try {
      const range = await resolveRange(ops, step.scope);
      if (step.captureProfile) await ops.captureNoiseProfile(range.track, range.start, range.end);
      else {
        await ops.select(range);
        await ops.command(step.command, step.params, 600_000);
      }
      applied.push(step.name);
    } catch (error) {
      throw new Error(`pipeline stopped at "${step.name}" after ${applied.length} completed steps: ${error instanceof Error ? error.message : String(error)}`);
    }
  }
  return { dryRun: false, ...plan, applied };
}

const EDIT_COMMANDS = {
  split: 'Split', split_new: 'SplitNew', trim: 'Trim', duplicate: 'Duplicate', delete: 'Delete',
  split_delete: 'SplitDelete', cut: 'Cut', split_cut: 'SplitCut', copy: 'Copy', paste: 'Paste',
  silence: 'Silence', join: 'Join', disjoin: 'Disjoin',
} as const;

export const EditSchema = z.object({
  action: z.enum(Object.keys(EDIT_COMMANDS) as [keyof typeof EDIT_COMMANDS, ...(keyof typeof EDIT_COMMANDS)[]]),
  ...Scope,
  trackCount: z.number().int().min(1).max(256).default(1),
}).strict().refine((a) => a.start === undefined || a.end === undefined || a.end >= a.start, { message: 'end must not be before start' });

export async function edit(ops: Ops, input: unknown): Promise<unknown> {
  const args = EditSchema.parse(input);
  const command = EDIT_COMMANDS[args.action];
  safeMenu(command);
  if (args.action === 'trim') safeMenu('SplitDelete');
  const target = await audioTrack(ops, args.track);
  const tracks = await ops.tracks();
  const selected = tracks.slice(target.index, target.index + args.trackCount);
  if (selected.length !== args.trackCount || selected.some((t) => t.kind !== 'wave')) throw new Error('edit scope must contain existing audio tracks only');
  const start = args.start ?? Math.min(...selected.map((t) => t.start));
  const end = args.end ?? Math.max(...selected.map((t) => t.end));
  if (!Number.isFinite(start) || !Number.isFinite(end) || end < start || (end === start && !['split', 'paste'].includes(args.action))) throw new Error(`${args.action} requires a finite non-empty time range`);
  if (args.action === 'trim') {
    const clips = await ops.info('Clips') as ClipInfo[];
    if (!clips.some((clip) => clip.track >= target.index && clip.track < target.index + args.trackCount && clip.start < end && clip.end > start)) {
      throw new Error('trim range must overlap audio on the selected tracks');
    }
    const trackStart = Math.min(...selected.map((track) => track.start));
    const trackEnd = Math.max(...selected.map((track) => track.end));
    if (!Number.isFinite(trackStart) || !Number.isFinite(trackEnd)) throw new Error('selected audio tracks have invalid extents');
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

export const GenerateSchema = z.object({
  kind: z.enum(['tone', 'noise', 'silence', 'chirp', 'dtmf', 'rhythm']),
  track: Track.optional().describe('omit to create a new track; supplying it replaces audio in the range'),
  name: SafeString.min(1).optional(),
  channels: z.number().int().min(1).max(2).default(1),
  start: Seconds.default(0),
  duration: z.number().finite().positive().max(3600).default(1),
  frequency: Frequency.optional(),
  amplitude: Amplitude.optional(),
  waveform: Waveform.optional(),
  noiseType: z.enum(['White', 'Pink', 'Brownian']).optional(),
  endFrequency: Frequency.optional(),
  endAmplitude: Amplitude.optional(),
  interpolation: z.enum(['Linear', 'Logarithmic']).optional(),
  sequence: z.string().regex(/^[0-9A-Da-d*#]+$/).max(256).optional(),
  dutyCycle: z.number().finite().min(0).max(100).optional(),
  tempo: z.number().finite().min(30).max(300).optional(),
  beatsPerBar: z.number().int().min(1).max(20).optional(),
  swing: z.number().finite().min(-1).max(1).optional(),
  clickSound: z.enum(['Metronome', 'Ping (short)', 'Ping (long)', 'Cowbell', 'ResonantNoise', 'NoiseClick', 'Drip (short)', 'Drip (long)']).optional(),
}).strict().superRefine((args, ctx) => {
  if (args.start + args.duration > 86_400) ctx.addIssue({ code: 'custom', message: 'generation range exceeds 24 hours' });
  const allowed: Record<typeof args.kind, string[]> = {
    tone: ['frequency', 'amplitude', 'waveform'], noise: ['amplitude', 'noiseType'], silence: [],
    chirp: ['frequency', 'amplitude', 'waveform', 'endFrequency', 'endAmplitude', 'interpolation'],
    dtmf: ['sequence', 'dutyCycle', 'amplitude'], rhythm: ['tempo', 'beatsPerBar', 'swing', 'clickSound'],
  };
  for (const key of ['frequency', 'amplitude', 'waveform', 'noiseType', 'endFrequency', 'endAmplitude', 'interpolation', 'sequence', 'dutyCycle', 'tempo', 'beatsPerBar', 'swing', 'clickSound'] as const) {
    if (args[key] !== undefined && !allowed[args.kind].includes(key)) ctx.addIssue({ code: 'custom', path: [key], message: `${key} is not used by ${args.kind}` });
  }
});

export async function generate(ops: Ops, input: unknown): Promise<unknown> {
  const args = GenerateSchema.parse(input);
  const command = { tone: 'Tone', noise: 'Noise', silence: 'Silence', chirp: 'Chirp', dtmf: 'DtmfTones', rhythm: 'RhythmTrack' }[args.kind];
  const params: Record<string, ParamValue> = {};
  if (args.kind === 'tone' || args.kind === 'chirp') params.Waveform = args.waveform ?? 'Sine';
  if (args.kind === 'tone') { params.Frequency = args.frequency ?? 440; params.Amplitude = args.amplitude ?? 0.25; }
  if (args.kind === 'noise') { params.Type = args.noiseType ?? 'White'; params.Amplitude = args.amplitude ?? 0.25; }
  if (args.kind === 'chirp') Object.assign(params, { StartFreq: args.frequency ?? 440, EndFreq: args.endFrequency ?? 1320, StartAmp: args.amplitude ?? 0.25, EndAmp: args.endAmplitude ?? 0.1, Interpolation: args.interpolation ?? 'Linear' });
  if (args.kind === 'dtmf') Object.assign(params, { Sequence: (args.sequence ?? '0123456789').toUpperCase(), 'Duty Cycle': args.dutyCycle ?? 55, Amplitude: args.amplitude ?? 0.25 });
  if (args.kind === 'rhythm') Object.assign(params, { TEMPO: args.tempo ?? 120, TIMESIG: args.beatsPerBar ?? 4, SWING: args.swing ?? 0, BARS: 0, 'CLICK-TRACK-DUR': args.duration, OFFSET: 0, 'CLICK-TYPE': args.clickSound ?? 'Metronome', HIGH: 84, LOW: 80 });
  catalogueCommand(command, params);
  let index: number;
  if (args.track === undefined) {
    index = (await ops.tracks()).length;
    safeMenu(args.channels === 2 ? 'NewStereoTrack' : 'NewMonoTrack');
    await ops.run(args.channels === 2 ? 'NewStereoTrack' : 'NewMonoTrack');
  } else index = (await audioTrack(ops, args.track)).index;
  await ops.select({ track: index, start: args.start, end: args.start + args.duration });
  await ops.command(command, params, 600_000);
  if (args.name !== undefined) await ops.command('SetTrack', { Name: args.name });
  return { kind: args.kind, track: index, start: args.start, end: args.start + args.duration, name: (await ops.tracks())[index]?.name };
}

interface ClipInfo { track: number; clip?: number; start: number; end: number; name?: string }

export const ClipSetSchema = z.object({
  track: Track,
  at: Seconds.describe('time inside the clip; name/color require a point strictly after its start and before its end'),
  name: SafeString.optional(),
  gainDb: Gain.optional().describe('relative sample gain applied destructively with Amplify to this clip'),
  color: z.enum(['Color0', 'Color1', 'Color2', 'Color3']).optional(),
}).strict().refine((a) => a.name !== undefined || a.gainDb !== undefined || a.color !== undefined, { message: 'supply name, gainDb or color' });

export async function clipSet(ops: Ops, input: unknown): Promise<unknown> {
  const args = ClipSetSchema.parse(input);
  const { index } = await audioTrack(ops, args.track);
  const clips = await ops.info('Clips') as ClipInfo[];
  const matches = clips.filter((clip) => clip.track === index && clip.start <= args.at && args.at < clip.end);
  if (matches.length !== 1) throw new Error(`time ${args.at}s identifies ${matches.length} clips on track ${index}; choose a point inside one clip`);
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
  return { track: index, start: clip.start, end: clip.end, name: args.name ?? clip.name, gainDbApplied: args.gainDb, color: args.color };
}

const TRACK_COMMANDS = {
  remove: 'RemoveTracks', mix: 'MixAndRender', mix_new: 'MixAndRenderToNewTrack',
  align_end_to_end: 'Align_EndToEnd', align_together: 'Align_Together', align_start_zero: 'Align_StartToZero',
  align_start_cursor: 'Align_StartToSelStart', align_start_end: 'Align_StartToSelEnd',
  align_end_cursor: 'Align_EndToSelStart', align_end_end: 'Align_EndToSelEnd',
} as const;

export const TrackEditSchema = z.object({
  action: z.enum(['add_mono', 'add_stereo', 'add_label', 'remove', 'mix', 'mix_new', 'align_end_to_end', 'align_together', 'align_start_zero', 'align_start_cursor', 'align_start_end', 'align_end_cursor', 'align_end_end']),
  track: Track.optional(),
  trackCount: z.number().int().min(1).max(256).default(1),
  name: SafeString.min(1).optional(),
  start: Seconds.optional(),
  end: Seconds.optional(),
}).strict().superRefine((a, ctx) => {
  const add = a.action.startsWith('add_');
  if (!add && a.track === undefined) ctx.addIssue({ code: 'custom', path: ['track'], message: 'track is required for this action' });
  if (add && (a.track !== undefined || a.start !== undefined || a.end !== undefined)) ctx.addIssue({ code: 'custom', message: 'add actions accept no existing track or time range' });
  if (add && a.trackCount !== 1) ctx.addIssue({ code: 'custom', path: ['trackCount'], message: 'add actions create exactly one track' });
  if (!add && a.name !== undefined) ctx.addIssue({ code: 'custom', path: ['name'], message: 'name is only used when adding a track' });
  if (a.start !== undefined && a.end !== undefined && a.end < a.start) ctx.addIssue({ code: 'custom', message: 'end must not be before start' });
});

export async function trackEdit(ops: Ops, input: unknown): Promise<unknown> {
  const args = TrackEditSchema.parse(input);
  if (args.action === 'add_mono' || args.action === 'add_stereo' || args.action === 'add_label') {
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
  if (args.action !== 'remove' && selected.some((t) => t.kind !== 'wave')) throw new Error('mix and alignment require audio tracks');
  // GetInfo omits start/end for label tracks (live 3.7.8, 2026-10-02).
  // Removal only needs track selection; use a finite zero-time fallback.
  const start = args.start ?? Math.min(...selected.map((t) => t.start ?? 0));
  const end = args.end ?? Math.max(...selected.map((t) => t.end ?? 0));
  await ops.select({ track: index, trackCount: args.trackCount, start, end });
  const reply = await ops.run(command, {}, 600_000);
  return { action: args.action, reply, tracks: await ops.tracks() };
}

export const FadeSchema = z.object({
  ...Scope,
  direction: z.enum(['in', 'out']),
}).strict().refine(validRange, { message: 'end must be after start' });

export async function fade(ops: Ops, input: unknown): Promise<unknown> {
  const args = FadeSchema.parse(input);
  const command = args.direction === 'in' ? 'FadeIn' : 'FadeOut';
  catalogueCommand(command, {});
  const range = await resolveRange(ops, args);
  await ops.select(range);
  await ops.command(command, {}, 600_000);
  return { ...range, direction: args.direction };
}

export const AutoDuckSchema = z.object({
  bed: Track,
  voice: Track,
  start: Seconds.optional(),
  end: Seconds.optional(),
  duckDb: z.number().finite().min(-60).max(0).default(-12),
  thresholdDb: z.number().finite().min(-100).max(0).default(-30),
  fadeDown: z.number().finite().min(0).max(10).default(0.5),
  fadeUp: z.number().finite().min(0).max(10).default(0.5),
  innerFadeDown: z.number().finite().min(0).max(10).default(0),
  innerFadeUp: z.number().finite().min(0).max(10).default(0),
  maximumPause: z.number().finite().min(0).max(60).default(1),
  dryRun: z.boolean().default(false),
}).strict().refine(validRange, { message: 'end must be after start' });

export async function autoDuck(ops: Ops, input: unknown): Promise<unknown> {
  const args = AutoDuckSchema.parse(input);
  const bed = await audioTrack(ops, args.bed);
  const voice = await audioTrack(ops, args.voice);
  const tracks = await ops.tracks();
  const nextAudio = tracks.findIndex((track, index) => index > bed.index && track.kind === 'wave');
  if (voice.index !== nextAudio) throw new Error('Auto Duck requires the voice to be the next audio track below the bed; reorder the tracks first');
  const params = { DuckAmountDb: args.duckDb, ThresholdDb: args.thresholdDb, OuterFadeDownLen: args.fadeDown, OuterFadeUpLen: args.fadeUp, InnerFadeDownLen: args.innerFadeDown, InnerFadeUpLen: args.innerFadeUp, MaximumPause: args.maximumPause };
  catalogueCommand('AutoDuck', params);
  const scope = await resolveRange(ops, { track: bed.index, start: args.start, end: args.end });
  if (args.dryRun) return { dryRun: true, command: 'AutoDuck', params, scope, voice: voice.index };
  await ops.select(scope); // The unselected next audio track is Audacity's control track.
  await ops.command('AutoDuck', params, 600_000);
  return { dryRun: false, bed: bed.index, voice: voice.index, params, scope };
}

function safeMenu(command: string): void {
  if (!MENU_IDS.includes(command)) throw new Error(`task command is not a safe catalogue menu item: ${command}`);
}

async function audioTrack(ops: Ops, ref: TrackRef): Promise<{ index: number; info: TrackInfo }> {
  const index = await ops.trackIndex(ref);
  const info = (await ops.tracks())[index]!;
  if (info.kind !== 'wave') throw new Error(`track ${index} is ${info.kind}, not an audio track`);
  return { index, info };
}

async function resolveRange(ops: Ops, scope: { track: TrackRef; start?: number; end?: number }): Promise<{ track: number; start: number; end: number }> {
  const { index, info } = await audioTrack(ops, scope.track);
  const start = scope.start ?? info.start;
  const end = scope.end ?? info.end;
  if (!(end > start)) throw new Error(`nothing to process between ${start}s and ${end}s on track ${index}`);
  return { track: index, start, end };
}
