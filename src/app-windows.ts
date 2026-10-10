import { powershell } from './app-helper.js';

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
${
  show
    ? `
foreach ($frame in $script:frames) { if ($frame.title -eq 'panel') { [void][GizmosWin]::SetWindowPos($frame.handle, [IntPtr]::Zero, 0, 0, 0, 0, 0x57) } }
Start-Sleep -Milliseconds 150
foreach ($frame in $script:frames) { if ($frame.title -ne 'panel') { [void][GizmosWin]::SetWindowPos($frame.handle, [IntPtr]::Zero, 0, 0, 0, 0, 0x57) } }
`
    : `foreach ($frame in $script:frames) { [void][GizmosWin]::SetWindowPos($frame.handle, [IntPtr]::Zero, 0, 0, 0, 0, 0x97) }`
}
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
  $p = [uint32]0; $thread = [GizmosDlg]::GetWindowThreadProcessId($h, [ref]$p)
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
    [void]$found.Add([pscustomobject]@{ handle = $h.ToInt64().ToString(); pid = $p; thread = $thread; enabled = [GizmosDlg]::IsWindowEnabled($h); title = $t.ToString(); className = $c.ToString(); dialog = $dialog; message = ($script:dialogTexts -join '\n'); closed = $closed; visible = [GizmosDlg]::IsWindowVisible($h) })
  }
  return $true }, [IntPtr]::Zero) | Out-Null
ConvertTo-Json -Compress -InputObject @($found)`;

/** Audacity's visible top-level windows; with close, its standard dialogs get WM_CLOSE (no input simulation). */
export interface AudacityWindow {
  handle: string;
  pid: number;
  thread: number;
  enabled: boolean;
  title: string;
  className: string;
  dialog: boolean;
  /** Texts of a dialog's child controls, one per line. */
  message: string;
  closed: boolean;
  visible: boolean;
}
export async function listWindows(close: boolean): Promise<AudacityWindow[]> {
  if (process.platform !== 'win32') throw new Error('dialog handling is implemented for Windows only');
  const out = await powershell(DIALOG_SCRIPT(close));
  return out ? (JSON.parse(out) as AudacityWindow[]) : [];
}

export async function setWindowVisible(show: boolean): Promise<number> {
  if (process.platform !== 'win32') throw new Error('showing and hiding the window is implemented for Windows only');
  return Number(await powershell(WINDOW_SCRIPT(show)));
}

/** Close only the project HWND captured before saving, rechecking native owner. */
export async function closeProjectWindow(handle: string, pid: number): Promise<boolean> {
  if (process.platform !== 'win32') throw new Error('closing project frames is implemented for Windows only');
  if (!/^\d+$/.test(handle) || !Number.isInteger(pid) || pid <= 0) throw new Error('invalid project window identity');
  const result = await powershell(`
Add-Type @"
using System; using System.Runtime.InteropServices;
public static class GizmosExactClose {
  [DllImport("user32.dll")] public static extern uint GetWindowThreadProcessId(IntPtr h, out uint pid);
  [DllImport("user32.dll")] public static extern bool PostMessage(IntPtr h, uint msg, IntPtr w, IntPtr l);
}
"@
$h = [IntPtr][long]${handle}; $owner = [uint32]0
[void][GizmosExactClose]::GetWindowThreadProcessId($h, [ref]$owner)
if ($owner -eq ${pid}) { [GizmosExactClose]::PostMessage($h, 0x0010, [IntPtr]::Zero, [IntPtr]::Zero) } else { $false }`);
  return result.toLowerCase() === 'true';
}
