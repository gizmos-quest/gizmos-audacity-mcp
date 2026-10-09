import { expect, it } from 'vitest';
import { type LiveContext, type Measurement, testTimeout, type Windows } from './session.js';

export function registerControls(context: LiveContext) {
  const { call, refuse, importVoice } = context;
  it(
    'undoes and redoes timeline edits in native history',
    async () => {
      await importVoice();
      const before = await call<Measurement>('audacity_measure', { track: 'Voice', backend: 'wav' });
      await call('audacity_edit', { action: 'split_delete', track: 'Voice', start: 0.5, end: 1 });
      expect(await call('audacity_history', { action: 'undo' })).toMatchObject({ completed: 1 });
      expect((await call<Measurement>('audacity_measure', { track: 'Voice', backend: 'wav' })).rms).toBeCloseTo(
        before.rms,
        5,
      );
      await call('audacity_history', { action: 'redo' });
      expect((await call<Measurement>('audacity_measure', { track: 'Voice', backend: 'wav' })).rms).toBeCloseTo(
        before.rms * Math.sqrt(0.75),
        4,
      );
    },
    testTimeout,
  );

  it(
    'lists preferences and safely sets/readbacks/restores each writable preference',
    async () => {
      expect(await call('audacity_preferences', { action: 'list' })).toBeDefined();
      for (const [name, value] of [
        ['/SamplingRate/DefaultProjectSampleRate', 48000],
        ['/AudioIO/RecordChannels', 1],
      ] as const) {
        const original = await call<{ value: string }>('audacity_preferences', { action: 'get', name });
        try {
          const updated = await call<{ value: string }>('audacity_preferences', { action: 'set', name, value });
          expect(Number(updated.value)).toBe(value);
          expect(Number((await call<{ value: string }>('audacity_preferences', { action: 'get', name })).value)).toBe(
            value,
          );
        } finally {
          await call('audacity_preferences', { action: 'set', name, value: Number(original.value) });
        }
      }
      await expect(
        refuse('audacity_preferences', { action: 'set', name: '/Module/mod-script-pipe', value: 0 }),
      ).rejects.toThrow(/writable preferences/);
    },
    testTimeout,
  );

  it(
    'lists/previews/applies an existing macro without dialogs',
    async () => {
      await importVoice();
      await call('audacity_select', { track: 'Voice' });
      const macros = await call<{ macros: { name: string; safe: boolean }[] }>('audacity_macros', { action: 'list' });
      expect(macros.macros.find((macro) => macro.name === 'Fade Ends')?.safe).toBe(true);
      expect(await call('audacity_macros', { action: 'apply', name: 'Fade Ends', dryRun: true })).toMatchObject({
        dryRun: true,
      });
      expect(await call('audacity_macros', { action: 'apply', name: 'Fade Ends' })).toHaveProperty('completed');
      expect((await call<Windows>('audacity_dialogs')).windows.filter((window) => window.dialog)).toEqual([]);
    },
    testTimeout,
  );
}
