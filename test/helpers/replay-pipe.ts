import { spawnSync } from 'node:child_process';
import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { open } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

const fixtures = new URL('../fixtures/audacity-3.7.8/', import.meta.url);
export const wire = (name: string): Buffer => readFileSync(new URL(`${name}.response.bin`, fixtures));
export interface Delivery {
  bytes: Buffer;
  fragmentBytes?: number;
  delayMs?: number;
  truncateAt?: number;
}
export type Replay = (command: string) => Delivery;

/** Portable POSIX FIFOs that the production helper opens on Linux and macOS. */
export async function replayPipe(replay: Replay) {
  const scratch = mkdtempSync(join(tmpdir(), 'audacity-replay-'));
  const paths = { to: join(scratch, 'to'), from: join(scratch, 'from') };
  const requests: Buffer[] = [];
  const commands: string[] = [];
  let stopped = false;
  // Closing cancels a delayed delivery instead of waiting for it.
  const closing = new AbortController();
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
      if (delivery.delayMs)
        await new Promise((resolve) => {
          const timer = setTimeout(resolve, delivery.delayMs);
          closing.signal.addEventListener('abort', () => resolve(clearTimeout(timer)), { once: true });
        });
      if (stopped) return;
      await write(bytes.subarray(offset, offset + Math.max(1, size)));
    }
  }
  const created = spawnSync('mkfifo', [paths.to, paths.from], { encoding: 'utf8' });
  if (created.status !== 0) throw new Error(created.stderr || 'mkfifo failed');
  const loop = (async () => {
    while (!stopped) {
      accepting = true;
      const input = await open(paths.to, 'r');
      const output = await open(paths.from, 'w');
      accepting = false;
      let replied = false;
      try {
        const chunks: Buffer[] = [];
        for (;;) {
          const buffer = Buffer.alloc(1024);
          const { bytesRead } = await input.read(buffer, 0, buffer.length, null);
          if (!bytesRead) break;
          chunks.push(buffer.subarray(0, bytesRead));
          if (buffer.subarray(0, bytesRead).includes(10)) break;
        }
        if (!stopped && chunks.length)
          await deliver(receive(Buffer.concat(chunks)), async (chunk) => {
            await output.writeFile(chunk);
          });
        // Ending the reply (complete or truncated) closes our write end. Like
        // Audacity's PipeServer, wait for the client to close its request end
        // before reopening, so no stale end pairs with the next client.
        replied = true;
        await output.close();
        while (!stopped && (await input.read(Buffer.alloc(1024), 0, 1024, null)).bytesRead);
      } catch (cause) {
        // The client stops reading at the completion line; a fragmented reply's
        // trailing bytes can then meet a closed FIFO, which is not a replay fault.
        if (!stopped && (cause as NodeJS.ErrnoException).code !== 'EPIPE') error = cause;
      } finally {
        await input.close();
        if (!replied) await output.close();
      }
    }
  })();
  return {
    paths,
    commands,
    requests,
    assertHealthy() {
      if (error) throw error;
    },
    async close() {
      stopped = true;
      closing.abort();
      if (accepting) {
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
