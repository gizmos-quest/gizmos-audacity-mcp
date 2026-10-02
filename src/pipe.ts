// Client for Audacity's mod-script-pipe: one command in, one reply out.
//
// Audacity serves two named pipes (Windows: \\.\pipe\ToSrvPipe and
// \\.\pipe\FromSrvPipe; elsewhere /tmp/audacity_script_pipe.{to,from}.<uid>).
// A command is one line; the reply is a block of lines ending with
// "BatchCommand finished: OK|Failed!". Audacity handles one command at a
// time, so every call goes through a queue.
import { open, type FileHandle } from 'node:fs/promises';
import { userInfo } from 'node:os';

export interface PipePaths {
  to: string;
  from: string;
}

export function defaultPipePaths(platform: NodeJS.Platform = process.platform): PipePaths {
  if (platform === 'win32') {
    return { to: '\\\\.\\pipe\\ToSrvPipe', from: '\\\\.\\pipe\\FromSrvPipe' };
  }
  const uid = userInfo().uid;
  return { to: `/tmp/audacity_script_pipe.to.${uid}`, from: `/tmp/audacity_script_pipe.from.${uid}` };
}

export interface PipeReply {
  ok: boolean;
  /** Reply body without the trailing "BatchCommand finished" line. */
  body: string;
  status: string;
}

export class AudacityUnavailable extends Error {}
export class AudacityTimeout extends Error {}

const FINISHED = 'BatchCommand finished:';

export function parseReply(raw: string): PipeReply {
  const lines = raw.replace(/\r/g, '').split('\n');
  const index = lines.findIndex((line) => line.startsWith(FINISHED));
  const status = index >= 0 ? (lines[index] ?? '').slice(FINISHED.length).trim() : 'missing';
  const body = (index >= 0 ? lines.slice(0, index) : lines).join('\n').trim();
  return { ok: status === 'OK', body, status };
}

export class AudacityPipe {
  private queue: Promise<unknown> = Promise.resolve();

  constructor(
    private readonly paths: PipePaths = defaultPipePaths(),
    private readonly defaultTimeoutMs = 120_000,
  ) {}

  send(command: string, timeoutMs = this.defaultTimeoutMs): Promise<PipeReply> {
    if (/[\r\n\0]/.test(command)) {
      throw new Error('a command must be a single line');
    }
    const run = this.queue.then(() => this.exchange(command, timeoutMs));
    this.queue = run.catch(() => undefined);
    return run;
  }

  private async exchange(command: string, timeoutMs: number): Promise<PipeReply> {
    let to: FileHandle | undefined;
    let from: FileHandle | undefined;
    try {
      // Audacity re-creates the pipe instance after each client disconnects; a command that
      // follows quickly can find it missing for a moment, so opening is retried briefly.
      const deadline = Date.now() + 5_000;
      for (;;) {
        try {
          to ??= await open(this.paths.to, 'w');
          from = await open(this.paths.from, 'r');
          break;
        } catch (error) {
          const code = (error as NodeJS.ErrnoException).code ?? 'error';
          if (Date.now() < deadline && (code === 'ENOENT' || code === 'EBUSY')) {
            await new Promise((r) => setTimeout(r, 50));
            continue;
          }
          throw new AudacityUnavailable(
            `Audacity's script pipe is not reachable (${code}). Start Audacity 3.x with mod-script-pipe enabled.`,
          );
        }
      }
      await to.write(`${command}\r\n\0`);
      const reader = from;
      const read = (async () => {
        const chunks: string[] = [];
        const buffer = Buffer.alloc(65_536);
        for (;;) {
          const { bytesRead } = await reader.read(buffer, 0, buffer.length, null);
          if (bytesRead === 0) break;
          chunks.push(buffer.toString('utf8', 0, bytesRead));
          const text = chunks.join('');
          if (/BatchCommand finished:[^\n]*\n/.test(text)) return text;
        }
        return chunks.join('');
      })();
      let timer: NodeJS.Timeout | undefined;
      const timeout = new Promise<never>((_, reject) => {
        timer = setTimeout(() => reject(new AudacityTimeout(`no reply within ${timeoutMs} ms: ${command}`)), timeoutMs);
      });
      try {
        return parseReply(await Promise.race([read, timeout]));
      } finally {
        clearTimeout(timer);
      }
    } finally {
      await to?.close().catch(() => undefined);
      await from?.close().catch(() => undefined);
    }
  }
}
