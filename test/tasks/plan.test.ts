import { describe, expect, it, vi } from 'vitest';
import { catalogueCommand } from '../../src/format.js';
import { pipeline, planPipeline } from '../../src/tasks.js';

vi.mock('../../src/source-rate.js', () => ({ measureSourceRate: vi.fn(async () => 48_000) }));

import { expectNoMutation, mockOps } from '../helpers/task-fixture.js';

describe('reviewed pipeline plans', () => {
  it.each([
    ['cleanup', ['Normalize', 'High-passFilter']],
    ['voice', ['Normalize', 'High-passFilter', 'Compressor']],
    ['podcast', ['Normalize', 'High-passFilter', 'Compressor']],
    ['interview', ['Normalize', 'High-passFilter', 'Compressor']],
    ['audiobook', ['Normalize', 'High-passFilter', 'Compressor']],
    ['vocal', ['Normalize', 'High-passFilter', 'Compressor', 'BassAndTreble']],
    ['live', ['Normalize', 'High-passFilter', 'Compressor']],
    ['music', ['Normalize', 'High-passFilter', 'Compressor']],
    ['lofi', ['Normalize', 'High-passFilter', 'Low-passFilter', 'Compressor', 'BassAndTreble']],
  ])('validates the complete %s preset against the installed catalogue', (preset, commands) => {
    const plan = planPipeline({ track: 'Voice', preset });
    expect(plan.steps.map((step) => step.command)).toEqual(commands);
    for (const step of plan.steps) {
      expect(catalogueCommand(step.command, step.params)).toMatch(new RegExp(`^${step.command}:`));
      expect(step.scope.track).toBe('Voice');
    }
  });

  it('orders profiling, timing edits, dynamics, EQ, loudness and limiting', () => {
    const plan = planPipeline({
      track: 0,
      start: 2,
      end: 9,
      noiseProfile: { start: 2, end: 2.2 },
      lowPassHz: 9000,
      shortenPauses: { minimum: 1, truncateTo: 0.2 },
      bassDb: 1,
      trebleDb: 2,
      loudness: 'lufs',
      lufs: -18,
      limitPeakDb: -1,
    });
    expect(plan.steps.map((step) => step.command)).toEqual([
      'NoiseReduction',
      'NoiseReduction',
      'Normalize',
      'High-passFilter',
      'Low-passFilter',
      'TruncateSilence',
      'Compressor',
      'BassAndTreble',
      'LoudnessNormalization',
      'Limiter',
    ]);
    expect(plan.steps[0]).toMatchObject({ params: {}, scope: { track: 0, start: 2, end: 2.2 } });
    expect(plan.steps[0]?.captureProfile).toBe(true);
    expect(plan.steps[1]).toMatchObject({ params: {}, scope: { track: 0, start: 2, end: 9 } });
    expect(plan.steps[2]?.params).toMatchObject({ RemoveDcOffset: true, ApplyVolume: false });
    expect(plan.steps[6]?.params).toMatchObject({ makeupGainDb: 0 });
    expect(plan.steps.at(-1)?.params).toMatchObject({ thresholdDb: -1, makeupTargetDb: -1 });
    expect(plan.notes.join(' ')).toMatch(/alignment with video/);
    expect(plan.notes.join(' ')).toMatch(/verify loudness and true peak/);
  });

  it.each([false, true])(
    'rejects requested click removal before pipe interaction even when dryRun=%s',
    async (dryRun) => {
      const mocks = mockOps();
      await expect(pipeline(mocks.ops, { track: 0, dryRun, removeClicks: true })).rejects.toThrow(
        'blocking modal dialog',
      );
      expectNoMutation(mocks);
      expect(mocks.tracks).not.toHaveBeenCalled();
      expect(() => planPipeline({ track: 0, removeClicks: true })).toThrow('blocking modal dialog');
    },
  );

  it.each([
    ['peak', 'Normalize', { PeakLevel: -2, ApplyVolume: true, RemoveDcOffset: false }],
    ['lufs', 'LoudnessNormalization', { NormalizeTo: 0, LUFSLevel: -18 }],
    ['rms', 'LoudnessNormalization', { NormalizeTo: 1, RMSLevel: -22 }],
  ])('uses the catalogue parameters for %s normalization', (loudness, command, params) => {
    const plan = planPipeline({ track: 0, loudness, peakDb: -2, lufs: -18, rmsDb: -22 });
    expect(plan.steps.at(-1)).toMatchObject({ command, params });
    expect(plan.notes.join(' ')).toMatch(/boost quiet audio/);
  });

  it('can disable DC removal and compression without implicitly normalizing', () => {
    const plan = planPipeline({ track: 0, removeDc: false, compress: false, highPassHz: 120 });
    expect(plan.steps).toHaveLength(1);
    expect(plan.steps[0]).toMatchObject({ command: 'High-passFilter', params: { FREQUENCY: 120 } });
    expect(plan.notes.join(' ')).toMatch(/no room-tone interval/);
  });

  it('uses explicit compressor settings and never silently adds makeup gain', () => {
    const plan = planPipeline({
      preset: 'cleanup',
      track: 0,
      compress: true,
      thresholdDb: -24,
      ratio: 4,
      attackMs: 15,
      releaseMs: 300,
    });
    expect(plan.steps.at(-1)?.params).toMatchObject({
      thresholdDb: -24,
      compressionRatio: 4,
      attackMs: 15,
      releaseMs: 300,
      makeupGainDb: 0,
    });
  });
});
