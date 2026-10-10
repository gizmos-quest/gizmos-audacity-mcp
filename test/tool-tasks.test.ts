import { describe, expect, it, vi } from 'vitest';
import type { Ops } from '../src/ops.js';
import { autoDuck } from '../src/tasks/duck.js';
import { clipSet, edit, fade, trackEdit } from '../src/tasks/editing.js';
import { generate } from '../src/tasks/generate.js';
import { pipeline } from '../src/tasks/pipeline.js';
import { registerTaskTools } from '../src/tool-tasks.js';
import { toolRecorder } from './helpers/tool-recorder.js';

vi.mock('../src/tasks/duck.js', async (original) => ({
  ...(await original<typeof import('../src/tasks/duck.js')>()),
  autoDuck: vi.fn(async () => ({})),
}));
vi.mock('../src/tasks/editing.js', async (original) => ({
  ...(await original<typeof import('../src/tasks/editing.js')>()),
  edit: vi.fn(async () => ({})),
  clipSet: vi.fn(async () => ({})),
  trackEdit: vi.fn(async () => ({})),
  fade: vi.fn(async () => ({})),
}));
vi.mock('../src/tasks/generate.js', async (original) => ({
  ...(await original<typeof import('../src/tasks/generate.js')>()),
  generate: vi.fn(async () => ({})),
}));
vi.mock('../src/tasks/pipeline.js', async (original) => ({
  ...(await original<typeof import('../src/tasks/pipeline.js')>()),
  pipeline: vi.fn(async () => ({})),
}));

describe('task registration contracts', () => {
  it('describes destructive ducking and retained original mix tracks with practical next steps', () => {
    const descriptions = new Map<string, string>();
    registerTaskTools((name, description) => descriptions.set(name, description), {} as Ops);
    expect(descriptions.get('audacity_auto_duck')).toContain('Destructively duck bed samples');
    expect(descriptions.get('audacity_auto_duck')).toContain('save a project backup first');
    expect(descriptions.get('audacity_auto_duck')).toContain('import the bed first, then voice');
    expect(descriptions.get('audacity_auto_duck')).toContain('audacity_envelope_set for editable ducking');
    expect(descriptions.get('audacity_track_edit')).toContain(
      'mix_new keeps the original tracks audible: mute them before exporting the new mix to avoid doubling',
    );
    expect(descriptions.get('audacity_track_edit')).toContain(
      'Find the new audio track in returned tracks; it can precede label tracks',
    );
  });

  it('keeps each public shape and forwards request-scoped pipeline progress', async () => {
    const ops = {} as Ops;
    const progress = vi.fn(async () => undefined);
    const recorder = toolRecorder();
    registerTaskTools(recorder.register, ops);
    for (const [name, args, action] of [
      ['audacity_pipeline', { track: 'Voice', dryRun: true }, pipeline],
      ['audacity_edit', { action: 'split', track: 0, start: 1, end: 1 }, edit],
      ['audacity_generate', { kind: 'tone' }, generate],
      ['audacity_clip_set', { track: 0, at: 0.5, name: 'Clip' }, clipSet],
      ['audacity_track_edit', { action: 'add_mono', name: 'New' }, trackEdit],
      ['audacity_fade', { track: 0, direction: 'in' }, fade],
      ['audacity_auto_duck', { bed: 0, voice: 1, dryRun: true }, autoDuck],
    ] as const) {
      await recorder.call(name, args, progress);
      expect(action).toHaveBeenCalledWith(
        ops,
        expect.objectContaining(args),
        ...(name === 'audacity_pipeline' ? [progress] : []),
      );
    }
    await expect(recorder.call('audacity_pipeline', { track: 'Voice', ignored: true })).rejects.toThrow();
    expect(pipeline).toHaveBeenCalledOnce();
  });
});
