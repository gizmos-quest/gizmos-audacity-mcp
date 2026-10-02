// Turns a command id and parameters into one mod-script-pipe line, and reads
// GetInfo replies (JSON that Audacity writes without escaping backslashes).
import { commandSchema, SafeString } from './catalogue.js';

export type ParamValue = string | number | boolean;

function formatValue(value: ParamValue): string {
  if (typeof value === 'boolean') return value ? '1' : '0'; // "True" is read as false
  if (typeof value === 'number') {
    if (!Number.isFinite(value)) throw new Error('numbers must be finite');
    return String(value);
  }
  SafeString.parse(value);
  return /[\s=:]/.test(value) || value === '' ? `"${value}"` : value;
}

export function formatCommand(id: string, params: Record<string, ParamValue | undefined> = {}): string {
  if (!/^[A-Za-z][A-Za-z0-9-]*$/.test(id)) throw new Error(`invalid command id: ${id}`);
  const parts = Object.entries(params)
    .filter((entry): entry is [string, ParamValue] => entry[1] !== undefined)
    .map(([key, value]) => {
      if (!/^[A-Za-z_][A-Za-z0-9_]*$/.test(key)) throw new Error(`invalid parameter name: ${key}`);
      return `${key}=${formatValue(value)}`;
    });
  return `${id}:${parts.length ? ' ' + parts.join(' ') : ''}`;
}

/** Validate against the catalogue, then format. */
export function catalogueCommand(id: string, params: Record<string, unknown> = {}): string {
  const parsed = commandSchema(id).parse(params) as Record<string, ParamValue | undefined>;
  return formatCommand(id, parsed);
}

export function parseInfoJson(body: string): unknown {
  const start = body.search(/[[{]/);
  if (start < 0) return [];
  const text = body.slice(start).replace(/\\(?!["\\/bfnrtu])/g, '\\\\');
  return JSON.parse(text.replace(/[\u0000-\u001f]+/g, ' '));
}
