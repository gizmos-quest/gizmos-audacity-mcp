import { beforeEach, describe, expect, it, vi } from 'vitest';
import { pipeline, planPipeline } from '../../src/tasks/pipeline.js';
import { fixture, mutations } from '../helpers/noise-fixture.js';

const { measureScopeMock, measureSourceFramesMock, measureSourceRateMock } = vi.hoisted(() => ({
  measureScopeMock: vi.fn(),
  measureSourceFramesMock: vi.fn(),
  measureSourceRateMock: vi.fn(),
}));
vi.mock('../../src/analysis/render.js', async (importOriginal) => ({
  ...(await importOriginal<typeof import('../../src/analysis/render.js')>()),
  measureScope: measureScopeMock,
}));
vi.mock('../../src/source-rate.js', () => ({
  measureSourceFrames: measureSourceFramesMock,
  measureSourceRate: measureSourceRateMock,
}));

beforeEach(() => {
  measureScopeMock.mockReset().mockResolvedValue({ frames: 4096 });
  measureSourceFramesMock.mockReset().mockResolvedValue(4096);
  measureSourceRateMock.mockReset().mockResolvedValue(48_000);
});

describe('noise-aware pipeline dispatch', () => {
  it('marks profile capture separately from reduction in dry-run steps with no invented parameters', () => {
    const plan = planPipeline({ track: 0, noiseProfile: { start: 0, end: 0.25 } });
    expect(plan.steps.slice(0, 2)).toMatchObject([
      { command: 'NoiseReduction', params: {}, captureProfile: true, scope: { track: 0, start: 0, end: 0.25 } },
      { command: 'NoiseReduction', params: {}, scope: { track: 0 } },
    ]);
    expect(plan.steps[1]?.captureProfile).toBeUndefined();
    expect(plan.notes.join(' ')).toContain('saved noise-reduction settings');
  });

  it('dispatches the profile stage to captureNoiseProfile and the reduction stage to command', async () => {
    const project = fixture();
    project.ops.freshApplication();
    const capture = vi.spyOn(project.ops, 'captureNoiseProfile');
    const command = vi.spyOn(project.ops, 'command');
    await pipeline(project.ops, {
      track: 0,
      preset: 'cleanup',
      removeDc: false,
      noiseProfile: { start: 0, end: 0.25 },
    });
    expect(capture).toHaveBeenCalledExactlyOnceWith(0, 0, 0.25);
    expect(command.mock.calls.filter(([id]) => id === 'NoiseReduction')).toEqual([['NoiseReduction', {}, 600_000]]);
    expect(project.calls.filter((line) => line === 'NoiseReduction:')).toHaveLength(2);
    expect(measureScopeMock).toHaveBeenCalledTimes(1);
  });

  it('reuses an already captured interval when a pipeline requests it', async () => {
    const project = fixture();
    project.ops.freshApplication();
    await project.ops.captureNoiseProfile(0, 0, 0.25);
    project.calls.length = 0;
    await pipeline(project.ops, {
      track: 0,
      preset: 'cleanup',
      removeDc: false,
      noiseProfile: { start: 0, end: 0.25 },
    });
    expect(project.calls.filter((line) => line === 'NoiseReduction:')).toHaveLength(1);
    expect(measureScopeMock).toHaveBeenCalledTimes(1);
  });

  it('refuses an unknown native profile before any pipeline mutation', async () => {
    const project = fixture();
    await expect(pipeline(project.ops, { track: 0, noiseProfile: { start: 0, end: 0.25 } })).rejects.toThrow(
      /0 completed steps.*state is unknown/,
    );
    expect(mutations(project.calls)).toEqual([]);
    expect(measureScopeMock).not.toHaveBeenCalled();
  });
});
