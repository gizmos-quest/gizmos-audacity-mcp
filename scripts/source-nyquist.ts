// Reads the `$name` and `$control` header lines of a bundled Nyquist plug-in
// (the documented plug-in header format) into the parameter facts that native
// batch validation uses. Limits follow Audacity-3.7.8 NyquistBase.cpp:2405-2471
// (`nil` limits) and the GetInfo types of NyquistBase.cpp:256-289.
import { type SourceCommand, type SourceParam, squash } from './source-cpp.js';

const FLT_MAX = 3.4028234663852886e38;
const INT_MAX = 2_147_483_647;

/** Words, "strings" and (lists) of header text; `;` comments end a line outside strings. */
export function readItems(text: string): { items: string[]; complete: boolean } {
  const items: string[] = [];
  let i = 0;
  const skip = () => {
    for (;;) {
      while (/\s/.test(text[i] ?? '')) i++;
      if (text[i] !== ';') return;
      while (i < text.length && text[i] !== '\n') i++;
    }
  };
  // Returns the raw item text, or undefined when the text ends inside it.
  const item = (): string | undefined => {
    const start = i;
    if (text[i] === '"') {
      for (i++; i < text.length && text[i] !== '"'; i++) if (text[i] === '\\') i++;
      return i < text.length ? text.slice(start, ++i) : undefined;
    }
    if (text[i] === '(') {
      for (i++, skip(); text[i] !== ')'; skip()) {
        if (i >= text.length || item() === undefined) return undefined;
      }
      return text.slice(start, ++i);
    }
    while (i < text.length && !/[\s()";]/.test(text[i]!)) i++;
    return text.slice(start, i);
  };
  for (skip(); i < text.length; skip()) {
    if (text[i] === ')')
      i++; // a stray closing parenthesis is ignored
    else {
      const next = item();
      if (next === undefined) return { items, complete: false };
      items.push(next);
    }
  }
  return { items, complete: true };
}

/** The text of `"x"`, of `(_ "x")`, or the word itself. */
export function unquote(item: string): string {
  if (item.startsWith('"')) return item.slice(1, -1).replace(/\\(.)/g, (_, c: string) => (c === 'n' ? '\n' : c));
  if (item.startsWith('(')) {
    const [, text] = readItems(item.slice(1, -1)).items;
    return text === undefined ? '' : unquote(text);
  }
  return item;
}

/** Script names of a choice list: `(("Id" (_ "Label")) (_ "Label") ...)` or `"A,B"`. */
export function parseChoices(item: string): string[] {
  if (!item.startsWith('('))
    return unquote(item)
      .split(',')
      .map((choice) => choice.trim());
  return readItems(item.slice(1, -1)).items.map((choice) => {
    const [first, second] = choice.startsWith('(') ? readItems(choice.slice(1, -1)).items : [];
    return first?.startsWith('"') && second?.startsWith('(') ? unquote(first) : unquote(choice);
  });
}

// A value Audacity cannot read as a number (such as `nil`) counts as 0.
const number = (text: string) => (/^[+-]?(?:\d+\.?\d*|\.\d+)(?:[eE][+-]?\d+)?$/.test(text) ? Number(text) : 0);
const NUMERIC: Record<string, 'double' | 'int'> = {
  float: 'double',
  real: 'double',
  'float-text': 'double',
  time: 'double',
  int: 'int',
  'int-text': 'int',
};

function control(items: string[], file: string): SourceParam | undefined {
  if (items[1] === 'text' && items.length === 3) return undefined;
  const [, key, , kind, extra, initial = '', low = '', high = ''] = items;
  if (!key || !kind || extra === undefined) throw new Error(`${file}: unsupported $control ${items.join(' ')}`);
  if (kind === 'string' || kind === 'file') return { key, type: 'string', default: unquote(initial) };
  if (kind === 'choice') {
    const choices = parseChoices(extra);
    const chosen = choices[Math.trunc(number(initial))];
    if (chosen === undefined) throw new Error(`${file}: ${key} default is not a choice`);
    return { key, type: 'enum', default: chosen, choices };
  }
  const type = NUMERIC[kind];
  if (!type) throw new Error(`${file}: unsupported $control type ${kind} for ${key}`);
  if (items.length < 8) throw new Error(`${file}: ${key} lacks minimum/maximum`); // Audacity drops it
  // `nil` means unbounded only for the -text and time types; elsewhere it reads as 0.
  const nil = (limit: string) => unquote(limit).toLowerCase() === 'nil';
  const min = !nil(low)
    ? number(unquote(low))
    : kind === 'int-text'
      ? -INT_MAX - 1
      : kind === 'float-text'
        ? -FLT_MAX
        : 0;
  const unbounded = kind === 'int-text' ? INT_MAX : kind === 'float-text' || kind === 'time' ? FLT_MAX : 0;
  const max = Math.max(min, nil(high) ? unbounded : number(unquote(high)));
  return { key, type, default: Math.min(Math.max(number(initial), min), max), min, max };
}

/** Parameters of one `.ny` file; a `$` or `;control` line with an open list or string continues. */
export function parseNyquist(source: string, file: string): SourceCommand {
  let name: string | undefined;
  const params: SourceParam[] = [];
  const lines = source.split(/\r?\n/);
  for (let i = 0; i < lines.length; i++) {
    if (lines[i]!.length < 2 || !/^[;$]/.test(lines[i]!)) continue;
    const continues = /^(?:\$|;control)/.test(lines[i]!);
    let text = lines[i]!.slice(1);
    let read = readItems(text);
    while (continues && !read.complete && i + 1 < lines.length) {
      text += `\n${lines[++i]}`;
      read = readItems(text);
    }
    const [head, value] = read.items;
    if (head === 'name' && value) name = unquote(value);
    if (head === 'control') {
      const param = control(read.items, file);
      if (param) params.push(param);
    }
  }
  if (!name) throw new Error(`${file}: no $name header`);
  return { id: squash(name), kind: 'nyquist', file, params };
}
