// Real stdio MCP integration against Audacity 3.7.x. Only AUDACITY_LIVE=1
// enables process or pipe access. User projects are backed up persistently;
// every test edit happens in the hidden, disposable test project.

import { expect, it } from 'vitest';
import { type LiveContext, type Measurement, testTimeout } from './session.js';

export function registerNoise(context: LiveContext) {
  const { call, refuse, tracks, importVoice } = context;
  it(
    'captures a noise profile and runs explicit cleanup, pause shortening and loudness stages',
    async () => {
      const { quietFixture } = context;
      const tracedCall = async <T = unknown>(name: string, args: Record<string, unknown> = {}): Promise<T> => {
        const label = `${name}${typeof args.effect === 'string' ? ` ${args.effect}` : typeof args.preset === 'string' ? ` ${args.preset}` : ''}`;
        const started = performance.now();
        process.stderr.write(`[noise workflow] starting ${label}\n`);
        try {
          const result = await call<T>(name, args);
          process.stderr.write(
            `[noise workflow] completed ${label} in ${Math.round(performance.now() - started)} ms\n`,
          );
          return result;
        } catch (error) {
          process.stderr.write(
            `[noise workflow] failed ${label} after ${Math.round(performance.now() - started)} ms\n`,
          );
          throw error;
        }
      };
      await importVoice('Voice', quietFixture);
      await tracedCall('audacity_generate', {
        kind: 'noise',
        track: 'Voice',
        start: 0,
        duration: 0.25,
        amplitude: 0.001,
      });
      const untouchedSelection = await call('audacity_info', { type: 'Selection' });
      const untouchedAudio = await call<Measurement>('audacity_measure', { track: 'Voice', backend: 'wav' });
      await expect(
        refuse('audacity_pipeline', { preset: 'voice', track: 'Voice', removeClicks: true }),
      ).rejects.toThrow(/Click removal|blocking modal/i);
      expect(await call('audacity_info', { type: 'Selection' })).toEqual(untouchedSelection);
      expect((await call<Measurement>('audacity_measure', { track: 'Voice', backend: 'wav' })).rms).toBeCloseTo(
        untouchedAudio.rms,
        5,
      );
      await tracedCall('audacity_noise_profile', { track: 'Voice', start: 0, end: 0.25 });
      // Native Noise Reduction has no automation parameters in 3.7.8. A profile
      // persists for this process; the pipeline reuses this exact room-tone scope.
      await tracedCall('audacity_effect', { effect: 'NoiseReduction', track: 'Voice', params: {} });
      const pipelineArgs = {
        preset: 'voice',
        track: 'Voice',
        noiseProfile: { start: 0, end: 0.25 },
        lowPassHz: 12000,
        shortenPauses: { thresholdDb: -50, minimum: 0.1, truncateTo: 0.05 },
        loudness: 'lufs',
        lufs: -18,
        limitPeakDb: -1,
      };
      const plan = await tracedCall<{ steps: { name: string; command: string }[] }>('audacity_pipeline', {
        ...pipelineArgs,
        dryRun: true,
      });
      process.stderr.write(`[noise workflow] planned commands: ${plan.steps.map((step) => step.command).join(', ')}\n`);
      const result = await tracedCall<{ applied: unknown[]; steps: unknown[] }>('audacity_pipeline', pipelineArgs);
      expect(result.applied.length).toBe(result.steps.length);
      expect((await tracks())[0]?.end).toBeLessThanOrEqual(2.001);
      await tracedCall('audacity_pipeline', { preset: 'cleanup', track: 'Voice', loudness: 'rms', rmsDb: -20 });
      await tracedCall('audacity_pipeline', { preset: 'cleanup', track: 'Voice', loudness: 'peak', peakDb: -3 });
      expect((await call<Measurement>('audacity_measure', { track: 'Voice', backend: 'wav' })).peakDbfs).toBeCloseTo(
        -3,
        1,
      );
    },
    testTimeout,
  );
}
