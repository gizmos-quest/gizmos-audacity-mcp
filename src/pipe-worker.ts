// A disposable pipe client, never Audacity itself. Terminating this helper makes
// timeouts bounded even when Windows has an outstanding blocking ReadFile.

import { constants } from 'node:fs';
import { type FileHandle, open } from 'node:fs/promises';
import { StringDecoder } from 'node:string_decoder';
import { fileURLToPath } from 'node:url';
import { validatePipePaths } from './pipe-paths.js';

type PipeHandle = Pick<FileHandle, 'writeFile' | 'read' | 'close'>;
type WorkerReply = { raw: string } | { error: string; code?: string; sent: boolean };

async function openNativePipe(path: string, flags: 'w' | 'r'): Promise<FileHandle> {
  validatePipePaths({ to: path, from: path });
  const handle = await open(path, flags === 'w' ? constants.O_WRONLY : constants.O_RDONLY);
  if (process.platform !== 'win32' && !(await handle.stat()).isFIFO()) {
    await handle.close();
    throw new Error('Scripting FIFO changed before opening; refusing file I/O');
  }
  return handle;
}

/** One exchange with replaceable handles for short-write and disconnect tests. */
export async function exchangePipeRequest(
  paths: { to: string; from: string },
  command: string,
  openHandle: (path: string, flags: 'w' | 'r') => Promise<PipeHandle> = openNativePipe,
  nonce?: string,
): Promise<WorkerReply> {
  let to: PipeHandle | undefined;
  let from: PipeHandle | undefined;
  let sent = false;
  try {
    const deadline = Date.now() + 5_000;
    for (;;) {
      try {
        to ??= await openHandle(paths.to, 'w');
        from = await openHandle(paths.from, 'r');
        break;
      } catch (error) {
        // A failed open may leave the other handle connected to an obsolete
        // pipe instance. Retry with both handles recreated, as for each command.
        await to?.close().catch(() => undefined);
        await from?.close().catch(() => undefined);
        to = undefined;
        from = undefined;
        const code = (error as NodeJS.ErrnoException).code;
        if (Date.now() >= deadline || !['ENOENT', 'EBUSY', 'EACCES'].includes(code ?? '')) throw error;
        await new Promise((resolve) => setTimeout(resolve, 50));
      }
    }
    // Even a rejected write may have sent a prefix. Mark the outcome uncertain
    // before the first write, and use writeFile to handle short successful writes.
    sent = true;
    await to.writeFile(command + (process.platform === 'win32' ? '\r\n\0' : '\n'));
    const buffer = Buffer.alloc(65_536);
    const decoder = new StringDecoder('utf8');
    let body = '';
    let totalBytes = 0;
    for (;;) {
      const { bytesRead } = await from.read(buffer, 0, buffer.length, null);
      if (!bytesRead) break;
      totalBytes += bytesRead;
      if (totalBytes > 16_000_000) throw new Error('Audacity reply exceeds 16 MB');
      body += decoder.write(buffer.subarray(0, bytesRead));
      const completion = /(?:^|\n)BatchCommand finished:([^\n]*)\n/.exec(body);
      if (completion) {
        if (!nonce) break;
        const end = completion.index + completion[0].length;
        const frame = body.slice(0, completion.index).replaceAll('\r', '').trim();
        if (frame === nonce && completion[1]?.trim() === 'OK') return { raw: body.slice(0, end) };
        body = body.slice(end);
        // A single read can contain several old replies and the nonce reply.
        for (;;) {
          const next = /(?:^|\n)BatchCommand finished:([^\n]*)\n/.exec(body);
          if (!next) break;
          const finish = next.index + next[0].length;
          if (body.slice(0, next.index).replaceAll('\r', '').trim() === nonce && next[1]?.trim() === 'OK')
            return { raw: body.slice(0, finish) };
          body = body.slice(finish);
        }
      }
    }
    if (nonce) throw new Error('Audacity disconnected before the recovery nonce echo');
    return { raw: body + decoder.end() };
  } catch (error) {
    const e = error as NodeJS.ErrnoException;
    return { error: e.message, code: e.code, sent };
  } finally {
    await to?.close().catch(() => undefined);
    await from?.close().catch(() => undefined);
  }
}

if (process.argv[1] === fileURLToPath(import.meta.url)) {
  let request = '';
  for await (const chunk of process.stdin) request += String(chunk);
  const { paths, command, nonce } = JSON.parse(request) as {
    paths: { to: string; from: string };
    command: string;
    nonce?: string;
  };
  const reply = await exchangePipeRequest(paths, command, openNativePipe, nonce);
  process.stdout.write(JSON.stringify(reply));
  if ('error' in reply) process.exitCode = 1;
}
