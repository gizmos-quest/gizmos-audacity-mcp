import { describe, expect, it } from 'vitest';
import { MeasureOptionsSchema, MeasureScopeSchema } from '../../src/analysis/options.js';

describe('measurement scope and option schemas', () => {
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
});
