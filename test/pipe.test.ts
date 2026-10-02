import { describe, expect, it, vi } from 'vitest';
import { AudacityPipe, AudacityTimeout, AudacityNeedsRecovery, defaultPipePaths, parseReply } from '../src/pipe.js';
import { SerialQueue } from '../src/queue.js';

describe('serialized pipe and operations', () => {
  it('keeps complete operation sequences together and continues after failure', async () => {
    const q = new SerialQueue(); const calls: string[] = [];
    await Promise.allSettled([q.run(async () => { calls.push('a-select'); await Promise.resolve(); calls.push('a-effect'); throw new Error('a'); }),
      q.run(async () => { calls.push('b-select'); await Promise.resolve(); calls.push('b-effect'); })]);
    expect(calls).toEqual(['a-select', 'a-effect', 'b-select', 'b-effect']);
  });
  it('marks a timeout uncertain, never replays it and requires explicit reset', async () => {
    const transport = vi.fn().mockRejectedValueOnce(new AudacityTimeout('blocked')).mockResolvedValue({ ok: true, body: 'tracks', status: 'OK' });
    const pipe = new AudacityPipe({ to: 'to', from: 'from' }, 20, transport);
    await expect(pipe.send('Amplify:')).rejects.toThrow(AudacityTimeout);
    await expect(pipe.send('Amplify:')).rejects.toThrow(AudacityNeedsRecovery);
    expect(transport).toHaveBeenCalledTimes(1);
    pipe.reset(); expect((await pipe.send('GetInfo: Type=Tracks')).body).toBe('tracks');
    expect(transport).toHaveBeenCalledTimes(2);
  });
  it.each(['x\nStop:', 'x\rStop:', 'x\0Stop:'])('refuses injected command %j', (command) => {
    expect(() => new AudacityPipe().send(command)).toThrow('single line');
  });
  it.each([0, -1, Infinity, NaN])('refuses invalid timeout %s', (timeout) => {
    expect(() => new AudacityPipe().send('Stop:', timeout)).toThrow();
  });
  it('has real platform pipe paths and distinguishes failure/missing replies', () => {
    expect(defaultPipePaths('win32').to).toBe('\\\\.\\pipe\\ToSrvPipe');
    expect(defaultPipePaths('linux').to).toContain('/tmp/audacity_script_pipe.to.');
    expect(parseReply('Audacity error\r\nBatchCommand finished: Failed!\n')).toEqual({ ok: false, body: 'Audacity error', status: 'Failed!' });
    expect(parseReply('partial')).toEqual({ ok: false, body: 'partial', status: 'missing' });
  });
});
