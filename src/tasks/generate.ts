import { z } from 'zod';
import { SafeString } from '../catalogue.js';
import { preflightEffectParameters } from '../effects/parameters.js';
import { catalogueCommand, type ParamValue } from '../format.js';
import type { Ops } from '../ops.js';
import { Seconds, Track } from '../tool-input.js';
import { Amplitude, audioTrack, Frequency, safeMenu, Waveform } from './scope.js';

export const GenerateSchema = z
  .object({
    // DTMF is reserved: scripted DtmfTones ignores the sequence length (catalogue.ts).
    kind: z.enum(['tone', 'noise', 'silence', 'chirp', 'rhythm']),
    track: Track.optional().describe('omit to create a new track; supplying it replaces audio in the range'),
    name: SafeString.min(1).optional(),
    channels: z
      .number()
      .int()
      .min(1)
      .max(2)
      .optional()
      .describe('new-track channel count; defaults to mono and must be omitted for an existing track'),
    start: Seconds.default(0),
    duration: z.number().positive().max(3600).default(1),
    frequency: Frequency.optional(),
    amplitude: Amplitude.optional(),
    waveform: Waveform.optional(),
    noiseType: z.enum(['White', 'Pink', 'Brownian']).optional(),
    endFrequency: Frequency.optional(),
    endAmplitude: Amplitude.optional(),
    interpolation: z.enum(['Linear', 'Logarithmic']).optional(),
    tempo: z.number().min(30).max(300).optional(),
    beatsPerBar: z.number().int().min(1).max(20).optional(),
    swing: z.number().min(-1).max(1).optional(),
    clickSound: z
      .enum([
        'Metronome',
        'Ping (short)',
        'Ping (long)',
        'Cowbell',
        'ResonantNoise',
        'NoiseClick',
        'Drip (short)',
        'Drip (long)',
      ])
      .optional(),
  })
  .strict()
  .superRefine((args, ctx) => {
    if (args.start + args.duration > 86_400)
      ctx.addIssue({ code: 'custom', message: 'generation range exceeds 24 hours' });
    if (args.track !== undefined && args.channels !== undefined)
      ctx.addIssue({
        code: 'custom',
        path: ['channels'],
        message: 'channels is used only when creating a new track; existing tracks retain their channels',
      });
    const allowed: Record<typeof args.kind, string[]> = {
      tone: ['frequency', 'amplitude', 'waveform'],
      noise: ['amplitude', 'noiseType'],
      silence: [],
      chirp: ['frequency', 'amplitude', 'waveform', 'endFrequency', 'endAmplitude', 'interpolation'],
      rhythm: ['tempo', 'beatsPerBar', 'swing', 'clickSound'],
    };
    for (const key of [
      'frequency',
      'amplitude',
      'waveform',
      'noiseType',
      'endFrequency',
      'endAmplitude',
      'interpolation',
      'tempo',
      'beatsPerBar',
      'swing',
      'clickSound',
    ] as const) {
      if (args[key] !== undefined && !allowed[args.kind].includes(key))
        ctx.addIssue({ code: 'custom', path: [key], message: `${key} is not used by ${args.kind}` });
    }
  });

export async function generate(ops: Ops, input: unknown): Promise<unknown> {
  const args = GenerateSchema.parse(input);
  const command = {
    tone: 'Tone',
    noise: 'Noise',
    silence: 'Silence',
    chirp: 'Chirp',
    rhythm: 'RhythmTrack',
  }[args.kind];
  const params: Record<string, ParamValue> = {};
  if (args.kind === 'tone' || args.kind === 'chirp') params.Waveform = args.waveform ?? 'Sine';
  if (args.kind === 'tone') {
    params.Frequency = args.frequency ?? 440;
    params.Amplitude = args.amplitude ?? 0.25;
  }
  if (args.kind === 'noise') {
    params.Type = args.noiseType ?? 'White';
    params.Amplitude = args.amplitude ?? 0.25;
  }
  if (args.kind === 'chirp')
    Object.assign(params, {
      StartFreq: args.frequency ?? 440,
      EndFreq: args.endFrequency ?? 1320,
      StartAmp: args.amplitude ?? 0.25,
      EndAmp: args.endAmplitude ?? 0.1,
      Interpolation: args.interpolation ?? 'Linear',
    });
  if (args.kind === 'rhythm')
    Object.assign(params, {
      TEMPO: args.tempo ?? 120,
      TIMESIG: args.beatsPerBar ?? 4,
      SWING: args.swing ?? 0,
      BARS: 0,
      'CLICK-TRACK-DUR': args.duration,
      OFFSET: 0,
      'CLICK-TYPE': args.clickSound ?? 'Metronome',
      HIGH: 84,
      LOW: 80,
    });
  catalogueCommand(command, params);
  if (args.name !== undefined) catalogueCommand('SetTrack', { Name: args.name });
  preflightEffectParameters(command, params);
  let index: number;
  if (args.track === undefined) {
    const channels = args.channels ?? 1;
    index = (await ops.tracks()).length;
    safeMenu(channels === 2 ? 'NewStereoTrack' : 'NewMonoTrack');
    await ops.run(channels === 2 ? 'NewStereoTrack' : 'NewMonoTrack');
  } else index = (await audioTrack(ops, args.track)).index;
  await ops.select({ track: index, start: args.start, end: args.start + args.duration });
  await ops.command(command, params, 600_000);
  if (args.name !== undefined) await ops.command('SetTrack', { Name: args.name });
  return {
    kind: args.kind,
    track: index,
    start: args.start,
    end: args.start + args.duration,
    name: (await ops.tracks())[index]?.name,
  };
}
