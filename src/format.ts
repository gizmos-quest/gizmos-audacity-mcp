// Turns a command id and parameters into one mod-script-pipe line, and reads
// GetInfo replies (JSON that Audacity writes without escaping backslashes).
import { posix, win32 } from 'node:path';
import { commandSchema, SafeString } from './catalogue.js';

export type ParamValue = string | number | boolean;

/** 3.7.8 PipeServer.cpp at 6120ce4 uses a 1024-byte buffer and appends NUL.
 * Keep the entire native message below 1024, including platform terminators.
 * Oversize boundaries are tested with fake pipes only, never native Audacity. */
export function assertCommandBudget(command: string, platform = process.platform): string {
  if (/[\r\n\0]/.test(command)) throw new Error('a command must be a single line');
  const bytes = Buffer.byteLength(command, 'utf8') + (platform === 'win32' ? 3 : 1);
  if (bytes > 1023)
    throw new Error(
      `Audacity command requires ${bytes} encoded bytes; maximum is 1023 including terminators. Shorten text or paths; commands are never truncated.`,
    );
  return command;
}

/** 3.7.8 scripting parameters reach CommandParameters::SetParameters
 * (libraries/lib-components/EffectAutomationParameters.h): wxCmdLineParser DOS
 * splitting (a backslash before a quote makes the quote literal), then Unescape
 * turns `\n` into a newline and `\\` into one backslash. Such text cannot reach
 * Audacity unchanged, so it is refused. Windows accepts forward slashes, so file
 * paths are sent with them and a folder such as `C:\new` stays intact. Paths are
 * made absolute first: Audacity resolves relative ones against its own directory. */
function formatValue(key: string, value: ParamValue, platform: NodeJS.Platform): string {
  if (typeof value === 'boolean') return value ? '1' : '0'; // "True" is read as false
  if (typeof value === 'number') {
    if (!Number.isFinite(value)) throw new Error('numbers must be finite');
    return String(value);
  }
  SafeString.parse(value);
  const path = /^filename$/i.test(key) && value !== '';
  const text = !path ? value : platform === 'win32' ? win32.resolve(value).replaceAll('\\', '/') : posix.resolve(value);
  if (/\\(?:n|\\)|\\$/.test(text))
    throw new Error(
      `${key} contains \\n, a double backslash or a trailing backslash, which Audacity's parameter parser would change`,
    );
  return /[\s=:]/.test(text) || text === '' ? `"${text}"` : text;
}

export function formatCommand(
  id: string,
  params: Record<string, ParamValue | undefined> = {},
  platform = process.platform,
): string {
  if (!/^[A-Za-z][A-Za-z0-9_-]*$/.test(id)) throw new Error(`invalid command id: ${id}`);
  const parts = Object.entries(params)
    .filter((entry): entry is [string, ParamValue] => entry[1] !== undefined)
    .map(([key, value]) => {
      if (!/^[A-Za-z_][A-Za-z0-9_ -]*$/.test(key)) throw new Error(`invalid parameter name: ${key}`);
      // Hyphens (Nyquist) and quoted spaced keys (FindClipping/DTMF) verified on live 3.7.8, 2026-10-02.
      return `${key.includes(' ') ? `"${key}"` : key}=${formatValue(key, value, platform)}`;
    });
  return assertCommandBudget(`${id}:${parts.length ? ` ${parts.join(' ')}` : ''}`, platform);
}

/** Validate against the catalogue, then format. */
export function catalogueCommand(id: string, params: Record<string, unknown> = {}): string {
  const parsed = commandSchema(id).parse(params) as Record<string, ParamValue | undefined>;
  return formatCommand(id, parsed);
}

export function parseInfoJson(body: string): unknown {
  const start = body.search(/[[{]/);
  if (start < 0) throw new Error('Audacity GetInfo returned no JSON; project state is unknown');
  // 3.7.8 CommandMessageTarget::Escaped (libraries/lib-menus/CommandTargets.cpp)
  // escapes only `"`. Every other backslash in a string is literal: drive and UNC
  // paths, `\n` typed into a name. Re-escape exactly those before JSON parsing.
  // A string that natively ends in a backslash stays ambiguous and fails parsing.
  const text = body.slice(start).replace(/"(?:\\"|\\(?!")|[^"\\])*"/g, (value) => value.replace(/\\(?!")/g, '\\\\'));
  // biome-ignore lint/suspicious/noControlCharactersInRegex: native GetInfo emits literal control bytes, repaired before JSON parsing.
  return JSON.parse(text.replace(/[\u0000-\u001f]+/g, ' '));
}
