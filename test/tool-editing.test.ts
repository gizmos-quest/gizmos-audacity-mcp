import { beforeEach, describe, expect, it, vi } from 'vitest';
import { type Ops, validateProjectFile } from '../src/ops.js';
import { registerEditingTools } from '../src/tool-editing.js';
import { toolRecorder } from './helpers/tool-recorder.js';

vi.mock('../src/ops.js', async (original) => ({
  ...(await original<typeof import('../src/ops.js')>()),
  validateProjectFile: vi.fn(),
}));

function session() {
  const ops = {
    select: vi.fn(async () => undefined),
    tracks: vi.fn(async () => [{ name: 'Voice', kind: 'wave', start: 0, end: 2 }]),
    trackIndex: vi.fn(async () => 0),
    run: vi.fn(async () => 'native body'),
    importTrack: vi.fn(async () => ({ track: 0, name: 'Voice' })),
    moveClip: vi.fn(async () => undefined),
    setEnvelope: vi.fn(async () => 2),
    setLabels: vi.fn(async () => 1),
    applyEffect: vi.fn(async () => 'native effect'),
    captureNoiseProfile: vi.fn(async () => undefined),
    exportMix: vi.fn(async () => undefined),
  };
  const recorder = toolRecorder();
  registerEditingTools(recorder.register, ops as unknown as Ops);
  return { ...recorder, ops };
}

beforeEach(() => vi.clearAllMocks());

describe('editing tool contracts', () => {
  it('forwards selection/import defaults without changing public argument shape', async () => {
    const { call, ops } = session();
    expect(await call('audacity_select', { track: 'Voice' })).toBe('selected');
    expect(ops.select).toHaveBeenCalledExactlyOnceWith({ track: 'Voice' });
    expect(await call('audacity_import', { file: 'source.wav', name: 'Voice' })).toEqual({ track: 0, name: 'Voice' });
    expect(ops.importTrack).toHaveBeenCalledExactlyOnceWith('source.wav', 'Voice', 0);
  });

  it('rejects empty setter before target lookup and selects before native setter', async () => {
    const { call, ops } = session();
    await expect(call('audacity_track_set', { track: 0 })).rejects.toThrow('at least one');
    expect(ops.trackIndex).not.toHaveBeenCalled();
    expect(
      await call('audacity_track_set', {
        track: 'Voice',
        gainDb: -6,
        pan: 0.25,
        name: 'Updated',
        mute: false,
        solo: true,
      }),
    ).toMatchObject({ kind: 'wave' });
    expect(ops.run.mock.calls).toEqual([
      ['SelectTracks', { Track: 0, TrackCount: 1, Mode: 'Set' }],
      ['SetTrack', { Name: 'Updated', Volume: -6, Pan: 25, Mute: false, Solo: true }],
    ]);
    await call('audacity_track_set', { track: 0, mute: true });
    expect(ops.run).toHaveBeenLastCalledWith('SetTrack', expect.objectContaining({ Pan: undefined, Mute: true }));
  });

  it('retains clip/envelope/label defaults and returns unchanged reports', async () => {
    const { call, ops } = session();
    expect(await call('audacity_clip_move', { track: 0, at: 0.5, start: 1 })).toBe('moved');
    expect(ops.moveClip).toHaveBeenCalledExactlyOnceWith(0, 0.5, 1);
    const points = [
      { time: 0, value: 1 },
      { time: 1, value: 0.5 },
    ];
    expect(await call('audacity_envelope_set', { track: 'Voice', points })).toEqual({ points: 2 });
    expect(ops.setEnvelope).toHaveBeenCalledExactlyOnceWith('Voice', points, true);
    const labels = [{ start: 0, text: 'Opening' }];
    expect(await call('audacity_labels_set', { labels })).toEqual({ labels: 1 });
    expect(ops.setLabels).toHaveBeenCalledExactlyOnceWith(labels, 'Labels');
  });

  it('forwards effect scope and empty params to the shared safe path', async () => {
    const { call, ops } = session();
    expect(await call('audacity_effect', { effect: 'FadeIn', track: 'Voice' })).toBe('native effect');
    expect(ops.applyEffect).toHaveBeenCalledExactlyOnceWith('FadeIn', {}, { track: 'Voice' });
    expect(await call('audacity_noise_profile', { track: 0, start: 0, end: 1 })).toBe('noise profile captured');
    expect(ops.captureNoiseProfile).toHaveBeenCalledExactlyOnceWith(0, 0, 1);
  });

  it('preserves whole-mix export defaults and explicit time selection', async () => {
    const { call, ops } = session();
    expect(await call('audacity_export', { file: 'mix.wav', start: 0, end: 2 })).toEqual({ file: 'mix.wav' });
    expect(ops.exportMix).toHaveBeenCalledExactlyOnceWith('mix.wav', 2, 0, 2);
  });

  it('validates project destination before I/O and refuses nonempty open', async () => {
    const { call, ops } = session();
    await expect(call('audacity_project', { action: 'open', file: 'saved.aup3' })).rejects.toThrow('empty project');
    expect(validateProjectFile).toHaveBeenCalledWith('saved.aup3', false);
    expect(ops.run).not.toHaveBeenCalled();
    ops.tracks.mockResolvedValueOnce([]);
    expect(await call('audacity_project', { action: 'open', file: 'saved.aup3' })).toBe('native body');
    expect(ops.run).toHaveBeenLastCalledWith('OpenProject2', { Filename: 'saved.aup3', AddToHistory: false }, 300000);
    await call('audacity_project', { action: 'save', file: 'new.aup3' });
    expect(validateProjectFile).toHaveBeenLastCalledWith('new.aup3', true);
    expect(ops.run).toHaveBeenLastCalledWith('SaveProject2', { Filename: 'new.aup3', AddToHistory: false }, 300000);
  });

  it('rejects unknown nested inputs before any operation call', async () => {
    const { call, ops } = session();
    await expect(
      call('audacity_envelope_set', { track: 0, points: [{ time: 0, value: 1, ignored: true }] }),
    ).rejects.toThrow();
    expect(ops.setEnvelope).not.toHaveBeenCalled();
  });
});
