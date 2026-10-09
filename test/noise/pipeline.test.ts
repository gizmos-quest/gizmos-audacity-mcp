import { beforeEach, describe, expect, it, vi } from 'vitest';
import { Ops, type TrackInfo } from '../../src/ops.js';
import { AudacityPipe, AudacityTimeout, type PipeReply } from '../../src/pipe.js';
import { pipeline, planPipeline } from '../../src/tasks.js';

const { measureScopeMock, measureSourceFramesMock, measureSourceRateMock } = vi.hoisted(() => ({
  measureScopeMock: vi.fn(),
  measureSourceFramesMock: vi.fn(),
  measureSourceRateMock: vi.fn(),
}));
vi.mock('../../src/analysis.js', async (importOriginal) => ({
  ...(await importOriginal<typeof import('../../src/analysis.js')>()),
  measureScope: measureScopeMock,
}));
vi.mock('../../src/source-rate.js', () => ({
  measureSourceFrames: measureSourceFramesMock,
  measureSourceRate: measureSourceRateMock,
}));

function fixture(
  tracks: TrackInfo[] = [
    { name: 'Voice', kind: 'wave', start: 0, end: 10 },
    { name: 'Other', kind: 'wave', start: 0, end: 10 },
    { name: 'Labels', kind: 'label', start: 0, end: 10 },
  ],
) {
  const calls: string[] = [];
  const clips = tracks.flatMap((track, index) =>
    track.kind === 'wave' ? [{ track: index, start: track.start, end: track.end }] : [],
  );
  let rejection: string | undefined;
  let timeout = false;
  let identity: string | undefined = 'synthetic-process-1';
  let selection = { Start: 0, End: 10 };
  const pipe = new AudacityPipe(
    { to: 'fixture.to', from: 'fixture.from' },
    100,
    async (_paths, command): Promise<PipeReply> => {
      calls.push(command);
      if (command.startsWith('GetInfo:'))
        return {
          ok: true,
          status: 'OK',
          body: JSON.stringify(
            command.includes('Type=Clips') ? clips : command.includes('Type=Selection') ? selection : tracks,
          ),
        };
      if (command.startsWith('Select:')) {
        const first = Number(/\bTrack=(\d+)/.exec(command)?.[1]);
        const count = Number(/\bTrackCount=(\d+)/.exec(command)?.[1]);
        for (const [index, track] of tracks.entries()) track.selected = Number(index >= first && index < first + count);
        selection = {
          Start: Number(/\bStart=([\d.]+)/.exec(command)?.[1]),
          End: Number(/\bEnd=([\d.]+)/.exec(command)?.[1]),
        };
      }
      if (command.startsWith('NoiseReduction:')) {
        if (timeout) throw new AudacityTimeout('fixture native profile reply was lost');
        if (rejection) return { ok: false, status: 'Failed!', body: rejection };
      }
      if (command.startsWith('Record') && timeout) throw new AudacityTimeout('fixture recording reply was lost');
      return { ok: true, status: 'OK', body: '' };
    },
  );
  return {
    ops: new Ops(pipe, async () => identity),
    pipe,
    calls,
    tracks,
    clips,
    changeIdentity: (value: string | undefined) => {
      identity = value;
    },
    rejectProfile: (text: string) => {
      rejection = text;
    },
    loseProfileReply: () => {
      timeout = true;
    },
    loseRecordingReply: () => {
      timeout = true;
    },
  };
}

const mutations = (calls: string[]) => calls.filter((command) => !command.startsWith('GetInfo:'));

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
