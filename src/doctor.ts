import { spawnSync } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import { existsSync, statSync } from 'node:fs';
import { copyFile, readFile } from 'node:fs/promises';
import { userInfo } from 'node:os';
import { dirname, extname, join } from 'node:path';
import { assertEnglishCommands } from './app.js';
import { configPath, writeStoppedConfig } from './app-config.js';
import {
  assertExecutableMatches,
  assertSupportedVersion,
  audacityExe,
  audacityProcesses,
  executableVersion,
  isRunning,
  pipeExists,
} from './app-process.js';
import { AudacityPipe } from './pipe.js';

export interface DoctorCheck {
  name: string;
  ok: boolean;
  detail: string;
}
export interface DoctorReport {
  ok: boolean;
  checks: DoctorCheck[];
  backup?: string;
}

export function configValue(config: string, section: string, key: string): string | undefined {
  let current = '';
  for (const line of config.split(/\r?\n/)) {
    const header = /^\[([^\]]+)\]$/.exec(line.trim());
    if (header) {
      current = header[1]!;
      continue;
    }
    if (current === section && line.startsWith(`${key}=`)) return line.slice(key.length + 1).trim();
  }
  return undefined;
}

function setConfigValue(config: string, section: string, key: string, value: string): string {
  const newline = config.includes('\r\n') ? '\r\n' : '\n';
  const lines = config.split(/\r?\n/);
  const start = lines.findIndex((line) => line.trim() === `[${section}]`);
  if (start < 0)
    return `${config}${config.endsWith(newline) ? '' : newline}[${section}]${newline}${key}=${value}${newline}`;
  let end = lines.findIndex((line, index) => index > start && /^\[/.test(line));
  if (end < 0) end = lines.length;
  const existing = lines.findIndex((line, index) => index > start && index < end && line.startsWith(`${key}=`));
  if (existing >= 0) lines[existing] = `${key}=${value}`;
  else lines.splice(start + 1, 0, `${key}=${value}`);
  return lines.join(newline);
}

/** Only the module's enablement record changes; registry, language and other prefs stay. */
export function enablePipeConfig(config: string, moduleStamp?: string): string {
  const enabled = setConfigValue(config, 'Module', 'mod-script-pipe', '1');
  return moduleStamp ? setConfigValue(enabled, 'ModuleDateTime', 'mod-script-pipe', moduleStamp) : enabled;
}

/** Windows/portable installs keep modules beside the executable; a macOS bundle in Contents/modules. */
export function scriptModule(executable: string): string | undefined {
  const name = `mod-script-pipe${process.platform === 'win32' ? '.dll' : '.so'}`;
  return [join(dirname(executable), 'modules', name), join(dirname(executable), '..', 'modules', name)].find((file) =>
    existsSync(file),
  );
}

/** wxDateTime::FormatISOCombined of the file's local modification time, as ModuleSettings writes it. */
export function moduleStamp(file: string): string {
  const time = new Date(Math.floor(statSync(file).mtimeMs / 1000) * 1000);
  const pad = (value: number) => String(value).padStart(2, '0');
  return `${time.getFullYear()}-${pad(time.getMonth() + 1)}-${pad(time.getDate())}T${pad(time.getHours())}:${pad(time.getMinutes())}:${pad(time.getSeconds())}`;
}

async function readConfig(file = configPath()): Promise<string> {
  try {
    return await readFile(file, 'utf8');
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error;
    throw new Error(`No Audacity settings at ${file}. Start and quit Audacity once, then run doctor again.`);
  }
}

/** Returns the backup path, or undefined when the config already enables this module file. */
export async function fixPipeConfig(): Promise<string | undefined> {
  // Refuse a wrong/unsupported executable before changing any configuration.
  const executable = audacityExe();
  assertSupportedVersion(await executableVersion(executable));
  if (await isRunning())
    throw new Error('doctor --fix requires Audacity to be stopped; quit it before changing its config.');
  const file = configPath();
  const original = await readConfig(file);
  const module = scriptModule(executable);
  // Mirrors ModuleSettings::SetModuleStatus for an explicit user decision: without
  // the module file's current timestamp, 3.7.8 resets the module to "new" and skips it.
  const updated = enablePipeConfig(original, module && moduleStamp(module));
  if (updated === original) return undefined;
  const backup = `${file}.before-doctor-${randomUUID()}.bak`;
  await copyFile(file, backup);
  // Recheck after backup. No first-party pipe session can silently rewrite config.
  if (await isRunning()) throw new Error(`Audacity started during doctor --fix; config unchanged. Backup: ${backup}`);
  await writeStoppedConfig(file, original, updated);
  return backup;
}

export async function doctor(fix = false): Promise<DoctorReport> {
  const checks: DoctorCheck[] = [];
  let backup: string | undefined;
  if (fix) backup = await fixPipeConfig();
  const check = async (name: string, inspect: () => Promise<string>) => {
    try {
      checks.push({ name, ok: true, detail: await inspect() });
    } catch (error) {
      checks.push({ name, ok: false, detail: error instanceof Error ? error.message : String(error) });
    }
  };
  await check('version', async () => {
    const version = await executableVersion();
    assertSupportedVersion(version);
    return version;
  });
  await check('mod-script-pipe', async () => {
    const config = await readConfig();
    if (configValue(config, 'Module', 'mod-script-pipe') !== '1')
      throw new Error(
        'mod-script-pipe is disabled or missing. While Audacity is stopped, run doctor --fix, then restart.',
      );
    // 3.7.8 ModuleSettings::GetModuleStatus loads an enabled module only when its
    // recorded ModuleDateTime equals the file's; otherwise it is "new" and skipped.
    const module = scriptModule(audacityExe());
    if (module && configValue(config, 'ModuleDateTime', 'mod-script-pipe') !== moduleStamp(module))
      throw new Error(
        'mod-script-pipe was enabled for a different module file (for example before an update), so Audacity skips it. While Audacity is stopped, run doctor --fix, then restart.',
      );
    return 'Enabled in config; restart Audacity after changing this value.';
  });
  let running = false;
  await check('same-user', async () => {
    const processes = await audacityProcesses();
    running = processes.length > 0;
    assertExecutableMatches(audacityExe(), processes);
    const expectedOwner = process.platform === 'win32' ? userInfo().username.toLowerCase() : String(userInfo().uid);
    if (processes.some((process) => !process.owner || process.owner.toLowerCase() !== expectedOwner))
      throw new Error('Audacity and this server must run as the same user; owner could not be verified.');
    return running
      ? 'Running process matches this executable/user.'
      : 'Audacity is stopped; start it as this user to check the pipe.';
  });
  await check('pipe', async () => {
    if (!running || !pipeExists())
      throw new Error('No running scripting endpoint; start Audacity after enabling the module.');
    return 'Endpoint present; one client must own its reader/writer.';
  });
  await check('English command IDs', async () => {
    if (
      !running ||
      !checks.find((check) => check.name === 'same-user')?.ok ||
      !pipeExists() ||
      !checks.find((check) => check.name === 'version')?.ok
    )
      throw new Error('Start supported Audacity as this user to check English IDs.');
    const pipe = new AudacityPipe();
    try {
      const reply = await pipe.send('GetInfo: Type=Commands Format=JSON', 10_000);
      if (!reply.ok) throw new Error(reply.body || reply.status);
      assertEnglishCommands(reply.body);
      return 'Required English scripting and Nyquist IDs present.';
    } finally {
      pipe.release();
    }
  });
  await check('ffmpeg (optional)', async () => {
    const ffmpeg = process.env.AUDACITY_FFMPEG ?? 'ffmpeg';
    // Match probeFile: a configured executable directory can provide both
    // optional tools without being added to the user's PATH.
    const ffprobe =
      process.env.AUDACITY_FFPROBE ??
      (/[\\/]/.test(ffmpeg) ? join(dirname(ffmpeg), `ffprobe${extname(ffmpeg)}`) : 'ffprobe');
    for (const file of [ffmpeg, ffprobe]) {
      const result = spawnSync(file, ['-version'], { timeout: 10_000, windowsHide: true, stdio: 'ignore' });
      if (result.status !== 0)
        throw new Error(`${file} unavailable; WAV measurement still works, LUFS/true peak need ffmpeg and ffprobe.`);
    }
    return 'ffmpeg and ffprobe available.';
  });
  return {
    ok: checks.every((check) => check.ok || check.name === 'ffmpeg (optional)'),
    checks,
    ...(backup ? { backup } : {}),
  };
}

export async function runDoctor(args: string[]): Promise<void> {
  if (args.some((arg) => arg !== '--fix')) throw new Error('Usage: gizmos-audacity-mcp doctor [--fix]');
  const report = await doctor(args.includes('--fix'));
  process.stdout.write(`${JSON.stringify(report, null, 2)}\n`);
  if (!report.ok) process.exitCode = 1;
}
