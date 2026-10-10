import { z } from 'zod';

export type Parameters = Record<string, unknown>;
export const FILTERS = new Set(['High-passFilter', 'Low-passFilter', 'NotchFilter', 'ShelfFilter']);
const NumberValue = z.number();

function explicitNumber(id: string, params: Parameters, key: string): number {
  if (params[key] === undefined)
    throw new Error(`${id} requires explicit ${key}; saved UI settings cannot establish dialog-free processing`);
  return NumberValue.parse(params[key]);
}

/** Static guards run before selecting tracks, creating tracks or earlier macro edits. */
export function preflightEffectParameters(id: string, params: Parameters): void {
  if (FILTERS.has(id)) {
    const key = id === 'ShelfFilter' ? 'HZ' : 'FREQUENCY';
    const value = explicitNumber(id, params, key);
    if (value < (id === 'ShelfFilter' ? 10 : 0.1)) throw new Error(`${id} ${key} is below its supported minimum`);
  } else if (id === 'NoiseGate') {
    if (params.MODE !== 'Gate') throw new Error('NoiseGate requires explicit MODE=Gate; Analyze opens a result dialog');
    if (explicitNumber(id, params, 'GATE-FREQ') < 0) throw new Error('NoiseGate GATE-FREQ must be nonnegative');
  } else if (id === 'Vocoder') {
    const levels = ['TRACK-VL', 'NOISE-VL', 'RADAR-VL'].map((key) => explicitNumber(id, params, key));
    if (levels.some((value) => value < 0 || value > 100) || levels.every((value) => value === 0))
      throw new Error('Vocoder needs at least one positive carrier level; carrier levels must be between 0 and 100');
  } else if (id === 'LegacyLimiter') {
    if (!['SoftLimit', 'HardLimit', 'SoftClip', 'HardClip'].includes(String(params.TYPE)))
      throw new Error('LegacyLimiter requires explicit TYPE to preflight its averaging window');
    if (['SoftLimit', 'HardLimit'].includes(String(params.TYPE)) && !(explicitNumber(id, params, 'HOLD') >= 1))
      throw new Error('LegacyLimiter limiting modes require HOLD of at least 1 ms');
  } else if (id === 'RhythmTrack') {
    const bars = explicitNumber(id, params, 'BARS');
    if (bars < 0 || !Number.isInteger(bars)) throw new Error('RhythmTrack BARS must be a nonnegative integer');
    if (bars === 0 && !(explicitNumber(id, params, 'CLICK-TRACK-DUR') > 0))
      throw new Error('RhythmTrack needs positive BARS or CLICK-TRACK-DUR to avoid a result dialog');
  } else if (id === 'AdjustableFade') {
    if (params.PRESET === undefined)
      throw new Error('AdjustableFade requires explicit PRESET to avoid unknown saved UI gain settings');
    if (params.PRESET === 'None') {
      if (!['Percent', 'dB'].includes(String(params.UNITS)))
        throw new Error('AdjustableFade with PRESET=None requires explicit UNITS');
      const gains = ['GAIN0', 'GAIN1'].map((key) => explicitNumber(id, params, key));
      if (params.UNITS === 'Percent' && gains.some((value) => value < 0 || value > 1000))
        throw new Error('AdjustableFade percentage gains must be between 0 and 1000');
      if (params.UNITS === 'dB' && gains.some((value) => value > 100))
        throw new Error('AdjustableFade dB gains must not exceed 100');
    }
  }
}
