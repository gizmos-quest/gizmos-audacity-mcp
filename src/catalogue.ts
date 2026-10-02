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
  // Repair opens a modal above 128 samples (live 3.7.8, 2026-10-02).
  // Official Repair.cpp also rejects pitch/speed clips and missing context;
  // GetInfo omits pitch/speed state, so a length bound alone is not safe.
  'Repair',
  // NyquistBase::Init requires spectral UI state that GetInfo cannot expose;
  // missing state opens a modal before any spectral plug-in parameters run.
  // Live 3.7.8, 2026-10-02: SpectralEditMultiTool on ordinary waveform audio
  // blocked the pipe on a Message dialog; WM_CLOSE and recovery released it.
  'SpectralEditMultiTool', 'SpectralEditParametricEq', 'SpectralEditShelves', 'SpectralDelete',
  // LabelSounds returns a modal result string on silent/no-sound selections
  // and exposes no silent-message setting. Use audacity_silence and labels.
  // Live 3.7.8, 2026-10-02: LabelSounds on 0.5 seconds of digital silence
  // blocked on Message/Label Sounds dialogs; WM_CLOSE and recovery released it.
  'LabelSounds',
  // Live exact 3.7.8, 2026-10-02 (recorded native regression probe):
  // an equalabel.ny trace error leaves native mDebug enabled. A later valid
  // VERBOSE=None call still opens Debug Output; that process state is not
  // observable when attaching. Use audacity_labels regular instead.
  'RegularIntervalLabels',
]);

export const COMMAND_IDS = COMMANDS.map((c) => c.id).filter((id) => !RESERVED.has(id));

/**
 * Menu commands that run without a dialog. Items whose label ends in "..."
 * open a modal window, which would block the pipe until a person closes it.
 */
const MENU_DENY = new Set([
  'ClickRemoval', 'Repair',
  'SpectralEditMultiTool', 'SpectralEditParametricEq', 'SpectralEditShelves', 'SpectralDelete', 'LabelSounds', 'RegularIntervalLabels',
  // Recording can open channel/rate mismatch dialogs. The dedicated transport
  // tool verifies topology and chooses the action from the user's preference.
  'Record1stChoice', 'Record2ndChoice',
  'Exit', 'Close', 'New', 'Preferences', 'ManageTools', 'Macros', 'ManageMacros', 'ApplyMacrosPalette',
  // open a dialog although their label has no "..." (collected from other Audacity MCP servers)
  'TrackGain', 'TrackPan', 'ChangeAudio', 'InputDevice', 'OutputDevice', 'EditLabels', 'TimerRecord', 'Resample',
  'EditMetaData', 'PlotSpectrum', 'ContrastAnalyser', 'MixerBoard', 'UndoHistory', 'Log',
  'ConfigReset', 'ManageGenerators', 'ManageEffects', 'ManageAnalyzers', 'About', 'QuickHelp', 'Manual',
  'AudacitySupport', 'AudioSetup', 'LinkAccount', 'Updates', 'ExportAudio', 'ExportMultiple',
  'Save', 'UpdateMixdown', 'ShareAudioTB', 'AddRealtimeEffects', 'RepeatLastEffect', 'Scrub', 'Seek', 'PunchAndRoll',
]);
/** Verified transport/view aliases; Play and Stop are absent from GetInfo's menu listing. */
const EXTRA_MENU = ['Play', 'Stop', 'Pause', 'CursProjectStart', 'CursProjectEnd', 'ZoomSel', 'FitInWindow'];
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

// GetInfo omits numeric bounds. These are the declared 3.7.8 settings from
// src/commands/SetTrackInfoCommand.cpp, SetEnvelopeCommand.cpp and
// SetClipCommand.cpp, researched alongside the pinned live setter tests.
// SetClip deliberately permits a small negative native start; task tools
// retain their nonnegative project-time contract.
const audioBounds = { Volume: [-36, 36], Pan: [-100, 100] } as const;
const visualBounds = { Height: [44, 2000], VZoomHigh: [-2, 2], VZoomLow: [-2, 2] } as const;
// Constant numeric $control limits from the official Audacity-3.7.8 plug-ins
// below. NyquistBase::SetLispVarsFromParameters ignores out-of-range controls
// in batch processing, retaining saved settings; reject them before any edit.
// A nil control bound is intentionally omitted, rather than guessed from UI
// text or a dynamic sample-rate limit (effect-safety handles source Nyquist).
// Sources: Audacity-3.7.8/plug-ins/{adjustable-fade,beat,clipfix,
// crossfadetracks,delay,highpass,legacy-limiter,lowpass,noisegate,notch,pluck,
// equalabel,rhythmtrack,rissetdrum,sample-data-export,ShelfFilter,tremolo,vocoder}.ny
// and libraries/lib-nyquist-effects/NyquistBase.cpp (DoLoadSettings).
// Native effect constants below are declared in official 3.7.8
// libraries/lib-builtin-effects/{AmplifyBase,ToneGenBase,NormalizeBase,ReverbBase}.h.
// ToneGenBase's DBL_MAX frequency upper limit adds no finite-number guard and
// is omitted. Project/source-dependent frequency limits are separate checks.
const numericBounds: Record<string, Record<string, readonly [number | undefined, number | undefined]>> = {
  SetTrackAudio: audioBounds, SetTrackVisuals: visualBounds,
  SetTrack: { ...audioBounds, ...visualBounds },
  SetEnvelope: { Time: [0, 100_000], Value: [0, 2] },
  SetClip: { At: [0, 100_000], Start: [-5, 1_000_000] },
  Amplify: { Ratio: [0.003162, 316.227766] },
  Tone: { Frequency: [1, undefined], Amplitude: [0, 1] },
  Chirp: { StartFreq: [1, undefined], EndFreq: [1, undefined], StartAmp: [0, 1], EndAmp: [0, 1] },
  Normalize: { PeakLevel: [-145, 0] },
  Reverb: { RoomSize: [0, 100], Delay: [0, 200], Reverberance: [0, 100], HfDamping: [0, 100], ToneLow: [0, 100], ToneHigh: [0, 100], WetGain: [-20, 10], DryGain: [-20, 10], StereoWidth: [0, 100] },
  AdjustableFade: { CURVE: [-100, 100] },
  BeatFinder: { THRESVAL: [5, 100] },
  ClipFix: { THRESHOLD: [0, 100], GAIN: [-30, 0] },
  CrossfadeTracks: { CURVE: [0, 1] },
  Delay: { DGAIN: [-30, 1], DELAY: [0, 5], SHIFT: [-2, 2], NUMBER: [1, 30] },
  'High-passFilter': { FREQUENCY: [0, undefined] },
  'Low-passFilter': { FREQUENCY: [0, undefined] },
  LegacyLimiter: { 'GAIN-L': [0, 10], 'GAIN-R': [0, 10], THRESH: [-10, 0], HOLD: [1, 50] },
  NoiseGate: { THRESHOLD: [-96, -6], 'GATE-FREQ': [0, 10], 'LEVEL-REDUCTION': [-100, 0], ATTACK: [1, 1000], HOLD: [0, 2000], DECAY: [10, 4000] },
  NotchFilter: { FREQUENCY: [0, undefined], Q: [0.1, 1000] },
  Pluck: { PITCH: [1, 120], DUR: [0, 60] },
  RegularIntervalLabels: { TOTALNUM: [1, 1000], INTERVAL: [0.001, 3600], REGION: [0, 3600], FIRSTNUM: [0, undefined] },
  RhythmTrack: { TEMPO: [30, 300], TIMESIG: [1, 20], SWING: [-1, 1], BARS: [0, 1000], 'CLICK-TRACK-DUR': [0, undefined], OFFSET: [0, undefined], HIGH: [18, 116], LOW: [18, 116] },
  RissetDrum: { FREQ: [50, 2000], DECAY: [0.1, 60], CF: [100, 5000], BW: [10, 1000], NOISE: [0, 100], GAIN: [0, 1] },
  SampleDataExport: { NUMBER: [1, 1_000_000] },
  ShelfFilter: { HZ: [10, 10_000], GAIN: [-72, 72] },
  Tremolo: { PHASE: [-180, 180], WET: [1, 100], LFO: [0.001, 1000] },
  Vocoder: { DST: [1, 120], BANDS: [10, 240], 'TRACK-VL': [0, 100], 'NOISE-VL': [0, 100], 'RADAR-VL': [0, 100], 'RADAR-F': [1, 100] },
};

function boundedParam(id: string, param: CatalogueParam): CatalogueParam {
  const bounds = numericBounds[id]?.[param.key];
  return bounds ? { ...param, minimum: bounds[0], maximum: bounds[1] } : param;
}

function paramSchema(param: CatalogueParam): z.ZodType {
  if (['double', 'float', 'int', 'size_t'].includes(param.type)) {
    let number = z.number().finite();
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
