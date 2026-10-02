// A disposable pipe client, never Audacity itself. Terminating this helper makes
// timeouts bounded even when Windows has an outstanding blocking ReadFile.
import { open, type FileHandle } from 'node:fs/promises';
import { StringDecoder } from 'node:string_decoder';
import { fileURLToPath } from 'node:url';

type PipeHandle = Pick<FileHandle, 'writeFile' | 'read' | 'close'>;
type WorkerReply = { raw: string } | { error: string; code?: string; sent: boolean };

/** One exchange with replaceable handles for short-write and disconnect tests. */
export async function exchangePipeRequest(paths: { to: string; from: string }, command: string,
  openHandle: (path: string, flags: 'w' | 'r') => Promise<PipeHandle> = open): Promise<WorkerReply> {
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
    for (;;) {
      const { bytesRead } = await from.read(buffer, 0, buffer.length, null);
      if (!bytesRead) break;
      body += decoder.write(buffer.subarray(0, bytesRead));
      if (body.length > 16_000_000) throw new Error('Audacity reply exceeds 16 MB');
      if (/(?:^|\n)BatchCommand finished:[^\n]*\n/.test(body)) break;
    }
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
  const { paths, command } = JSON.parse(request) as { paths: { to: string; from: string }; command: string };
  const reply = await exchangePipeRequest(paths, command);
  process.stdout.write(JSON.stringify(reply));
  if ('error' in reply) process.exitCode = 1;
}
