// Client for Audacity's mod-script-pipe. Every exchange uses a disposable
// Node helper because an awaited FileHandle.close cannot cancel a blocked
// Windows read. Only the helper is terminated on timeout, never Audacity.
import { spawn } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import { existsSync } from 'node:fs';
import { userInfo } from 'node:os';
import { fileURLToPath } from 'node:url';
import { assertCommandBudget, parseInfoJson } from './format.js';
import { acquirePipeOwnership, releasePipeOwnership } from './pipe-ownership.js';
import { validatePipePaths } from './pipe-paths.js';
import { SerialQueue } from './queue.js';

export interface PipePaths {
  to: string;
  from: string;
}
export function defaultPipePaths(platform: NodeJS.Platform = process.platform): PipePaths {
  const to = process.env.AUDACITY_PIPE_TO;
  const from = process.env.AUDACITY_PIPE_FROM;
  if (to !== undefined || from !== undefined) {
    if (!to || !from) throw new Error('AUDACITY_PIPE_TO and AUDACITY_PIPE_FROM must both be nonempty');
    validatePipePaths({ to, from }, platform);
    return { to, from };
  }
  return nativePipePaths(platform);
}
/** Audacity's own endpoints: only these belong to a process whose installation can be qualified. */
export function nativePipePaths(platform: NodeJS.Platform = process.platform): PipePaths {
  if (platform === 'win32') return { to: '\\\\.\\pipe\\ToSrvPipe', from: '\\\\.\\pipe\\FromSrvPipe' };
  const uid = userInfo().uid;
  return { to: `/tmp/audacity_script_pipe.to.${uid}`, from: `/tmp/audacity_script_pipe.from.${uid}` };
}
export interface PipeReply {
  ok: boolean;
  body: string;
  status: string;
}
export class AudacityUnavailable extends Error {
  constructor(
    message: string,
    readonly uncertainOutcome = false,
    /** The next step that tool errors append to the message. */
    readonly advice = uncertainOutcome
      ? ' Use audacity_dialogs and audacity_recover; do not replay edits blindly.'
      : ' Use audacity_launch.',
  ) {
    super(message);
  }
}
/** The relay answered without a project (the lone LF in pipe-worker): nothing ran. */
export class AudacityNoProject extends AudacityUnavailable {}
export class AudacityTimeout extends Error {}
export class AudacityNeedsRecovery extends Error {}
const NO_PROJECT =
  'Audacity answered with an empty reply and no status: it has no active project (still starting up, or its project window was closed), so its script relay did not run the command. Wait for startup and check audacity_dialogs.';
export function parseReply(raw: string): PipeReply {
  const lines = raw.replace(/\r/g, '').split('\n');
  const index = lines.findIndex((line) => line.startsWith('BatchCommand finished:'));
  const status = index >= 0 ? (lines[index] ?? '').slice('BatchCommand finished:'.length).trim() : 'missing';
  return { ok: status === 'OK', body: (index >= 0 ? lines.slice(0, index) : lines).join('\n').trim(), status };
}
export type PipeTransport = (
  paths: PipePaths,
  command: string,
  timeoutMs: number,
  nonce?: string,
) => Promise<PipeReply>;

const exchange: PipeTransport = (paths, command, timeoutMs, nonce) => {
  validatePipePaths(paths);
  return new Promise((resolve, reject) => {
    const compiled = new URL('./pipe-worker.js', import.meta.url);
    const helper = existsSync(compiled) ? compiled : new URL('./pipe-worker.ts', import.meta.url);
    // Source-only maintainer entry points need TS .js-specifier resolution.
    // tsx is already a dev dependency; npm installations always use built JS.
    const args = existsSync(compiled) ? [fileURLToPath(helper)] : ['--import', 'tsx', fileURLToPath(helper)];
    const child = spawn(process.execPath, args, {
      windowsHide: true,
      stdio: ['pipe', 'pipe', 'pipe'],
    });
    let output = '';
    let error = '';
    let cancellation: Error | undefined;
    const timer = setTimeout(() => {
      cancellation = new AudacityTimeout(`no reply within ${timeoutMs} ms: ${command}`);
      child.kill(); // Cancels the pipe client's I/O; the Audacity process keeps running.
      // Wait for the helper's close event before another queued exchange can
      // start. Otherwise the old reader can steal the recovery probe's reply.
    }, timeoutMs);
    child.stdout.setEncoding('utf8');
    child.stderr.setEncoding('utf8');
    child.stdout.on('data', (chunk: string) => {
      if (cancellation) return;
      if (output.length + chunk.length > 20_000_000) {
        cancellation = new AudacityUnavailable(
          'Audacity pipe helper output exceeds 20 MB; check audacity_recover.',
          true,
        );
        child.kill();
      } else output += chunk;
    });
    child.stderr.on('data', (chunk: string) => {
      error = (error + chunk).slice(-4096);
    });
    child.on('error', (e) => {
      clearTimeout(timer);
      reject(new AudacityUnavailable(e.message, child.pid !== undefined));
    });
    child.on('close', () => {
      clearTimeout(timer);
      if (cancellation) {
        reject(cancellation);
        return;
      }
      try {
        const result = JSON.parse(output) as {
          raw?: string;
          idle?: boolean;
          error?: string;
          code?: string;
          sent?: boolean;
        };
        // Windows serves one client at a time: busy means an earlier command still
        // runs (or waits on a dialog) after its client was cancelled.
        if (result.raw === undefined && result.code === 'EBUSY')
          throw new AudacityUnavailable(
            "Audacity's script pipe is busy: an earlier command is still running or waits on a dialog.",
            result.sent ?? true,
            ' Check audacity_dialogs, wait, then retry; do not replay edits blindly.',
          );
        if (result.raw === undefined)
          throw new AudacityUnavailable(
            `Audacity's script pipe is not reachable (${result.code ?? result.error}).`,
            result.sent ?? true,
          );
        // The relay runs nothing without a project, but keep the latch until a
        // synchronized recovery read proves an active project again.
        if (result.idle) throw new AudacityNoProject(NO_PROJECT, true);
        const reply = parseReply(result.raw);
        if (reply.status === 'missing')
          throw new AudacityUnavailable(
            'Audacity disconnected before completing its reply; check audacity_recover.',
            true,
          );
        resolve(reply);
      } catch (e) {
        reject(e instanceof AudacityUnavailable ? e : new AudacityUnavailable(error || String(e), true));
      }
    });
    child.stdin.on('error', () => undefined);
    child.stdin.end(JSON.stringify({ paths, command, nonce }));
  });
};

export type PipeQualifier = (paths: PipePaths) => Promise<void>;

export class AudacityPipe {
  private readonly queue = new SerialQueue();
  private uncertain = false;
  private qualified = false;
  constructor(
    private readonly paths: PipePaths = defaultPipePaths(),
    private readonly defaultTimeoutMs = 120_000,
    private readonly transport: PipeTransport = exchange,
    /** Checks the Audacity installation before each operation's first command other than a read. */
    private readonly qualify?: PipeQualifier,
  ) {}
  /** A new tool operation qualifies Audacity again before its first edit. */
  newOperation(): void {
    this.qualified = false;
  }
  get needsRecovery(): boolean {
    return this.uncertain;
  }
  /** Clear after an observed process exit, a projectless read-only probe, or for transport fixtures. */
  reset(): void {
    this.uncertain = false;
  }
  /** Release only after all operations finish; useful for sequential test clients. */
  release(): void {
    releasePipeOwnership(this.paths);
  }
  /** Synchronize a channel, not the earlier edit's outcome. Never replay it.
   * Message/Text is private: live 3.7.8 ARM64 on 2026-10-09 returned the exact
   * nonce with OK and no dialog. PipeServer processes requests serially. Drain
   * stale complete frames on the SAME handles until this nonce, then read Tracks.
   * The public Message command remains reserved. */
  reconnect(timeoutMs = this.defaultTimeoutMs): Promise<PipeReply> {
    this.validateTimeout(timeoutMs);
    return this.queue.run(async () => {
      this.uncertain = true;
      try {
        if (this.transport === exchange) acquirePipeOwnership(this.paths);
        const nonce = `gizmos-sync-${randomUUID().replaceAll('-', '')}`;
        const barrier = await this.transport(this.paths, `Message: Text=${nonce}`, timeoutMs, nonce);
        if (!barrier.ok || barrier.body !== nonce)
          throw new AudacityUnavailable(
            'Recovery nonce was not acknowledged; connection remains unsynchronized.',
            true,
          );
        const reply = await this.transport(this.paths, 'GetInfo: Type=Tracks Format=JSON', timeoutMs);
        if (reply.ok) {
          // The correlated barrier passed all prior requests. Validate actual
          // current state before releasing edits or restoring import guards.
          let tracks: unknown;
          try {
            tracks = parseInfoJson(reply.body);
          } catch {
            throw new AudacityUnavailable(
              'Reconnect returned no readable Tracks JSON; the prior outcome remains unknown.',
              true,
            );
          }
          if (
            !Array.isArray(tracks) ||
            tracks.some(
              (track: unknown) =>
                !track ||
                typeof track !== 'object' ||
                typeof (track as Record<string, unknown>).name !== 'string' ||
                typeof (track as Record<string, unknown>).kind !== 'string',
            )
          ) {
            throw new AudacityUnavailable(
              'Reconnect returned invalid Tracks state; the prior outcome remains unknown.',
              true,
            );
          }
          this.uncertain = false;
        }
        return reply;
      } catch (error) {
        if (error instanceof AudacityTimeout || (error instanceof AudacityUnavailable && error.uncertainOutcome))
          this.uncertain = true;
        throw error;
      }
    });
  }
  private validateTimeout(timeoutMs: number): void {
    if (!Number.isFinite(timeoutMs) || timeoutMs <= 0 || timeoutMs > 2_147_483_647)
      throw new Error('timeoutMs must be positive, finite and at most 2147483647');
  }
  send(command: string, timeoutMs = this.defaultTimeoutMs): Promise<PipeReply> {
    assertCommandBudget(command);
    this.validateTimeout(timeoutMs);
    return this.queue.run(async () => {
      if (this.uncertain)
        throw new AudacityNeedsRecovery(
          'A previous command did not complete with a trustworthy reply; its outcome is unknown. Close blocking dialogs with audacity_dialogs, then use audacity_recover. Do not replay the edit blindly.',
        );
      if (this.qualify && !this.qualified && !/^Get(?:Info|Preference):/.test(command)) {
        await this.qualify(this.paths);
        this.qualified = true;
      }
      if (this.transport === exchange) acquirePipeOwnership(this.paths);
      try {
        return await this.transport(this.paths, command, timeoutMs);
      } catch (e) {
        if (e instanceof AudacityTimeout || (e instanceof AudacityUnavailable && e.uncertainOutcome))
          this.uncertain = true;
        throw e;
      }
    });
  }
}
