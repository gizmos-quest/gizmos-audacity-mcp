import { spawnSync } from 'node:child_process';
import { expect, it } from 'vitest';
import { audacityExe, closeProjectWindow, isRunning, listWindows } from '../../src/app.js';
import { type LiveContext, testTimeout } from './session.js';

async function waitFor(check: () => Promise<boolean>, milliseconds: number): Promise<void> {
  const deadline = Date.now() + milliseconds;
  while (!(await check())) {
    if (Date.now() >= deadline) throw new Error('native process transition did not finish before its deadline');
    await new Promise((resolve) => setTimeout(resolve, 250));
  }
}

const projectFrames = async () =>
  (await listWindows(false)).filter(
    (window) => window.className.startsWith('wxWindow') && window.title && window.title !== 'panel' && !window.dialog,
  );

export function registerProcessEpoch(context: LiveContext) {
  const { call, refuse, tracks, output } = context;
  it(
    'invalidates a captured profile after an external clean process restart with the same saved track',
    async () => {
      await call('audacity_fresh', { visible: false });
      await call('audacity_import', { file: context.lowFixture, name: 'Epoch source' });
      await call('audacity_noise_profile', { track: 'Epoch source', start: 0, end: 0.25 });
      const saved = output('epoch-project', 'aup3');
      await call('audacity_project', { action: 'save', file: saved });
      // External native window closure deliberately bypasses server lifecycle invalidation.
      // The project is already saved, and only the measured project HWND/PID is closed.
      const frames = await projectFrames();
      expect(frames).toHaveLength(1);
      expect(await closeProjectWindow(frames[0]!.handle, frames[0]!.pid)).toBe(true);
      await waitFor(async () => !(await isRunning()), 15_000);
      // The external start opens the saved project natively, so this server never
      // observes the load. Live 3.7.8 ARM64: the file reuses the initial project,
      // and only the transient startup frame is visible.
      const executable = audacityExe().replaceAll("'", "''");
      const argument = `"${saved}"`.replaceAll("'", "''");
      const started = spawnSync(
        'powershell.exe',
        [
          '-NoProfile',
          '-NonInteractive',
          '-Command',
          `Start-Process -FilePath '${executable}' -ArgumentList '${argument}' -WindowStyle Hidden`,
        ],
        { windowsHide: true, encoding: 'utf8', timeout: 10_000 },
      );
      expect(started.status, started.stderr).toBe(0);
      // Same readiness as the server's launch: the startup frame is gone and one
      // enabled project frame exists. Before that, Audacity may have no project.
      await waitFor(async () => {
        const windows = await listWindows(false);
        const titled = windows.filter(
          (window) => window.className.startsWith('wxWindow') && window.title && window.title !== 'panel',
        );
        return (
          !windows.some((window) => window.dialog) &&
          !titled.some((window) => window.title === 'Audacity is starting up...') &&
          titled.length === 1 &&
          titled[0]!.enabled
        );
      }, 60_000);
      // The same MCP server still knows the old profile; unchanged name/index must not authorize native capture-as-reduction.
      expect((await tracks())[0]?.name).toBe('Epoch source');
      await expect(
        refuse('audacity_effect', { effect: 'NoiseReduction', params: {}, track: 'Epoch source' }),
      ).rejects.toThrow(/process identity changed/);
      expect((await listWindows(false)).some((window) => window.dialog)).toBe(false);
      await call('audacity_fresh', { visible: false, backupTo: output('epoch-backup', 'aup3') });
      expect(await tracks()).toEqual([]);
    },
    testTimeout,
  );
}
