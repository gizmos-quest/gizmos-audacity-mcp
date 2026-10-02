import { beforeEach, describe, expect, it, vi } from 'vitest';
import { fileURLToPath } from 'node:url';
import { AudacityPipe, AudacityTimeout, type PipeReply } from '../src/pipe.js';
import { Ops, type TrackInfo } from '../src/ops.js';
import { PipelineSchema, pipeline, planPipeline } from '../src/tasks.js';

const { measureScopeMock } = vi.hoisted(() => ({ measureScopeMock: vi.fn() }));
vi.mock('../src/analysis.js', () => ({ measureScope: measureScopeMock }));

function fixture(tracks: TrackInfo[] = [
  { name: 'Voice', kind: 'wave', start: 0, end: 10 },
  { name: 'Other', kind: 'wave', start: 0, end: 10 },
  { name: 'Labels', kind: 'label', start: 0, end: 10 },
]) {
  const calls: string[] = [];
  let rejection: string | undefined;
  let timeout = false;
  const pipe = new AudacityPipe({ to: 'fixture.to', from: 'fixture.from' }, 100,
    async (_paths, command): Promise<PipeReply> => {
      calls.push(command);
      if (command.startsWith('GetInfo:')) return { ok: true, status: 'OK', body: JSON.stringify(tracks) };
      if (command.startsWith('Select:')) {
        const first = Number(/\bTrack=(\d+)/.exec(command)?.[1]);
        const count = Number(/\bTrackCount=(\d+)/.exec(command)?.[1]);
        for (const [index, track] of tracks.entries()) track.selected = Number(index >= first && index < first + count);
      }
      if (command.startsWith('NoiseReduction:')) {
        if (timeout) throw new AudacityTimeout('fixture native profile reply was lost');
        if (rejection) return { ok: false, status: 'Failed!', body: rejection };
      }
      return { ok: true, status: 'OK', body: '' };
    });
  return { ops: new Ops(pipe), pipe, calls, tracks,
    rejectProfile: (text: string) => { rejection = text; },
    loseProfileReply: () => { timeout = true; } };
}

const mutations = (calls: string[]) => calls.filter((command) => !command.startsWith('GetInfo:'));

beforeEach(() => { measureScopeMock.mockReset().mockResolvedValue({ frames: 4096 }); });

describe('noise profile process state', () => {
  it('treats an existing Audacity process as unknown and refuses capture before measurement or mutation', async () => {
    const project = fixture();
    await expect(project.ops.captureNoiseProfile('Voice', 0, 0.25)).rejects.toThrow('state is unknown');
    expect(measureScopeMock).not.toHaveBeenCalled();
    expect(mutations(project.calls)).toEqual([]);
  });

  it.each(['unknown', 'fresh'])('refuses generic reduction in %s state before any pipe call', (state) => {
    const project = fixture();
    if (state === 'fresh') project.ops.freshApplication();
    expect(() => project.ops.command('NoiseReduction', {})).toThrow('needs a profile captured by this server');
    expect(project.calls).toEqual([]);
  });

  it.each(['unknown', 'fresh'])('refuses scoped reduction in %s state before changing selection', async (state) => {
    const project = fixture();
    if (state === 'fresh') project.ops.freshApplication();
    await expect(project.ops.applyEffect('NoiseReduction', {}, { track: 0, start: 1, end: 2 })).rejects.toThrow('needs a profile captured by this server');
    expect(project.calls).toEqual([]);
  });

  it('measures rendered frames before selecting and capturing the first profile', async () => {
    const project = fixture();
    project.ops.freshApplication();
    await project.ops.captureNoiseProfile('Voice', 0, 0.25);
    expect(measureScopeMock).toHaveBeenCalledExactlyOnceWith(project.ops, { track: 0, start: 0, end: 0.25 }, { backend: 'wav' });
    expect(mutations(project.calls)).toEqual(['Select: Mode=Set Track=0 TrackCount=1 Start=0 End=0.25', 'NoiseReduction:']);
  });

  it('reuses the exact same resolved track and interval without replaying native capture', async () => {
    const project = fixture();
    project.ops.freshApplication();
    await project.ops.captureNoiseProfile('Voice', 0, 0.25);
    project.calls.length = 0;
    await project.ops.captureNoiseProfile(0, 0, 0.25);
    expect(measureScopeMock).toHaveBeenCalledTimes(1);
    expect(mutations(project.calls)).toEqual([]);
  });

  it.each([
    { track: 1, start: 0, end: 0.25 },
    { track: 0, start: 0.01, end: 0.25 },
    { track: 0, start: 0, end: 0.3 },
  ])('refuses a different room-tone profile before measurement or mutation %#', async (range) => {
    const project = fixture();
    project.ops.freshApplication();
    await project.ops.captureNoiseProfile(0, 0, 0.25);
    project.calls.length = 0;
    await expect(project.ops.captureNoiseProfile(range.track, range.start, range.end)).rejects.toThrow('one scripted noise profile per process');
    expect(measureScopeMock).toHaveBeenCalledTimes(1);
    expect(mutations(project.calls)).toEqual([]);
  });

  it('preserves Audacity capture error text and marks state unknown so capture cannot replay', async () => {
    const project = fixture();
    project.ops.freshApplication();
    project.rejectProfile('Audacity own profile capture failure');
    await expect(project.ops.captureNoiseProfile(0, 0, 0.25)).rejects.toThrow('Audacity own profile capture failure');
    project.calls.length = 0;
    await expect(project.ops.captureNoiseProfile(0, 0, 0.25)).rejects.toThrow('state is unknown');
    expect(() => project.ops.command('NoiseReduction', {})).toThrow('needs a profile captured by this server');
    expect(mutations(project.calls)).toEqual([]);
    expect(measureScopeMock).toHaveBeenCalledTimes(1);
  });

  it('keeps unknown capture state after a lost reply even when the pipe is explicitly reset', async () => {
    const project = fixture();
    project.ops.freshApplication();
    project.loseProfileReply();
    await expect(project.ops.captureNoiseProfile(0, 0, 0.25)).rejects.toThrow('native profile reply was lost');
    expect(project.pipe.needsRecovery).toBe(true);
    project.pipe.reset();
    project.calls.length = 0;
    await expect(project.ops.captureNoiseProfile(0, 0, 0.25)).rejects.toThrow('state is unknown');
    expect(mutations(project.calls)).toEqual([]);
    expect(measureScopeMock).toHaveBeenCalledTimes(1);
  });

  it('does not treat a pipe reset as a new Audacity application', async () => {
    const project = fixture();
    project.ops.freshApplication();
    await project.ops.captureNoiseProfile(0, 0, 0.25);
    project.pipe.reset();
    project.calls.length = 0;
    await expect(project.ops.captureNoiseProfile(0, 1, 1.25)).rejects.toThrow('one scripted noise profile per process');
    expect(mutations(project.calls)).toEqual([]);
  });

  it('allows a new capture only after the caller reports a fresh application', async () => {
    const project = fixture();
    project.ops.freshApplication();
    await project.ops.captureNoiseProfile(0, 0, 0.25);
    project.ops.freshApplication();
    project.calls.length = 0;
    await project.ops.captureNoiseProfile(1, 1, 1.25);
    expect(measureScopeMock).toHaveBeenCalledTimes(2);
    expect(mutations(project.calls)).toEqual(['Select: Mode=Set Track=1 TrackCount=1 Start=1 End=1.25', 'NoiseReduction:']);
  });

  it('applies subsequent reductions with saved native settings and an explicit target range', async () => {
    const project = fixture();
    project.ops.freshApplication();
    await project.ops.captureNoiseProfile(0, 0, 0.25);
    project.calls.length = 0;
    await project.ops.applyEffect('NoiseReduction', {}, { track: 0, start: 1, end: 2 });
    expect(mutations(project.calls)).toEqual(['Select: Mode=Set Track=0 TrackCount=1 Start=1 End=2', 'NoiseReduction:']);
  });

  it.each([
    { track: 1 }, { track: 0, trackCount: 2 },
  ])('refuses reduction on a different or multiple audio tracks without invoking the native effect %#', async (scope) => {
    const project = fixture();
    project.ops.freshApplication();
    await project.ops.captureNoiseProfile(0, 0, 0.25);
    await project.ops.select({ ...scope, start: 1, end: 2 });
    project.calls.length = 0;
    await expect(project.ops.command('NoiseReduction', {})).rejects.toThrow('only the unchanged audio track');
    expect(mutations(project.calls)).toEqual([]);
  });

  it('refuses reduction with no selected audio before invoking the native effect', async () => {
    const project = fixture();
    project.ops.freshApplication();
    await project.ops.captureNoiseProfile(0, 0, 0.25);
    for (const track of project.tracks) track.selected = 0;
    project.calls.length = 0;
    await expect(project.ops.command('NoiseReduction', {})).rejects.toThrow('only the unchanged audio track');
    expect(mutations(project.calls)).toEqual([]);
  });

  it('refuses reduction after the profiled track identity changes', async () => {
    const project = fixture();
    project.ops.freshApplication();
    await project.ops.captureNoiseProfile(0, 0, 0.25);
    project.tracks[0]!.name = 'Replacement';
    project.calls.length = 0;
    await expect(project.ops.command('NoiseReduction', {})).rejects.toThrow('only the unchanged audio track');
    expect(mutations(project.calls)).toEqual([]);
  });

  it.each(['NewMonoTrack', 'NewStereoTrack', 'NewLabelTrack', 'RemoveTracks', 'MixAndRender', 'MixAndRenderToNewTrack', 'Duplicate', 'SplitNew', 'Undo', 'Redo'])('invalidates a captured profile after track-structure/history command %s', async (id) => {
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
    ['run', 'SetTrack'], ['run', 'SetTrackStatus'], ['command', 'SetTrack'], ['command', 'SetTrackStatus'],
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

describe('profile measurement and input preflight', () => {
  it.each([0, 1, 2047, 4095])('refuses %i rendered samples before native profile selection or capture', async (frames) => {
    const project = fixture();
    project.ops.freshApplication();
    measureScopeMock.mockResolvedValueOnce({ frames });
    await expect(project.ops.captureNoiseProfile(0, 0, 0.25)).rejects.toThrow('at least 4096 rendered samples');
    expect(mutations(project.calls)).toEqual([]);
    // No native profile call happened, so a longer interval can still capture.
    await project.ops.captureNoiseProfile(0, 0, 0.5);
    expect(mutations(project.calls)).toEqual(['Select: Mode=Set Track=0 TrackCount=1 Start=0 End=0.5', 'NoiseReduction:']);
  });

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
    { track: 0, start: 1, end: 1 }, { track: 0, start: 2, end: 1 },
    { track: 0, start: -1, end: 1 }, { track: 0, start: 9, end: 11 },
    { track: 0, start: Number.NaN, end: 1 }, { track: 2, start: 0, end: 1 },
  ])('rejects invalid or non-audio room tone before measurement or mutation %#', async (scope) => {
    const project = fixture();
    project.ops.freshApplication();
    await expect(project.ops.captureNoiseProfile(scope.track, scope.start, scope.end)).rejects.toThrow('non-empty interval inside an audio track');
    expect(measureScopeMock).not.toHaveBeenCalled();
    expect(mutations(project.calls)).toEqual([]);
  });

  it.each([{ Reduction: 12 }, { Sensitivity: 6 }, { Smoothing: 3 }])('rejects unsupported saved-setting aliases before effect selection %#', async (params) => {
    const project = fixture();
    project.ops.freshApplication();
    await expect(project.ops.applyEffect('NoiseReduction', params, { track: 0, start: 0, end: 1 })).rejects.toThrow();
    expect(project.calls).toEqual([]);
    expect(() => project.ops.command('NoiseReduction', params)).toThrow();
    expect(project.calls).toEqual([]);
  });

  it.each(['reductionDb', 'sensitivity', 'smoothing'])('rejects unsupported pipeline profile setting %s strictly', (key) => {
    expect(() => PipelineSchema.parse({ track: 0, noiseProfile: { start: 0, end: 0.25, [key]: 3 } })).toThrow();
  });
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
    await pipeline(project.ops, { track: 0, preset: 'cleanup', removeDc: false, noiseProfile: { start: 0, end: 0.25 } });
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
    await pipeline(project.ops, { track: 0, preset: 'cleanup', removeDc: false, noiseProfile: { start: 0, end: 0.25 } });
    expect(project.calls.filter((line) => line === 'NoiseReduction:')).toHaveLength(1);
    expect(measureScopeMock).toHaveBeenCalledTimes(1);
  });

  it('refuses an unknown native profile before any pipeline mutation', async () => {
    const project = fixture();
    await expect(pipeline(project.ops, { track: 0, noiseProfile: { start: 0, end: 0.25 } })).rejects.toThrow(/0 completed steps.*state is unknown/);
    expect(mutations(project.calls)).toEqual([]);
    expect(measureScopeMock).not.toHaveBeenCalled();
  });
});
