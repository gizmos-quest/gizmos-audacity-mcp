import { beforeEach, describe, expect, it, vi } from 'vitest';
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

describe('noise profile process state', () => {
  it.each(['synthetic-process-2', undefined])(
    'refuses capture after the fresh process changes to %s',
    async (identity) => {
      const project = fixture();
      project.ops.freshApplication();
      project.changeIdentity(identity);
      await expect(project.ops.captureNoiseProfile(0, 0, 0.25)).rejects.toThrow('process identity changed');
      expect(measureScopeMock).not.toHaveBeenCalled();
      expect(mutations(project.calls)).toEqual([]);
    },
  );
  it('refuses reduction after an external restart even with identical tracks', async () => {
    const project = fixture();
    project.ops.freshApplication();
    await project.ops.captureNoiseProfile(0, 0, 0.25);
    project.changeIdentity('synthetic-process-2');
    project.calls.length = 0;
    await expect(project.ops.command('NoiseReduction')).rejects.toThrow('process identity changed');
    expect(mutations(project.calls)).toEqual([]);
    expect(() => project.ops.command('NoiseReduction')).toThrow('needs a profile captured');
  });
  it('refuses reduction when the source rate changes without a topology change', async () => {
    const project = fixture();
    project.ops.freshApplication();
    await project.ops.captureNoiseProfile(0, 0, 0.25);
    measureSourceRateMock.mockResolvedValueOnce(8000);
    project.calls.length = 0;
    await expect(project.ops.command('NoiseReduction')).rejects.toThrow('source sample rate changed');
    expect(mutations(project.calls)).toEqual([]);
    expect(() => project.ops.command('NoiseReduction')).toThrow('needs a profile captured');
  });
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
    await expect(project.ops.applyEffect('NoiseReduction', {}, { track: 0, start: 1, end: 2 })).rejects.toThrow(
      'needs a profile captured by this server',
    );
    expect(project.calls).toEqual([]);
  });

  it('measures rendered frames before selecting and capturing the first profile', async () => {
    const project = fixture();
    project.ops.freshApplication();
    await project.ops.captureNoiseProfile('Voice', 0, 0.25);
    expect(measureScopeMock).toHaveBeenCalledExactlyOnceWith(
      project.ops,
      { track: 0, start: 0, end: 0.25 },
      { backend: 'wav' },
    );
    expect(mutations(project.calls)).toEqual([
      'Select: Mode=Set Track=0 TrackCount=1 Start=0 End=0.25',
      'NoiseReduction:',
    ]);
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
    await expect(project.ops.captureNoiseProfile(range.track, range.start, range.end)).rejects.toThrow(
      'one scripted noise profile per process',
    );
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
    expect(mutations(project.calls)).toEqual([
      'Select: Mode=Set Track=1 TrackCount=1 Start=1 End=1.25',
      'NoiseReduction:',
    ]);
  });

  it('applies subsequent reductions with saved native settings and an explicit target range', async () => {
    const project = fixture();
    project.ops.freshApplication();
    await project.ops.captureNoiseProfile(0, 0, 0.25);
    project.calls.length = 0;
    await project.ops.applyEffect('NoiseReduction', {}, { track: 0, start: 1, end: 2 });
    expect(mutations(project.calls)).toEqual([
      'Select: Mode=Set Track=0 TrackCount=1 Start=1 End=2',
      'NoiseReduction:',
    ]);
  });

  it.each([{ track: 1 }, { track: 0, trackCount: 2 }])(
    'refuses reduction on a different or multiple audio tracks without invoking the native effect %#',
    async (scope) => {
      const project = fixture();
      project.ops.freshApplication();
      await project.ops.captureNoiseProfile(0, 0, 0.25);
      await project.ops.select({ ...scope, start: 1, end: 2 });
      project.calls.length = 0;
      await expect(project.ops.command('NoiseReduction', {})).rejects.toThrow('only the unchanged audio track');
      expect(mutations(project.calls)).toEqual([]);
    },
  );

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
});
