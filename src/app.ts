// Launching, showing, hiding and quitting Audacity. Audacity 3 has no
// headless mode; a hidden main window is the clean equivalent, because the
// pipe works the same and the tools never open a dialog.
import { spawn } from 'node:child_process';
import { existsSync, readdirSync, readFileSync, statSync } from 'node:fs';
import { rm, copyFile, writeFile, mkdtemp } from 'node:fs/promises';
import { tmpdir, homedir } from 'node:os';
import { join, resolve, sep } from 'node:path';
import { AudacityPipe, defaultPipePaths } from './pipe.js';
import { formatCommand } from './format.js';
import { validateProjectFile } from './ops.js';

export function audacityExe(): string {
  if (process.env.AUDACITY_EXE !== undefined) {
    const file = process.env.AUDACITY_EXE;
    if (!file || !existsSync(file) || !statSync(file).isFile()) throw new Error(`AUDACITY_EXE is not an existing executable file: ${file}`);
    return resolve(file);
  }
  const candidates = [
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
    let cancelled: Error | undefined;
    const timer = setTimeout(() => { cancelled = new Error('Audacity Windows helper timed out after 30000 ms'); child.kill(); }, 30_000);
    child.stdout.on('data', (d) => {
      if (out.length + d.length > 1_000_000) { cancelled = new Error('Audacity Windows helper output exceeds 1 MB'); child.kill(); }
      else out += d;
    });
    child.stderr.on('data', (d) => (err = (err + d).slice(-4096)));
    child.on('error', (error) => { clearTimeout(timer); reject(error); });
    child.on('close', (code) => {
      clearTimeout(timer);
      if (cancelled) reject(cancelled);
      else if (code === 0) resolve(out.trim());
      else reject(new Error(err.trim() || `exit ${code}`));
    });
  });
}

export interface AudacityProcess { pid: number; executable: string | null; fileVersion: string | null; productVersion: string | null }

/** Inspect actual running Windows binaries; a winget version pin alone is not evidence. */
export async function audacityProcesses(): Promise<AudacityProcess[]> {
  if (process.platform !== 'win32') return [];
  const out = await powershell(`
$found = @(Get-Process Audacity -ErrorAction SilentlyContinue | ForEach-Object {
  $processPath = $_.Path
  $version = if ($processPath) { (Get-Item -LiteralPath $processPath).VersionInfo } else { $null }
  [pscustomobject]@{ pid = $_.Id; executable = $processPath; fileVersion = $version.FileVersion; productVersion = $version.ProductVersion }
})
ConvertTo-Json -Compress -InputObject @($found)`);
  return out ? JSON.parse(out) as AudacityProcess[] : [];
}

export async function isRunning(): Promise<boolean> {
  if (process.platform !== 'win32') return pipeExists();
  const out = await powershell('(Get-Process Audacity -ErrorAction SilentlyContinue | Measure-Object).Count');
  return Number(out) > 0;
}

export function pipeExists(): boolean {
  if (process.platform !== 'win32') return existsSync(defaultPipePaths().to) && existsSync(defaultPipePaths().from);
  try {
    return readdirSync('\\\\.\\pipe\\').includes('ToSrvPipe');
  } catch {
    return false;
  }
}

export async function launch(visible: boolean, waitMs = 60_000): Promise<{ started: boolean; visible: boolean; processes: AudacityProcess[] }> {
  if (!Number.isFinite(waitMs) || waitMs <= 0 || waitMs > 2_147_483_647) throw new Error('waitMs must be positive, finite and at most 2147483647');
  if (pipeExists()) {
    const reply = await new AudacityPipe().send('GetInfo: Type=Tracks Format=JSON', 20_000);
    if (!reply.ok) throw new Error(reply.body || reply.status);
    if (process.platform === 'win32') await setWindowVisible(visible);
    return { started: false, visible, processes: await audacityProcesses() };
  }
  if (await isRunning()) throw new Error('Audacity is running without a reachable pipe. Use audacity_dialogs or audacity_recover; do not start a second project window.');
  const recovery = recoveryEntries();
  if (recovery.length) throw new Error(`Audacity has ${recovery.length} crash-recovery entries. Use audacity_recover to inspect them before launch.`);
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
      // The pipe is published before the UI event loop finishes startup.
      const reply = await new AudacityPipe().send('GetInfo: Type=Tracks Format=JSON', Math.min(20_000, Math.max(1000, deadline - Date.now())));
      if (!reply.ok) throw new Error(reply.body || reply.status);
      if (process.platform === 'win32') await setWindowVisible(visible);
      return { started: true, visible, processes: await audacityProcesses() };
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
  [DllImport("user32.dll")] public static extern bool SetWindowPos(IntPtr h, IntPtr after, int x, int y, int width, int height, uint flags);
  [DllImport("user32.dll", CharSet=CharSet.Unicode)] public static extern int GetWindowText(IntPtr h, StringBuilder s, int n);
  [DllImport("user32.dll", CharSet=CharSet.Unicode)] public static extern int GetClassName(IntPtr h, StringBuilder s, int n);
}
"@
$ids = @(Get-Process Audacity -ErrorAction SilentlyContinue | ForEach-Object { [uint32]$_.Id })
$script:frames = New-Object System.Collections.ArrayList
[GizmosWin]::EnumWindows({ param($h, $l)
  $p = [uint32]0; [void][GizmosWin]::GetWindowThreadProcessId($h, [ref]$p)
  $c = New-Object System.Text.StringBuilder 256; [void][GizmosWin]::GetClassName($h, $c, 256)
  $t = New-Object System.Text.StringBuilder 512; [void][GizmosWin]::GetWindowText($h, $t, 512)
  if ($ids -contains $p -and $t.Length -gt 0 -and $c.ToString().StartsWith('wxWindow')) {
    [void]$script:frames.Add([pscustomobject]@{ handle = $h; title = $t.ToString() }) }
  return $true }, [IntPtr]::Zero) | Out-Null
# Live 3.7.8: ShowWindow from a hidden helper left the project frame hidden.
# SetWindowPos forces visibility without moving, sizing, ordering or activation.
# Settle the wxWidgets parent before showing the actual project frame.
${show ? `
foreach ($frame in $script:frames) { if ($frame.title -eq 'panel') { [void][GizmosWin]::SetWindowPos($frame.handle, [IntPtr]::Zero, 0, 0, 0, 0, 0x57) } }
Start-Sleep -Milliseconds 150
foreach ($frame in $script:frames) { if ($frame.title -ne 'panel') { [void][GizmosWin]::SetWindowPos($frame.handle, [IntPtr]::Zero, 0, 0, 0, 0, 0x57) } }
` : `foreach ($frame in $script:frames) { [void][GizmosWin]::SetWindowPos($frame.handle, [IntPtr]::Zero, 0, 0, 0, 0, 0x97) }`}
$script:frames.Count`;

const DIALOG_SCRIPT = (close: boolean) => `
Add-Type @"
using System; using System.Runtime.InteropServices; using System.Text;
public static class GizmosDlg {
  public delegate bool EnumProc(IntPtr h, IntPtr l);
  [DllImport("user32.dll")] public static extern bool EnumWindows(EnumProc f, IntPtr l);
  [DllImport("user32.dll")] public static extern bool EnumChildWindows(IntPtr h, EnumProc f, IntPtr l);
  [DllImport("user32.dll")] public static extern uint GetWindowThreadProcessId(IntPtr h, out uint pid);
  [DllImport("user32.dll")] public static extern bool IsWindowVisible(IntPtr h);
  [DllImport("user32.dll")] public static extern bool IsWindowEnabled(IntPtr h);
  [DllImport("user32.dll")] public static extern IntPtr GetWindow(IntPtr h, uint cmd);
  [DllImport("user32.dll", CharSet=CharSet.Unicode)] public static extern int GetWindowText(IntPtr h, StringBuilder s, int n);
  [DllImport("user32.dll")] public static extern int GetWindowLong(IntPtr h, int index);
  [DllImport("user32.dll", CharSet=CharSet.Unicode)] public static extern int GetClassName(IntPtr h, StringBuilder s, int n);
  [DllImport("user32.dll")] public static extern bool PostMessage(IntPtr h, uint msg, IntPtr w, IntPtr l);
}
"@
$found = New-Object System.Collections.ArrayList
$ids = @(Get-Process Audacity -ErrorAction SilentlyContinue | ForEach-Object { [uint32]$_.Id })
[GizmosDlg]::EnumWindows({ param($h, $l)
  $p = [uint32]0; [void][GizmosDlg]::GetWindowThreadProcessId($h, [ref]$p)
  if ($ids -contains $p) {
    $t = New-Object System.Text.StringBuilder 512; [void][GizmosDlg]::GetWindowText($h, $t, 512)
    $c = New-Object System.Text.StringBuilder 256; [void][GizmosDlg]::GetClassName($h, $c, 256)
    $owner = [GizmosDlg]::GetWindow($h, 4)
    $blockedOwner = $owner -ne [IntPtr]::Zero -and -not [GizmosDlg]::IsWindowEnabled($owner)
    $dialog = ($c.ToString() -eq '#32770' -and ([GizmosDlg]::IsWindowVisible($h) -or $blockedOwner)) -or ($blockedOwner -and ([GizmosDlg]::GetWindowLong($h, -20) -band 1) -ne 0)
    $script:dialogTexts = New-Object System.Collections.ArrayList
    if ($dialog) {
      [void][GizmosDlg]::EnumChildWindows($h, { param($child, $unused)
        $text = New-Object System.Text.StringBuilder 2048; [void][GizmosDlg]::GetWindowText($child, $text, 2048)
        if ($text.Length -gt 0) { [void]$script:dialogTexts.Add($text.ToString()) }
        return $true }, [IntPtr]::Zero)
    }
    $closed = $false
    if (${close ? '$true' : '$false'} -and $dialog) { [void][GizmosDlg]::PostMessage($h, 0x0010, [IntPtr]::Zero, [IntPtr]::Zero); $closed = $true }
    if ($t.Length -gt 0) { [void]$found.Add([pscustomobject]@{ title = $t.ToString(); className = $c.ToString(); dialog = $dialog; message = ($script:dialogTexts -join '\n'); closed = $closed; visible = [GizmosDlg]::IsWindowVisible($h) }) }
  }
  return $true }, [IntPtr]::Zero) | Out-Null
ConvertTo-Json -Compress -InputObject @($found)`;

/** Audacity's visible top-level windows; with close, its standard dialogs get WM_CLOSE (no input simulation). */
export async function listWindows(close: boolean): Promise<{ title: string; dialog: boolean; closed: boolean; visible: boolean }[]> {
  if (process.platform !== 'win32') throw new Error('dialog handling is implemented for Windows only');
  const out = await powershell(DIALOG_SCRIPT(close));
  return out ? (JSON.parse(out) as { title: string; dialog: boolean; closed: boolean; visible: boolean }[]) : [];
}

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
  const scratch = keepProject === undefined ? await mkdtemp(join(tmpdir(), 'gizmos-audacity-quit-')) : undefined;
  const target = keepProject ?? join(scratch!, 'project.aup3');
  validateProjectFile(target, true);
  let save;
  try { save = await pipe.send(formatCommand('SaveProject2', { Filename: target }), 120_000); }
  catch (error) {
    if (scratch && error instanceof Error && pipe.needsRecovery) error.message += `. Temporary save destination retained for inspection: ${target}`;
    throw error;
  }
  if (!save.ok) throw new Error(save.body || save.status);
  const exit = await pipe.send(formatCommand('Exit'), 30_000).catch(() => undefined); // the pipe closes with the app
  if (exit && !exit.ok) throw new Error(`${exit.body || exit.status}. Project retained at ${target}`);
  const deadline = Date.now() + 30_000;
  while (await isRunning() && Date.now() < deadline) await new Promise((r) => setTimeout(r, 300));
  if (await isRunning()) throw new Error(`Audacity did not quit; project retained at ${target}. Check audacity_dialogs.`);
  pipe.reset();
  if (scratch) {
    const resolved = resolve(scratch);
    if (!resolved.startsWith(resolve(tmpdir()) + sep) || !resolved.includes('gizmos-audacity-quit-')) throw new Error(`refusing unsafe quit scratch cleanup: ${resolved}`);
    await rm(resolved, { recursive: true, force: true });
  }
  return keepProject ? { savedTo: target } : {};
}

export function configPath(): string {
  if (process.env.AUDACITY_CONFIG) return process.env.AUDACITY_CONFIG;
  if (process.platform === 'win32') return join(process.env.APPDATA ?? homedir(), 'audacity', 'audacity.cfg');
  if (process.platform === 'darwin') return join(homedir(), 'Library', 'Application Support', 'audacity', 'audacity.cfg');
  return join(process.env.XDG_CONFIG_HOME ?? join(homedir(), '.config'), 'audacity', 'audacity.cfg');
}

export function parseActiveProjects(config: string): string[] {
  const section = config.match(/^\[ActiveProjects\]\r?\n([\s\S]*?)(?=^\[|$(?![\s\S]))/m)?.[1] ?? '';
  return section.split(/\r?\n/).flatMap((line) => /^\d+=(.+)$/.exec(line)?.[1]?.replace(/\\\\/g, '\\') ?? []);
}

/** Entries are expected while a project is open; they are stale only after a clean process check. */
export function recoveryEntries(): string[] {
  return existsSync(configPath()) ? parseActiveProjects(readFileSync(configPath(), 'utf8')) : [];
}

export async function discardStaleRecovery(): Promise<{ backup: string; projects: string[] }> {
  if (await isRunning()) throw new Error('recovery entries can only be changed while Audacity is stopped');
  const file = configPath(); const config = readFileSync(file, 'utf8');
  const projects = parseActiveProjects(config);
  const backup = `${file}.before-recovery-${Date.now()}.bak`;
  await copyFile(file, backup);
  await writeFile(file, config.replace(/^(\[ActiveProjects\]\r?\n)[\s\S]*?(?=^\[|$(?![\s\S]))/m, '$1'));
  return { backup, projects }; // Project files and their recovery data are never deleted.
}
