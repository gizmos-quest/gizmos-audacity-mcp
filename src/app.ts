// Lifecycle is qualified on Windows. A hidden Audacity still needs its native
// UI/message loop; there is no headless mode or simulated keyboard/mouse input.
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, resolve, sep } from 'node:path';
import { recoveryEntries } from './app-config.js';
import { powershell } from './app-helper.js';
import {
  type AudacityProcess,
  assertExecutableMatches,
  assertSupportedVersion,
  audacityExe,
  audacityProcesses,
  currentProcessIdentity,
  executableVersion,
  isRunning,
  pipeExists,
  preflightExecutableOverride,
  startPosix,
} from './app-process.js';
import { closeProjectWindow, listWindows, setWindowVisible } from './app-windows.js';
import { formatCommand, parseInfoJson } from './format.js';
import { errorWithContext, validateProjectFile } from './ops.js';
import { AudacityNoProject, AudacityPipe, type PipeReply } from './pipe.js';

export * from './app-config.js';
export * from './app-process.js';
export * from './app-windows.js';

export function assertEnglishCommands(body: string): void {
  const commands = parseInfoJson(body);
  if (!Array.isArray(commands)) throw new Error('Audacity Commands returned invalid state');
  const ids = new Set(commands.map((command) => (command as { id?: unknown }).id));
  const missing = ['GetInfo', 'Select', 'SampleDataExport', 'High-passFilter'].filter((id) => !ids.has(id));
  if (missing.length)
    throw new Error(
      `Audacity needs English command IDs; missing ${missing.join(', ')}. Set Language=en while stopped and review/rebuild the plugin registry with a backup. No localized aliases are substituted.`,
    );
}

const pause = (ms: number) => new Promise((resolveWait) => setTimeout(resolveWait, ms));

async function readyWindows(deadline = Date.now(), waitForFrame = true): Promise<void> {
  if (process.platform !== 'win32') return;
  for (;;) {
    const windows = await listWindows(false);
    if (windows.some((window) => window.dialog))
      throw new Error(
        'Audacity has a blocking startup dialog. Use audacity_dialogs to inspect/close it, then launch again.',
      );
    // Live English 3.7.8 ARM64, 2026-10-09: the transient titled wx frame
    // "Audacity is starting up..." overlaps the enabled project frame. Wait for
    // its removal, rather than mistaking it for a second project or using the pipe
    // while InitPart2 is still running. This is operational readiness, not proof
    // of an internal wx event-loop predicate.
    if (windows.some((window) => window.title === 'Audacity is starting up...')) {
      if (Date.now() >= deadline)
        throw new Error('Audacity startup window is still present; inspect audacity_dialogs.');
      await pause(250);
      continue;
    }
    // Live 3.7.8 ARM64: hidden untitled wxWindowNR auxiliaries are also top-level.
    // Keep them in diagnostic inventory, but only a titled non-panel frame is a
    // project candidate. Ambiguous titled frames are conservatively refused.
    const frames = windows.filter(
      (window) => window.className.startsWith('wxWindow') && window.title && window.title !== 'panel' && !window.dialog,
    );
    if (frames.length === 1 && frames[0]!.enabled) return;
    if (!waitForFrame || Date.now() >= deadline || frames.length > 1)
      throw new Error(
        `Audacity has no single enabled project window; startup may be incomplete or the process is windowless. Candidates: ${JSON.stringify(frames.map(({ title, enabled }) => ({ title, enabled })))}. Inspect audacity_dialogs.`,
      );
    await pause(250);
  }
}

export async function launch(
  visible: boolean,
  waitMs = 60_000,
): Promise<{ started: boolean; visible: boolean; processes: AudacityProcess[] }> {
  if (!Number.isFinite(waitMs) || waitMs <= 0 || waitMs > 2_147_483_647)
    throw new Error('waitMs must be positive, finite and at most 2147483647');
  await preflightExecutableOverride();
  const executable = audacityExe();
  assertSupportedVersion(await executableVersion(executable));
  assertExecutableMatches(executable, await audacityProcesses());
  const started = !(await isRunning());
  if (started) {
    const recovery = recoveryEntries();
    if (recovery.length)
      throw new Error(
        `Audacity has ${recovery.length} crash-recovery entries. Use audacity_recover to inspect them before launch.`,
      );
    if (process.platform === 'win32')
      await powershell(
        `Start-Process -FilePath '${executable.replaceAll("'", "''")}' -WindowStyle ${visible ? 'Normal' : 'Hidden'}`,
      );
    else await startPosix(executable);
  } else if (!pipeExists())
    throw new Error(
      'Audacity is running without a reachable pipe. Use audacity_dialogs or audacity_recover; do not start a second project window.',
    );

  const deadline = Date.now() + waitMs;
  while (!pipeExists() && Date.now() < deadline) await pause(250);
  if (!pipeExists())
    throw new Error(
      'Audacity started but its script pipe did not appear. Enable mod-script-pipe under Preferences > Modules and restart.',
    );
  // The module is published before InitPart2/OnRun (3.7.8 AudacityApp.cpp
  // :1563/:1685/:1693). A pipe or even a reply inside a startup modal is weaker
  // than an enabled project frame. An attached process may still show its
  // startup frame: wait for that, but never for a frame in a windowless process.
  await readyWindows(deadline, started);
  if (started) {
    await pause(750);
    await readyWindows();
  }
  const pipe = new AudacityPipe();
  // On a first start or after plugin changes, 3.7.8 runs PluginStartupRegistration
  // before creating the project (AudacityApp.cpp:1656-1668); live x64 3.7.8 under
  // emulation, 2026-10-10: its window passed the frame check. The relay then sends
  // the projectless lone LF and runs nothing, so only this read-only probe waits.
  let tracks: PipeReply | undefined;
  while (!tracks) {
    try {
      tracks = await pipe.send('GetInfo: Type=Tracks Format=JSON', Math.max(1, deadline - Date.now()));
    } catch (error) {
      if (!(error instanceof AudacityNoProject) || Date.now() >= deadline) throw error;
      pipe.reset();
      await pause(500);
    }
  }
  if (!tracks.ok) throw new Error(tracks.body || tracks.status);
  if (!Array.isArray(parseInfoJson(tracks.body))) throw new Error('Audacity has no readable active project');
  const commands = await pipe.send('GetInfo: Type=Commands Format=JSON', Math.max(1, deadline - Date.now()));
  if (!commands.ok) throw new Error(commands.body || commands.status);
  assertEnglishCommands(commands.body);
  if (process.platform === 'win32') await setWindowVisible(visible);
  return { started, visible, processes: await audacityProcesses() };
}

/** Save acknowledgment precedes native closure. Retain scratch on every uncertain
 * failure; never kill Audacity or send raw Exit (observed 3.7.9 teardown crash).
 * 3.7.8 ProjectManager.cpp:381-626 closes the database before removing the frame.
 * Closing a frame can leave a windowless process during incomplete startup, so
 * actual process exit and empty recovery state are required, never pipe presence.
 * No WM_QUIT fallback: nested-loop safety is not established on all binaries. */
export async function quit(pipe: AudacityPipe, keepProject?: string): Promise<{ savedTo?: string }> {
  await preflightExecutableOverride();
  if (process.platform !== 'win32')
    throw new Error(
      'Safe native project closure is verified on Windows only; save your project and quit Audacity through its UI on this platform.',
    );
  const processes = await audacityProcesses();
  if (processes.length !== 1) throw new Error('Quit requires exactly one Audacity process');
  const identity = await currentProcessIdentity();
  if (!identity) throw new Error('Cannot establish Audacity process identity before quit');
  const windows = await listWindows(false);
  const frames = windows.filter(
    (window) => window.className.startsWith('wxWindow') && window.title && window.title !== 'panel' && !window.dialog,
  );
  if (windows.some((window) => window.dialog) || frames.length !== 1 || !frames[0]!.enabled)
    throw new Error(
      'Quit requires one enabled project and no blocking dialogs. Inspect audacity_dialogs; no project was discarded.',
    );
  const frame = frames[0]!;
  const scratch = keepProject === undefined ? await mkdtemp(join(tmpdir(), 'gizmos-audacity-quit-')) : undefined;
  const target = keepProject ?? join(scratch!, 'project.aup3');
  validateProjectFile(target, true);
  const saveCommand = formatCommand('SaveProject2', { Filename: target });
  try {
    const stop = await pipe.send(formatCommand('Stop'), 30_000);
    if (!stop.ok) throw new Error(stop.body || stop.status);
    const save = await pipe.send(saveCommand, 120_000);
    if (!save.ok) throw new Error(save.body || save.status);
    if ((await currentProcessIdentity()) !== identity) throw new Error('Audacity process changed after saving');
    const closed = await closeProjectWindow(frame.handle, frame.pid);
    if (!closed) throw new Error('Audacity project window changed before closure');
    const deadline = Date.now() + 30_000;
    while ((await isRunning()) && Date.now() < deadline) await pause(300);
    if (await isRunning())
      throw new Error(
        'Audacity did not exit after project closure; a windowless process needs operator inspection. No process was terminated.',
      );
    if (recoveryEntries().length) throw new Error('Audacity exited with recovery entries; inspect audacity_recover');
    pipe.reset();
  } catch (error) {
    throw errorWithContext(
      error,
      `${error instanceof Error ? error.message : String(error)}. Project destination retained for inspection: ${target}`,
    );
  }
  if (scratch) {
    const absolute = resolve(scratch);
    if (!absolute.startsWith(resolve(tmpdir()) + sep) || !absolute.includes('gizmos-audacity-quit-'))
      throw new Error(`refusing unsafe quit scratch cleanup: ${absolute}`);
    await rm(absolute, { recursive: true, force: true });
  }
  return keepProject ? { savedTo: target } : {};
}
