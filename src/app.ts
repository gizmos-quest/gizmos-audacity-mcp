// Launching, showing, hiding and quitting Audacity. Audacity 3 has no
// headless mode; a hidden main window is the clean equivalent, because the
// pipe works the same and the tools never open a dialog.
import { spawn } from 'node:child_process';
import { existsSync, readdirSync } from 'node:fs';
import { rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { AudacityPipe } from './pipe.js';
import { formatCommand } from './format.js';

export function audacityExe(): string {
  const candidates = [
    process.env.AUDACITY_EXE,
    'C:\\Program Files\\Audacity\\Audacity.exe',
    '/usr/bin/audacity',
    '/Applications/Audacity.app/Contents/MacOS/Wrapper',
  ].filter((p): p is string => !!p);
  const found = candidates.find((p) => existsSync(p));
  if (!found) throw new Error('Audacity not found; set AUDACITY_EXE');
  return found;
}

function powershell(script: string): Promise<string> {
  return new Promise((resolve, reject) => {
    const child = spawn('powershell.exe', ['-NoProfile', '-NonInteractive', '-Command', script], { windowsHide: true });
    let out = '';
    let err = '';
    child.stdout.on('data', (d) => (out += d));
    child.stderr.on('data', (d) => (err += d));
    child.on('close', (code) => (code === 0 ? resolve(out.trim()) : reject(new Error(err.trim() || `exit ${code}`))));
  });
}

export async function isRunning(): Promise<boolean> {
  if (process.platform !== 'win32') return false;
  const out = await powershell('(Get-Process Audacity -ErrorAction SilentlyContinue | Measure-Object).Count');
  return Number(out) > 0;
}

export function pipeExists(): boolean {
  if (process.platform !== 'win32') return true;
  try {
    return readdirSync('\\\\.\\pipe\\').includes('ToSrvPipe');
  } catch {
    return false;
  }
}

export async function launch(visible: boolean, waitMs = 60_000): Promise<{ started: boolean; visible: boolean }> {
  if (pipeExists()) return { started: false, visible };
  if (process.platform !== 'win32') {
    spawn(audacityExe(), [], { detached: true, stdio: 'ignore' }).unref();
  } else {
    const style = visible ? 'Normal' : 'Hidden';
    await powershell(`Start-Process -FilePath '${audacityExe().replace(/'/g, "''")}' -WindowStyle ${style}`);
  }
  const deadline = Date.now() + waitMs;
  while (Date.now() < deadline) {
    if (pipeExists()) {
      await new Promise((r) => setTimeout(r, 1500)); // let the module finish registering
      return { started: true, visible };
    }
    await new Promise((r) => setTimeout(r, 500));
  }
  throw new Error(
    'Audacity started but its script pipe did not appear. A dialog (crash recovery, module prompt) may be ' +
      'waiting: show the window and close it, or enable mod-script-pipe under Preferences > Modules.',
  );
}

const WINDOW_SCRIPT = (show: boolean) => `
Add-Type @"
using System; using System.Runtime.InteropServices; using System.Text;
public static class GizmosWin {
  public delegate bool EnumProc(IntPtr h, IntPtr l);
  [DllImport("user32.dll")] public static extern bool EnumWindows(EnumProc f, IntPtr l);
  [DllImport("user32.dll")] public static extern uint GetWindowThreadProcessId(IntPtr h, out uint pid);
  [DllImport("user32.dll")] public static extern bool ShowWindow(IntPtr h, int cmd);
  [DllImport("user32.dll")] public static extern int GetWindowTextLength(IntPtr h);
  [DllImport("user32.dll")] public static extern bool SetForegroundWindow(IntPtr h);
}
"@
$ids = @(Get-Process Audacity -ErrorAction SilentlyContinue | ForEach-Object { [uint32]$_.Id })
$count = 0
[GizmosWin]::EnumWindows({ param($h, $l)
  $p = [uint32]0; [void][GizmosWin]::GetWindowThreadProcessId($h, [ref]$p)
  if ($ids -contains $p -and [GizmosWin]::GetWindowTextLength($h) -gt 0) {
    [void][GizmosWin]::ShowWindow($h, ${show ? 5 : 0}); ${show ? '[void][GizmosWin]::SetForegroundWindow($h);' : ''} $script:count++ }
  return $true }, [IntPtr]::Zero) | Out-Null
$count`;

export async function setWindowVisible(show: boolean): Promise<number> {
  if (process.platform !== 'win32') throw new Error('showing and hiding the window is implemented for Windows only');
  return Number(await powershell(WINDOW_SCRIPT(show)));
}

/**
 * Quit without a "save changes?" prompt: save the project to a temporary
 * file first (so nothing is unsaved), exit, then delete that file. Pass
 * keepProject to save to a real path instead.
 */
export async function quit(pipe: AudacityPipe, keepProject?: string): Promise<{ savedTo?: string }> {
  const target = keepProject ?? join(tmpdir(), `gizmos-audacity-quit-${Date.now()}.aup3`);
  await pipe.send(formatCommand('SaveProject2', { Filename: target }), 120_000);
  await pipe.send(formatCommand('Exit'), 30_000).catch(() => undefined); // the pipe closes with the app
  const deadline = Date.now() + 30_000;
  while (pipeExists() && Date.now() < deadline) await new Promise((r) => setTimeout(r, 300));
  if (!keepProject) {
    await rm(target, { force: true });
    await rm(`${target}-shm`, { force: true });
    await rm(`${target}-wal`, { force: true });
  }
  return keepProject ? { savedTo: target } : {};
}
