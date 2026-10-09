import { randomUUID } from 'node:crypto';
import { existsSync, readFileSync } from 'node:fs';
import { copyFile, readFile, rename, unlink, writeFile } from 'node:fs/promises';
import { homedir } from 'node:os';
import { dirname, join } from 'node:path';
import { isRunning } from './app-process.js';

export function configPath(): string {
  if (process.env.AUDACITY_CONFIG) return process.env.AUDACITY_CONFIG;
  if (process.env.AUDACITY_EXE) {
    const portable = join(dirname(process.env.AUDACITY_EXE), 'Portable Settings', 'audacity.cfg');
    if (existsSync(dirname(portable))) return portable;
  }
  if (process.platform === 'win32') return join(process.env.APPDATA ?? homedir(), 'audacity', 'audacity.cfg');
  if (process.platform === 'darwin')
    return join(homedir(), 'Library', 'Application Support', 'audacity', 'audacity.cfg');
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
  const file = configPath();
  const config = readFileSync(file, 'utf8');
  const projects = parseActiveProjects(config);
  const backup = `${file}.before-recovery-${randomUUID()}.bak`;
  await copyFile(file, backup);
  await writeStoppedConfig(
    file,
    config,
    config.replace(/^(\[ActiveProjects\]\r?\n)[\s\S]*?(?=^\[|$(?![\s\S]))/m, '$1'),
  );
  return { backup, projects }; // Project files and their recovery data are never deleted.
}

/** Write a complete replacement beside the config, then atomically rename only
 * while stopped and unchanged. Retain the caller's backup on every failure. */
export async function writeStoppedConfig(file: string, original: string, updated: string): Promise<void> {
  const scratch = `${file}.gizmos-${randomUUID()}.tmp`;
  try {
    await writeFile(scratch, updated, { flag: 'wx' });
    if (await isRunning()) throw new Error('Audacity started during config backup; config unchanged.');
    if ((await readFile(file, 'utf8')) !== original)
      throw new Error('Audacity config changed during backup; refusing to replace it.');
    await rename(scratch, file);
  } finally {
    await unlink(scratch).catch(() => undefined);
  }
}
