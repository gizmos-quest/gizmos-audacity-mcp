import { z } from 'zod';
import { launch, listWindows, pipeExists, preflightExecutableOverride, quit, setWindowVisible } from './app.js';
import { SafeString } from './catalogue.js';
import type { Ops } from './ops.js';
import { AudacityNeedsRecovery } from './pipe.js';
import type { ToolRegistrar } from './tools.js';

export function registerLifecycleTools(tool: ToolRegistrar, ops: Ops): void {
  const pipe = ops.pipe;
  tool(
    'audacity_launch',
    'Start or attach to Audacity with a visible or hidden Windows project window. Waits for a real script-pipe response.',
    { visible: z.boolean().default(true) },
    async ({ visible }) => {
      if (pipe.needsRecovery)
        throw new AudacityNeedsRecovery(
          'A previous pipe outcome is unknown; use audacity_recover before attaching again.',
        );
      const result = await launch(visible);
      if (result.started) ops.freshApplication();
      return result;
    },
  );

  tool(
    'audacity_window',
    'Show or hide the Audacity window. A hidden Audacity keeps working through the pipe.',
    { show: z.boolean() },
    async ({ show }) => ({ windows: await setWindowVisible(show) }),
  );

  tool(
    'audacity_quit',
    'Quit Audacity without a save prompt. Without saveTo the project is discarded (saved to a temporary file that is then deleted).',
    { saveTo: SafeString.optional().describe('keep the project at this .aup3 path') },
    async ({ saveTo }) => {
      await preflightExecutableOverride();
      await ops.restoreImportPreferences();
      return quit(pipe, saveTo);
    },
  );

  tool(
    'audacity_dialogs',
    "List Audacity's open windows and dialogs; close=true closes the dialogs (WM_CLOSE, like the window's X; Cancel for questions). Use it when a call times out: a modal dialog blocks the pipe.",
    { close: z.boolean().default(false) },
    async ({ close }) => ({ windows: await listWindows(close) }),
  );

  tool(
    'audacity_fresh',
    'Get an empty project in a single window. If the open project has tracks it is saved to backupTo (required then), Audacity quits without a prompt and starts again. Never use the New menu: a second project window has crashed Audacity 3.7 under scripting.',
    {
      visible: z.boolean().default(true),
      backupTo: SafeString.optional().describe('.aup3 path for the current project'),
    },
    async ({ visible, backupTo }) => {
      await preflightExecutableOverride();
      // Process-wide effect state is known fresh only for a process this call started.
      const relaunch = async () => {
        const result = await launch(visible);
        if (result.started) ops.freshApplication();
        else ops.unknownApplication();
        return result;
      };
      if (!pipeExists()) return { ...(await relaunch()), backedUpTo: null };
      const tracks = await ops.tracks();
      if (tracks.length === 0) {
        await ops.restoreImportPreferences();
        await quit(pipe);
        return { ...(await relaunch()), backedUpTo: null };
      }
      if (!backupTo) throw new Error(`the open project has ${tracks.length} tracks; pass backupTo to keep them`);
      await ops.restoreImportPreferences();
      await quit(pipe, backupTo);
      return { ...(await relaunch()), backedUpTo: backupTo };
    },
  );
}
