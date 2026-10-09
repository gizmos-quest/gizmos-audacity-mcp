import { describe, expect, it, vi } from 'vitest';
import type { Ops } from '../src/ops.js';
import { autoDuck, clipSet, edit, fade, generate, pipeline, trackEdit } from '../src/tasks.js';
import { registerTaskTools } from '../src/tool-tasks.js';
import { toolRecorder } from './helpers/tool-recorder.js';

vi.mock('../src/tasks.js', async (original) => ({
  ...(await original<typeof import('../src/tasks.js')>()),
  pipeline: vi.fn(async () => ({})),
  edit: vi.fn(async () => ({})),
  generate: vi.fn(async () => ({})),
  clipSet: vi.fn(async () => ({})),
  trackEdit: vi.fn(async () => ({})),
  fade: vi.fn(async () => ({})),
  autoDuck: vi.fn(async () => ({})),
}));

describe('task registration contracts', () => {
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
