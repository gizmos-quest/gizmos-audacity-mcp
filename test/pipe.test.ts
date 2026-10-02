import { describe, expect, it, vi } from 'vitest';
import { AudacityPipe, AudacityTimeout, AudacityNeedsRecovery, AudacityUnavailable, defaultPipePaths, parseReply } from '../src/pipe.js';
import { SerialQueue } from '../src/queue.js';
import { exchangePipeRequest } from '../src/pipe-worker.js';
import type { FileHandle } from 'node:fs/promises';

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
  it.each([0, -1, Infinity, NaN, 2_147_483_648])('refuses invalid timeout %s', (timeout) => {
    expect(() => new AudacityPipe().send('Stop:', timeout)).toThrow();
    expect(() => new AudacityPipe().reconnect(timeout)).toThrow();
  });
  it('distinguishes definitely unsent errors from a possibly partial write', async () => {
    const transport = vi.fn().mockRejectedValueOnce(new AudacityUnavailable('open failed', false))
      .mockRejectedValueOnce(new AudacityUnavailable('write failed after an unknown prefix', true));
    const pipe = new AudacityPipe({ to: 'to', from: 'from' }, 20, transport);
    await expect(pipe.send('Amplify:')).rejects.toThrow('open failed');
    expect(pipe.needsRecovery).toBe(false);
    await expect(pipe.send('Amplify:')).rejects.toThrow('write failed');
    expect(pipe.needsRecovery).toBe(true);
    await expect(pipe.send('Amplify:')).rejects.toBeInstanceOf(AudacityNeedsRecovery);
    expect(transport).toHaveBeenCalledTimes(2);
  });
  it('keeps uncertainty through unreachable and rejected recovery probes, clearing it only on a real OK reply', async () => {
    const transport = vi.fn().mockRejectedValueOnce(new AudacityTimeout('edit reply lost'))
      .mockRejectedValueOnce(new AudacityUnavailable('no pipe yet', false))
      .mockResolvedValueOnce({ ok: false, body: 'native probe failure', status: 'Failed!' })
      .mockResolvedValue({ ok: true, body: '[]', status: 'OK' });
    const pipe = new AudacityPipe({ to: 'to', from: 'from' }, 20, transport);
    await expect(pipe.send('Amplify:')).rejects.toThrow('edit reply lost');
    await expect(pipe.reconnect(40)).rejects.toThrow('no pipe yet');
    expect(pipe.needsRecovery).toBe(true);
    expect((await pipe.reconnect()).body).toBe('native probe failure');
    expect(pipe.needsRecovery).toBe(true);
    await expect(pipe.send('Amplify:')).rejects.toBeInstanceOf(AudacityNeedsRecovery);
    expect((await pipe.reconnect()).ok).toBe(true);
    expect(pipe.needsRecovery).toBe(false);
    await pipe.send('GetInfo: Type=Tracks');
    expect(transport.mock.calls.map((call) => call[1])).toEqual(['Amplify:',
      'GetInfo: Type=Tracks Format=JSON', 'GetInfo: Type=Tracks Format=JSON', 'GetInfo: Type=Tracks Format=JSON', 'GetInfo: Type=Tracks']);
    expect(transport.mock.calls[1]?.[2]).toBe(40);
  });
  it('serializes a reconnect probe after completion of the prior exchange', async () => {
    let finish!: (reply: { ok: boolean; body: string; status: string }) => void;
    const transport = vi.fn().mockImplementationOnce(() => new Promise((resolve) => { finish = resolve; }))
      .mockResolvedValue({ ok: true, body: '[]', status: 'OK' });
    const pipe = new AudacityPipe({ to: 'to', from: 'from' }, 20, transport);
    const edit = pipe.send('Amplify:'); const probe = pipe.reconnect();
    await Promise.resolve(); expect(transport).toHaveBeenCalledTimes(1);
    finish({ ok: true, body: '', status: 'OK' }); await Promise.all([edit, probe]);
    expect(transport.mock.calls.map((call) => call[1])).toEqual(['Amplify:', 'GetInfo: Type=Tracks Format=JSON']);
  });
  it.each(['', 'late edit OK', '{}', '[{}]', '[null]'])('keeps recovery required after a stale or invalid successful response %j', async (body) => {
    const transport = vi.fn().mockRejectedValueOnce(new AudacityTimeout('edit reply lost'))
      .mockResolvedValueOnce({ ok: true, body, status: 'OK' }).mockResolvedValue({ ok: true, body: '[]', status: 'OK' });
    const pipe = new AudacityPipe({ to: 'to', from: 'from' }, 20, transport);
    await expect(pipe.send('Amplify:')).rejects.toBeInstanceOf(AudacityTimeout);
    await expect(pipe.reconnect()).rejects.toBeInstanceOf(AudacityUnavailable);
    expect(pipe.needsRecovery).toBe(true);
    await expect(pipe.send('Amplify:')).rejects.toBeInstanceOf(AudacityNeedsRecovery);
    expect((await pipe.reconnect()).ok).toBe(true); expect(pipe.needsRecovery).toBe(false);
    expect(transport).toHaveBeenCalledTimes(3);
  });
  it('has real platform pipe paths and distinguishes failure/missing replies', () => {
    expect(defaultPipePaths('win32').to).toBe('\\\\.\\pipe\\ToSrvPipe');
    expect(defaultPipePaths('linux').to).toContain('/tmp/audacity_script_pipe.to.');
    expect(parseReply('Audacity error\r\nBatchCommand finished: Failed!\n')).toEqual({ ok: false, body: 'Audacity error', status: 'Failed!' });
    expect(parseReply('partial')).toEqual({ ok: false, body: 'partial', status: 'missing' });
  });
});

describe('disposable pipe helper', () => {
  function handles(chunks = ['BatchCommand finished: OK\n']) {
    const to = { writeFile: vi.fn(async () => undefined), close: vi.fn(async () => undefined) };
    const from = { read: vi.fn(async (buffer: Buffer) => {
      const chunk = Buffer.from(chunks.shift() ?? ''); chunk.copy(buffer);
      return { bytesRead: chunk.length, buffer };
    }), close: vi.fn(async () => undefined) };
    const open = vi.fn(async (_path: string, flags: 'r' | 'w') => (flags === 'w' ? to : from) as unknown as FileHandle);
    return { to, from, open };
  }
  it('reports a rejected write as uncertain even if only a prefix reached Audacity', async () => {
    const io = handles(); io.to.writeFile.mockRejectedValueOnce(Object.assign(new Error('short write disconnected'), { code: 'EPIPE' }));
    expect(await exchangePipeRequest({ to: 'to', from: 'from' }, 'Amplify:', io.open))
      .toEqual({ error: 'short write disconnected', code: 'EPIPE', sent: true });
    expect(io.from.read).not.toHaveBeenCalled();
    expect(io.to.close).toHaveBeenCalledOnce(); expect(io.from.close).toHaveBeenCalledOnce();
  });
  it('reports a failed open as definitely unsent and closes any previously opened handle', async () => {
    const io = handles(); io.open.mockImplementationOnce(async () => io.to as unknown as FileHandle)
      .mockRejectedValueOnce(Object.assign(new Error('invalid read path'), { code: 'EINVAL' }));
    expect(await exchangePipeRequest({ to: 'to', from: 'from' }, 'Amplify:', io.open))
      .toEqual({ error: 'invalid read path', code: 'EINVAL', sent: false });
    expect(io.to.writeFile).not.toHaveBeenCalled(); expect(io.to.close).toHaveBeenCalledOnce();
  });
  it('recreates both handles after a transient second-open failure', async () => {
    const io = handles(); io.open.mockImplementationOnce(async () => io.to as unknown as FileHandle)
      .mockRejectedValueOnce(Object.assign(new Error('busy pipe instance'), { code: 'EBUSY' }));
    expect(await exchangePipeRequest({ to: 'to', from: 'from' }, 'Stop:', io.open))
      .toEqual({ raw: 'BatchCommand finished: OK\n' });
    expect(io.open.mock.calls).toEqual([['to', 'w'], ['from', 'r'], ['to', 'w'], ['from', 'r']]);
    expect(io.to.close).toHaveBeenCalledTimes(2); expect(io.from.close).toHaveBeenCalledOnce();
  });
  it('writes the entire command and waits for a completion line rather than a body substring', async () => {
    const io = handles(['A body mentioning BatchCommand finished: OK\n', 'actual body\nBatchCommand finished: OK\n']);
    expect(await exchangePipeRequest({ to: 'to', from: 'from' }, 'Stop:', io.open))
      .toEqual({ raw: 'A body mentioning BatchCommand finished: OK\nactual body\nBatchCommand finished: OK\n' });
    expect(io.to.writeFile).toHaveBeenCalledExactlyOnceWith(`Stop:${process.platform === 'win32' ? '\r\n\0' : '\n'}`);
    expect(io.from.read).toHaveBeenCalledTimes(2);
  });
});
