import { describe, expect, it, vi } from 'vitest';
import { AutoDuckSchema, autoDuck } from '../../src/tasks/duck.js';
import {
  ClipSetSchema,
  clipSet,
  EditSchema,
  edit,
  FadeSchema,
  fade,
  TrackEditSchema,
  trackEdit,
} from '../../src/tasks/editing.js';
import { GenerateSchema, generate } from '../../src/tasks/generate.js';
import { PipelineSchema, pipeline } from '../../src/tasks/pipeline.js';

vi.mock('../../src/source-rate.js', () => ({ measureSourceRate: vi.fn(async () => 48_000) }));

import { expectNoMutation, mockOps } from '../helpers/task-fixture.js';

describe('strict task contracts', () => {
  it('accepts consistent nonnegative track indices beyond 255', () => {
    expect(PipelineSchema.parse({ track: 256 }).track).toBe(256);
    expect(GenerateSchema.parse({ kind: 'tone', track: 256 }).track).toBe(256);
    expect(EditSchema.parse({ action: 'split', track: 256 }).track).toBe(256);
  });
  it.each([
    ['pipeline', PipelineSchema, { track: 0 }],
    ['edit', EditSchema, { action: 'split', track: 0 }],
    ['generate', GenerateSchema, { kind: 'tone' }],
    ['clip_set', ClipSetSchema, { track: 0, at: 1, name: 'Clip' }],
    ['track_edit', TrackEditSchema, { action: 'add_mono' }],
    ['fade', FadeSchema, { track: 0, direction: 'in' }],
    ['auto_duck', AutoDuckSchema, { bed: 0, voice: 1 }],
  ] as const)('%s rejects unknown root properties', (_name, schema, input) => {
    expect(() => schema.parse({ ...input, typo: true })).toThrow();
  });

  it.each([
    { noiseProfile: { start: 0, end: 1, typo: 0 } },
    { shortenPauses: { minimum: 1, typo: 0 } },
    { noiseProfile: { start: 1, end: 1 } },
    { shortenPauses: { minimum: 0.2, truncateTo: 0.3 } },
  ])('rejects invalid nested pipeline settings %#', (settings) => {
    expect(() => PipelineSchema.parse({ track: 0, ...settings })).toThrow();
  });

  it.each([
    { kind: 'silence', frequency: 440 },
    { kind: 'noise', waveform: 'Sine' },
    { kind: 'tone', endFrequency: 880 },
    { kind: 'dtmf', sequence: 'pause,wait' },
    { kind: 'rhythm', beatsPerBar: 2.5 },
    { kind: 'tone', start: 86_399, duration: 2 },
    { kind: 'tone', frequency: Number.NaN },
    { kind: 'tone', amplitude: Number.POSITIVE_INFINITY },
    { kind: 'chirp', duration: 0 },
    { kind: 'tone', track: 0, channels: 1 },
    { kind: 'tone', track: 0, channels: 2 },
  ])('rejects invalid or irrelevant generation settings %#', (input) => {
    expect(() => GenerateSchema.parse(input)).toThrow();
  });

  it.each(['clickThreshold', 'clickWidth'])('rejects unused click removal option %s', (key) => {
    expect(() => PipelineSchema.parse({ track: 0, [key]: 200 })).toThrow();
  });

  it.each([
    { action: 'remove' },
    { action: 'add_mono', track: 0 },
    { action: 'add_stereo', start: 1 },
    { action: 'add_label', trackCount: 2 },
    { action: 'mix', track: 0, name: 'ignored' },
    { action: 'align_together', track: 0, start: 2, end: 1 },
  ])('rejects ambiguous track-edit settings %#', (input) => {
    expect(() => TrackEditSchema.parse(input)).toThrow();
  });

  it.each([
    [PipelineSchema, { track: 0, start: 1, end: 1 }],
    [FadeSchema, { track: 0, direction: 'in', start: 1, end: 1 }],
    [AutoDuckSchema, { bed: 0, voice: 1, start: 2, end: 1 }],
    [EditSchema, { action: 'split', track: 0, start: 2, end: 1 }],
    [ClipSetSchema, { track: 0, at: 1 }],
    [ClipSetSchema, { track: 0, at: 1, name: 'a"b' }],
  ] as const)('rejects invalid edit scope or clip properties %#', (schema, input) => {
    expect(() => schema.parse(input)).toThrow();
  });

  it.each([
    [pipeline, { track: 0, noiseProfile: { start: 0, end: 1, typo: true } }],
    [edit, { track: 0, action: 'unknown' }],
    [generate, { kind: 'silence', amplitude: 0.25 }],
    [clipSet, { track: 0, at: 1, gainDb: Number.NaN }],
    [trackEdit, { action: 'add_mono', track: 0 }],
    [fade, { track: 0, direction: 'in', start: 2, end: 1 }],
    [autoDuck, { bed: 0, voice: 1, typo: true }],
  ] as const)('validates a task before any pipe interaction %#', async (handler, input) => {
    const mocks = mockOps();
    await expect(handler(mocks.ops, input)).rejects.toThrow();
    expectNoMutation(mocks);
    expect(mocks.tracks).not.toHaveBeenCalled();
    expect(mocks.trackIndex).not.toHaveBeenCalled();
    expect(mocks.info).not.toHaveBeenCalled();
  });
});
