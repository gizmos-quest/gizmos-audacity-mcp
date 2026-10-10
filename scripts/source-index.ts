// Indexes the C++ declarations behind Audacity's scripting parameters:
// classes, constants, enums, macros, EnumValueSymbol tables, EffectParameter
// declarations, CapturedParameters lists and VisitSettings bodies. It knows
// only the shapes used at the pinned tag; anything else throws when used.
import {
  closing,
  convert,
  type Decl,
  evaluate,
  type SourceFile,
  splitArgs,
  stripCode,
  type Value,
} from './source-cpp.js';

const AMBIGUOUS: Decl = { file: '', scope: '', text: '' };

/** Declarations of a set of C++ files, keyed by `Class::name` or `file#name`. */
export class CppIndex {
  readonly bases = new Map<string, string[]>();
  readonly bodies = new Map<string, Decl[]>();
  readonly constants = new Map<string, Decl>();
  readonly enumStrings = new Map<string, Decl>();
  readonly parameters = new Map<string, Decl>();
  readonly symbols = new Map<string, Decl>();
  readonly lists = new Map<string, Decl>();
  readonly visits = new Map<string, Decl[]>();
  readonly aliases = new Map<string, string>();

  constructor(files: SourceFile[]) {
    for (const file of files) this.add(file.path, stripCode(file.text));
  }

  private add(path: string, text: string): void {
    const scopes: { name: string; start: number; end: number }[] = [];
    for (const m of text.matchAll(
      /(?<!enum\s+)\b(?:class|struct)\s+(?:\w+_API\s+)?(\w+)\s*(?:final\s*)?(:[^{;()]*)?\{/g,
    )) {
      const start = m.index + m[0].length - 1;
      const end = closing(text, start);
      const name = m[1]!;
      scopes.push({ name, start, end });
      const bases = splitArgs((m[2] ?? '').slice(1)).map((base) => /(\w+)\s*(?:<[\s\S]*>)?$/.exec(base)?.[1] ?? '');
      this.bases.set(name, [...(this.bases.get(name) ?? []), ...bases.filter(Boolean)]);
      this.bodies.set(name, [
        ...(this.bodies.get(name) ?? []),
        { file: path, scope: name, text: text.slice(start, end) },
      ]);
    }
    const scopeAt = (offset: number) =>
      scopes.filter((s) => s.start < offset && offset < s.end).sort((a, b) => b.start - a.start)[0]?.name ?? '';
    const put = (
      map: Map<string, Decl>,
      name: string,
      at: number,
      body: string,
      type?: string,
      scope = scopeAt(at),
    ) => {
      const decl = { file: path, scope, text: body, type };
      for (const key of scope ? [`${scope}::${name}`] : [`${path}#${name}`, `#${name}`])
        map.set(key, map.has(key) ? AMBIGUOUS : decl);
    };
    for (const m of text.matchAll(
      /(?:static\s+)?(?:inline\s+)?(?:constexpr|const)\s+(double|float|int|bool|size_t|auto|wchar_t)\s+(\w+)\s*(\[\])?\s*(?:=\s*([^;{]+?)|\{([^}]*)\})\s*;/g,
    ))
      put(this.constants, m[2]!, m.index, (m[4] ?? m[5] ?? '').trim(), m[3] ? 'string' : m[1]);
    for (const m of text.matchAll(/^[ \t]*#[ \t]*define[ \t]+(\w+)[ \t]+([^\n]+)$/gm))
      put(this.constants, m[1]!, m.index, m[2]!.trim(), 'auto', '');
    for (const m of text.matchAll(/\benum\s+(?:\w+\s*)?(?::\s*\w+\s*)?\{([^}]*)\}/g)) {
      // Preprocessor-dependent enumerators have no single value: poison them.
      const conditional = m[1]!.includes('#');
      let previous = '';
      for (const item of splitArgs(m[1]!.replace(/^[ \t]*#.*$/gm, ''))) {
        const [, name, value] = /^(\w+)\s*(?:=\s*([\s\S]+))?$/.exec(item) ?? [];
        if (!name) throw new Error(`${path}: unsupported enumerator ${item}`);
        const expr = conditional ? '#conditional' : (value ?? (previous ? `${previous} + 1` : '0'));
        put(this.constants, name, m.index, expr, 'int');
        previous = name;
      }
    }
    for (const m of text.matchAll(/EnumValueSymbol\s+(?:(\w+)::)?(\w+)\s*\[[^\]]*\]\s*=\s*\{/g)) {
      const open = m.index + m[0].length - 1;
      put(
        this.enumStrings,
        m[2]!,
        m.index,
        text.slice(open + 1, closing(text, open)),
        undefined,
        m[1] ?? scopeAt(m.index),
      );
    }
    for (const m of text.matchAll(/static\s+constexpr\s+(\w*Parameter)\s+(\w+)\s*\{/g)) {
      const open = m.index + m[0].length - 1;
      put(this.parameters, m[2]!, m.index, text.slice(open + 1, closing(text, open)), m[1]);
    }
    for (const m of text.matchAll(/using\s+(\w+)\s*=\s*EffectParameter<\s*\w+\s*,\s*(\w+)\s*,\s*\w+\s*>\s*;/g))
      this.aliases.set(m[1]!, m[2]!);
    for (const m of text.matchAll(/ComponentInterfaceSymbol\s+(\w+)::Symbol\s*\{([^}]*)\}/g)) {
      const name = /^\s*(?:wxT\(\s*"([^"]*)"\s*\)|X[OC]\(\s*"([^"]*)")/.exec(m[2]!);
      if (!name) throw new Error(`${path}: unsupported symbol of ${m[1]}`);
      this.symbols.set(m[1]!, { file: path, scope: m[1]!, text: name[1] ?? name[2]! });
    }
    for (const m of text.matchAll(/EffectParameterMethods\s*&\s*(\w+)::Parameters\s*\(\s*\)\s*const\s*\{/g)) {
      const open = m.index + m[0].length - 1;
      this.lists.set(m[1]!, { file: path, scope: m[1]!, text: text.slice(open + 1, closing(text, open)) });
    }
    for (const m of text.matchAll(
      /bool\s+(?:(\w+)::)?VisitSettings\s*\(\s*(?:SettingsVisitorBase<\s*Const\s*>|SettingsVisitor)\s*&\s*\w+\s*\)\s*\{/g,
    )) {
      const open = m.index + m[0].length - 1;
      const owner = m[1] ?? scopeAt(m.index);
      const body = text.slice(open + 1, closing(text, open));
      if (/\.\s*(?:Define|DefineEnum|VisitSettings)\s*\(/.test(body))
        this.visits.set(owner, [...(this.visits.get(owner) ?? []), { file: path, scope: owner, text: body }]);
    }
  }

  /** `name` as seen from `scope`: its class chain, then the same file, then a unique global. */
  lookup(map: Map<string, Decl>, name: string, scope: string, file: string): Decl {
    const qualified = /^(\w+)::(\w+)$/.exec(name);
    const chain = (cls: string): string[] => [cls, ...(this.bases.get(cls) ?? []).flatMap(chain)];
    const keys = [
      ...(qualified ? chain(qualified[1]!) : scope ? chain(scope) : []).map(
        (cls) => `${cls}::${qualified ? qualified[2] : name}`,
      ),
      ...(qualified ? [] : [`${file}#${name}`, `#${name}`]),
    ];
    for (const key of keys) {
      const found = map.get(key);
      if (found === AMBIGUOUS) throw new Error(`ambiguous declaration ${key}`);
      if (found) return found;
    }
    throw new Error(`cannot resolve ${name} from ${scope || file}`);
  }

  /** Evaluate a constant expression in the scope of a declaration. */
  evaluate(expr: string, scope: string, file: string): Value {
    return evaluate(expr, (name) => {
      const decl = this.lookup(this.constants, name, scope, file);
      return convert(this.evaluate(decl.text, decl.scope, decl.file), decl.type ?? 'auto');
    });
  }

  /** Internal names of an EnumValueSymbol table; undefined for one computed at run time. */
  choices(table: string, scope: string, file: string): string[] | undefined {
    if (/\.data\s*\(\s*\)$/.test(table)) return undefined;
    return splitArgs(this.lookup(this.enumStrings, table, scope, file).text).map((item) => {
      const internal = /^\{?\s*(?:wxT|X[OC]|XXO)\(\s*"((?:[^"\\]|\\.)*)"/.exec(item);
      if (!internal) throw new Error(`unsupported EnumValueSymbol ${item}`);
      return internal[1]!;
    });
  }

  /** Declared type of `member` in `cls` or one of its bases. */
  memberType(cls: string, member: string): string {
    const pattern = new RegExp(`\\b(double|float|int|size_t|bool|wxString)\\s+${member}\\s*[;={,[]`);
    for (const body of this.bodies.get(cls) ?? []) {
      const found = pattern.exec(body.text);
      if (found) return found[1]!;
    }
    for (const base of this.bases.get(cls) ?? []) {
      try {
        return this.memberType(base, member);
      } catch {}
    }
    throw new Error(`cannot find member ${cls}::${member}`);
  }
}
