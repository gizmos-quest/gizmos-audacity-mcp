import { EventEmitter } from 'node:events';
import type { FileHandle } from 'node:fs/promises';
import { PassThrough } from 'node:stream';
import { fileURLToPath } from 'node:url';
import { afterEach, describe, expect, it, vi } from 'vitest';
// @ts-expect-error E2E intentionally imports the generated, distributable runtime after npm run build.
import { AudacityNeedsRecovery, AudacityNoProject, AudacityPipe } from '../../dist/pipe.js';
import { recoveryReply, wire } from '../helpers/replay-pipe.js';

const fake = vi.hoisted(() => ({ spawn: vi.fn() }));
vi.mock('node:child_process', () => ({ spawn: fake.spawn }));
vi.mock('../../dist/pipe-ownership.js', () => ({ acquirePipeOwnership: vi.fn(), releasePipeOwnership: vi.fn() }));

const platform = Object.getOwnPropertyDescriptor(process, 'platform')!;
const cleanup: (() => void)[] = [];
afterEach(() => {
  for (const close of cleanup.splice(0)) close();
  Object.defineProperty(process, 'platform', platform);
  vi.useRealTimers();
  vi.clearAllMocks();
});

interface Delivery {
  bytes: Buffer;
  fragmentBytes?: number;
  holdOpen?: boolean;
}

/** Replace native handles and process creation, retaining the built worker and reply classification. */
async function session(replay: (command: string) => Delivery) {
  Object.defineProperty(process, 'platform', { ...platform, value: 'win32' });
  vi.resetModules();
  // Import after selecting the platform so the production Windows idle deadline is exercised.
  // @ts-expect-error The worker is built before this suite runs.
  const { exchangePipeRequest } = await import('../../dist/pipe-worker.js');
  const requests: string[] = [];
  const exchanges: { reader: ReturnType<typeof vi.fn>; close: ReturnType<typeof vi.fn> }[] = [];
  const children: { kill: ReturnType<typeof vi.fn> }[] = [];
  let blocked!: () => void;
  const blockedRead = new Promise<void>((resolve) => {
    blocked = resolve;
  });
  fake.spawn.mockImplementation(() => {
    const stdin = new PassThrough();
    const stdout = new PassThrough();
    const stderr = new PassThrough();
    const child = Object.assign(new EventEmitter(), { stdin, stdout, stderr, pid: 1234, kill: vi.fn() });
    children.push(child);
    let input = '';
    stdin.on('data', (chunk: Buffer) => {
      input += chunk.toString('utf8');
    });
    stdin.once('finish', () => {
      const request = JSON.parse(input) as { paths: { to: string; from: string }; command: string; nonce?: string };
      let bytes: Buffer = Buffer.alloc(0);
      let fragmentBytes = 65_536;
      let holdOpen = false;
      let unblock: (() => void) | undefined;
      const to = {
        writeFile: vi.fn(async (value: string) => {
          requests.push(value);
          const delivery = replay(value.replace(/\r\n\0$/, ''));
          bytes = delivery.bytes;
          fragmentBytes = delivery.fragmentBytes ?? fragmentBytes;
          holdOpen = delivery.holdOpen ?? false;
        }),
        close: vi.fn(async () => undefined),
      };
      const from = {
        read: vi.fn(async (buffer: Buffer) => {
          if (!bytes.length && holdOpen) {
            blocked();
            await new Promise<void>((resolve) => {
              unblock = resolve;
            });
          }
          const length = Math.min(bytes.length, buffer.length, fragmentBytes);
          bytes.copy(buffer, 0, 0, length);
          bytes = bytes.subarray(length);
          return { bytesRead: length, buffer };
        }),
        close: vi.fn(async () => undefined),
      };
      exchanges.push({ reader: from.read, close: from.close });
      cleanup.push(() => unblock?.());
      const open = async (_path: string, mode: 'w' | 'r') => (mode === 'w' ? to : from) as unknown as FileHandle;
      void exchangePipeRequest(request.paths, request.command, open, request.nonce).then((reply: unknown) => {
        stdout.write(JSON.stringify(reply));
        child.emit('close', 0);
      });
    });
    return child;
  });
  const pipe = new AudacityPipe({ to: '\\\\.\\pipe\\portable-to', from: '\\\\.\\pipe\\portable-from' }, 120_000);
  cleanup.push(() => pipe.release());
  return { pipe, requests, exchanges, children, blockedRead };
}

describe('Windows framing through portable handle doubles', () => {
  it('exits the built helper after flushing a projectless reply with an abandoned read', async () => {
    const { spawn } = await vi.importActual<typeof import('node:child_process')>('node:child_process');
    const child = spawn(
      process.execPath,
      [
        '--import',
        new URL('../helpers/projectless-worker.ts', import.meta.url).href,
        fileURLToPath(new URL('../../dist/pipe-worker.js', import.meta.url)),
      ],
      { windowsHide: true, stdio: ['pipe', 'pipe', 'pipe'] },
    );
    let output = '';
    let error = '';
    child.stdout.setEncoding('utf8').on('data', (chunk: string) => {
      output += chunk;
    });
    child.stderr.setEncoding('utf8').on('data', (chunk: string) => {
      error += chunk;
    });
    const closed = new Promise<void>((resolve, reject) => {
      child.once('error', reject);
      child.once('close', () => resolve());
    });
    // A missing self-exit must fail and still clean up this test's own helper.
    const deadline = setTimeout(() => child.kill(), 10_000);
    try {
      child.stdin.end(
        JSON.stringify({
          paths: { to: '\\\\.\\pipe\\portable-to', from: '\\\\.\\pipe\\portable-from' },
          command: 'GetInfo: Type=Tracks Format=JSON',
        }),
      );
      await closed;
      expect(error).toBe('');
      expect(JSON.parse(output)).toEqual({ raw: '\n', idle: true });
      expect(child.killed, 'the helper must exit without parent cancellation').toBe(false);
      expect(child.signalCode).toBe('SIGTERM');
    } finally {
      clearTimeout(deadline);
      if (child.exitCode === null && child.signalCode === null) child.kill();
      await closed;
    }
  });

  it('writes CRLF/NUL once and decodes byte-fragmented recorded UTF-8 through the built worker', async () => {
    const { pipe, requests, exchanges } = await session(() => ({ bytes: wire('11-audio-tracks'), fragmentBytes: 1 }));
    const reply = await pipe.send('GetInfo: Type=Tracks Format=JSON');
    expect(reply).toMatchObject({ ok: true, status: 'OK', body: expect.stringContaining('Fixture café 音') });
    expect(requests).toEqual(['GetInfo: Type=Tracks Format=JSON\r\n\0']);
    expect(exchanges[0]?.close).toHaveBeenCalledOnce();
  });

  it('ends the recorded projectless LF at the Windows idle deadline and recovers without replaying an edit', async () => {
    let projectless = true;
    const { pipe, requests, exchanges, children, blockedRead } = await session((command) => {
      if (projectless) return { bytes: wire('02-no-project-tracks'), holdOpen: true };
      if (command.startsWith('Message: Text=')) return { bytes: recoveryReply(command) };
      return { bytes: wire('01-empty-tracks') };
    });
    vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout'] });
    let settled = false;
    const outcome = pipe
      .send('GetInfo: Type=Tracks Format=JSON')
      .catch((error: unknown) => error)
      .finally(() => {
        settled = true;
      });
    // Wait for the fake's blocked read without advancing the worker's clock.
    await blockedRead;
    expect(exchanges[0]?.reader).toHaveBeenCalledTimes(2);
    await vi.advanceTimersByTimeAsync(1_999);
    expect(settled).toBe(false);
    expect(pipe.needsRecovery).toBe(false);
    await vi.advanceTimersByTimeAsync(1);
    expect(settled).toBe(true);
    expect(await outcome).toMatchObject({
      constructor: AudacityNoProject,
      message: expect.stringContaining('no active project'),
      uncertainOutcome: true,
    });
    expect(children[0]?.kill).not.toHaveBeenCalled();
    expect(exchanges[0]?.close).not.toHaveBeenCalled();
    expect(pipe.needsRecovery).toBe(true);
    await expect(pipe.send('Amplify: Ratio=0.5')).rejects.toBeInstanceOf(AudacityNeedsRecovery);
    expect(requests).toEqual(['GetInfo: Type=Tracks Format=JSON\r\n\0']);
    projectless = false;
    expect((await pipe.reconnect()).body).toBe('[  ]');
    expect(pipe.needsRecovery).toBe(false);
    expect(requests).toEqual([
      'GetInfo: Type=Tracks Format=JSON\r\n\0',
      expect.stringMatching(/^Message: Text=gizmos-sync-[a-f\d]+\r\n\0$/),
      'GetInfo: Type=Tracks Format=JSON\r\n\0',
    ]);
  });
});
