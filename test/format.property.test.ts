import { win32 } from 'node:path';
import fc from 'fast-check';
import { describe, expect, it } from 'vitest';
import { formatCommand, type ParamValue, parseInfoJson } from '../src/format.js';

// Property-based tests: generated input checked against a model of how Audacity
// 3.7.8 reads a scripting command and writes a GetInfo reply. src/format.ts cites
// the native sources; the model implements only those rules.

/** wxCmdLineParser DOS splitting (quotes group and are dropped, a backslash makes
 * the next quote literal), the first `=` between key and value, then Unescape. */
function nativeParameters(command: string): Record<string, string> {
  const chars = [...command.slice(command.indexOf(':') + 1)];
  const tokens: string[] = [];
  let token: string | undefined;
  let quoted = false;
  for (let index = 0; index < chars.length; index++) {
    const char = chars[index]!;
    if (char === '\\' && chars[index + 1] === '"') {
      token = `${token ?? ''}"`;
      index++;
    } else if (char === '"') {
      quoted = !quoted;
      token ??= '';
    } else if (!quoted && /\s/.test(char)) {
      if (token !== undefined) tokens.push(token);
      token = undefined;
    } else token = `${token ?? ''}${char}`;
  }
  if (token !== undefined) tokens.push(token);
  return Object.fromEntries(
    tokens.map((pair) => {
      const split = pair.indexOf('=');
      return [pair.slice(0, split), nativeUnescape(pair.slice(split + 1))];
    }),
  );
}

/** 3.7.8 Unescape: `\n` becomes a newline and `\\` one backslash. */
function nativeUnescape(value: string): string {
  return value.replace(/\\([n\\])/g, (_, escaped: string) => (escaped === 'n' ? '\n' : '\\'));
}

/** Line breaks and NUL end the pipe message; the model judges everything else. */
function nativeChanges(text: string): boolean {
  return /[\r\n\0]/.test(text) || nativeParameters(`Probe: Text="${text}"`).Text !== text;
}

function nativeText(value: ParamValue): string {
  if (typeof value === 'boolean') return value ? '1' : '0';
  return String(value);
}

/** Characters that exercise quoting, splitting, escaping and UTF-8 byte counts. */
const CHARS = ['a', 'Z', '0', 'n', ' ', '\t', '=', ':', '/', '\\', '{', '[', ',', '\u0001', 'é', '€', '😀'];
const UNSAFE = ['"', '\n', '\r', '\0'];
const text = (chars: string[], maxLength = 24) => fc.string({ unit: fc.constantFrom(...chars), maxLength });

describe('formatCommand properties', () => {
  it('sends every accepted command as one line within budget that native parsing reads back unchanged', () => {
    const id = fc.stringMatching(/^[A-Za-z][A-Za-z0-9_-]{0,15}$/);
    const name = fc.stringMatching(/^[A-Za-z_][A-Za-z0-9_ -]{0,10}$/).filter((key) => !/^filename$/i.test(key));
    const value: fc.Arbitrary<ParamValue> = fc.oneof(
      fc.boolean(),
      fc.integer(),
      fc.double({ noNaN: true, noDefaultInfinity: true }),
      text(CHARS).filter((item) => !nativeChanges(item)),
    );
    fc.assert(
      fc.property(id, fc.dictionary(name, value, { maxKeys: 5 }), (command, params) => {
        const line = formatCommand(command, params, 'linux');
        expect(line).not.toMatch(/[\r\n\0]/);
        expect(line.startsWith(`${command}:`)).toBe(true);
        expect(Buffer.byteLength(line, 'utf8') + 1).toBeLessThanOrEqual(1023);
        const expected = Object.entries(params).map(([key, item]) => [key, nativeText(item)]);
        expect(nativeParameters(line)).toEqual(Object.fromEntries(expected));
      }),
    );
  });

  it('refuses text exactly when native parsing would change it', () => {
    fc.assert(
      fc.property(text([...CHARS, ...UNSAFE]), (Text) => {
        if (nativeChanges(Text)) expect(() => formatCommand('SetLabel', { Text }, 'linux')).toThrow();
        else expect(nativeParameters(formatCommand('SetLabel', { Text }, 'linux')).Text).toBe(Text);
      }),
    );
  });

  it('sends Windows paths that still name the same file after native parsing', () => {
    const segment = fc.string({ unit: fc.constantFrom('a', 'n', 'e', 'w', 't', ' ', '-', '.', 'é'), minLength: 1 });
    const root = fc.constantFrom('C:', 'd:', '\\\\server\\share');
    fc.assert(
      fc.property(root, fc.array(segment, { minLength: 1, maxLength: 4 }), (drive, segments) => {
        const path = [drive, ...segments].join('\\');
        const sent = nativeParameters(formatCommand('Import2', { Filename: path }, 'win32')).Filename ?? '';
        expect(sent).not.toContain('\\');
        expect(win32.normalize(sent)).toBe(win32.resolve(path));
      }),
    );
  });

  it('refuses a command over the native byte budget instead of truncating it', () => {
    const platform = fc.constantFrom<NodeJS.Platform>('linux', 'win32');
    const long = fc.string({ unit: fc.constantFrom('a', 'é', '€', '😀'), minLength: 150, maxLength: 600 });
    fc.assert(
      fc.property(platform, long, (target, Text) => {
        const line = `SetLabel: Text=${Text}`;
        if (Buffer.byteLength(line, 'utf8') + (target === 'win32' ? 3 : 1) > 1023)
          expect(() => formatCommand('SetLabel', { Text }, target)).toThrow(/never truncated/);
        else expect(formatCommand('SetLabel', { Text }, target)).toBe(line);
      }),
    );
  });
});

/** 3.7.8 GetInfo output: strings escape only `"`; everything else is plain JSON. */
function nativeJson(value: unknown): string {
  if (typeof value === 'string') return `"${value.replaceAll('"', '\\"')}"`;
  if (Array.isArray(value)) return `[ ${value.map(nativeJson).join(', ')} ]`;
  if (value !== null && typeof value === 'object') {
    const members = Object.entries(value).map(([key, item]) => `${nativeJson(key)}:${nativeJson(item)}`);
    return `{ ${members.join(', ')} }`;
  }
  return JSON.stringify(value);
}

// biome-ignore lint/suspicious/noControlCharactersInRegex: GetInfo text carries literal control bytes.
const CONTROL_RUNS = /[\u0000-\u001f]+/g;

/** parseInfoJson turns each run of control characters into one space before parsing. */
function flattened(value: unknown): unknown {
  if (typeof value === 'string') return value.replace(CONTROL_RUNS, ' ');
  if (Array.isArray(value)) return value.map(flattened);
  if (value !== null && typeof value === 'object')
    return Object.fromEntries(
      Object.entries(value).map(([key, item]) => [key.replace(CONTROL_RUNS, ' '), flattened(item)]),
    );
  return value;
}

describe('parseInfoJson properties', () => {
  it('reads any GetInfo reply whose strings escape only quotes', () => {
    // A string that natively ends in a backslash stays ambiguous (see src/format.ts).
    const string = text([...CHARS, ...UNSAFE, '}', ']'], 16).filter((item) => !item.endsWith('\\'));
    const { tree } = fc.letrec<{ tree: unknown; item: unknown; list: unknown[]; record: Record<string, unknown> }>(
      (tie) => ({
        tree: fc.oneof({ depthSize: 'small' }, tie('list'), tie('record')),
        item: fc.oneof(
          { depthSize: 'small' },
          string,
          fc.integer(),
          fc.double({ noNaN: true, noDefaultInfinity: true }),
          fc.boolean(),
          fc.constant(null),
          tie('tree'),
        ),
        list: fc.array(tie('item'), { maxLength: 4 }),
        record: fc.dictionary(string, tie('item'), { maxKeys: 4 }),
      }),
    );
    fc.assert(
      fc.property(text(['a', ' ', '\n', ':', '"'], 8), tree, (prefix, value) => {
        expect(parseInfoJson(`${prefix}${nativeJson(value)}`)).toEqual(JSON.parse(JSON.stringify(flattened(value))));
      }),
    );
  });
});
