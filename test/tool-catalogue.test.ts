import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { Ops } from '../src/ops.js';
import { registerCatalogueTools } from '../src/tool-catalogue.js';
import { toolRecorder } from './helpers/tool-recorder.js';

const pipeExists = vi.hoisted(() => vi.fn());
vi.mock('../src/app.js', () => ({ pipeExists }));
beforeEach(() => pipeExists.mockReset().mockReturnValue(true));

function session() {
  const ops = {
    tracks: vi.fn(async () => [{ name: 'Voice', kind: 'wave' }]),
    info: vi.fn(async () => []),
    command: vi.fn(async () => 'command body'),
    run: vi.fn(async () => 'menu body'),
  };
  const recorder = toolRecorder();
  registerCatalogueTools(recorder.register, ops as unknown as Ops);
  return { ...recorder, ops };
}

describe('catalogue tools', () => {
  it('only reads native tracks when a pipe is present', async () => {
    const { call, ops } = session();
    expect(await call('audacity_status')).toEqual({ running: true, tracks: [{ name: 'Voice', kind: 'wave' }] });
    pipeExists.mockReturnValueOnce(false);
    expect(await call('audacity_status')).toEqual({ running: false });
    expect(ops.tracks).toHaveBeenCalledOnce();
  });
  it('retains raw array info and bundled catalogue descriptions', async () => {
    const { call, ops } = session();
    expect(await call('audacity_info', { type: 'Clips' })).toEqual([]);
    expect(ops.info).toHaveBeenCalledExactlyOnceWith('Clips');
    expect(await call('audacity_describe', { command: 'SetTrack' })).toMatchObject({
      id: 'SetTrack',
      params: expect.any(Array),
    });
  });
  it('uses the safe generic operations with compatible defaults/timeouts', async () => {
    const { call, ops } = session();
    ops.tracks.mockResolvedValue([{ name: 'Voice', kind: 'wave', selected: 1 }] as never);
    ops.info.mockResolvedValue({ Start: 0, End: 1 } as never);
    expect(await call('audacity_command', { command: 'FadeIn' })).toBe('command body');
    expect(ops.command).toHaveBeenCalledExactlyOnceWith('FadeIn', {}, 600000);
    expect(await call('audacity_menu', { command: 'FitInWindow' })).toBe('menu body');
    expect(ops.run).toHaveBeenCalledExactlyOnceWith('FitInWindow');
    await expect(call('audacity_command', { command: 'Message' })).rejects.toThrow();
    await expect(call('audacity_menu', { command: 'New' })).rejects.toThrow();
    expect(ops.command).toHaveBeenCalledOnce();
    expect(ops.run).toHaveBeenCalledOnce();
  });
  it.each([
    ['an empty time selection', { Start: 1, End: 1 }, [{ name: 'Voice', kind: 'wave', selected: 1 }]],
    ['no selected track', { Start: 0, End: 1 }, [{ name: 'Voice', kind: 'wave', selected: 0 }]],
    ['only a time track', { Start: 0, End: 1 }, [{ name: 'Time', kind: 'time', selected: 1 }]],
  ])('refuses a generic effect with %s before Audacity shows its selection dialog', async (_, selection, tracks) => {
    const { call, ops } = session();
    ops.info.mockResolvedValue(selection as never);
    ops.tracks.mockResolvedValue(tracks as never);
    await expect(call('audacity_command', { command: 'Amplify', params: { Ratio: 2 } })).rejects.toThrow(
      'non-empty time selection',
    );
    await expect(call('audacity_command', { command: 'Tone', params: {} })).rejects.toThrow('non-empty time selection');
    expect(ops.command).not.toHaveBeenCalled();
  });
  it('validates generic parameters before reading the selection', async () => {
    const { call, ops } = session();
    await expect(call('audacity_command', { command: 'Compressor', params: { attackMs: 500 } })).rejects.toThrow();
    expect(ops.info).not.toHaveBeenCalled();
    expect(ops.command).not.toHaveBeenCalled();
  });
});
