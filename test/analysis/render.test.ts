import { access } from 'node:fs/promises';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { measureScope } from '../../src/analysis/render.js';
import type { TrackInfo } from '../../src/ops.js';
import { AudacityTimeout } from '../../src/pipe.js';
import { directories } from '../helpers/audio-fixture.js';
import { bed, fakeOps, label, voice } from '../helpers/render-fixture.js';

describe('rendered measurement selection transactions', () => {
  it('uses a track extent, preserves controls and restores original noncontiguous selection', async () => {
    const { ops, mock } = fakeOps([voice, bed, label]);
    const measured = await measureScope(ops, { track: 'Voice' }, { backend: 'wav' });
    expect(mock.command).toHaveBeenCalledWith('Select', { Track: 0, TrackCount: 1, Start: 2, End: 3, Mode: 'Set' });
    expect(measured.scope).toEqual({ tracks: [0], start: 2, end: 3 });
    expect(measured).not.toHaveProperty('file');
    expect(mock.command.mock.calls.map(([id]) => id)).toEqual([
      'Select',
      'Export2',
      'SelectTracks',
      'SelectTracks',
      'SelectTime',
    ]);
    expect(mock.run).toHaveBeenCalledWith('SelectNone');
    expect(mock.command).toHaveBeenCalledWith('SelectTracks', { Track: 0, TrackCount: 1, Mode: 'Add' });
    expect(mock.command).toHaveBeenCalledWith('SelectTracks', { Track: 2, TrackCount: 1, Mode: 'Add' });
    expect(mock.command).toHaveBeenLastCalledWith('SelectTime', { Start: 0.25, End: 0.75, RelativeTo: 'ProjectStart' });
    const exported = String(mock.command.mock.calls.find(([id]) => id === 'Export2')![1].Filename);
    await expect(access(exported)).rejects.toThrow();
    expect(mock.command.mock.calls.some(([id]) => id.startsWith('SetTrack'))).toBe(false);
  });
  it('exports mono even when a label track is also selected', async () => {
    const { ops, mock } = fakeOps([voice, label]);
    await measureScope(ops, {}, { backend: 'wav' });
    expect(mock.command.mock.calls.find(([id]) => id === 'Export2')![1].NumChannels).toBe(1);
  });
  it('exports stereo when the selected audio includes a stereo track', async () => {
    const { ops, mock } = fakeOps([voice, bed]);
    await measureScope(ops, { track: 1 }, { backend: 'wav' });
    expect(mock.command.mock.calls.find(([id]) => id === 'Export2')![1].NumChannels).toBe(2);
  });
  it('explicitly reselects current tracks and time to clear label text editing', async () => {
    const { ops, mock } = fakeOps([voice, bed, label], { start: 0.25, end: 0.75 });
    const measured = await measureScope(ops, { currentSelection: true }, { backend: 'wav' });
    expect(measured.scope).toEqual({ tracks: [0, 2], start: 0.25, end: 0.75 });
    expect(mock.run).toHaveBeenCalledTimes(2);
    expect(mock.command.mock.calls.findIndex(([id]) => id === 'SelectTime')).toBeLessThan(
      mock.command.mock.calls.findIndex(([id]) => id === 'Export2'),
    );
  });
  it('warns when measuring rendered muted audio without changing mute', async () => {
    const { ops, mock } = fakeOps([{ ...voice, mute: 1 }]);
    expect((await measureScope(ops, { track: 0 }, { backend: 'wav' })).notes.join(' ')).toContain('muted track');
    expect(mock.command.mock.calls.some(([id]) => id === 'SetTrack')).toBe(false);
  });
  it('restores selection even after Audacity export fails and preserves its error', async () => {
    const { ops, mock } = fakeOps([voice], undefined, 'Audacity own Export2 error');
    await expect(measureScope(ops, { track: 0 }, { backend: 'wav' })).rejects.toThrow('Audacity own Export2 error');
    expect(mock.command).toHaveBeenLastCalledWith('SelectTime', { Start: 0.25, End: 0.75, RelativeTo: 'ProjectStart' });
  });
  it('reports both the original Audacity error and a failed selection restoration', async () => {
    const { ops, mock } = fakeOps([voice], undefined, 'Audacity own Export2 error');
    mock.run.mockRejectedValue(new Error('Audacity own SelectNone error'));
    await expect(measureScope(ops, { track: 0 }, { backend: 'wav' })).rejects.toThrow(
      /Audacity own Export2 error.*Selection restoration also failed: Audacity own SelectNone error/,
    );
  });
  it.each([
    ['empty project', [], {}],
    ['label-only project', [label], {}],
    ['label-only selection', [label], { currentSelection: true }],
    ['out-of-range count', [voice], { track: 0, trackCount: 2 }],
  ])('refuses %s without exporting', async (_name, tracks, scope) => {
    const { ops, mock } = fakeOps(tracks as TrackInfo[]);
    await expect(measureScope(ops, scope, { backend: 'wav' })).rejects.toThrow();
    expect(mock.command.mock.calls.some(([id]) => id === 'Export2')).toBe(false);
    expect(mock.command).not.toHaveBeenCalled();
    expect(mock.run).not.toHaveBeenCalled();
  });
  it.each([{ track: 0, start: 4 }, { track: 0, end: 1 }, { currentSelection: true }])(
    'does not change selection for an empty resolved measurement range %j',
    async (scope) => {
      const { ops, mock } = fakeOps([voice], { start: 1, end: 1 });
      await expect(measureScope(ops, scope, { backend: 'wav' })).rejects.toThrow(/non-empty time selection/);
      expect(mock.command).not.toHaveBeenCalled();
      expect(mock.run).not.toHaveBeenCalled();
    },
  );
  it('retains scratch and the original timeout class without sending restoration commands after an uncertain export', async () => {
    const { ops, mock } = fakeOps([voice]);
    const pipe = { needsRecovery: false };
    Object.assign(ops, { pipe });
    const timeout = new AudacityTimeout('unknown Export2 outcome');
    mock.command.mockImplementation(async (id) => {
      if (id === 'Export2') {
        pipe.needsRecovery = true;
        throw timeout;
      }
      return '';
    });
    await expect(measureScope(ops, { track: 0 }, { backend: 'wav' })).rejects.toBe(timeout);
    expect(timeout.message).toContain('Measurement scratch retained at');
    expect(mock.command.mock.calls.map(([id]) => id)).toEqual(['Select', 'Export2']);
    expect(mock.run).not.toHaveBeenCalled();
    const exported = String(mock.command.mock.calls.find(([id]) => id === 'Export2')![1].Filename);
    const directory = join(exported, '..');
    await expect(access(directory)).resolves.toBeUndefined();
    directories.push(directory);
  });
  it('preserves a restoration timeout class and the native export error while retaining scratch', async () => {
    const { ops, mock } = fakeOps([voice], undefined, 'Native export failure');
    const pipe = { needsRecovery: false };
    Object.assign(ops, { pipe });
    const timeout = new AudacityTimeout('no restoration reply');
    mock.run.mockImplementation(async () => {
      pipe.needsRecovery = true;
      throw timeout;
    });
    await expect(measureScope(ops, { track: 0 }, { backend: 'wav' })).rejects.toBe(timeout);
    expect(timeout.message).toMatch(/Native export failure.*no restoration reply.*scratch retained/);
    const exported = String(mock.command.mock.calls.find(([id]) => id === 'Export2')![1].Filename);
    directories.push(join(exported, '..'));
  });
  it('validates incompatible scope before contacting Audacity', async () => {
    const { ops, mock } = fakeOps([voice]);
    await expect(measureScope(ops, { currentSelection: true, track: 0 })).rejects.toThrow();
    expect(mock.tracks).not.toHaveBeenCalled();
  });
});
