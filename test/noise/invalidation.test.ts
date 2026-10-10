import { fileURLToPath } from 'node:url';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { Ops, type TrackInfo } from '../../src/ops.js';
import { AudacityPipe, AudacityTimeout, type PipeReply } from '../../src/pipe.js';

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
            command.includes('Type=Clips')
              ? clips
              : command.includes('Type=Selection')
                ? selection
                : command.includes('Type=Menus')
                  ? [
                      { id: 'Undo', label: 'Undo Split' },
                      { id: 'Redo', label: 'Redo Split' },
                    ]
                  : tracks,
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

describe('noise profile invalidation', () => {
  it.each([
    'NewMonoTrack',
    'NewStereoTrack',
    'NewLabelTrack',
    'RemoveTracks',
    'MixAndRender',
    'MixAndRenderToNewTrack',
    'Duplicate',
    'SplitNew',
    'Undo',
    'Redo',
  ])('invalidates a captured profile after track-structure/history command %s', async (id) => {
    const project = fixture();
    project.ops.freshApplication();
    await project.ops.captureNoiseProfile(0, 0, 0.25);
    await project.ops.run(id);
    project.calls.length = 0;
    expect(() => project.ops.command('NoiseReduction', {})).toThrow('needs a profile captured by this server');
    await expect(project.ops.captureNoiseProfile(0, 0, 0.25)).rejects.toThrow('state is unknown');
    expect(mutations(project.calls)).toEqual([]);
    expect(measureScopeMock).toHaveBeenCalledTimes(1);
  });

  it.each([
    ['Record1stChoice', false],
    ['Record2ndChoice', false],
    ['Record1stChoice', true],
    ['Record2ndChoice', true],
  ] as const)('invalidates a profile before %s, including a lost reply: %s', async (command, lostReply) => {
    const project = fixture();
    project.ops.freshApplication();
    await project.ops.captureNoiseProfile(0, 0, 0.25);
    if (lostReply) {
      project.loseRecordingReply();
      await expect(project.ops.record(command)).rejects.toThrow('recording reply was lost');
      expect(project.pipe.needsRecovery).toBe(true);
      project.pipe.reset();
    } else await project.ops.record(command);
    project.calls.length = 0;
    expect(() => project.ops.command('NoiseReduction', {})).toThrow('needs a profile captured by this server');
    await expect(project.ops.captureNoiseProfile(0, 0, 0.25)).rejects.toThrow('state is unknown');
    expect(mutations(project.calls)).toEqual([]);
  });

  it('invalidates a captured profile after catalogue Import2 through the generic command path', async () => {
    const project = fixture();
    project.ops.freshApplication();
    await project.ops.captureNoiseProfile(0, 0, 0.25);
    // This existing fixture source is never imported into a real Audacity;
    // the injected transport verifies the generic path's state transition.
    await project.ops.command('Import2', { Filename: fileURLToPath(import.meta.url) });
    project.calls.length = 0;
    expect(() => project.ops.command('NoiseReduction', {})).toThrow('needs a profile captured by this server');
    await expect(project.ops.captureNoiseProfile(0, 0, 0.25)).rejects.toThrow('state is unknown');
    expect(mutations(project.calls)).toEqual([]);
  });

  it.each([
    ['run', 'SetTrack'],
    ['run', 'SetTrackStatus'],
    ['command', 'SetTrack'],
    ['command', 'SetTrackStatus'],
  ] as const)('invalidates a captured profile after %s %s renames', async (path, id) => {
    const project = fixture();
    project.ops.freshApplication();
    await project.ops.captureNoiseProfile(0, 0, 0.25);
    await project.ops[path](id, { Name: 'Renamed' });
    project.calls.length = 0;
    expect(() => project.ops.command('NoiseReduction', {})).toThrow('needs a profile captured by this server');
    await expect(project.ops.captureNoiseProfile(0, 0, 0.25)).rejects.toThrow('state is unknown');
    expect(mutations(project.calls)).toEqual([]);
  });
});
