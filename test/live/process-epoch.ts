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
      const frames = (await listWindows(false)).filter(
        (window) =>
          window.className.startsWith('wxWindow') && window.title && window.title !== 'panel' && !window.dialog,
      );
      expect(frames).toHaveLength(1);
      expect(await closeProjectWindow(frames[0]!.handle, frames[0]!.pid)).toBe(true);
      await waitFor(async () => !(await isRunning()), 15_000);
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
      await waitFor(
        async () =>
          (await listWindows(false)).some(
            (window) =>
              window.className.startsWith('wxWindow') &&
              window.title &&
              window.title !== 'panel' &&
              window.enabled &&
              !window.dialog,
          ),
        60_000,
      );
      // The same MCP server still knows the old profile; unchanged name/index must not authorize native capture-as-reduction.
      expect((await tracks())[0]?.name).toBe('Epoch source');
      await expect(
        refuse('audacity_effect', { effect: 'NoiseReduction', params: {}, track: 'Epoch source' }),
      ).rejects.toThrow(/process identity changed|noise-profile state is unknown/);
      expect((await listWindows(false)).some((window) => window.dialog)).toBe(false);
      await call('audacity_fresh', { visible: false, backupTo: output('epoch-backup', 'aup3') });
      expect(await tracks()).toEqual([]);
    },
    testTimeout,
  );
}
