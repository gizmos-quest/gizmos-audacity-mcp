import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { Ops } from '../src/ops.js';
import { AudacityNeedsRecovery } from '../src/pipe.js';
import { registerLifecycleTools } from '../src/tool-lifecycle.js';
import { toolRecorder } from './helpers/tool-recorder.js';

const native = vi.hoisted(() => ({
  launch: vi.fn(),
  quit: vi.fn(),
  pipeExists: vi.fn(),
  preflight: vi.fn(),
  listWindows: vi.fn(),
  setWindowVisible: vi.fn(),
}));
vi.mock('../src/app.js', () => ({
  launch: native.launch,
  quit: native.quit,
  pipeExists: native.pipeExists,
  preflightExecutableOverride: native.preflight,
  listWindows: native.listWindows,
  setWindowVisible: native.setWindowVisible,
}));

function session() {
  const ops = {
    pipe: { needsRecovery: false },
    freshApplication: vi.fn(),
    unknownApplication: vi.fn(),
    tracks: vi.fn(async () => [] as object[]),
    restoreImportPreferences: vi.fn(async () => undefined),
  };
  const recorder = toolRecorder();
  registerLifecycleTools(recorder.register, ops as unknown as Ops);
  return { ...recorder, ops };
}

beforeEach(() => {
  vi.clearAllMocks();
  native.pipeExists.mockReturnValue(true);
  native.launch.mockResolvedValue({ started: true, visible: false, processes: [] });
  native.quit.mockResolvedValue({});
  native.preflight.mockResolvedValue(undefined);
  native.listWindows.mockResolvedValue([]);
  native.setWindowVisible.mockResolvedValue(1);
});

describe('lifecycle tool boundaries', () => {
  it('launch establishes fresh state only after starting a new process', async () => {
    const { call, ops } = session();
    expect(await call('audacity_launch', { visible: false })).toMatchObject({ started: true });
    expect(native.launch).toHaveBeenCalledExactlyOnceWith(false);
    expect(ops.freshApplication).toHaveBeenCalledOnce();
    native.launch.mockResolvedValueOnce({ started: false });
    await call('audacity_launch');
    expect(native.launch).toHaveBeenLastCalledWith(true);
    expect(ops.freshApplication).toHaveBeenCalledOnce();
  });

  it('never attaches while a prior outcome is unknown', async () => {
    const { call, ops } = session();
    ops.pipe.needsRecovery = true;
    await expect(call('audacity_launch')).rejects.toBeInstanceOf(AudacityNeedsRecovery);
    expect(native.launch).not.toHaveBeenCalled();
  });

  it('forwards native dialog/window controls without pipe access', async () => {
    const { call, ops } = session();
    expect(await call('audacity_window', { show: false })).toEqual({ windows: 1 });
    expect(await call('audacity_dialogs')).toEqual({ windows: [] });
    await call('audacity_dialogs', { close: true });
    expect(native.listWindows.mock.calls).toEqual([[false], [true]]);
    expect(native.setWindowVisible).toHaveBeenCalledExactlyOnceWith(false);
    expect(ops.tracks).not.toHaveBeenCalled();
  });

  it('restores pending import choices before quit', async () => {
    const { call, ops } = session();
    await call('audacity_quit', { saveTo: 'keep.aup3' });
    expect(native.quit).toHaveBeenCalledExactlyOnceWith(ops.pipe, 'keep.aup3');
    expect(native.preflight.mock.invocationCallOrder[0]).toBeLessThan(
      ops.restoreImportPreferences.mock.invocationCallOrder[0]!,
    );
    expect(ops.restoreImportPreferences.mock.invocationCallOrder[0]).toBeLessThan(
      native.quit.mock.invocationCallOrder[0]!,
    );
  });

  it('starts a stopped fresh session without a project read or quit', async () => {
    native.pipeExists.mockReturnValueOnce(false);
    const { call, ops } = session();
    expect(await call('audacity_fresh', { visible: false })).toMatchObject({ backedUpTo: null });
    expect(ops.tracks).not.toHaveBeenCalled();
    expect(native.quit).not.toHaveBeenCalled();
    expect(ops.freshApplication).toHaveBeenCalledOnce();
  });

  it('does not establish fresh state when stopped-path launch only attaches', async () => {
    native.pipeExists.mockReturnValueOnce(false);
    native.launch.mockResolvedValueOnce({ started: false });
    const { call, ops } = session();
    await call('audacity_fresh');
    expect(ops.freshApplication).not.toHaveBeenCalled();
    expect(ops.unknownApplication).toHaveBeenCalledOnce();
  });

  it('keeps profile state unknown when a restart attaches to another process', async () => {
    native.launch.mockResolvedValueOnce({ started: false, visible: true, processes: [] });
    const { call, ops } = session();
    await call('audacity_fresh');
    expect(native.quit).toHaveBeenCalledOnce();
    expect(ops.freshApplication).not.toHaveBeenCalled();
    expect(ops.unknownApplication).toHaveBeenCalledOnce();
  });

  it('restarts even an empty project after restoring pending choices', async () => {
    const { call, ops } = session();
    expect(await call('audacity_fresh')).toMatchObject({ backedUpTo: null });
    expect(native.quit).toHaveBeenCalledExactlyOnceWith(ops.pipe);
    expect(native.quit.mock.invocationCallOrder[0]).toBeLessThan(native.launch.mock.invocationCallOrder[0]!);
    expect(ops.freshApplication).toHaveBeenCalledOnce();
  });

  it('requires preservation before restarting a project with tracks', async () => {
    const { call, ops } = session();
    ops.tracks.mockResolvedValue([{ name: 'Voice' }]);
    await expect(call('audacity_fresh')).rejects.toThrow('backupTo');
    expect(native.quit).not.toHaveBeenCalled();
    expect(native.launch).not.toHaveBeenCalled();
    expect(await call('audacity_fresh', { visible: false, backupTo: 'backup.aup3' })).toMatchObject({
      backedUpTo: 'backup.aup3',
    });
    expect(native.quit).toHaveBeenCalledExactlyOnceWith(ops.pipe, 'backup.aup3');
  });

  it('never launches or resets profile state after failed preservation', async () => {
    const { call, ops } = session();
    native.quit.mockRejectedValueOnce(new Error('native save failed'));
    await expect(call('audacity_fresh')).rejects.toThrow('native save failed');
    expect(native.launch).not.toHaveBeenCalled();
    expect(ops.freshApplication).not.toHaveBeenCalled();
  });
});
