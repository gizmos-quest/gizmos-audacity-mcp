import { existsSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { expect, it } from 'vitest';
import { configPath, recoveryEntries } from '../../src/app-config.js';
import { isRunning } from '../../src/app-process.js';
import type { LiveContext, Windows } from './session.js';

const root = fileURLToPath(new URL('../..', import.meta.url));

export function registerProjects(context: LiveContext) {
  const { call, refuse, tracks, importVoice, output } = context;
  it('reads the actual project rate, refuses unsafe saves/opens, restarts and reopens a saved project', async () => {
    await importVoice();
    await call('audacity_command', { command: 'SetProject', params: { Rate: 48000 } });
    expect(await call('audacity_project_info')).toMatchObject({ rate: 48000, lengthSeconds: 2 });
    const project = output('saved-project', 'aup3');
    await call('audacity_project', { action: 'save', file: project });
    expect(existsSync(project)).toBe(true);
    await expect(refuse('audacity_project', { action: 'save', file: project })).rejects.toThrow(/exists/);
    await expect(refuse('audacity_project', { action: 'open', file: project })).rejects.toThrow(/empty project/);
    await expect(refuse('audacity_fresh', { visible: false })).rejects.toThrow(/backupTo/);
    expect((await call<Windows>('audacity_dialogs')).windows.some((window) => window.dialog)).toBe(false);
    await call('audacity_quit', { saveTo: output('kept-on-quit', 'aup3') });
    expect(recoveryEntries()).toEqual([]);
    expect(await call('audacity_status')).toEqual({ running: false });
    await call('audacity_launch', { visible: false });
    await call('audacity_project', { action: 'open', file: project });
    expect((await tracks())[0]?.name).toBe('Voice');
    const backup = join(root, '.work', 'live-backups', `fresh-backup-${Date.now()}.aup3`);
    expect(await call('audacity_fresh', { visible: false, backupTo: backup })).toMatchObject({ backedUpTo: backup });
    expect(existsSync(backup)).toBe(true);
    expect(await tracks()).toEqual([]);
    expect((await call<Windows>('audacity_dialogs')).windows.some((window) => window.dialog)).toBe(false);
    await call('audacity_quit');
    expect(await isRunning()).toBe(false);
    expect(recoveryEntries()).toEqual([]);
    const configFile = configPath();
    const originalConfig = readFileSync(configFile, 'utf8');
    const originalProject = readFileSync(backup);
    const stalePath = backup.replace(/\\/g, '/');
    const newline = originalConfig.includes('\r\n') ? '\r\n' : '\n';
    const recoverySection = `[ActiveProjects]${newline}1=${stalePath}${newline}`;
    const section = /^\[ActiveProjects\](?:\r?\n|$)[\s\S]*?(?=^\[|$(?![\s\S]))/m;
    const injectedConfig = section.test(originalConfig)
      ? originalConfig.replace(section, recoverySection)
      : `${originalConfig}${newline}${recoverySection}`;
    // Retain an exact original config backup as well as the backup produced by
    // audacity_recover. Only the stopped test process's config is changed.
    writeFileSync(`${configFile}.before-live-recovery-${Date.now()}.bak`, originalConfig);
    try {
      writeFileSync(configFile, injectedConfig);
      expect(recoveryEntries()).toEqual([stalePath]);
      await expect(refuse('audacity_launch', { visible: false })).rejects.toThrow(/crash-recovery entries/);
      expect(await isRunning()).toBe(false);
      expect((await call<Windows>('audacity_dialogs')).windows.filter((window) => window.dialog)).toEqual([]);
      const recovered = await call<{ discarded: { backup: string; projects: string[] } | null }>('audacity_recover', {
        discardRecovery: true,
        reconnect: false,
      });
      expect(recovered.discarded?.projects).toEqual([stalePath]);
      expect(recovered.discarded?.backup).toBeDefined();
      expect(readFileSync(recovered.discarded!.backup, 'utf8').includes(`1=${stalePath}`)).toBe(true);
      expect(recoveryEntries()).toEqual([]);
      expect(readFileSync(backup).equals(originalProject)).toBe(true);
    } finally {
      if (await isRunning()) {
        await call('audacity_dialogs', { close: true });
        await call('audacity_recover', { closeDialogs: true });
        await call('audacity_quit');
      }
      // biome-ignore lint/correctness/noUnsafeFinally: Restoring a running application's config would violate stopped-only mutation.
      if (await isRunning()) throw new Error('cannot restore the test config while Audacity is running');
      writeFileSync(configFile, originalConfig);
      expect(recoveryEntries()).toEqual([]);
      await call('audacity_launch', { visible: false });
    }
  }, 180_000);
}
