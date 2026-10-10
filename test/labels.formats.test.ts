import { describe, expect, it } from 'vitest';
import { formatLabels, parseLabelsFile, timestamp } from '../src/labels.js';

describe('label file contracts', () => {
  it('rounds timestamps through minute/hour carry', () => {
    expect(timestamp(59.9999)).toBe('00:01:00.000');
    expect(timestamp(3600.125, ',')).toBe('01:00:00,125');
  });
  it('strictly imports TSV and JSON with positive time ordering', () => {
    expect(parseLabelsFile('0\t1\tFirst\r\n2\t2\tPoint\n', 'tsv')).toHaveLength(2);
    expect(() => parseLabelsFile('1\t0\tbackward', 'tsv')).toThrow();
    expect(() => parseLabelsFile('x\t2\tbad', 'tsv')).toThrow();
    expect(() => parseLabelsFile('[{"start":0,"text":"x","typo":1}]', 'json')).toThrow();
  });
  it.each(['tsv', 'json', 'srt', 'vtt', 'chapters', 'cue', 'podlove', 'ffmetadata'] as const)(
    'formats %s labels with sorted ranges',
    (format) => {
      const output = formatLabels(
        [
          { start: 2, text: 'Second' },
          { start: 0, text: 'First' },
        ],
        format,
        3,
      );
      expect(output.indexOf('First')).toBeLessThan(output.indexOf('Second'));
      if (format === 'srt') expect(output).toContain('00:00:00,000 --> 00:00:02,000');
      if (format === 'vtt') expect(output).toMatch(/^WEBVTT/);
      if (format === 'ffmetadata') expect(output).toContain('TIMEBASE=1/1000');
    },
  );
  it('escapes ffmetadata titles and refuses an end-less subtitle', () => {
    expect(formatLabels([{ start: 0, end: 1, text: 'A=B;#C' }], 'ffmetadata', 2)).toContain('title=A\\=B\\;\\#C');
    expect(() => formatLabels([{ start: 1, text: 'end' }], 'srt', 1)).toThrow('positive end');
  });
});
