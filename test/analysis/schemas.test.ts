import { describe, expect, it } from 'vitest';
import { MeasureOptionsSchema, MeasureScopeSchema } from '../../src/analysis/options.js';
import { amplitudeDb, percentile, SilenceSchema } from '../../src/analysis/types.js';
import { selectionTimes } from '../../src/audacity/info.js';

describe('numeric and schema helpers', () => {
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
  it.each([
    { trackCount: 2 },
    { currentSelection: true, track: 0 },
    { currentSelection: true, start: 0 },
    { start: 2, end: 1 },
    { start: 1, end: 1 },
    { track: -1 },
    { track: 1.2 },
    { track: 'bad"name' },
    { start: NaN },
    { bogus: 1 },
  ])('refuses invalid scope %j', (scope) => expect(MeasureScopeSchema.safeParse(scope).success).toBe(false));
  it('accepts track count, ranged scope, default scope and current selection', () => {
    expect(MeasureScopeSchema.parse({ track: 'Voice', trackCount: 2, start: 0, end: 1 })).toMatchObject({
      currentSelection: false,
    });
    expect(MeasureScopeSchema.parse({ currentSelection: true })).toEqual({ currentSelection: true });
    expect(MeasureScopeSchema.parse({})).toEqual({ currentSelection: false });
  });
  it.each([{ backend: 'other' }, { dualMono: 1 }, { timeoutMs: 0 }, { timeoutMs: 600001 }, { surprise: 1 }])(
    'refuses invalid measurement options %j',
    (options) => {
      expect(MeasureOptionsSchema.safeParse(options).success).toBe(false);
    },
  );
  it('reads selection objects and Audacity casing variants', () => {
    expect(selectionTimes([{ start: 0.2, end: 1.2 }])).toEqual({ start: 0.2, end: 1.2 });
    expect(selectionTimes({ Start: 0.2, End: 1.2 })).toEqual({ start: 0.2, end: 1.2 });
  });
  it.each([
    null,
    [],
    {},
    { start: '0', end: 1 },
    { start: -1, end: 1 },
    { start: 2, end: 1 },
    { start: 0, end: Infinity },
  ])('refuses unreadable selection %j', (selection) => {
    expect(() => selectionTimes(selection)).toThrow();
  });
});
