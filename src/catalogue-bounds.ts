import type { CatalogueParam } from './catalogue.js';

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
  SetTrackAudio: audioBounds,
  SetTrackVisuals: visualBounds,
  SetTrack: { ...audioBounds, ...visualBounds },
  SetEnvelope: { Time: [0, 100_000], Value: [0, 2] },
  SetClip: { At: [0, 100_000], Start: [-5, 1_000_000] },
  Amplify: { Ratio: [0.003162, 316.227766] },
  Tone: { Frequency: [1, undefined], Amplitude: [0, 1] },
  Chirp: { StartFreq: [1, undefined], EndFreq: [1, undefined], StartAmp: [0, 1], EndAmp: [0, 1] },
  Normalize: { PeakLevel: [-145, 0] },
  Reverb: {
    RoomSize: [0, 100],
    Delay: [0, 200],
    Reverberance: [0, 100],
    HfDamping: [0, 100],
    ToneLow: [0, 100],
    ToneHigh: [0, 100],
    WetGain: [-20, 10],
    DryGain: [-20, 10],
    StereoWidth: [0, 100],
  },
  AdjustableFade: { CURVE: [-100, 100] },
  BeatFinder: { THRESVAL: [5, 100] },
  ClipFix: { THRESHOLD: [0, 100], GAIN: [-30, 0] },
  CrossfadeTracks: { CURVE: [0, 1] },
  Delay: { DGAIN: [-30, 1], DELAY: [0, 5], SHIFT: [-2, 2], NUMBER: [1, 30] },
  'High-passFilter': { FREQUENCY: [0, undefined] },
  'Low-passFilter': { FREQUENCY: [0, undefined] },
  LegacyLimiter: { 'GAIN-L': [0, 10], 'GAIN-R': [0, 10], THRESH: [-10, 0], HOLD: [1, 50] },
  NoiseGate: {
    THRESHOLD: [-96, -6],
    'GATE-FREQ': [0, 10],
    'LEVEL-REDUCTION': [-100, 0],
    ATTACK: [1, 1000],
    HOLD: [0, 2000],
    DECAY: [10, 4000],
  },
  NotchFilter: { FREQUENCY: [0, undefined], Q: [0.1, 1000] },
  Pluck: { PITCH: [1, 120], DUR: [0, 60] },
  RegularIntervalLabels: { TOTALNUM: [1, 1000], INTERVAL: [0.001, 3600], REGION: [0, 3600], FIRSTNUM: [0, undefined] },
  RhythmTrack: {
    TEMPO: [30, 300],
    TIMESIG: [1, 20],
    SWING: [-1, 1],
    BARS: [0, 1000],
    'CLICK-TRACK-DUR': [0, undefined],
    OFFSET: [0, undefined],
    HIGH: [18, 116],
    LOW: [18, 116],
  },
  RissetDrum: { FREQ: [50, 2000], DECAY: [0.1, 60], CF: [100, 5000], BW: [10, 1000], NOISE: [0, 100], GAIN: [0, 1] },
  SampleDataExport: { NUMBER: [1, 1_000_000] },
  ShelfFilter: { HZ: [10, 10_000], GAIN: [-72, 72] },
  Tremolo: { PHASE: [-180, 180], WET: [1, 100], LFO: [0.001, 1000] },
  Vocoder: {
    DST: [1, 120],
    BANDS: [10, 240],
    'TRACK-VL': [0, 100],
    'NOISE-VL': [0, 100],
    'RADAR-VL': [0, 100],
    'RADAR-F': [1, 100],
  },
};

export function boundedParam(id: string, param: CatalogueParam): CatalogueParam {
  const bounds = numericBounds[id]?.[param.key];
  return bounds ? { ...param, minimum: bounds[0], maximum: bounds[1] } : param;
}
