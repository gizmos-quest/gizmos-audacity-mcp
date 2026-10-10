import { describe, expect, it } from 'vitest';
import { AudacityNeedsRecovery, AudacityPipe, AudacityUnavailable } from '../../src/pipe.js';

describe('lost pipe replies', () => {
  it('requires recovery after a sent command loses its reply and never retries the edit', async () => {
    let attempts = 0;
    const pipe = new AudacityPipe({ to: 'to', from: 'from' }, 100, async () => {
      attempts++;
      if (attempts === 1) throw new AudacityUnavailable('reply disconnected', true);
      return { ok: true, status: 'OK', body: '' };
    });
    await expect(pipe.send('Amplify: Ratio=0.5')).rejects.toThrow('reply disconnected');
    expect(pipe.needsRecovery).toBe(true);
    await expect(pipe.send('Amplify: Ratio=0.5')).rejects.toThrow(AudacityNeedsRecovery);
    expect(attempts).toBe(1);
    pipe.reset();
    await expect(pipe.send('GetInfo: Type=Tracks')).resolves.toMatchObject({ ok: true });
    expect(attempts).toBe(2);
  });

  it('allows reconnecting an unavailable pipe when the command was never sent', async () => {
    let attempts = 0;
    const pipe = new AudacityPipe({ to: 'to', from: 'from' }, 100, async () => {
      attempts++;
      if (attempts === 1) throw new AudacityUnavailable('pipe missing', false);
      return { ok: true, status: 'OK', body: '' };
    });
    await expect(pipe.send('GetInfo: Type=Tracks')).rejects.toThrow('pipe missing');
    expect(pipe.needsRecovery).toBe(false);
    await expect(pipe.send('GetInfo: Type=Tracks')).resolves.toMatchObject({ ok: true });
    expect(attempts).toBe(2);
  });
});
