import { describe, expect, it, vi } from 'vitest';
import { loudnessTarget } from '../../src/analysis/loudness.js';
import type { measureScope } from '../../src/analysis/render.js';
import { measureBuffer, wav } from '../helpers/audio-fixture.js';
import { fakeOps, label, voice } from '../helpers/render-fixture.js';

describe('static-gain loudness targeting', () => {
  it('returns the loudness dry-run plan without selecting or changing samples', async () => {
    const { ops, mock } = fakeOps([voice]);
    const measured = {
      ...(await measureBuffer(wav([0.1]))),
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
    const before = { ...(await measureBuffer(wav([0.1]))), integratedLufs: -20, truePeakDbtp: -10, scope: {} };
    const after = {
      ...(await measureBuffer(wav([0.1 * 10 ** (4 / 20)]))),
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
    const measure = vi.fn<typeof measureScope>().mockResolvedValue({ ...(await measureBuffer(wav([0.1]))), scope: {} });
    await expect(loudnessTarget(ops, { track: 0 }, measure)).rejects.toThrow(/established integrated LUFS/);
    await expect(loudnessTarget(ops, { track: 1 }, measure)).rejects.toThrow(/audio track/);
    expect(mock.command).not.toHaveBeenCalled();
    expect(mock.select).not.toHaveBeenCalled();
  });
  it('refuses a loudness gain outside native Amplify bounds before changing selection', async () => {
    const { ops, mock } = fakeOps([voice]);
    const measure = vi
      .fn<typeof measureScope>()
      .mockResolvedValue({ ...(await measureBuffer(wav([0.1]))), integratedLufs: 50, truePeakDbtp: 60, scope: {} });
    await expect(loudnessTarget(ops, { track: 0 }, measure)).rejects.toThrow();
    expect(mock.command).not.toHaveBeenCalled();
    expect(mock.select).not.toHaveBeenCalled();
  });
  it('reports unknown when post-gain loudness cannot be established', async () => {
    const { ops } = fakeOps([voice]);
    const before = { ...(await measureBuffer(wav([0.1]))), integratedLufs: -20, truePeakDbtp: -10, scope: {} };
    const after = { ...(await measureBuffer(wav([0.1]))), scope: {} };
    const measure = vi.fn<typeof measureScope>().mockResolvedValueOnce(before).mockResolvedValueOnce(after);
    expect(await loudnessTarget(ops, { track: 0 }, measure)).toMatchObject({ targetCheck: { status: 'unknown' } });
  });
  it('preserves Audacity gain errors and does not continue to verification', async () => {
    const { ops, mock } = fakeOps([voice]);
    const before = { ...(await measureBuffer(wav([0.1]))), integratedLufs: -20, truePeakDbtp: -10, scope: {} };
    const measure = vi.fn<typeof measureScope>().mockResolvedValue(before);
    mock.command.mockRejectedValue(new Error('Audacity Amplify error'));
    await expect(loudnessTarget(ops, { track: 0 }, measure)).rejects.toThrow('Audacity Amplify error');
    expect(measure).toHaveBeenCalledTimes(1);
  });
});
