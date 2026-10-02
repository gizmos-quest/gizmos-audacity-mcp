// The command catalogue read from Audacity itself (GetInfo: Type=Commands /
// Type=Menus, English UI). It turns every scripting command and effect into
// a typed contract, so a call is validated before it reaches Audacity.
import { readFileSync } from 'node:fs';
import { z } from 'zod';

export interface CatalogueParam {
  key: string;
  type: 'double' | 'float' | 'int' | 'size_t' | 'bool' | 'enum' | 'string';
  default?: unknown;
  enum?: string[];
}

export interface CatalogueCommand {
  id: string;
  name: string;
  params?: CatalogueParam[];
  tip?: string;
}

export interface MenuItem {
  id?: string;
  label: string;
  depth: number;
  flags: number;
}

function load<T>(name: string): T {
  return JSON.parse(readFileSync(new URL(`../catalogue/${name}`, import.meta.url), 'utf8')) as T;
}

export const COMMANDS: CatalogueCommand[] = load('commands.json');
export const MENUS: MenuItem[] = load('menus.json');

/** Commands handled by dedicated tools or unsafe for an agent (they act outside the project). */
const RESERVED = new Set([
  'Help', 'Message', 'SetPreference', 'SaveLog', 'ClearLog', 'NyquistPrompt', 'NyquistPluginInstaller',
  'Drag', 'OpenProject2', 'SaveProject2', 'SaveCopy',
  // MeasureRms opens two modal result dialogs (live 3.7.8, 2026-10-02). Use audacity_measure.
  'MeasureRms', 'SampleDataImport',
  // ClickRemoval opens a blocking error dialog on valid audio without clicks
  // (live 3.7.8, 2026-10-02; confirmed in official ClickRemovalBase::Process).
  'ClickRemoval',
  // Repair's native processing opens a modal error for selections over 128
  // samples (live 3.7.8, 2026-10-02); no safe bounded wrapper is exposed.
  'Repair',
]);

export const COMMAND_IDS = COMMANDS.map((c) => c.id).filter((id) => !RESERVED.has(id));

/**
 * Menu commands that run without a dialog. Items whose label ends in "..."
 * open a modal window, which would block the pipe until a person closes it.
 */
const MENU_DENY = new Set([
  'ClickRemoval', 'Repair',
  'Exit', 'Close', 'New', 'Preferences', 'ManageTools', 'Macros', 'ManageMacros', 'ApplyMacrosPalette',
  // open a dialog although their label has no "..." (collected from other Audacity MCP servers)
  'TrackGain', 'TrackPan', 'ChangeAudio', 'InputDevice', 'OutputDevice', 'EditLabels', 'TimerRecord', 'Resample',
  'EditMetaData', 'PlotSpectrum', 'ContrastAnalyser', 'MixerBoard', 'UndoHistory', 'Log',
  'ConfigReset', 'ManageGenerators', 'ManageEffects', 'ManageAnalyzers', 'About', 'QuickHelp', 'Manual',
  'AudacitySupport', 'AudioSetup', 'LinkAccount', 'Updates', 'ExportAudio', 'ExportMultiple',
  'Save', 'UpdateMixdown', 'AddRealtimeEffects', 'RepeatLastEffect', 'Scrub', 'Seek', 'PunchAndRoll',
]);
/** Transport and view commands from the hidden "Extra" menu, which GetInfo does not list (verified live on 3.7.8). */
const EXTRA_MENU = ['Play', 'Stop', 'Pause', 'Record1stChoice', 'CursProjectStart', 'CursProjectEnd', 'ZoomSel', 'FitInWindow'];
export const MENU_IDS = [
  ...new Set([
    ...MENUS.filter(
      (m): m is MenuItem & { id: string } => typeof m.id === 'string' && !/[.…]/.test(m.label) &&
        /^[A-Za-z][A-Za-z0-9_-]*$/.test(m.id) && !MENU_DENY.has(m.id) && !m.id.startsWith('Effect_') && !m.id.startsWith('Macro_'),
    ).map((m) => m.id),
    ...EXTRA_MENU,
  ]),
];

export const EFFECT_IDS = COMMAND_IDS.filter((id) => {
  const command = COMMANDS.find((c) => c.id === id)!;
  return !/^(Get|Set|Select|Import|Export|Open|Save)/.test(id) && !['Comment', 'CompareAudio'].includes(command.id);
});

/** A value Audacity's parser takes verbatim; quotes and line breaks cannot be escaped. */
export const SafeString = z
  .string()
  .max(4096)
  .refine((s) => !/["\r\n\0]/.test(s), 'must not contain double quotes or line breaks');

function paramSchema(param: CatalogueParam): z.ZodType {
  switch (param.type) {
    case 'double':
    case 'float':
      return z.number().finite();
    case 'int':
      return z.number().int();
    case 'size_t':
      return z.number().int().nonnegative();
    case 'bool':
      return z.boolean();
    case 'enum':
      return z.enum((param.enum ?? []) as [string, ...string[]]);
    case 'string':
      return SafeString;
  }
}

const TRACK_SCOPE: CatalogueParam[] = [
  { key: 'Track', type: 'int' },
  { key: 'TrackCount', type: 'int' },
  { key: 'Channel', type: 'int' },
  { key: 'ChannelCount', type: 'int' },
];

/**
 * Parameters Audacity accepts but does not list in GetInfo: the track scope
 * of the Set* commands (verified live on 3.7.8).
 */
const UNLISTED: Record<string, CatalogueParam[]> = {
  SetTrack: TRACK_SCOPE,
  SetTrackStatus: TRACK_SCOPE,
  SetTrackAudio: TRACK_SCOPE,
  SetTrackVisuals: TRACK_SCOPE,
  SetClip: TRACK_SCOPE,
  SetEnvelope: TRACK_SCOPE,
  // NoiseReduction has no automation parameters in 3.7.8. Live acceptance
  // of arbitrary keys is misleading: NoiseReductionBase ignores them.
};

const schemas = new Map<string, z.ZodType>();

export function commandSchema(id: string): z.ZodType {
  const cached = schemas.get(id);
  if (cached) return cached;
  const command = COMMANDS.find((c) => c.id === id);
  if (!command) throw new Error(`unknown Audacity command: ${id}`);
  const shape: Record<string, z.ZodType> = {};
  for (const param of [...(command.params ?? []), ...(UNLISTED[id] ?? [])]) {
    shape[param.key] = paramSchema(param).optional();
  }
  const schema = z.object(shape).strict();
  schemas.set(id, schema);
  return schema;
}

export function describeCommand(id: string): CatalogueCommand | undefined {
  const command = COMMANDS.find((c) => c.id === id);
  return command ? { ...command, params: [...(command.params ?? []), ...(UNLISTED[id] ?? [])] } : undefined;
}
