import { z } from 'zod';
import { launch } from '../app.js';
import { discardStaleRecovery, recoveryEntries } from '../app-config.js';
import { isRunning, preflightExecutableOverride } from '../app-process.js';
import { listWindows } from '../app-windows.js';
import type { Ops } from '../ops.js';
import { CommandFailed } from '../ops.js';
import type { ToolRegistrar } from '../tools.js';

export function registerRecoveryTool(tool: ToolRegistrar, ops: Ops): void {
  tool(
    'audacity_recover',
    'Inspect process, pipe and crash-recovery entries; optionally close blocking dialogs and reconnect after a timeout. Never kills Audacity or replays edits. discardRecovery clears stale config entries only while Audacity is stopped, saving the config first and retaining all project files.',
    {
      closeDialogs: z.boolean().default(false),
      reconnect: z.boolean().default(true),
      discardRecovery: z.boolean().default(false),
      visible: z.boolean().default(false),
    },
    async ({ closeDialogs, reconnect, discardRecovery, visible }) => {
      await preflightExecutableOverride();
      const running = await isRunning();
      const entries = recoveryEntries();
      const windows = process.platform === 'win32' ? await listWindows(closeDialogs) : [];
      if (discardRecovery && running) throw new Error('stop Audacity cleanly before discarding stale recovery entries');
      const discarded = discardRecovery && entries.length ? await discardStaleRecovery() : null;
      if (!reconnect) return { running, entries, windows, discarded, needsRecovery: ops.pipe.needsRecovery };
      if (windows.some((w) => w.dialog && !w.closed)) throw new Error('blocking dialogs remain; use closeDialogs=true');
      ops.unknownApplication();
      if (!running && (await launch(visible)).started) ops.freshApplication();
      const reply = await ops.pipe.reconnect();
      if (!reply.ok) throw new CommandFailed('GetInfo', reply);
      const tracks = await ops.tracks();
      await ops.restoreImportPreferences();
      return {
        running: true,
        entries: recoveryEntries(),
        windows: process.platform === 'win32' ? await listWindows(false) : [],
        discarded,
        tracks,
        synchronized: true,
        previousOutcome: 'unknown',
        note: 'Connection synchronized; the earlier command outcome remains unknown. Review the project before repeating an edit.',
      };
    },
  );
}
