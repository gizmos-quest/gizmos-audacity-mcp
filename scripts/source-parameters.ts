// Regenerate catalogue/parameters.json from a clean checkout of a tagged
// Audacity source tree (see docs/testing.md). Run by hand only:
//   npm run parameters -- <path-to-audacity-checkout>
import { execFileSync } from 'node:child_process';
import { readdirSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { pathToFileURL } from 'node:url';
import type { SourceCommand, SourceFile } from './source-cpp.js';
import { builtinEffects, scriptingCommands } from './source-declarations.js';
import { CppIndex } from './source-index.js';
import { parseNyquist } from './source-nyquist.js';

function sourceFiles(root: string, directory: string, pattern: RegExp): SourceFile[] {
  return readdirSync(join(root, directory))
    .filter((name) => pattern.test(name))
    .sort()
    .map((name) => ({ path: `${directory}/${name}`, text: readFileSync(join(root, directory, name), 'utf8') }));
}

const EFFECTS = ['libraries/lib-builtin-effects/', 'src/effects/'];

export function extract(root: string): SourceCommand[] {
  const cpp = [
    ...EFFECTS.flatMap((directory) => sourceFiles(root, directory.slice(0, -1), /\.(?:h|cpp)$/)),
    ...sourceFiles(root, 'src/commands', /\.(?:h|cpp)$/),
    ...sourceFiles(root, 'libraries/lib-dynamic-range-processor', /^DynamicRangeProcessorTypes\.h$/),
    ...sourceFiles(root, 'libraries/lib-math', /^Biquad\.h$/),
  ];
  const index = new CppIndex(cpp);
  const commands = [
    ...builtinEffects(index, (file) => EFFECTS.some((directory) => file.startsWith(directory))),
    ...scriptingCommands(index, (file) => file.startsWith('src/commands/')),
    ...sourceFiles(root, 'plug-ins', /\.ny$/).map((file) => parseNyquist(file.text, file.path)),
  ].sort((a, b) => (a.id < b.id ? -1 : a.id > b.id ? 1 : 0));
  for (const [i, command] of commands.entries())
    if (command.id === commands[i - 1]?.id) throw new Error(`duplicate command id ${command.id}`);
  return commands;
}

function git(root: string, ...args: string[]): string {
  return execFileSync('git', ['-C', root, ...args], { encoding: 'utf8' }).trim();
}

if (import.meta.url === pathToFileURL(process.argv[1] ?? '').href) {
  const root = process.argv[2];
  if (!root) throw new Error('Usage: npm run parameters -- <audacity-checkout>');
  if (git(root, 'status', '--porcelain', '--untracked-files=no'))
    throw new Error('the Audacity checkout has local changes');
  const source = {
    repository: 'https://github.com/audacity/audacity',
    tag: git(root, 'describe', '--tags', '--exact-match', 'HEAD'),
    commit: git(root, 'rev-parse', 'HEAD'),
  };
  const commands = extract(root);
  const catalogue = JSON.parse(readFileSync(new URL('../catalogue/commands.json', import.meta.url), 'utf8')) as {
    id: string;
  }[];
  // NyquistPrompt's parameters are the program text, not declared controls.
  const missing = catalogue.filter((c) => c.id !== 'NyquistPrompt' && !commands.some((s) => s.id === c.id));
  if (missing.length) throw new Error(`no source declarations for ${missing.map((c) => c.id).join(', ')}`);
  writeFileSync(
    new URL('../catalogue/parameters.json', import.meta.url),
    `${JSON.stringify({ source, commands }, null, 1)}\n`,
  );
  console.log(`${commands.length} commands from ${source.tag} (${source.commit})`);
}
