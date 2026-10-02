// A disposable pipe client, never Audacity itself. Terminating this helper makes
// timeouts bounded even when Windows has an outstanding blocking ReadFile.
import { open, type FileHandle } from 'node:fs/promises';
import { StringDecoder } from 'node:string_decoder';

let request = '';
for await (const chunk of process.stdin) request += String(chunk);
const { paths, command } = JSON.parse(request) as { paths: { to: string; from: string }; command: string };
let to: FileHandle | undefined;
let from: FileHandle | undefined;
let sent = false;
try {
  const deadline = Date.now() + 5_000;
  for (;;) {
    try {
      to ??= await open(paths.to, 'w');
      from = await open(paths.from, 'r');
      break;
    } catch (error) {
      const code = (error as NodeJS.ErrnoException).code;
      if (Date.now() >= deadline || !['ENOENT', 'EBUSY', 'EACCES'].includes(code ?? '')) throw error;
      await new Promise((resolve) => setTimeout(resolve, 50));
    }
  }
  await to.write(command + (process.platform === 'win32' ? '\r\n\0' : '\n'));
  sent = true;
  const buffer = Buffer.alloc(65_536);
  const decoder = new StringDecoder('utf8');
  let body = '';
  for (;;) {
    const { bytesRead } = await from.read(buffer, 0, buffer.length, null);
    if (!bytesRead) break;
    body += decoder.write(buffer.subarray(0, bytesRead));
    if (body.length > 16_000_000) throw new Error('Audacity reply exceeds 16 MB');
    if (/BatchCommand finished:[^\n]*\n/.test(body)) break;
  }
  process.stdout.write(JSON.stringify({ raw: body + decoder.end() }));
} catch (error) {
  const e = error as NodeJS.ErrnoException;
  process.stdout.write(JSON.stringify({ error: e.message, code: e.code, sent }));
  process.exitCode = 1;
} finally {
  await to?.close().catch(() => undefined);
  await from?.close().catch(() => undefined);
}
