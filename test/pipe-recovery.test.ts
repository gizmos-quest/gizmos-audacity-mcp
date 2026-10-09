import type { FileHandle } from 'node:fs/promises';
import { describe, expect, it, vi } from 'vitest';
import { assertCommandBudget, formatCommand } from '../src/format.js';
import { AudacityNeedsRecovery, AudacityPipe, AudacityTimeout, AudacityUnavailable } from '../src/pipe.js';
import { exchangePipeRequest } from '../src/pipe-worker.js';

describe('encoded native command budget', () => {
  it.each(['win32', 'linux'] as const)('counts entire request and terminators on %s', (platform) => {
    const maximum = platform === 'win32' ? 1020 : 1022;
    expect(assertCommandBudget('x'.repeat(maximum), platform)).toHaveLength(maximum);
    expect(() => assertCommandBudget('x'.repeat(maximum + 1), platform)).toThrow('encoded bytes');
    expect(() => assertCommandBudget('音'.repeat(341), platform)).toThrow('encoded bytes');
  });
  it('checks composed parameter overhead, Unicode and transport before any write', () => {
    expect(() => formatCommand('SetLabel', { Text: 'a'.repeat(1010), Label: 1000 })).toThrow('maximum is 1023');
    const transport = vi.fn();
    const pipe = new AudacityPipe({ to: 'to', from: 'from' }, 20, transport);
    expect(() => pipe.send('a'.repeat(1023))).toThrow('maximum is 1023');
    expect(transport).not.toHaveBeenCalled();
  });
});

describe('nonce recovery contract', () => {
  it('never accepts stale same-shaped Tracks as the correlated echo', async () => {
    const transport = vi
      .fn()
      .mockRejectedValueOnce(new AudacityTimeout('edit lost'))
      .mockResolvedValueOnce({ ok: true, body: '[]', status: 'OK' });
    const pipe = new AudacityPipe({ to: 'to', from: 'from' }, 20, transport);
    await expect(pipe.send('Amplify:')).rejects.toThrow('edit lost');
    await expect(pipe.reconnect()).rejects.toThrow('nonce');
    expect(pipe.needsRecovery).toBe(true);
    await expect(pipe.send('Amplify:')).rejects.toBeInstanceOf(AudacityNeedsRecovery);
    expect(transport).toHaveBeenCalledTimes(2);
  });
  it.each(['', '{}', '[{}]', '[null]', '[{"name":"Voice"}]'])(
    'retains latch after echo but invalid Tracks %s',
    async (body) => {
      const transport = vi.fn(async (_paths, _command, _timeout, nonce?: string) => ({
        ok: true,
        body: nonce ?? body,
        status: 'OK',
      }));
      const pipe = new AudacityPipe({ to: 'to', from: 'from' }, 20, transport);
      await expect(pipe.reconnect()).rejects.toBeInstanceOf(AudacityUnavailable);
      expect(pipe.needsRecovery).toBe(true);
    },
  );
  it('clears synchronization only after its nonce and actual current Tracks, without replay', async () => {
    const transport = vi.fn(async (_paths, _command, _timeout, nonce?: string) => ({
      ok: true,
      body: nonce ?? '[]',
      status: 'OK',
    }));
    transport.mockRejectedValueOnce(new AudacityTimeout('edit lost'));
    const pipe = new AudacityPipe({ to: 'to', from: 'from' }, 20, transport);
    await expect(pipe.send('Amplify:')).rejects.toThrow('edit lost');
    expect((await pipe.reconnect(40)).body).toBe('[]');
    expect(pipe.needsRecovery).toBe(false);
    expect(transport.mock.calls.map((call) => call[1])).toEqual([
      'Amplify:',
      expect.stringMatching(/^Message: Text=gizmos-sync-/),
      'GetInfo: Type=Tracks Format=JSON',
    ]);
    expect(transport.mock.calls[1]?.[2]).toBe(40);
  });
  it('keeps native refusal text and the latch if the post-barrier read fails', async () => {
    const transport = vi.fn(async (_paths, _command, _timeout, nonce?: string) =>
      nonce ? { ok: true, body: nonce, status: 'OK' } : { ok: false, body: 'native failure', status: 'Failed!' },
    );
    const pipe = new AudacityPipe({ to: 'to', from: 'from' }, 20, transport);
    expect((await pipe.reconnect()).body).toBe('native failure');
  });
  it('drains delayed stale frames including multiple frames in one fragmented read', async () => {
    const chunks = [
      '\n[]\nBatchCommand finished: OK\n\nold\nBatchCommand finished: OK\n\nnonce-',
      '123\nBatchCommand finished: OK\n\n',
    ];
    const to = { writeFile: vi.fn(async () => undefined), close: vi.fn(async () => undefined) };
    const from = {
      read: vi.fn(async (buffer: Buffer) => {
        const bytes = Buffer.from(chunks.shift() ?? '');
        bytes.copy(buffer);
        return { bytesRead: bytes.length, buffer };
      }),
      close: vi.fn(async () => undefined),
    };
    const open = vi.fn(async (_path, mode) => (mode === 'w' ? to : from) as unknown as FileHandle);
    expect(await exchangePipeRequest({ to: 'to', from: 'from' }, 'Message: Text=nonce-123', open, 'nonce-123')).toEqual(
      { raw: '\nnonce-123\nBatchCommand finished: OK\n' },
    );
    expect(to.writeFile).toHaveBeenCalledOnce();
    expect(from.close).toHaveBeenCalledOnce();
  });
  it('refuses a disconnected recovery without its echo', async () => {
    const handle = {
      writeFile: vi.fn(async () => undefined),
      read: vi.fn(async () => ({ bytesRead: 0 })),
      close: vi.fn(async () => undefined),
    };
    expect(
      await exchangePipeRequest(
        { to: 'to', from: 'from' },
        'Message: Text=nonce',
        async () => handle as unknown as FileHandle,
        'nonce',
      ),
    ).toMatchObject({ sent: true, error: expect.stringContaining('nonce') });
  });
});
