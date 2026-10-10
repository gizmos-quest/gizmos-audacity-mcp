import { access } from 'node:fs/promises';
import { join } from 'node:path';
import { describe, expect, it, vi } from 'vitest';
import { z } from 'zod';
import { loudnessTarget } from '../../src/analysis/loudness.js';
import { measureScope } from '../../src/analysis/render.js';
import { TARGETS } from '../../src/analysis/targets.js';
import { registerAnalysisTools } from '../../src/analysis/tools.js';
import { measureWavBuffer } from '../../src/analysis/wav-metrics.js';
import type { TrackInfo } from '../../src/ops.js';
import { AudacityTimeout } from '../../src/pipe.js';

import { directories, wav } from '../helpers/audio-fixture.js';

import { bed, fakeOps, label, voice } from '../helpers/render-fixture.js';

describe('rendered measurement selection transactions and tool registration', () => {
  it('returns the loudness dry-run plan without selecting or changing samples', async () => {
    const { ops, mock } = fakeOps([voice]);
    const measured = {
      ...measureWavBuffer(wav([0.1])),
      integratedLufs: -20,
      truePeakDbtp: -10,
      scope: { tracks: [0], start: 2, end: 3 },
    };
    const measure = vi.fn<typeof measureScope>().mockResolvedValue(measured);
    expect(await loudnessTarget(ops, { track: 'Voice', dryRun: true }, measure)).toMatchObject({
      dryRun: true,
      before: measured,
      plan: { gainDb: 4 },
      steps: [{ command: 'Amplify', scope: { track: 0, start: 2, end: 3 } }],
    });
    expect(measure).toHaveBeenCalledWith(ops, { track: 0, start: 2, end: 3 }, { backend: 'ffmpeg' });
    expect(mock.select).not.toHaveBeenCalled();
    expect(mock.command).not.toHaveBeenCalled();
  });
  it('applies the planned loudness gain and verifies both loudness and native sample peaks', async () => {
    const { ops, mock } = fakeOps([voice]);
    const before = { ...measureWavBuffer(wav([0.1])), integratedLufs: -20, truePeakDbtp: -10, scope: {} };
    const after = {
      ...measureWavBuffer(wav([0.1 * 10 ** (4 / 20)])),
      integratedLufs: -16,
      truePeakDbtp: -6,
      scope: {},
    };
    const measure = vi.fn<typeof measureScope>().mockResolvedValueOnce(before).mockResolvedValueOnce(after);
    expect(await loudnessTarget(ops, { track: 0 }, measure)).toMatchObject({
      dryRun: false,
      before,
      after,
      targetCheck: { status: 'met' },
      samplePeakDbfs: after.peakDbfs,
      clippedSamples: 0,
    });
    expect(mock.select).toHaveBeenCalledWith({ track: 0, start: 2, end: 3 });
    expect(mock.command).toHaveBeenCalledWith('Amplify', { Ratio: 10 ** (4 / 20), AllowClipping: true }, 600_000);
    expect(measure).toHaveBeenCalledTimes(2);
  });
  it('refuses missing loudness or label targeting before mutation', async () => {
    const { ops, mock } = fakeOps([voice, label]);
    const measure = vi.fn<typeof measureScope>().mockResolvedValue({ ...measureWavBuffer(wav([0.1])), scope: {} });
    await expect(loudnessTarget(ops, { track: 0 }, measure)).rejects.toThrow(/established integrated LUFS/);
    await expect(loudnessTarget(ops, { track: 1 }, measure)).rejects.toThrow(/audio track/);
    expect(mock.command).not.toHaveBeenCalled();
    expect(mock.select).not.toHaveBeenCalled();
  });
  it('refuses a loudness gain outside native Amplify bounds before changing selection', async () => {
    const { ops, mock } = fakeOps([voice]);
    const measure = vi
      .fn<typeof measureScope>()
      .mockResolvedValue({ ...measureWavBuffer(wav([0.1])), integratedLufs: 50, truePeakDbtp: 60, scope: {} });
    await expect(loudnessTarget(ops, { track: 0 }, measure)).rejects.toThrow();
    expect(mock.command).not.toHaveBeenCalled();
    expect(mock.select).not.toHaveBeenCalled();
  });
  it('reports unknown when post-gain loudness cannot be established', async () => {
    const { ops } = fakeOps([voice]);
    const before = { ...measureWavBuffer(wav([0.1])), integratedLufs: -20, truePeakDbtp: -10, scope: {} };
    const after = { ...measureWavBuffer(wav([0.1])), scope: {} };
    const measure = vi.fn<typeof measureScope>().mockResolvedValueOnce(before).mockResolvedValueOnce(after);
    expect(await loudnessTarget(ops, { track: 0 }, measure)).toMatchObject({ targetCheck: { status: 'unknown' } });
  });
  it('preserves Audacity gain errors and does not continue to verification', async () => {
    const { ops, mock } = fakeOps([voice]);
    const before = { ...measureWavBuffer(wav([0.1])), integratedLufs: -20, truePeakDbtp: -10, scope: {} };
    const measure = vi.fn<typeof measureScope>().mockResolvedValue(before);
    mock.command.mockRejectedValue(new Error('Audacity Amplify error'));
    await expect(loudnessTarget(ops, { track: 0 }, measure)).rejects.toThrow('Audacity Amplify error');
    expect(measure).toHaveBeenCalledTimes(1);
  });
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
  it('registers eight strictly typed analysis tools with useful descriptions', async () => {
    const tools = new Map<
      string,
      { shape: z.ZodRawShape; handler: (args: never) => Promise<unknown>; description: string }
    >();
    const register: Parameters<typeof registerAnalysisTools>[0] = (name, description, shape, handler) => {
      tools.set(name, { shape, handler: handler as (args: never) => Promise<unknown>, description });
    };
    const { ops } = fakeOps([voice]);
    registerAnalysisTools(register, ops);
    expect([...tools.keys()]).toEqual([
      'audacity_loudness_target',
      'audacity_silence',
      'audacity_probe_file',
      'audacity_measure',
      'audacity_measure_file',
      'audacity_compare_files',
      'audacity_targets',
      'audacity_contrast',
    ]);
    for (const { shape, description } of tools.values()) {
      expect(description.length).toBeGreaterThan(80);
      expect(z.object(shape).strict().safeParse({ arbitrary: 1 }).success).toBe(false);
    }
    const targetTool = tools.get('audacity_targets')!;
    expect(await targetTool.handler({} as never)).toMatchObject({ presets: TARGETS });
    const silence = tools.get('audacity_silence')!;
    const args = z.object(silence.shape).strict().parse({ track: 0 });
    expect(await silence.handler(args as never)).toMatchObject({
      regions: [{ start: 2, end: 2.5, duration: 0.5 }],
      count: 1,
      truncated: false,
    });
    const invalidArgs = z.object(silence.shape).strict().parse({ file: 'source.wav', track: 0 });
    await expect(silence.handler(invalidArgs as never)).rejects.toThrow(/file cannot be combined/);
  });
  it('validates both contrast ranges before contacting Audacity or changing selection', async () => {
    const handlers = new Map<string, (args: unknown) => Promise<unknown>>();
    const register: Parameters<typeof registerAnalysisTools>[0] = (name, _description, shape, handler) => {
      handlers.set(name, (args) => handler(z.object(shape).strict().parse(args)));
    };
    const { ops, mock } = fakeOps([voice]);
    registerAnalysisTools(register, ops);
    await expect(
      handlers.get('audacity_contrast')!({
        foreground: { track: 0, start: 2, end: 3 },
        background: { track: 0, start: 3, end: 2 },
      }),
    ).rejects.toThrow(/end must be after start/);
    expect(mock.tracks).not.toHaveBeenCalled();
    expect(mock.command).not.toHaveBeenCalled();
  });
  it.each([1, 2])(
    'preflights nonexistent or non-audio background track %i before exporting the foreground',
    async (track) => {
      const handlers = new Map<string, (args: unknown) => Promise<unknown>>();
      const register: Parameters<typeof registerAnalysisTools>[0] = (name, _description, shape, handler) => {
        handlers.set(name, (args) => handler(z.object(shape).strict().parse(args)));
      };
      const { ops, mock } = fakeOps([voice, label]);
      registerAnalysisTools(register, ops);
      await expect(
        handlers.get('audacity_contrast')!({
          foreground: { track: 0, start: 2, end: 3 },
          background: { track, start: 2, end: 3 },
        }),
      ).rejects.toThrow();
      expect(mock.command).not.toHaveBeenCalled();
      expect(mock.run).not.toHaveBeenCalled();
    },
  );
});
