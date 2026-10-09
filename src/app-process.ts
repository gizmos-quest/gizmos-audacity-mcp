import { spawn } from 'node:child_process';
import { accessSync, constants, existsSync, readdirSync, statSync } from 'node:fs';
import { resolve } from 'node:path';
import { powershell } from './app-helper.js';
import { defaultPipePaths } from './pipe.js';

export function audacityExe(): string {
  const explicit = process.env.AUDACITY_EXE;
  const candidates =
    explicit !== undefined
      ? [explicit]
      : [
          'C:\\Program Files\\Audacity\\Audacity.exe',
          '/usr/bin/audacity',
          '/Applications/Audacity.app/Contents/MacOS/Wrapper',
        ];
  const file = candidates.find((candidate) => candidate && existsSync(candidate) && statSync(candidate).isFile());
  if (!file)
    throw new Error(
      explicit !== undefined
        ? `AUDACITY_EXE is not an existing executable file: ${explicit}`
        : 'Audacity not found; set AUDACITY_EXE',
    );
  if (process.platform !== 'win32') {
    try {
      accessSync(file, constants.X_OK);
    } catch {
      throw new Error(`AUDACITY_EXE is not executable: ${file}`);
    }
  } else if (!/\.exe$/i.test(file)) throw new Error(`AUDACITY_EXE must be a Windows executable (.exe): ${file}`);
  return resolve(file);
}

export interface AudacityProcess {
  pid: number;
  executable: string | null;
  fileVersion: string | null;
  productVersion: string | null;
  started?: string;
  owner?: string;
}

function capture(command: string, args: string[]): Promise<string> {
  return new Promise((resolveOutput, reject) => {
    const child = spawn(command, args, { windowsHide: true });
    let output = '';
    let error = '';
    const timer = setTimeout(() => {
      child.kill();
      reject(new Error('Process inspection timed out'));
    }, 10_000);
    child.stdout.on('data', (data) => {
      output += data;
      if (output.length > 1_000_000) {
        child.kill();
        reject(new Error('Process inspection exceeds 1 MB'));
      }
    });
    child.stderr.on('data', (data) => {
      error = (error + data).slice(-4096);
    });
    child.once('error', (failure) => {
      clearTimeout(timer);
      reject(failure);
    });
    child.once('close', (code) => {
      clearTimeout(timer);
      if (code === 0) resolveOutput(output);
      else reject(new Error(error || `Process inspection exited ${code}`));
    });
  });
}

/** Process records, not stale FIFO names, authorize stopped-only config writes. */
export async function audacityProcesses(): Promise<AudacityProcess[]> {
  if (process.platform !== 'win32') {
    const output = await capture('ps', ['-axo', 'pid=,uid=,lstart=,comm=']);
    return output.split('\n').flatMap((line) => {
      const match = /^\s*(\d+)\s+(\d+)\s+(.{24})\s+(.+?)\s*$/.exec(line);
      if (
        !match ||
        !/(?:^|\/)audacity(?:$|\.app\/)|Audacity\.app\/Contents\/MacOS\/(?:Wrapper|Audacity)$/i.test(match[4]!)
      )
        return [];
      return [
        {
          pid: Number(match[1]),
          owner: match[2]!,
          executable: match[4]!,
          started: match[3]!,
          fileVersion: null,
          productVersion: null,
        },
      ];
    });
  }
  const output = await powershell(`
$found = @(Get-Process Audacity -ErrorAction SilentlyContinue | ForEach-Object {
  $processPath = $_.Path
  $version = if ($processPath) { (Get-Item -LiteralPath $processPath).VersionInfo } else { $null }
  $identity = Get-CimInstance Win32_Process -Filter "ProcessId=$($_.Id)"
  $user = if ($identity) { Invoke-CimMethod -InputObject $identity -MethodName GetOwner -ErrorAction SilentlyContinue } else { $null }
  [pscustomobject]@{ pid = $_.Id; executable = $processPath; fileVersion = $version.FileVersion; productVersion = $version.ProductVersion; started = $_.StartTime.ToUniversalTime().Ticks.ToString(); owner = $user.User }
})
ConvertTo-Json -Compress -InputObject @($found)`);
  return output ? (JSON.parse(output) as AudacityProcess[]) : [];
}

export async function currentProcessIdentity(): Promise<string | undefined> {
  const processes = await audacityProcesses();
  if (processes.length !== 1) return undefined;
  const process = processes[0]!;
  if (!process.executable || !process.started) return undefined;
  return JSON.stringify([process.pid, process.executable, process.started]);
}

export function assertExecutableMatches(
  executable: string,
  processes: readonly AudacityProcess[],
  platform = process.platform,
): void {
  const normalize = (file: string) => (platform === 'win32' ? resolve(file).toLowerCase() : resolve(file));
  if (processes.length > 1)
    throw new Error(
      'Multiple Audacity processes share the pipe; preserve and quit extra installations before attaching.',
    );
  const other = processes.find(
    (process) => !process.executable || normalize(process.executable) !== normalize(executable),
  );
  if (other)
    throw new Error(
      `AUDACITY_EXE requests ${executable}, but Audacity PID ${other.pid} is running from ${other.executable ?? 'an unknown executable'}. Preserve and quit that installation before using this override.`,
    );
}

export async function preflightExecutableOverride(): Promise<void> {
  if (process.env.AUDACITY_EXE === undefined) return;
  const executable = audacityExe();
  assertExecutableMatches(executable, await audacityProcesses());
}
export async function isRunning(): Promise<boolean> {
  return (await audacityProcesses()).length > 0;
}
export function pipeExists(): boolean {
  if (process.env.AUDACITY_PIPE_TO !== undefined || process.platform !== 'win32') {
    const paths = defaultPipePaths();
    return existsSync(paths.to) && existsSync(paths.from);
  }
  try {
    return readdirSync('\\\\.\\pipe\\').includes('ToSrvPipe');
  } catch {
    return false;
  }
}

export async function executableVersion(file = audacityExe()): Promise<string> {
  if (process.platform === 'win32')
    return (
      await powershell(`(Get-Item -LiteralPath '${file.replaceAll("'", "''")}').VersionInfo.FileVersion`)
    ).replaceAll(',', '.');
  const output = await capture(file, ['--version']);
  const version = /\b(\d+\.\d+\.\d+)\b/.exec(output)?.[1];
  if (!version) throw new Error('Cannot determine Audacity version');
  return version;
}

export function assertSupportedVersion(version: string): void {
  if (/^4\./.test(version)) throw new Error('Audacity 4 has no mod-script-pipe; install Audacity 3.7.x.');
  if (!/^3\.7\.(?:8|9)(?:\.0)?$/.test(version))
    throw new Error(
      `Unsupported Audacity version ${version}; use the verified 3.7.8 target (3.7.9 compatibility is separately tested).`,
    );
}

/** Wait for spawn/error instead of letting a detached ENOENT/EACCES escape. */
export async function startPosix(file: string): Promise<void> {
  await new Promise<void>((resolveStarted, reject) => {
    const child = spawn(file, [], { detached: true, stdio: 'ignore' });
    child.once('error', reject);
    child.once('spawn', () => {
      child.unref();
      resolveStarted();
    });
  });
}
