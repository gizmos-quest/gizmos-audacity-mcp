// Text helpers and a constant-expression evaluator for the C++ declarations
// behind Audacity's scripting parameters (see source-index.ts). Only the shapes
// used at the pinned tag are understood; anything else throws.

export type ParamType = 'double' | 'float' | 'int' | 'size_t' | 'bool' | 'enum' | 'string';
export interface SourceParam {
  key: string;
  type: ParamType;
  default?: number | boolean | string;
  min?: number;
  max?: number;
  choices?: string[];
  optional?: true;
}
export interface SourceCommand {
  id: string;
  kind: 'effect' | 'command' | 'nyquist';
  file: string;
  params: SourceParam[];
}
export interface SourceFile {
  path: string;
  text: string;
}
export type CType = 'double' | 'float' | 'int' | 'bool' | 'string';
export interface Value {
  type: CType;
  value: number | boolean | string;
}
export interface Decl {
  file: string;
  scope: string;
  text: string;
  type?: string;
}

const BUILTIN: Record<string, Value> = {
  FLT_MAX: { type: 'float', value: 3.4028234663852886e38 },
  DBL_MAX: { type: 'double', value: Number.MAX_VALUE },
  INT_MAX: { type: 'int', value: 2_147_483_647 },
  true: { type: 'bool', value: true },
  false: { type: 'bool', value: false },
};
const STRING =
  /^(?:L|wxT\(\s*L?|_\(\s*|X[OC]\(\s*|XXO\(\s*|wxString\s*[({]\s*)"((?:[^"\\]|\\.)*)"\s*(?:,\s*"[^"]*"\s*)?[)}]?$/;

/** EffectDefinitionInterface::GetSquashedName (libraries/lib-components/EffectInterface.cpp). */
export function squash(name: string): string {
  return name
    .trim()
    .split(' ')
    .filter(Boolean)
    .map((part) => part.slice(0, 1).toUpperCase() + part.slice(1).toLowerCase())
    .join('');
}

function skipLiteral(text: string, i: number): number {
  const quote = text[i];
  let j = i + 1;
  while (j < text.length && text[j] !== quote) j += text[j] === '\\' ? 2 : 1;
  return j;
}

/** Drop comments outside literals, and `#if 0` branches. */
export function stripCode(text: string): string {
  let out = '';
  for (let i = 0; i < text.length; i++) {
    const c = text[i]!;
    if (c === '"' || (c === "'" && !/\w/.test(text[i - 1] ?? ''))) {
      const end = skipLiteral(text, i);
      out += text.slice(i, end + 1);
      i = end;
    } else if (text.startsWith('//', i)) {
      const end = text.indexOf('\n', i);
      i = end < 0 ? text.length : end - 1;
    } else if (text.startsWith('/*', i)) {
      const end = text.indexOf('*/', i + 2);
      if (end < 0) throw new Error('unterminated comment');
      out += ' ';
      i = end + 1;
    } else out += c;
  }
  return out.replace(/^[ \t]*#if 0\b[\s\S]*?^[ \t]*#(?:else|endif)\b/gm, (block) => {
    if (/^[ \t]*#if/m.test(block.slice(6))) throw new Error('nested #if inside #if 0');
    return '';
  });
}

/** Index of the bracket that closes the one at `open`. */
export function closing(text: string, open: number): number {
  const opener = text[open];
  const closer = opener === '{' ? '}' : ')';
  let depth = 0;
  for (let i = open; i < text.length; i++) {
    const c = text[i];
    if (c === '"') i = skipLiteral(text, i);
    else if (c === opener) depth++;
    else if (c === closer && --depth === 0) return i;
  }
  throw new Error(`unbalanced ${opener} near ${text.slice(open, open + 60)}`);
}

/** Split call, template or initializer arguments at top-level commas. */
export function splitArgs(text: string): string[] {
  const out: string[] = [];
  let depth = 0;
  let start = 0;
  for (let i = 0; i < text.length; i++) {
    const c = text[i]!;
    if (c === '"') i = skipLiteral(text, i);
    else if ('({[<'.includes(c)) depth++;
    else if (')}]>'.includes(c)) depth--;
    else if (c === ',' && depth === 0) {
      out.push(text.slice(start, i).trim());
      start = i + 1;
    }
  }
  const last = text.slice(start).trim();
  if (last) out.push(last);
  return out;
}

/** A C++ conversion (static_cast or implicit) of a constant value. */
export function convert(value: Value, to: string): Value {
  if (to === 'auto') return value;
  if (to === 'string' || to === 'wxString' || value.type === 'string') {
    if (value.type !== 'string' || (to !== 'string' && to !== 'wxString')) throw new Error(`cannot convert to ${to}`);
    return value;
  }
  const n = Number(value.value);
  if (to === 'bool') return { type: 'bool', value: n !== 0 };
  if (to === 'float') return { type: 'float', value: Math.fround(n) };
  if (to === 'double') return { type: 'double', value: n };
  if (['int', 'size_t', 'long'].includes(to)) return { type: 'int', value: Math.trunc(n) };
  throw new Error(`unsupported C++ type ${to}`);
}

function arithmetic(a: Value, b: Value, op: string): Value {
  const type: CType =
    a.type === 'double' || b.type === 'double' ? 'double' : a.type === 'float' || b.type === 'float' ? 'float' : 'int';
  const [x, y] = [Number(a.value), Number(b.value)];
  const raw = op === '+' ? x + y : op === '-' ? x - y : op === '*' ? x * y : x / y;
  return convert({ type: 'double', value: raw }, type);
}

/** Evaluate a constant expression with C++ literal types and arithmetic conversions. */
export function evaluate(expr: string, resolve: (name: string) => Value): Value {
  const text = expr.trim();
  const literal = STRING.exec(text);
  if (literal) return { type: 'string', value: literal[1]!.replace(/\\(.)/g, '$1') };
  if (/^wxString\s*(?:\{\s*\}|\(\s*\))$/.test(text)) return { type: 'string', value: '' };
  const tokens = text.match(/\d+\.?\d*(?:[eE][+-]?\d+)?[fFlLuU]*|\.\d+(?:[eE][+-]?\d+)?[fF]?|\w+(?:::\w+)*|[-+*/()]/g);
  if (!tokens || tokens.join('') !== text.replace(/\s+/g, '')) throw new Error(`unsupported expression ${expr}`);
  let at = 0;
  const primary = (): Value => {
    const token = tokens[at++];
    if (token === undefined) throw new Error(`incomplete expression ${expr}`);
    if (token === '-' || token === '+') {
      const value = primary();
      return token === '-' ? { ...value, value: -Number(value.value) } : value;
    }
    if (token === '(') {
      if (/^(int|double|float|size_t|long)$/.test(tokens[at] ?? '') && tokens[at + 1] === ')') {
        const type = tokens[at]!;
        at += 2;
        return convert(primary(), type);
      }
      const value = sum();
      if (tokens[at++] !== ')') throw new Error(`unbalanced expression ${expr}`);
      return value;
    }
    if (/^[\d.]/.test(token)) {
      const number = Number(token.replace(/[fFlLuU]+$/, ''));
      if (/[fF]$/.test(token)) return { type: 'float', value: Math.fround(number) };
      return /[.eE]/.test(token) ? { type: 'double', value: number } : { type: 'int', value: number };
    }
    if (tokens[at] === '(') throw new Error(`unsupported expression ${expr}`); // a call
    return BUILTIN[token] ?? resolve(token);
  };
  const product = (): Value => {
    let value = primary();
    while (tokens[at] === '*' || tokens[at] === '/') {
      const op = tokens[at++]!;
      value = arithmetic(value, primary(), op);
    }
    return value;
  };
  const sum = (): Value => {
    let value = product();
    while (tokens[at] === '+' || tokens[at] === '-') {
      const op = tokens[at++]!;
      value = arithmetic(value, product(), op);
    }
    return value;
  };
  const result = sum();
  if (at !== tokens.length) throw new Error(`unsupported expression ${expr}`);
  return result;
}
