import { describe, expect, it, vi } from 'vitest';
import { commandSchema, describeCommand } from '../src/catalogue.js';
import { parseMacro } from '../src/controls/macros.js';
import { Ops } from '../src/ops.js';
import { AudacityPipe } from '../src/pipe.js';

const FLT_MAX = 3.4028234663852886e38;

describe('pinned numeric control limits', () => {
  it.each([
    ['NotchFilter', { Q: 0.09 }],
    ['NotchFilter', { Q: 1001 }],
    ['ShelfFilter', { HZ: 9 }],
    ['ShelfFilter', { HZ: 10_001 }],
    ['ShelfFilter', { GAIN: -73 }],
    ['ShelfFilter', { GAIN: 73 }],
    ['Delay', { NUMBER: 0 }],
    ['Delay', { NUMBER: 31 }],
    ['Delay', { SHIFT: -3 }],
    ['Delay', { SHIFT: 3 }],
    ['NoiseGate', { THRESHOLD: -97 }],
    ['NoiseGate', { THRESHOLD: -5 }],
    ['NoiseGate', { ATTACK: 0 }],
    ['NoiseGate', { ATTACK: 1001 }],
    ['Pluck', { PITCH: 0 }],
    ['Pluck', { PITCH: 121 }],
    ['Pluck', { DUR: -1 }],
    ['Pluck', { DUR: 61 }],
    ['RissetDrum', { DECAY: 0 }],
    ['RissetDrum', { GAIN: 1.01 }],
    ['SampleDataExport', { NUMBER: 0 }],
    ['SampleDataExport', { NUMBER: 1_000_001 }],
    ['RegularIntervalLabels', { TOTALNUM: 0 }],
    ['RegularIntervalLabels', { TOTALNUM: 1001 }],
    ['RhythmTrack', { TEMPO: 29 }],
    ['RhythmTrack', { TEMPO: 301 }],
    ['RhythmTrack', { SWING: -1.01 }],
    ['RhythmTrack', { OFFSET: -1 }],
    ['Tremolo', { WET: 0 }],
    ['Tremolo', { LFO: 1001 }],
    ['Vocoder', { BANDS: 9 }],
    ['Vocoder', { DST: 121 }],
  ] as const)('rejects %s values native batch processing would silently ignore: %j', (id, params) => {
    expect(() => commandSchema(id).parse(params)).toThrow();
  });

  it('refuses invalid filter controls before transport, selection, or earlier macro edits', async () => {
    const transport = vi.fn();
    const ops = new Ops(new AudacityPipe(undefined, 100, transport));
    expect(() => ops.command('NotchFilter', { FREQUENCY: 100, Q: 0 })).toThrow();
    await expect(ops.applyEffect('ShelfFilter', { HZ: 10_001, GAIN: 0 }, { track: 0 })).rejects.toThrow();
    expect(() => parseMacro('Amplify:Ratio=0.5\nNotchFilter:FREQUENCY=100 Q=0')).toThrow();
    expect(transport).not.toHaveBeenCalled();
  });

  it('accepts declared inclusive boundaries, and the FLT_MAX that Nyquist reads for nil limits', () => {
    expect(commandSchema('NotchFilter').parse({ FREQUENCY: FLT_MAX, Q: 0.1 })).toEqual({ FREQUENCY: FLT_MAX, Q: 0.1 });
    expect(commandSchema('ShelfFilter').parse({ HZ: 10_000, GAIN: 72 })).toEqual({ HZ: 10_000, GAIN: 72 });
    expect(commandSchema('SampleDataExport').parse({ NUMBER: 1_000_000 })).toEqual({ NUMBER: 1_000_000 });
    expect(commandSchema('RhythmTrack').parse({ BARS: 0, OFFSET: FLT_MAX })).toEqual({ BARS: 0, OFFSET: FLT_MAX });
    // NyquistBase.cpp reads a nil float-text/time limit as FLT_MAX; a larger value is ignored natively.
    expect(() => commandSchema('NotchFilter').parse({ FREQUENCY: 1e100 })).toThrow();
    expect(() => commandSchema('RhythmTrack').parse({ OFFSET: 1e100 })).toThrow();
  });

  it('reports source-derived bounds through command discovery', () => {
    expect(describeCommand('NotchFilter')?.params?.find((param) => param.key === 'Q')).toMatchObject({
      minimum: 0.1,
      maximum: 1000,
    });
    const frequency = describeCommand('High-passFilter')?.params?.find((param) => param.key === 'FREQUENCY');
    expect(frequency?.minimum).toBe(0);
    expect(frequency?.maximum).toBe(FLT_MAX);
    expect(describeCommand('AdjustableFade')?.params?.find((param) => param.key === 'GAIN0')?.minimum).toBe(-FLT_MAX);
  });

  it.each([
    ['Tone', { Amplitude: -0.1 }],
    ['Tone', { Amplitude: 1.1 }],
    ['Tone', { Frequency: 0.9 }],
    ['Chirp', { StartAmp: -0.1 }],
    ['Chirp', { EndAmp: 1.1 }],
    ['Chirp', { EndFreq: 0 }],
    ['Normalize', { PeakLevel: -146 }],
    ['Normalize', { PeakLevel: 1 }],
    ['Reverb', { RoomSize: -1 }],
    ['Reverb', { Delay: 201 }],
    ['Reverb', { WetGain: -21 }],
    ['Reverb', { DryGain: 11 }],
  ] as const)('refuses native %s declared numeric limit violations before selection: %j', async (id, params) => {
    const transport = vi.fn();
    const ops = new Ops(new AudacityPipe(undefined, 100, transport));
    await expect(ops.applyEffect(id, params, { track: 0 })).rejects.toThrow();
    expect(transport).not.toHaveBeenCalled();
  });

  it('accepts native inclusive boundaries and exposes unbounded frequency without a made-up maximum', () => {
    expect(commandSchema('Tone').parse({ Frequency: 1, Amplitude: 1 })).toEqual({ Frequency: 1, Amplitude: 1 });
    expect(commandSchema('Chirp').parse({ StartFreq: 1e100, EndFreq: 1, StartAmp: 0, EndAmp: 1 })).toEqual({
      StartFreq: 1e100,
      EndFreq: 1,
      StartAmp: 0,
      EndAmp: 1,
    });
    expect(commandSchema('Normalize').parse({ PeakLevel: -145 })).toEqual({ PeakLevel: -145 });
    expect(commandSchema('Reverb').parse({ Delay: 200, WetGain: -20, DryGain: 10 })).toEqual({
      Delay: 200,
      WetGain: -20,
      DryGain: 10,
    });
    expect(describeCommand('Tone')?.params?.find((param) => param.key === 'Frequency')).toMatchObject({ minimum: 1 });
    expect(describeCommand('Tone')?.params?.find((param) => param.key === 'Frequency')?.maximum).toBeUndefined();
  });

  it('rejects unsupported Amplify requests before selection or earlier macro edits', async () => {
    const transport = vi.fn();
    const ops = new Ops(new AudacityPipe(undefined, 100, transport));
    for (const Ratio of [0.003161, 316.228]) {
      await expect(ops.applyEffect('Amplify', { Ratio }, { track: 0 })).rejects.toThrow();
    }
    expect(() => ops.command('Amplify', { Ratio: 3, AllowClipping: false })).toThrow('ignores AllowClipping=false');
    expect(() => parseMacro('Amplify:Ratio=0.5\nAmplify:Ratio=3 AllowClipping=0')).toThrow(
      'ignores AllowClipping=false',
    );
    // AmplifyBase.h declares float limits; cast to the double member they are
    // 0.0031620000954717398 and 316.2277526855469, so the decimal spellings fail natively.
    for (const Ratio of [0.003162, 316.227766]) expect(() => commandSchema('Amplify').parse({ Ratio })).toThrow();
    for (const Ratio of [Math.fround(0.003162), Math.fround(316.227766)])
      expect(commandSchema('Amplify').parse({ Ratio })).toEqual({ Ratio });
    expect(transport).not.toHaveBeenCalled();
  });
});
