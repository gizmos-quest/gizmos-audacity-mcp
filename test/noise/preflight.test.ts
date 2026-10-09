import { beforeEach, describe, expect, it, vi } from 'vitest';
import { Ops, type TrackInfo } from '../../src/ops.js';
import { AudacityPipe, AudacityTimeout, type PipeReply } from '../../src/pipe.js';
import { PipelineSchema } from '../../src/tasks.js';

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

describe('profile measurement and input preflight', () => {
  it.each([0, 800, 2047, 4095])(
    'refuses %i source samples even when a project-rate render has enough frames',
    async (frames) => {
      const project = fixture();
      project.ops.freshApplication();
      measureScopeMock.mockResolvedValue({ frames: 4800 });
      measureSourceRateMock.mockResolvedValueOnce(frames / 0.25);
      await expect(project.ops.captureNoiseProfile(0, 0, 0.25)).rejects.toThrow('at least 4096 source samples');
      expect(mutations(project.calls)).toEqual([]);
      await project.ops.captureNoiseProfile(0, 0, 0.5);
      expect(project.calls.filter((command) => command === 'NoiseReduction:')).toHaveLength(1);
    },
  );

  it('refuses gap-spanning room tone before either measurement or native profile capture', async () => {
    const project = fixture();
    project.ops.freshApplication();
    project.clips.splice(0, 1, { track: 0, start: 0, end: 1 }, { track: 0, start: 2, end: 10 });
    await expect(project.ops.captureNoiseProfile(0, 0.9, 2.1)).rejects.toThrow('contained in one audio clip');
    expect(measureScopeMock).not.toHaveBeenCalled();
    expect(measureSourceFramesMock).not.toHaveBeenCalled();
    expect(mutations(project.calls)).toEqual([]);
  });

  it('preserves source-rate query errors without starting or poisoning profile capture', async () => {
    const project = fixture();
    project.ops.freshApplication();
    measureSourceRateMock.mockRejectedValueOnce(new Error('Audacity own source export failure'));
    await expect(project.ops.captureNoiseProfile(0, 0, 0.25)).rejects.toThrow('Audacity own source export failure');
    expect(mutations(project.calls)).toEqual([]);
    await project.ops.captureNoiseProfile(0, 0, 0.25);
    expect(project.calls.filter((command) => command === 'NoiseReduction:')).toHaveLength(1);
  });

  it('refuses a second clip partially overlapping room tone before measurement or capture', async () => {
    const project = fixture();
    project.ops.freshApplication();
    project.clips.push({ track: 0, start: 0.2, end: 0.4 });
    await expect(project.ops.captureNoiseProfile(0, 0, 0.25)).rejects.toThrow('contained in one audio clip');
    expect(measureScopeMock).not.toHaveBeenCalled();
    expect(measureSourceFramesMock).not.toHaveBeenCalled();
    expect(mutations(project.calls)).toEqual([]);
  });

  it.each([0, 1, 2047, 4095])(
    'refuses %i rendered samples before native profile selection or capture',
    async (frames) => {
      const project = fixture();
      project.ops.freshApplication();
      measureScopeMock.mockResolvedValueOnce({ frames });
      await expect(project.ops.captureNoiseProfile(0, 0, 0.25)).rejects.toThrow('at least 4096 rendered samples');
      expect(mutations(project.calls)).toEqual([]);
      // No native profile call happened, so a longer interval can still capture.
      await project.ops.captureNoiseProfile(0, 0, 0.5);
      expect(mutations(project.calls)).toEqual([
        'Select: Mode=Set Track=0 TrackCount=1 Start=0 End=0.5',
        'NoiseReduction:',
      ]);
    },
  );

  it('preserves measurement errors without poisoning a not-yet-captured profile', async () => {
    const project = fixture();
    project.ops.freshApplication();
    measureScopeMock.mockRejectedValueOnce(new Error('Audacity own measurement export error'));
    await expect(project.ops.captureNoiseProfile(0, 0, 0.25)).rejects.toThrow('Audacity own measurement export error');
    expect(mutations(project.calls)).toEqual([]);
    await project.ops.captureNoiseProfile(0, 0, 0.25);
    expect(project.calls.filter((command) => command.startsWith('NoiseReduction:'))).toHaveLength(1);
  });

  it.each([
    { track: 0, start: 1, end: 1 },
    { track: 0, start: 2, end: 1 },
    { track: 0, start: -1, end: 1 },
    { track: 0, start: 9, end: 11 },
    { track: 0, start: Number.NaN, end: 1 },
    { track: 2, start: 0, end: 1 },
  ])('rejects invalid or non-audio room tone before measurement or mutation %#', async (scope) => {
    const project = fixture();
    project.ops.freshApplication();
    await expect(project.ops.captureNoiseProfile(scope.track, scope.start, scope.end)).rejects.toThrow(
      'non-empty interval inside an audio track',
    );
    expect(measureScopeMock).not.toHaveBeenCalled();
    expect(mutations(project.calls)).toEqual([]);
  });

  it.each([{ Reduction: 12 }, { Sensitivity: 6 }, { Smoothing: 3 }])(
    'rejects unsupported saved-setting aliases before effect selection %#',
    async (params) => {
      const project = fixture();
      project.ops.freshApplication();
      await expect(project.ops.applyEffect('NoiseReduction', params, { track: 0, start: 0, end: 1 })).rejects.toThrow();
      expect(project.calls).toEqual([]);
      expect(() => project.ops.command('NoiseReduction', params)).toThrow();
      expect(project.calls).toEqual([]);
    },
  );

  it.each(['reductionDb', 'sensitivity', 'smoothing'])(
    'rejects unsupported pipeline profile setting %s strictly',
    (key) => {
      expect(() => PipelineSchema.parse({ track: 0, noiseProfile: { start: 0, end: 0.25, [key]: 3 } })).toThrow();
    },
  );
});
