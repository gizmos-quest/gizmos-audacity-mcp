import { describe, expect, it } from 'vitest';
import { amplitudeDb, percentile, SilenceSchema } from '../../src/analysis/types.js';

describe('numeric measurement helpers', () => {
  it('returns percentiles at endpoints and linearly interpolates', () => {
    expect(percentile([1, 2, 4], 0)).toBe(1);
    expect(percentile([1, 2, 4], 100)).toBe(4);
    expect(percentile([1, 2, 4], 75)).toBe(3);
    expect(percentile([], 50)).toBeNull();
  });
  it.each([-1, 101, NaN, Infinity])('refuses invalid percentile %s even for empty input', (percent) => {
    expect(() => percentile([], percent)).toThrow();
  });
  it.each([0, -1, NaN, Infinity])('returns unavailable dB for nonpositive or nonfinite amplitude %s', (value) =>
    expect(amplitudeDb(value)).toBeNull(),
  );
  it('computes finite amplitude dB', () => expect(amplitudeDb(0.1)).toBe(-20));
  it.each([
    { thresholdDb: -121 },
    { thresholdDb: 1 },
    { thresholdDb: NaN },
    { minimumSeconds: 0 },
    { minimumSeconds: 3601 },
    { maxRegions: 0 },
    { maxRegions: 1001 },
    { maxRegions: 1.5 },
    { bogus: 1 },
  ])('refuses invalid silence options %j', (options) => expect(SilenceSchema.safeParse(options).success).toBe(false));
});
