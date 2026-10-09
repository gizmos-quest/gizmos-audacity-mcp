import { spawnSync } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { open } from 'node:fs/promises';
import { createServer, type Server, type Socket } from 'node:net';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

const fixtures = new URL('../fixtures/audacity-3.7.8/', import.meta.url);
export const wire = (name: string): Buffer => readFileSync(new URL(`${name}.response.bin`, fixtures));
export interface Delivery {
  bytes: Buffer;
  fragmentBytes?: number;
  delayMs?: number;
  truncateAt?: number;
  /** Windows only: keep the reply connection open, as native Audacity does after a projectless LF. */
  holdOpen?: boolean;
}
export type Replay = (command: string) => Delivery;

/** Native named pipes on Windows; actual FIFOs on POSIX. The production worker opens these endpoints. */
export async function replayPipe(replay: Replay) {
  const scratch = mkdtempSync(join(tmpdir(), 'audacity-replay-'));
  const token = randomUUID();
  const paths =
    process.platform === 'win32'
      ? { to: `\\\\.\\pipe\\audacity-replay-to-${token}`, from: `\\\\.\\pipe\\audacity-replay-from-${token}` }
      : { to: join(scratch, 'to'), from: join(scratch, 'from') };
  const requests: Buffer[] = [];
  const commands: string[] = [];
  const servers: Server[] = [];
  const sockets = new Set<Socket>();
  let stopped = false;
  let accepting = false;
  let error: unknown;
  function receive(bytes: Buffer): Delivery {
    requests.push(bytes);
    const command = bytes.toString('utf8').replace(/[\r\n\0]+$/, '');
    commands.push(command);
    return replay(command);
  }
  async function deliver(delivery: Delivery, write: (chunk: Buffer) => Promise<void>) {
    const bytes = delivery.bytes.subarray(0, delivery.truncateAt ?? delivery.bytes.length);
    const size = delivery.fragmentBytes ?? bytes.length;
    for (let offset = 0; offset < bytes.length; offset += Math.max(1, size)) {
      if (delivery.delayMs) await new Promise((resolve) => setTimeout(resolve, delivery.delayMs));
      await write(bytes.subarray(offset, offset + Math.max(1, size)));
    }
  }
  let loop: Promise<void> | undefined;
  if (process.platform === 'win32') {
    let replySocket: Socket | undefined;
    let pending: Delivery | undefined;
    const send = async () => {
      if (!replySocket || !pending) return;
      const socket = replySocket;
      const delivery = pending;
      pending = undefined;
      replySocket = undefined;
      try {
        await deliver(delivery, async (chunk) => {
          await new Promise<void>((resolve, reject) =>
            socket.write(chunk, (cause) => (cause ? reject(cause) : resolve())),
          );
        });
        if (!delivery.holdOpen) socket.end();
      } catch (cause) {
        if (!stopped) error = cause;
      }
    };
    const input = createServer((socket) => {
      sockets.add(socket);
      socket.on('close', () => sockets.delete(socket));
      socket.on('error', () => undefined);
      let bytes = Buffer.alloc(0);
      socket.on('data', (chunk: Buffer) => {
        bytes = Buffer.concat([bytes, chunk]);
        if (!bytes.includes(0)) return;
        try {
          pending = receive(bytes);
          void send();
        } catch (cause) {
          error = cause;
          replySocket?.destroy();
        }
      });
    });
    const output = createServer((socket) => {
      sockets.add(socket);
      socket.on('close', () => sockets.delete(socket));
      socket.on('error', () => undefined);
      replySocket = socket;
      void send();
    });
    for (const [server, path] of [
      [input, paths.to],
      [output, paths.from],
    ] as const) {
      servers.push(server);
      await new Promise<void>((resolve, reject) => {
        server.once('error', reject);
        server.listen(path, resolve);
      });
    }
  } else {
    const created = spawnSync('mkfifo', [paths.to, paths.from], { encoding: 'utf8' });
    if (created.status !== 0) throw new Error(created.stderr || 'mkfifo failed');
    loop = (async () => {
      while (!stopped) {
        accepting = true;
        const input = await open(paths.to, 'r');
        const output = await open(paths.from, 'w');
        accepting = false;
        try {
          const chunks: Buffer[] = [];
          for (;;) {
            const buffer = Buffer.alloc(1024);
            const { bytesRead } = await input.read(buffer, 0, buffer.length, null);
            if (!bytesRead) break;
            chunks.push(buffer.subarray(0, bytesRead));
            if (buffer.subarray(0, bytesRead).includes(10)) break;
          }
          if (!stopped)
            await deliver(receive(Buffer.concat(chunks)), async (chunk) => {
              await output.writeFile(chunk);
            });
        } catch (cause) {
          if (!stopped) error = cause;
        } finally {
          await input.close();
          await output.close();
        }
      }
    })();
  }
  return {
    paths,
    commands,
    requests,
    assertHealthy() {
      if (error) throw error;
    },
    async close() {
      stopped = true;
      for (const socket of sockets) socket.destroy();
      await Promise.all(servers.map((server) => new Promise<void>((resolve) => server.close(() => resolve()))));
      if (loop && accepting) {
        // Unblock the FIFO accept loop without generating another fixture request.
        const to = await open(paths.to, 'w');
        const from = await open(paths.from, 'r');
        await to.close();
        await from.close();
      }
      await loop;
      rmSync(scratch, { recursive: true, force: true });
    },
  };
}

export function recoveryReply(command: string): Buffer {
  const token = command.slice('Message: Text='.length).replace(/^"|"$/g, '');
  if (!/^gizmos-sync-[a-f\d-]+$/.test(token)) throw new Error('unexpected recovery nonce');
  return Buffer.from(
    wire('15-recovery-nonce').toString('utf8').replace('audit-sync-7156c164f77b4d6080e99d4c7367a8fe', token),
  );
}
