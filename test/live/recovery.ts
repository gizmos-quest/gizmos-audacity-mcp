import { expect, it } from 'vitest';
import { listWindows } from '../../src/app.js';
import { AudacityNeedsRecovery, AudacityPipe, AudacityTimeout } from '../../src/pipe.js';
import { type LiveContext, type Measurement, testTimeout, type Windows } from './session.js';

export function registerRecovery(context: LiveContext) {
  const { call, importVoice } = context;
  it(
    'serializes concurrent selection/effect operations and rapid disposable pipe instances',
    async () => {
      await importVoice('One');
      await importVoice('Two');
      await Promise.all([
        call('audacity_effect', { effect: 'Amplify', track: 'One', params: { Ratio: 0.5 } }),
        call('audacity_effect', { effect: 'Amplify', track: 'Two', params: { Ratio: 0.25 } }),
        ...Array.from({ length: 8 }, () => call('audacity_info', { type: 'Tracks' })),
      ]);
      const a = await call<Measurement>('audacity_measure', { track: 'One', backend: 'wav' });
      const b = await call<Measurement>('audacity_measure', { track: 'Two', backend: 'wav' });
      expect(a.rms / b.rms).toBeCloseTo(2, 3);
    },
    testTimeout,
  );

  it(
    'recovers a deliberately opened modal dialog and explicitly restarts the private pipe',
    async () => {
      await importVoice();
      await context.closeClient();
      const privatePipe = new AudacityPipe();
      // Intentional unsafe command ONLY in this integration test. The public
      // catalogue refuses Preferences; root verification records live 3.7.8.
      try {
        // Give the disposable TypeScript helper time to start and write once.
        // A shorter timeout can expire before the command reaches Audacity;
        // that unknown outcome must never be retried just to open the dialog.
        await expect(privatePipe.send('Preferences:', 10_000)).rejects.toBeInstanceOf(AudacityTimeout);
        expect(privatePipe.needsRecovery).toBe(true);
        await expect(privatePipe.send('GetInfo: Type=Tracks Format=JSON', 5_000)).rejects.toBeInstanceOf(
          AudacityNeedsRecovery,
        );
        let windows: Windows = { windows: [] };
        const deadline = Date.now() + 10_000;
        do {
          windows = { windows: await listWindows(false) };
          if (windows.windows.some((window) => window.dialog)) break;
          await new Promise((resolve) => setTimeout(resolve, 200));
        } while (Date.now() < deadline);
        expect(
          windows.windows.some((window) => window.dialog),
          JSON.stringify(windows),
        ).toBe(true);
      } finally {
        await listWindows(true);
        try {
          const reply = await privatePipe.reconnect(5_000);
          expect(privatePipe.needsRecovery).toBe(false);
          expect(reply.ok).toBe(true);
          expect(reply.body).toContain('Voice');
        } finally {
          privatePipe.release();
          await context.connectClient();
        }
      }
      await call('audacity_recover', { closeDialogs: true });
      expect((await call<Windows>('audacity_dialogs')).windows.some((window) => window.dialog)).toBe(false);
      expect(await call('audacity_recover', { reconnect: false })).toMatchObject({
        running: true,
        needsRecovery: false,
      });
    },
    testTimeout,
  );
}
