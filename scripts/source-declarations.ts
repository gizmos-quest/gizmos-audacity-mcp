// Scripting parameters declared in Audacity's C++ source: the CapturedParameters
// list of a built-in effect and the Define/DefineEnum calls of a command's
// VisitSettings, with values cast the way native validation casts them.
import {
  closing,
  convert,
  type Decl,
  type ParamType,
  type SourceCommand,
  type SourceParam,
  splitArgs,
  squash,
} from './source-cpp.js';
import type { CppIndex } from './source-index.js';

const OUTPUT_TYPE: Record<string, ParamType> = {
  double: 'double',
  float: 'float',
  int: 'int',
  size_t: 'size_t',
  bool: 'bool',
  wxString: 'string',
};

function chainOwner(index: CppIndex, map: Map<string, unknown>, cls: string): string | undefined {
  if (map.has(cls)) return cls;
  for (const base of index.bases.get(cls) ?? []) {
    const owner = chainOwner(index, map, base);
    if (owner) return owner;
  }
  return undefined;
}

function effectParam(index: CppIndex, structure: string, name: string, file: string): SourceParam {
  const decl = index.lookup(index.parameters, name, structure, file);
  const args = splitArgs(decl.text);
  const member = /^&\s*(\w+)::(\w+)$/.exec(args[0] ?? '');
  if (!member || args.length < 5) throw new Error(`unsupported parameter declaration ${decl.scope}::${name}`);
  const value = (expr: string) => index.evaluate(expr, decl.scope, decl.file);
  const key = String(convert(value(args[1]!), 'string').value);
  if (decl.type === 'EnumParameter') {
    const choices = index.choices(args[6] ?? '', decl.scope, decl.file);
    const chosen = choices?.[Number(value(args[2]!).value)];
    if (!choices || chosen === undefined) throw new Error(`unsupported enumeration ${decl.scope}::${name}`);
    return { key, type: 'enum', default: chosen, choices };
  }
  // CapturedParameters::VisitOne: each value has the declared parameter type,
  // then static_cast<Member> (ShuttleAutomation.h); validation compares those.
  const declared = index.aliases.get(decl.type ?? '') ?? value(args[2]!).type;
  const memberType = index.memberType(member[1]!, member[2]!);
  const type = OUTPUT_TYPE[memberType];
  if (!type) throw new Error(`unsupported member type ${memberType}`);
  const cast = (expr: string) => convert(convert(value(expr), declared), memberType).value;
  const param: SourceParam = { key, type, default: cast(args[2]!) };
  if (type === 'string' || type === 'bool') return param;
  return { ...param, min: Number(cast(args[3]!)), max: Number(cast(args[4]!)) };
}

/** Built-in effects: the CapturedParameters list a scripted (batch) run visits. */
export function builtinEffects(index: CppIndex, isEffect: (file: string) => boolean): SourceCommand[] {
  return [...index.symbols].flatMap(([cls, symbol]) => {
    if (!isEffect(symbol.file)) return [];
    const id = squash(symbol.text);
    const owner = chainOwner(index, index.lists, cls);
    if (!owner) return [{ id, kind: 'effect' as const, file: symbol.file, params: [] }];
    const body = index.lists.get(owner)!;
    const lists = [...body.text.matchAll(/CapturedParameters<([^<>]*)>\s*(\w+)/g)].map((m) => ({
      name: m[2]!,
      args: splitArgs(m[1]!),
    }));
    // Scripting sets batch processing first (BatchCommands.cpp ApplyEffectCommand),
    // so Amplify uses batchParameters; ToneGenBase selects by effect.
    const list =
      lists.length === 1
        ? lists[0]
        : (lists.find((l) => l.name === 'batchParameters') ??
          lists.find((l) => l.name === `${id[0]!.toLowerCase()}${id.slice(1)}Parameters`));
    if (!list) throw new Error(`cannot choose a parameter list for ${id}`);
    const [structure, ...names] = list.args;
    return [
      {
        id,
        kind: 'effect' as const,
        file: body.file,
        params: names.map((n) => effectParam(index, structure!, n, body.file)),
      },
    ];
  });
}

function defineParam(index: CppIndex, body: Decl, cls: string, args: string[], optional: boolean): SourceParam {
  const [member, keyExpr, defaultExpr, minExpr, maxExpr] = args;
  if (!member || !keyExpr || !defaultExpr || !/^\w+$/.test(member)) throw new Error(`unsupported Define in ${cls}`);
  const value = (expr: string) => index.evaluate(expr, cls, body.file);
  const key = String(convert(value(keyExpr), 'string').value);
  const flag = optional ? { optional: true as const } : {};
  const memberType = index.memberType(cls, member);
  if (memberType === 'bool') return { key, type: 'bool', default: Boolean(value(defaultExpr).value), ...flag };
  if (memberType === 'wxString') {
    let fallback: string | undefined;
    try {
      fallback = String(convert(value(defaultExpr), 'string').value);
    } catch {} // a run-time default such as the export directory
    return { key, type: 'string', ...(fallback === undefined ? {} : { default: fallback }), ...flag };
  }
  // SettingsVisitor.h: int/size_t limits default to 0..100000. A double member
  // with float arguments uses the float overload, which GetInfo reports as float.
  const argType = memberType === 'double' && value(defaultExpr).type === 'float' ? 'float' : memberType;
  const type = OUTPUT_TYPE[argType];
  if (!type) throw new Error(`unsupported member type ${memberType}`);
  const integer = argType === 'int' || argType === 'size_t';
  if (!integer && (!minExpr || !maxExpr)) throw new Error(`${cls}.${key} needs explicit limits`);
  const cast = (expr: string | undefined, fallback: number) =>
    expr === undefined ? fallback : Number(convert(value(expr), argType).value);
  return {
    key,
    type,
    default: cast(defaultExpr, 0),
    min: cast(minExpr, 0),
    max: cast(maxExpr, 100_000),
    ...flag,
  };
}

function commandParams(index: CppIndex, cls: string): SourceParam[] {
  const params: SourceParam[] = [];
  for (const body of index.visits.get(chainOwner(index, index.visits, cls) ?? cls) ?? []) {
    const calls = /(\w+)\s*\.\s*VisitSettings\s*\(\s*\w+\s*\)|\.\s*(Define|DefineEnum)\s*\(/g;
    for (const m of body.text.matchAll(calls)) {
      if (m[1]) {
        const nested = new RegExp(`\\b(\\w+)\\s+${m[1]}\\s*;`).exec(
          index.bodies
            .get(cls)
            ?.map((b) => b.text)
            .join('\n') ?? '',
        );
        if (!nested) throw new Error(`cannot find delegated settings ${cls}.${m[1]}`);
        params.push(...commandParams(index, nested[1]!));
        continue;
      }
      const open = m.index + m[0].length - 1;
      const args = splitArgs(body.text.slice(open + 1, closing(body.text, open)));
      const statement = body.text.slice(
        Math.max(...[';', '{', '}'].map((c) => body.text.lastIndexOf(c, m.index))) + 1,
        m.index,
      );
      const optional = /\bOptional[NY]?\s*\(/.test(statement);
      if (m[2] === 'Define') {
        params.push(defineParam(index, body, cls, args, optional));
        continue;
      }
      const choices = index.choices(args[3] ?? '', cls, body.file);
      const key = String(convert(index.evaluate(args[1] ?? '', cls, body.file), 'string').value);
      const chosen = choices?.[Number(index.evaluate(args[2] ?? '', cls, body.file).value)];
      params.push({
        key,
        type: 'enum',
        ...(choices && chosen !== undefined ? { default: chosen, choices } : {}),
        ...(optional ? { optional: true as const } : {}),
      });
    }
  }
  return params;
}

/** Scripting commands: Define/DefineEnum calls in VisitSettings, following delegation. */
export function scriptingCommands(index: CppIndex, isCommand: (file: string) => boolean): SourceCommand[] {
  return [...index.symbols].flatMap(([cls, symbol]) =>
    isCommand(symbol.file)
      ? [{ id: squash(symbol.text), kind: 'command' as const, file: symbol.file, params: commandParams(index, cls) }]
      : [],
  );
}
