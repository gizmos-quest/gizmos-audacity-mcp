import { describe, expect, it } from 'vitest';
import { outputSchema } from '../src/tool-output.js';
import { measureBuffer, wav } from './helpers/audio-fixture.js';

describe('measurement report schemas', () => {
  it.each(['audacity_measure', 'audacity_measure_file'])(
    '%s accepts a flat report or one with its target check, never a partial report',
    async (tool) => {
      const measurement = await measureBuffer(wav([0.5, -0.5]));
      const schema = outputSchema(tool)!;
      expect(schema.safeParse(measurement).success).toBe(true);
      expect(schema.safeParse({ measurement, targetCheck: { status: 'met', checks: {} } }).success).toBe(true);
      expect(schema.safeParse({ peak: 0.5 }).success).toBe(false);
    },
  );
});
