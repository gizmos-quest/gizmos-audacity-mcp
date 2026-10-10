import { describe, expect, it } from 'vitest';
import { trackPanPercent } from '../../src/ops.js';

describe('native pan units', () => {
  it.each([
    [-1, -100],
    [-0.4, -40],
    [0, 0],
    [0.25, 25],
    [1, 100],
  ])('maps public pan %s to native percent %s', (pan, percent) => {
    expect(trackPanPercent(pan)).toBe(percent);
  });
  it.each([-1.01, 1.01, NaN, Infinity, -Infinity])('refuses invalid normalized pan %s', (pan) => {
    expect(() => trackPanPercent(pan)).toThrow('between -1 and 1');
  });
});
