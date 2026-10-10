// The command catalogue read from Audacity itself (GetInfo: Type=Commands /
// Type=Menus, English UI). It turns every scripting command and effect into
// a typed contract, so a call is validated before it reaches Audacity.
import { readFileSync } from 'node:fs';
import { z } from 'zod';
import { boundedParam } from './catalogue-bounds.js';

export interface CatalogueParam {
  key: string;
  type: 'double' | 'float' | 'int' | 'size_t' | 'bool' | 'enum' | 'string';
  default?: unknown;
  enum?: string[];
  minimum?: number;
  maximum?: number;
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
const MENUS: MenuItem[] = load('menus.json');

/** Commands handled by dedicated tools or unsafe for an agent (they act outside the project). */
const RESERVED = new Set([
  'Help',
  'Message',
  'SetPreference',
  'SaveLog',
  'ClearLog',
  'NyquistPrompt',
  'NyquistPluginInstaller',
  'Drag',
  'OpenProject2',
  'SaveProject2',
  'SaveCopy',
  // MeasureRms opens two modal result dialogs (live 3.7.8, 2026-10-02). Use audacity_measure.
  'MeasureRms',
  'SampleDataImport',
  // ClickRemoval opens a blocking error dialog on valid audio without clicks
  // (live 3.7.8, 2026-10-02; confirmed in official ClickRemovalBase::Process).
  'ClickRemoval',
  // Repair opens a modal above 128 samples (live 3.7.8, 2026-10-02).
  // Official Repair.cpp also rejects pitch/speed clips and missing context;
  // GetInfo omits pitch/speed state, so a length bound alone is not safe.
  'Repair',
  // NyquistBase::Init requires spectral UI state that GetInfo cannot expose;
  // missing state opens a modal before any spectral plug-in parameters run.
  // Live 3.7.8, 2026-10-02: SpectralEditMultiTool on ordinary waveform audio
  // blocked the pipe on a Message dialog; WM_CLOSE and recovery released it.
  'SpectralEditMultiTool',
  'SpectralEditParametricEq',
  'SpectralEditShelves',
  'SpectralDelete',
  // LabelSounds returns a modal result string on silent/no-sound selections
  // and exposes no silent-message setting. Use audacity_silence and labels.
  // Live 3.7.8, 2026-10-02: LabelSounds on 0.5 seconds of digital silence
  // blocked on Message/Label Sounds dialogs; WM_CLOSE and recovery released it.
  'LabelSounds',
  // Live exact 3.7.8, 2026-10-02 (regular-label trace regression):
  // an equalabel.ny trace error leaves native mDebug enabled. A later valid
  // VERBOSE=None call still opens Debug Output; that process state is not
  // observable when attaching. Use audacity_labels regular instead.
  'RegularIntervalLabels',
  // Scripted settings load through VisitSettings (Effect.cpp:264-274), which
  // skips the post-set step (ShuttleAutomation.h:100-105) where DtmfBase.cpp:37-49
  // recalculates tones; count and timing stay as constructed (DtmfBase.h:13-15).
  // Live 3.7.8, 2026-10-10: 10 symbols over 2 s gave 4 tones of 0.25 s, and
  // "12#" read past its end for the fourth tone.
  'DtmfTones',
]);

export const COMMAND_IDS = COMMANDS.map((c) => c.id).filter((id) => !RESERVED.has(id));

/**
 * Menu commands that run without a dialog. Items whose label ends in "..."
 * open a modal window, which would block the pipe until a person closes it.
 */
const MENU_DENY = new Set([
  'ClickRemoval',
  'Repair',
  'SpectralEditMultiTool',
  'SpectralEditParametricEq',
  'SpectralEditShelves',
  'SpectralDelete',
  'LabelSounds',
  'RegularIntervalLabels',
  // Recording can open channel/rate mismatch dialogs. The dedicated transport
  // tool verifies topology and chooses the action from the user's preference.
  'Record1stChoice',
  'Record2ndChoice',
  // Scripted menu commands skip their enabling flags (Audacity-3.7.8
  // libraries/lib-menus/CommandManager.cpp:826-829), so a handler's own checks
  // decide. Paste first imports files from the system clipboard, then can ask
  // about hidden clip data or report a track mismatch (src/menus/EditMenus.cpp:
  // 453-457, 548-555, 596-607); clipboard state is not observable.
  'Paste',
  // A stretched clip near either selection edge opens an error (src/menus/
  // SelectMenus.cpp:644-666); GetInfo does not report pitch or speed changes.
  'ZeroCross',
  // Restarts PortAudio even during playback or recording, which its menu flags
  // forbid (src/menus/TransportMenus.cpp:804-805, DeviceManager.cpp:245-262).
  'RescanDevices',
  'Exit',
  'Close',
  'New',
  'Preferences',
  'ManageTools',
  'Macros',
  'ManageMacros',
  'ApplyMacrosPalette',
  // open a dialog although their label has no "..." (collected from other Audacity MCP servers)
  'TrackGain',
  'TrackPan',
  'ChangeAudio',
  'InputDevice',
  'OutputDevice',
  'EditLabels',
  'TimerRecord',
  'Resample',
  'EditMetaData',
  'PlotSpectrum',
  'ContrastAnalyser',
  'MixerBoard',
  'UndoHistory',
  'Log',
  'ConfigReset',
  'ManageGenerators',
  'ManageEffects',
  'ManageAnalyzers',
  'About',
  'QuickHelp',
  'Manual',
  'AudacitySupport',
  'AudioSetup',
  'LinkAccount',
  'Updates',
  'ExportAudio',
  'ExportMultiple',
  'Save',
  'UpdateMixdown',
  'ShareAudioTB',
  'AddRealtimeEffects',
  'RepeatLastEffect',
  'Scrub',
  'Seek',
  'PunchAndRoll',
]);
/** Verified transport/view aliases; Play and Stop are absent from GetInfo's menu listing. */
const EXTRA_MENU = ['Play', 'Stop', 'Pause', 'CursProjectStart', 'CursProjectEnd', 'ZoomSel', 'FitInWindow'];
export const MENU_IDS = [
  ...new Set([
    ...MENUS.filter(
      (m): m is MenuItem & { id: string } =>
        typeof m.id === 'string' &&
        !/[.…]/.test(m.label) &&
        /^[A-Za-z][A-Za-z0-9_-]*$/.test(m.id) &&
        !MENU_DENY.has(m.id) &&
        !m.id.startsWith('Effect_') &&
        !m.id.startsWith('Macro_'),
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
  if (['double', 'float', 'int', 'size_t'].includes(param.type)) {
    let number = z.number();
    if (param.type === 'int' || param.type === 'size_t') number = number.int();
    if (param.type === 'size_t') number = number.nonnegative();
    if (param.minimum !== undefined) number = number.min(param.minimum);
    if (param.maximum !== undefined) number = number.max(param.maximum);
    return number;
  }
  switch (param.type) {
    case 'bool':
      return z.boolean();
    case 'enum':
      return z.enum((param.enum ?? []) as [string, ...string[]]);
    case 'string':
      return SafeString;
    default:
      throw new Error(`unsupported catalogue parameter type: ${param.type}`);
  }
}

// Audacity 3.7.8's SetTrack/SetClip/SetEnvelope implementations operate on
// the current selection and declare no Track/TrackCount/Channel/ChannelCount
// parameters. A successful pipe reply can silently ignore undeclared keys.
// Live 3.7.8, 2026-10-02: all 24 scope-key probes changed the selected track
// instead of the requested target; SetTrackVisuals changed selected-track height.
// Keep only the actual catalogue contract; task tools select explicitly.
// Source: Audacity-3.7.8/src/commands/SetTrackInfoCommand.cpp,
// SetClipCommand.cpp and SetEnvelopeCommand.cpp (VisitSettings/Apply).
// NoiseReduction likewise has no automation parameters: its implementation
// ignores guessed Reduction/Sensitivity/Smoothing keys.

const schemas = new Map<string, z.ZodType>();

export function commandSchema(id: string): z.ZodType {
  const cached = schemas.get(id);
  if (cached) return cached;
  const command = COMMANDS.find((c) => c.id === id);
  if (!command) throw new Error(`unknown Audacity command: ${id}`);
  const shape: Record<string, z.ZodType> = {};
  for (const param of command.params ?? []) {
    shape[param.key] = paramSchema(boundedParam(id, param)).optional();
  }
  const schema = z.object(shape).strict();
  schemas.set(id, schema);
  return schema;
}

export function describeCommand(id: string): CatalogueCommand | undefined {
  const command = COMMANDS.find((c) => c.id === id);
  return command ? { ...command, params: (command.params ?? []).map((param) => boundedParam(id, param)) } : undefined;
}
