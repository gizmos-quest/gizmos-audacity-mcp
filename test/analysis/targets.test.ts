import { describe, expect, it } from 'vitest';
import {
  checkTargets,
  compareMeasurements,
  LoudnessTargetSchema,
  planLoudnessTarget,
  TARGETS,
  TargetSchema,
} from '../../src/analysis/targets.js';
import { measureBuffer, wav } from '../helpers/audio-fixture.js';

describe('measurement targets and comparisons', () => {
  it('documents loudness control units while retaining the reviewed defaults', () => {
    const { shape } = LoudnessTargetSchema;
    expect(shape.targetLufs.description).toContain('integrated loudness, in LUFS');
    expect(shape.truePeakCeilingDbtp.description).toContain('rendered true peak, in dBTP');
    expect(shape.maxBoostDb.description).toContain('positive static gain, in dB; does not cap attenuation');
    expect(shape.toleranceLu.description).toContain('distance from targetLufs, in LU');
    expect(LoudnessTargetSchema.parse({})).toEqual({
      targetLufs: -16,
      truePeakCeilingDbtp: -1,
      maxBoostDb: 18,
      toleranceLu: 0.5,
    });
  });

  it('plans loudness gain from LUFS while retaining true-peak headroom', async () => {
    const measured = { ...(await measureBuffer(wav([0.1]))), integratedLufs: -20, truePeakDbtp: -10 };
    expect(planLoudnessTarget(measured, { targetLufs: -16 })).toMatchObject({
      gainDb: 4,
      ratio: 10 ** (4 / 20),
      predictedLufs: -16,
      achievable: true,
      limits: [],
    });
  });
  it('reports a peak-limited LUFS target as unachievable and reserves rounding headroom', async () => {
    const measured = { ...(await measureBuffer(wav([0.1]))), integratedLufs: -20, truePeakDbtp: -3 };
    expect(planLoudnessTarget(measured, { targetLufs: -14, truePeakCeilingDbtp: -1 })).toMatchObject({
      gainDb: 1.9,
      predictedLufs: -18.1,
      predictedTruePeakDbtp: -1.1,
      achievable: false,
      limits: ['true-peak ceiling'],
    });
  });
  it('caps boost and attenuates when the current peak already exceeds the ceiling', async () => {
    const measured = { ...(await measureBuffer(wav([0.1]))), integratedLufs: -30, truePeakDbtp: -20 };
    expect(planLoudnessTarget(measured, { maxBoostDb: 3 })).toMatchObject({
      gainDb: 3,
      achievable: false,
      limits: ['maximum boost'],
    });
    measured.truePeakDbtp = 0;
    expect(planLoudnessTarget(measured)).toMatchObject({ gainDb: -1.1, achievable: false });
  });
  it('attenuates to a lower LUFS target without using available peak headroom', async () => {
    const measured = { ...(await measureBuffer(wav([0.1]))), integratedLufs: -12, truePeakDbtp: -2 };
    expect(planLoudnessTarget(measured, { targetLufs: -16 })).toMatchObject({
      gainDb: -4,
      predictedLufs: -16,
      achievable: true,
    });
  });
  it.each([
    { integratedLufs: null, truePeakDbtp: -2 },
    { integratedLufs: -16, truePeakDbtp: null },
    { integratedLufs: NaN, truePeakDbtp: -2 },
    { integratedLufs: -16, truePeakDbtp: Infinity },
  ])('refuses absent or nonfinite loudness %j', async (metrics) => {
    const measured = await measureBuffer(wav([0.1]));
    expect(() => planLoudnessTarget({ ...measured, ...metrics })).toThrow(/established integrated LUFS and true peak/);
  });
  it('refuses silent audio and nonsensical attenuation before mutation', async () => {
    const silent = await measureBuffer(wav([0]));
    const tone = await measureBuffer(wav([0.1]));
    expect(() => planLoudnessTarget({ ...silent, integratedLufs: -70, truePeakDbtp: -100 })).toThrow(/non-silent/);
    expect(() => planLoudnessTarget({ ...tone, integratedLufs: -16, truePeakDbtp: 70 })).toThrow(/60 dB/);
  });
  it.each([
    { targetLufs: -51 },
    { targetLufs: -4 },
    { truePeakCeilingDbtp: 1 },
    { maxBoostDb: -1 },
    { toleranceLu: 0 },
    { bogus: 1 },
  ])('refuses invalid loudness settings %j', (settings) => {
    expect(LoudnessTargetSchema.safeParse(settings).success).toBe(false);
  });
  it.each([
    {},
    { peakDbfs: undefined },
    { peakDbfs: {} },
    { peakDbfs: { min: 1, max: 0 } },
    { peakDbfs: { max: Infinity } },
    { peakDbfs: { max: NaN } },
    { peakDbfs: { max: 0, bogus: 1 } },
    { bogus: { max: 0 } },
  ])('refuses invalid targets %j', (targets) => {
    expect(TargetSchema.safeParse(targets).success).toBe(false);
  });
  it.each(Object.entries(TARGETS))('validates the %s house reference', (_name, targets) =>
    expect(TargetSchema.safeParse(targets).success).toBe(true),
  );
  it('accepts inclusive target bounds and reports signed gaps', async () => {
    const measurement = await measureBuffer(wav([0.5]));
    expect(
      checkTargets(measurement, { peakDbfs: { min: measurement.peakDbfs!, max: measurement.peakDbfs! } }).status,
    ).toBe('met');
    const low = checkTargets(measurement, { peakDbfs: { min: -5 } });
    expect(low.status).toBe('missed');
    expect(low.checks.peakDbfs!.gap).toBeCloseTo(-1.0206, 5);
    const high = checkTargets(measurement, { peakDbfs: { max: -7 } });
    expect(high.checks.peakDbfs!.gap).toBeCloseTo(0.9794, 5);
  });
  it('never substitutes sample peak for unavailable true peak or estimates for noise floor', async () => {
    const measurement = await measureBuffer(wav([0.1]));
    const check = checkTargets(measurement, { truePeakDbtp: { max: -1 }, noiseFloorDbfs: { max: -60 } });
    expect(check.status).toBe('unknown');
    expect(check.checks.truePeakDbtp!.actual).toBeNull();
    expect(check.checks.noiseFloorDbfs!.reason).toContain('cannot certify');
  });
  it('reports missed over unknown when an available metric already fails', async () => {
    const measurement = await measureBuffer(wav([0.5]));
    expect(checkTargets(measurement, { peakDbfs: { max: -20 }, truePeakDbtp: { max: -1 } }).status).toBe('missed');
  });
  it('ignores explicitly undefined optional targets when valid bounds are present', async () => {
    expect(
      checkTargets(await measureBuffer(wav([0.1])), { peakDbfs: { max: 0 }, truePeakDbtp: undefined }).status,
    ).toBe('met');
  });
  it('keeps nonfinite measurement values unavailable', async () => {
    const measured = await measureBuffer(wav([0.1]));
    measured.integratedLufs = NaN;
    expect(checkTargets(measured, { integratedLufs: { max: -1 } }).status).toBe('unknown');
  });
  it('compares only metrics established on both sides', async () => {
    const before = await measureBuffer(wav([0.5]));
    const after = await measureBuffer(wav([0.25]));
    expect(compareMeasurements(before, after).peakDbfs!.change).toBeCloseTo(-6.0206, 5);
    expect(compareMeasurements(before, after)).not.toHaveProperty('integratedLufs');
    after.rmsDbfs = Infinity;
    expect(compareMeasurements(before, after)).not.toHaveProperty('rmsDbfs');
  });
});
