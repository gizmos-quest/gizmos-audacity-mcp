// Real stdio MCP integration against Audacity 3.7.x. Only AUDACITY_LIVE=1
// enables process or pipe access. User projects are backed up persistently;
// every test edit happens in the hidden, disposable test project.

import { existsSync } from 'node:fs';
import { expect, it } from 'vitest';
import { type LiveContext, type Measurement, testTimeout } from './session.js';

export function registerBatch(context: LiveContext) {
  const { call, refuse, tracks, importVoice, output } = context;
  it(
    'preflights and processes a batch while restoring original tracks and selection',
    async () => {
      const { fixture } = context;
      await importVoice('Original');
      await call('audacity_select', { track: 'Original', start: 0.25, end: 0.75 });
      const previous = await tracks();
      const selected = await call('audacity_info', { type: 'Selection' });
      const file = output('batch');
      const jobs = [{ file: fixture, output: file, options: { preset: 'cleanup', loudness: 'peak', peakDb: -3 } }];
      expect(await call('audacity_batch', { jobs, dryRun: true })).toMatchObject({ dryRun: true });
      expect(existsSync(file)).toBe(false);
      expect(await call('audacity_batch', { jobs, channels: 1 })).toMatchObject({ dryRun: false, completed: 1 });
      expect(await tracks()).toEqual(previous);
      expect(await call('audacity_info', { type: 'Selection' })).toEqual(selected);
      expect((await call<Measurement>('audacity_measure_file', { file, backend: 'wav' })).peakDbfs).toBeCloseTo(-3, 1);
      await expect(refuse('audacity_batch', { jobs })).rejects.toThrow(/exists/);
      const timingOutput = output('batch-timing-refusal');
      await expect(
        refuse('audacity_batch', {
          jobs: [
            {
              file: fixture,
              output: timingOutput,
              options: { preset: 'cleanup', shortenPauses: { minimum: 0.5, truncateTo: 0.25 } },
            },
          ],
          measure: false,
        }),
      ).rejects.toThrow(/sync.lock/i);
      expect(existsSync(timingOutput)).toBe(false);
      expect(await tracks()).toEqual(previous);
      expect(await call('audacity_info', { type: 'Selection' })).toEqual(selected);
    },
    testTimeout,
  );
}
