import { describe, expect, it, vi } from 'vitest';
// @ts-expect-error E2E intentionally imports the generated, distributable runtime after npm run build.
import { AudacityNeedsRecovery, AudacityPipe, AudacityTimeout } from '../../dist/pipe.js';
import { recoveryReply, replayPipe, wire } from '../helpers/replay-pipe.js';

describe('real disposable helper recovery', () => {
  it('drains a late Tracks frame through the recorded nonce barrier without replaying an edit', async () => {
    let disconnected = true;
    const fake = await replayPipe((command) => {
      if (command.startsWith('Message: Text='))
        return {
          bytes: Buffer.concat([wire('11-audio-tracks'), recoveryReply(command)]),
          fragmentBytes: 2,
        };
      if (command === 'GetInfo: Type=Tracks Format=JSON') return { bytes: wire('01-empty-tracks') };
      return { bytes: wire('07-new-mono'), ...(disconnected ? { truncateAt: 8 } : {}) };
    });
    const pipe = new AudacityPipe(fake.paths, 30_000);
    try {
      await expect(pipe.send('Stop:')).rejects.toThrow('disconnected');
      await expect(pipe.send('Stop:')).rejects.toBeInstanceOf(AudacityNeedsRecovery);
      expect(fake.commands).toEqual(['Stop:']);
      disconnected = false;
      expect((await pipe.reconnect()).body).toBe('[  ]');
      expect(pipe.needsRecovery).toBe(false);
      expect(fake.commands[1]).toMatch(/^Message: Text=gizmos-sync-/);
      expect(fake.commands[2]).toBe('GetInfo: Type=Tracks Format=JSON');
      expect((await pipe.send('Stop:')).ok).toBe(true);
      expect(fake.commands.filter((command) => command === 'Stop:')).toHaveLength(2);
      fake.assertHealthy();
    } finally {
      pipe.release();
      await fake.close();
    }
  });

  it.skipIf(process.platform !== 'win32')(
    'fails fast and stays latched on the recorded projectless lone-LF reply',
    async () => {
      let projectless = true;
      const fake = await replayPipe((command) => {
        if (projectless) return { bytes: wire('02-no-project-tracks'), holdOpen: true };
        if (command.startsWith('Message: Text=')) return { bytes: recoveryReply(command) };
        return { bytes: wire('01-empty-tracks') };
      });
      // The projectless rule ends this call long before the generous exchange timeout.
      const pipe = new AudacityPipe(fake.paths, 120_000);
      const started = performance.now();
      try {
        await expect(pipe.send('GetInfo: Type=Tracks Format=JSON')).rejects.toThrow(/no active project/);
        expect(performance.now() - started).toBeLessThan(60_000);
        expect(pipe.needsRecovery).toBe(true);
        projectless = false;
        expect((await pipe.reconnect()).body).toBe('[  ]');
        expect(pipe.needsRecovery).toBe(false);
        fake.assertHealthy();
      } finally {
        pipe.release();
        await fake.close();
      }
    },
    90_000,
  );

  it('bounds delayed I/O by terminating only its disposable helper', async () => {
    let sent!: () => void;
    const requestSent = new Promise<void>((resolve) => {
      sent = resolve;
    });
    const fake = await replayPipe(() => {
      sent();
      return { bytes: wire('07-new-mono'), delayMs: 60_000 };
    });
    const pipe = new AudacityPipe(fake.paths, 30_000);
    // Wait for the real helper's write before advancing only timer APIs. Slow
    // process startup must not turn a blocked-read test into a startup timeout.
    vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout'] });
    try {
      const timedOut = expect(pipe.send('Stop:')).rejects.toBeInstanceOf(AudacityTimeout);
      await Promise.race([requestSent, timedOut]);
      await vi.advanceTimersByTimeAsync(30_000);
      await timedOut;
      expect(pipe.needsRecovery).toBe(true);
      await expect(pipe.send('Stop:')).rejects.toBeInstanceOf(AudacityNeedsRecovery);
      expect(fake.commands.filter((command) => command === 'Stop:')).toHaveLength(1);
    } finally {
      pipe.release();
      try {
        await fake.close();
      } finally {
        vi.useRealTimers();
      }
    }
  });
});
