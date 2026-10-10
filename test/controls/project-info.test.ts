import { beforeEach, describe, expect, it, vi } from 'vitest';
import { z } from 'zod';
import { registerProjectInfoTools } from '../../src/controls/project-info.js';
import type { Ops, TrackInfo } from '../../src/ops.js';
import type { ToolRegistrar } from '../../src/tools.js';

const measured = vi.hoisted(() => vi.fn());
vi.mock('../../src/analysis/render.js', () => ({ measureScope: measured }));
vi.mock('../../src/app-config.js', () => ({ recoveryEntries: () => ['example.aup3'] }));
beforeEach(() => {
  measured.mockReset().mockResolvedValue({ sampleRate: 48000 });
});

function fixture(tracks: TrackInfo[] = []) {
  const values = new Map([
    ['/SamplingRate/DefaultProjectSampleRate', '44100'],
    ['/AudioIO/RecordChannels', '1'],
  ]);
  const ops = {
    tracks: vi.fn(async () => tracks),
    projectEnd: vi.fn(async () => 10),
    info: vi.fn(async (type: string) => ({ type })),
    command: vi.fn(async (_command: string, params: { Name: string }) => values.get(params.Name) ?? ''),
    run: vi.fn(async (command: string, params?: { Name: string; Value: string }) => {
      if (command === 'SetPreference' && params) values.set(params.Name, params.Value);
      return '';
    }),
  };
  const handlers = new Map<string, (args: unknown) => Promise<unknown>>();
  const tool: ToolRegistrar = (name, _description, shape, handler) => {
    handlers.set(name, (args) => handler(z.object(shape).strict().parse(args)));
  };
  registerProjectInfoTools(tool, ops as unknown as Ops);
  return { ops, call: (name: string, args: unknown) => handlers.get(name)!(args) };
}

describe('project data and history registrations', () => {
  it('reports an empty project rate as unknown rather than the default preference', async () => {
    const state = fixture();
    expect(await state.call('audacity_project_info', {})).toMatchObject({
      rate: null,
      defaultRate: 44100,
      activeProjectFiles: ['example.aup3'],
    });
    expect(measured).not.toHaveBeenCalled();
  });
  it('queries actual rendered rate over a tiny scoped export for audio projects', async () => {
    const tracks = [{ name: 'Voice', kind: 'wave', start: 2, end: 10 }];
    const state = fixture(tracks);
    expect(await state.call('audacity_project_info', {})).toMatchObject({ tracks, rate: 48000, defaultRate: 44100 });
    expect(measured).toHaveBeenCalledWith(state.ops, { track: 0, start: 2, end: 2.01 }, { backend: 'wav' });
  });
  it('runs the requested existing native history states and preserves a failure message', async () => {
    const state = fixture();
    expect(await state.call('audacity_history', { action: 'redo', steps: 2 })).toEqual({
      action: 'redo',
      completed: 2,
    });
    expect(state.ops.run.mock.calls).toEqual([['Redo'], ['Redo']]);
    state.ops.run.mockRejectedValueOnce(new Error('native history exhausted'));
    await expect(state.call('audacity_history', { action: 'undo' })).rejects.toThrow('native history exhausted');
  });
});
