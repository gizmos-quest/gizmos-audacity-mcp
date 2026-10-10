import { readdir, readFile } from 'node:fs/promises';
import { dirname, join } from 'node:path';
import { z } from 'zod';
import { configPath } from '../app.js';
import { COMMAND_IDS, describeCommand, MENU_IDS, SafeString } from '../catalogue.js';
import { preflightMacroEffects, requireEffectSelection } from '../effect-safety.js';
import type { ParamValue } from '../format.js';
import type { Ops } from '../ops.js';
import { errorWithContext, preflightCommand } from '../ops.js';
import type { ToolRegistrar } from '../tools.js';

export interface MacroStep {
  command: string;
  params: Record<string, ParamValue>;
}
/** Parse saved Audacity macros, validating every step before any of them runs. */
export function parseMacro(source: string, outputTo?: string): MacroStep[] {
  const steps: MacroStep[] = [];
  const add = (step: MacroStep) => {
    steps.push(step);
    if (steps.length > 1000) throw new Error('macro exceeds 1000 steps');
  };
  for (const [lineNumber, line] of source.split(/\r?\n/).entries()) {
    if (!line.trim() || line.trim().startsWith('#')) continue;
    const match = /^([A-Za-z][A-Za-z0-9_-]*):\s*(.*)$/.exec(line.trim());
    if (!match) throw new Error(`invalid macro line ${lineNumber + 1}`);
    const command = match[1]!;
    const text = match[2]!;
    if (['ExportMP3', 'ExportWav', 'ExportFlac', 'ExportOgg'].includes(command)) {
      if (text.trim()) throw new Error(`macro ${command} takes no parameters`);
      if (!outputTo) throw new Error(`macro ${command} needs outputTo; automatic destinations are refused`);
      const expected = { ExportMP3: '.mp3', ExportWav: '.wav', ExportFlac: '.flac', ExportOgg: '.ogg' }[command];
      if (!outputTo.toLowerCase().endsWith(expected!)) throw new Error(`${command} requires a ${expected} outputTo`);
      const step = { command: 'Export2', params: { Filename: outputTo, NumChannels: 2 } };
      preflightCommand(step.command, step.params);
      add(step);
      continue;
    }
    if (!COMMAND_IDS.includes(command) && !MENU_IDS.includes(command))
      throw new Error(`unsafe or unavailable macro command: ${command}`);
    const params: Record<string, ParamValue> = {};
    const keys = new Set<string>();
    const tokens = /\s*(?:"([A-Za-z_][A-Za-z0-9_ -]*)"|([A-Za-z_][A-Za-z0-9_ -]*?))=(?:"([^"\r\n]*)"|([^\s]+))/y;
    let offset = 0;
    while (offset < text.length) {
      tokens.lastIndex = offset;
      const token = tokens.exec(text);
      if (!token) {
        if (!text.slice(offset).trim()) break;
        throw new Error(`invalid parameters on macro line ${lineNumber + 1}`);
      }
      offset = tokens.lastIndex;
      const key = (token[1] ?? token[2])!;
      const value = (token[3] ?? token[4])!;
      if (keys.has(key)) throw new Error(`duplicate macro parameter: ${key}`);
      keys.add(key);
      if (key === 'Use_Preset') {
        if (value !== '<Current Settings>' || (describeCommand(command)?.params?.length ?? 0) > 0) {
          throw new Error(`macro preset ${value} is implicit; use explicit catalogue parameters`);
        }
        continue;
      }
      const type = describeCommand(command)?.params?.find((p) => p.key === key)?.type;
      if (type === 'bool') {
        if (!['0', '1'].includes(value)) throw new Error(`macro boolean ${key} must be 1/0`);
        params[key] = value === '1';
      } else if (type && ['double', 'float', 'int', 'size_t'].includes(type)) {
        if (!value.trim()) throw new Error(`macro numeric parameter ${key} must not be empty`);
        params[key] = Number(value);
      } else params[key] = value;
    }
    if (MENU_IDS.includes(command) && !describeCommand(command)) {
      if (Object.keys(params).length) throw new Error(`menu ${command} takes no parameters`);
    } else preflightCommand(command, params);
    if (command === 'SampleDataExport' && params.MESSAGES !== 'None')
      throw new Error('macro SampleDataExport requires MESSAGES=None');
    add({ command, params });
  }
  if (!steps.length) throw new Error('macro has no commands');
  return steps;
}

export function registerMacroTool(tool: ToolRegistrar, ops: Ops): void {
  tool(
    'audacity_macros',
    'List or apply saved local Audacity macros without opening the Macro Manager. Every step is parsed and checked first; dryRun lists steps. Modal/lifecycle commands and implicit effect presets are refused. Export macros need explicit outputTo.',
    {
      action: z.enum(['list', 'apply']),
      name: SafeString.min(1).optional(),
      dryRun: z.boolean().default(false),
      outputTo: SafeString.min(1).optional(),
    },
    async ({ action, name, dryRun, outputTo }) => {
      if (action === 'list' && (name !== undefined || outputTo !== undefined || dryRun))
        throw new Error('macro list takes no name, outputTo or dryRun');
      if (action === 'apply' && name === undefined) throw new Error('macro apply requires name');
      const directory = join(dirname(configPath()), 'Macros');
      let entries: string[];
      try {
        entries = await readdir(directory);
      } catch (error) {
        if ((error as NodeJS.ErrnoException).code === 'ENOENT') entries = [];
        else throw error;
      }
      const files = entries.filter((f) => f.toLowerCase().endsWith('.txt')).sort();
      if (action === 'list') {
        return {
          directory,
          macros: await Promise.all(
            files.map(async (file) => {
              try {
                return {
                  name: file.slice(0, -4),
                  steps: parseMacro(await readFile(join(directory, file), 'utf8')),
                  safe: true,
                };
              } catch (e) {
                return { name: file.slice(0, -4), safe: false, reason: (e as Error).message };
              }
            }),
          ),
        };
      }
      const file = files.find((f) => f.slice(0, -4) === name);
      if (!file) throw new Error('macro name does not exist; use list');
      const steps = parseMacro(await readFile(join(directory, file), 'utf8'), outputTo);
      if (dryRun) return { name, dryRun, steps };
      await preflightMacroEffects(ops, steps);
      if (steps.some((step) => step.command === 'NoiseReduction')) ops.requireNoiseProfile();
      let completed = 0;
      for (const step of steps) {
        try {
          if (step.command === 'Export2')
            await ops.exportMix(String(step.params.Filename), Number(step.params.NumChannels));
          else if (COMMAND_IDS.includes(step.command)) {
            await requireEffectSelection(ops, step.command);
            await ops.command(step.command, step.params, 600_000);
          } else await ops.run(step.command, step.params, 600_000);
          completed++;
        } catch (error) {
          throw errorWithContext(
            error,
            `macro stopped at ${step.command} after ${completed} completed steps: ${error instanceof Error ? error.message : String(error)}`,
          );
        }
      }
      return { name, dryRun, completed: steps.length };
    },
  );
}
