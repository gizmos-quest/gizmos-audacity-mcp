// Client for Audacity's mod-script-pipe. Every exchange uses a disposable
// Node helper because an awaited FileHandle.close cannot cancel a blocked
// Windows read. Only the helper is terminated on timeout, never Audacity.
import { spawn } from 'node:child_process';
import { existsSync } from 'node:fs';
import { userInfo } from 'node:os';
import { fileURLToPath } from 'node:url';
import { SerialQueue } from './queue.js';

export interface PipePaths { to: string; from: string }
export function defaultPipePaths(platform: NodeJS.Platform = process.platform): PipePaths {
  if (platform === 'win32') return { to: '\\\\.\\pipe\\ToSrvPipe', from: '\\\\.\\pipe\\FromSrvPipe' };
  const uid = userInfo().uid;
  return { to: `/tmp/audacity_script_pipe.to.${uid}`, from: `/tmp/audacity_script_pipe.from.${uid}` };
}
export interface PipeReply { ok: boolean; body: string; status: string }
export class AudacityUnavailable extends Error {
  constructor(message: string, readonly uncertainOutcome = false) { super(message); }
}
export class AudacityTimeout extends Error {}
export class AudacityNeedsRecovery extends Error {}
export function parseReply(raw: string): PipeReply {
  const lines = raw.replace(/\r/g, '').split('\n');
  const index = lines.findIndex((line) => line.startsWith('BatchCommand finished:'));
  const status = index >= 0 ? (lines[index] ?? '').slice('BatchCommand finished:'.length).trim() : 'missing';
  return { ok: status === 'OK', body: (index >= 0 ? lines.slice(0, index) : lines).join('\n').trim(), status };
}
export type PipeTransport = (paths: PipePaths, command: string, timeoutMs: number) => Promise<PipeReply>;

const exchange: PipeTransport = (paths, command, timeoutMs) => new Promise((resolve, reject) => {
  const compiled = new URL('./pipe-worker.js', import.meta.url);
  const helper = existsSync(compiled) ? compiled : new URL('./pipe-worker.ts', import.meta.url);
  const child = spawn(process.execPath, [fileURLToPath(helper)], { windowsHide: true, stdio: ['pipe', 'pipe', 'pipe'] });
  let output = ''; let error = ''; let timedOut = false;
  const timer = setTimeout(() => {
    timedOut = true;
    child.kill(); // Cancels the pipe client's I/O; the Audacity process keeps running.
    reject(new AudacityTimeout(`no reply within ${timeoutMs} ms: ${command}`));
  }, timeoutMs);
  child.stdout.setEncoding('utf8'); child.stderr.setEncoding('utf8');
  child.stdout.on('data', (chunk: string) => { output += chunk; if (output.length > 20_000_000) child.kill(); });
  child.stderr.on('data', (chunk: string) => { error = (error + chunk).slice(-4096); });
  child.on('error', (e) => { clearTimeout(timer); reject(new AudacityUnavailable(e.message)); });
  child.on('close', () => {
    clearTimeout(timer);
    if (timedOut) return;
    try {
      const result = JSON.parse(output) as { raw?: string; error?: string; code?: string; sent?: boolean };
      if (result.raw === undefined) throw new AudacityUnavailable(`Audacity's script pipe is not reachable (${result.code ?? result.error}).`, result.sent ?? true);
      const reply = parseReply(result.raw);
      if (reply.status === 'missing') throw new AudacityUnavailable('Audacity disconnected before completing its reply; check audacity_recover.', true);
      resolve(reply);
    } catch (e) { reject(e instanceof AudacityUnavailable ? e : new AudacityUnavailable(error || String(e), true)); }
  });
  child.stdin.on('error', () => undefined);
  child.stdin.end(JSON.stringify({ paths, command }));
});

export class AudacityPipe {
  private readonly queue = new SerialQueue();
  private uncertain = false;
  constructor(private readonly paths: PipePaths = defaultPipePaths(), private readonly defaultTimeoutMs = 120_000,
    private readonly transport: PipeTransport = exchange) {}
  get needsRecovery(): boolean { return this.uncertain; }
  /** Explicit recovery only: never automatically replay a possibly completed edit. */
  reset(): void { this.uncertain = false; }
  send(command: string, timeoutMs = this.defaultTimeoutMs): Promise<PipeReply> {
    if (/[\r\n\0]/.test(command)) throw new Error('a command must be a single line');
    if (!Number.isFinite(timeoutMs) || timeoutMs <= 0) throw new Error('timeoutMs must be positive and finite');
    return this.queue.run(async () => {
      if (this.uncertain) throw new AudacityNeedsRecovery('A previous command did not complete with a trustworthy reply; its outcome is unknown. Close blocking dialogs with audacity_dialogs, then use audacity_recover. Do not replay the edit blindly.');
      try { return await this.transport(this.paths, command, timeoutMs); }
      catch (e) { if (e instanceof AudacityTimeout || e instanceof AudacityUnavailable && e.uncertainOutcome) this.uncertain = true; throw e; }
    });
  }
}
