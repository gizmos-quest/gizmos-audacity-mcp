import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import { COMMANDS, commandSchema, describeCommand } from '../src/catalogue.js';
import { AutoDuckSchema, GenerateSchema, PipelineSchema } from '../src/tasks.js';

interface SourceParam {
  key: string;
  type: string;
  default?: unknown;
  min?: number;
  max?: number;
  choices?: string[];
  optional?: true;
}
const text = readFileSync(new URL('../catalogue/parameters.json', import.meta.url), 'utf8');
const generated = JSON.parse(text) as {
  source: Record<string, string>;
  commands: { id: string; kind: string; file: string; params: SourceParam[] }[];
};
const source = new Map(generated.commands.map((command) => [command.id, command]));
const FLT_MAX = 3.4028234663852886e38;

// Every difference between the pinned source and the live English 3.7.8
// GetInfo catalogue, with its evidence (Audacity-3.7.8 paths):
// - NyquistPrompt has no declared controls; its parameters are program text.
// - Amplify: GetInfo lists the interactive AllowClipping, but scripts run with
//   batch processing set (src/BatchCommands.cpp:556) and Amplify then visits only
//   Ratio (libraries/lib-builtin-effects/AmplifyBase.cpp:16-30). Live 3.7.8,
//   2026-10-02: AllowClipping=0 still clipped; false is refused in policy.ts.
// - Nyquist defaults: GetInfo prints 0, "" or the first choice for every
//   control (libraries/lib-nyquist-effects/NyquistBase.cpp:256-289); an omitted
//   control keeps its saved value in batch mode (NyquistBase.cpp:401-414).
// - Display and SpecColor choices are computed at run time
//   (src/commands/SetTrackInfoCommand.cpp:244-272); the live enum list applies.
const CATALOGUE_ONLY: Record<string, string[]> = { Amplify: ['AllowClipping'] };
const RUNTIME_CHOICES = [
  'SetTrack.Display',
  'SetTrack.SpecColor',
  'SetTrackVisuals.Display',
  'SetTrackVisuals.SpecColor',
];

function sameDefault(live: unknown, declared: SourceParam): boolean {
  if (declared.type === 'bool') return live === (declared.default ? 'True' : 'False');
  if (typeof declared.default !== 'number') return live === declared.default;
  // GetInfo prints float-rounded numbers such as 0.8999999761581421 as 0.9.
  return typeof live === 'number' && Math.abs(live - declared.default) <= 1e-6 * Math.max(1, Math.abs(live));
}

describe('source-derived parameters', () => {
  it('records the pinned upstream tag and commit in a deterministic file', () => {
    expect(generated.source).toEqual({
      repository: 'https://github.com/audacity/audacity',
      tag: 'Audacity-3.7.8',
      commit: '6120ce413cf8abd4cca7f9470915f0ff0a0d2ded',
    });
    expect(text).toBe(`${JSON.stringify(generated, null, 1)}\n`);
    const ids = generated.commands.map((command) => command.id);
    expect(ids).toEqual([...ids].sort());
    expect(new Set(ids).size).toBe(ids.length);
  });

  it.each(
    COMMANDS.filter((command) => command.id !== 'NyquistPrompt').map((command) => [command.id, command] as const),
  )('declares every live catalogue parameter of %s', (id, command) => {
    const entry = source.get(id);
    expect(entry, `${id} has source declarations`).toBeDefined();
    const live = (command.params ?? []).filter((param) => !CATALOGUE_ONLY[id]?.includes(param.key));
    expect(entry!.params.map((param) => param.key)).toEqual(live.map((param) => param.key));
    for (const [i, param] of live.entries()) {
      const declared = entry!.params[i]!;
      expect(declared.type, `${id}.${param.key}`).toBe(param.type);
      if (param.type === 'enum')
        expect(declared.choices ?? RUNTIME_CHOICES.includes(`${id}.${param.key}`), `${id}.${param.key}`).toEqual(
          declared.choices ? param.enum : true,
        );
      // Optional native parameters are listed as "unchanged" (src/ShuttleGetDefinition.cpp).
      expect(param.default === 'unchanged', `${id}.${param.key}`).toBe(declared.optional === true);
      if (declared.optional) continue;
      if (entry!.kind === 'nyquist')
        expect(param.default, `${id}.${param.key}`).toEqual(
          param.type === 'enum' ? param.enum?.[0] : param.type === 'string' ? '' : 0,
        );
      else expect(sameDefault(param.default, declared), `${id}.${param.key}`).toBe(true);
    }
  });

  it('validates every numeric catalogue parameter with its declared limits', () => {
    for (const command of COMMANDS) {
      for (const param of describeCommand(command.id)?.params ?? []) {
        const declared = source.get(command.id)?.params.find((p) => p.key === param.key);
        if (declared?.min === undefined || declared.max === undefined) continue;
        expect(param.minimum, `${command.id}.${param.key}`).toBe(
          declared.min > -Number.MAX_VALUE ? declared.min : undefined,
        );
        expect(param.maximum, `${command.id}.${param.key}`).toBe(
          declared.max < Number.MAX_VALUE ? declared.max : undefined,
        );
      }
    }
  });

  it.each([
    ['Compressor', { attackMs: 201 }],
    ['Compressor', { releaseMs: 1001 }],
    ['Limiter', { lookaheadMs: 51 }],
    ['AutoDuck', { DuckAmountDb: -25 }],
    ['AutoDuck', { OuterFadeDownLen: 3.1 }],
    ['TruncateSilence', { Threshold: -19 }],
    ['Paulstretch', { 'Time Resolution': 0.00098 }],
    ['Echo', { Delay: 0.001 }],
    ['CompareAudio', { Threshold: 0.01 }],
    ['SetProject', { X: -1 }],
    ['SetProject', { Rate: 0 }],
    ['SelectTracks', { Track: 101 }],
    ['SetLabel', { Label: 10_001 }],
    ['Export2', { NumChannels: 100_001 }],
    ['High-passFilter', { FREQUENCY: FLT_MAX * 2 }],
  ] as const)('refuses %s values that native validation rejects: %j', (id, params) => {
    expect(() => commandSchema(id).parse(params)).toThrow();
  });

  it('accepts the float-rounded limits that native validation compares against', () => {
    for (const [id, params] of [
      ['Echo', { Delay: Math.fround(0.001) }],
      ['CompareAudio', { Threshold: Math.fround(0.01) }],
      ['Paulstretch', { 'Time Resolution': Math.fround(0.00099) }],
      ['Compressor', { thresholdDb: -600, attackMs: 200 }],
      ['SetLabel', { Label: 10_000 }],
    ] as const)
      expect(commandSchema(id).parse(params)).toEqual(params);
  });

  it('keeps typed tool ranges inside the native limits they are sent to', () => {
    const range = (schema: unknown): [number, number] => {
      let inner = schema as { unwrap?: () => unknown; minValue: number; maxValue: number };
      while (inner.unwrap) inner = inner.unwrap() as typeof inner;
      return [inner.minValue, inner.maxValue];
    };
    const pipeline = PipelineSchema.shape;
    const pauses = pipeline.shortenPauses.unwrap().shape;
    const duck = AutoDuckSchema.shape;
    const generate = GenerateSchema.shape;
    // generate.amplitude also feeds DtmfTones, whose 0.001 minimum is checked when the command is built.
    for (const [schema, id, key] of [
      [pipeline.highPassHz, 'High-passFilter', 'FREQUENCY'],
      [pipeline.lowPassHz, 'Low-passFilter', 'FREQUENCY'],
      [pipeline.thresholdDb, 'Compressor', 'thresholdDb'],
      [pipeline.ratio, 'Compressor', 'compressionRatio'],
      [pipeline.attackMs, 'Compressor', 'attackMs'],
      [pipeline.releaseMs, 'Compressor', 'releaseMs'],
      [pipeline.bassDb, 'BassAndTreble', 'Bass'],
      [pipeline.trebleDb, 'BassAndTreble', 'Treble'],
      [pipeline.peakDb, 'Normalize', 'PeakLevel'],
      [pipeline.lufs, 'LoudnessNormalization', 'LUFSLevel'],
      [pipeline.rmsDb, 'LoudnessNormalization', 'RMSLevel'],
      [pipeline.limitPeakDb, 'Limiter', 'thresholdDb'],
      [pipeline.limitPeakDb, 'Limiter', 'makeupTargetDb'],
      [pauses.thresholdDb, 'TruncateSilence', 'Threshold'],
      [pauses.minimum, 'TruncateSilence', 'Minimum'],
      [pauses.truncateTo, 'TruncateSilence', 'Truncate'],
      [duck.duckDb, 'AutoDuck', 'DuckAmountDb'],
      [duck.thresholdDb, 'AutoDuck', 'ThresholdDb'],
      [duck.fadeDown, 'AutoDuck', 'OuterFadeDownLen'],
      [duck.fadeUp, 'AutoDuck', 'OuterFadeUpLen'],
      [duck.innerFadeDown, 'AutoDuck', 'InnerFadeDownLen'],
      [duck.innerFadeUp, 'AutoDuck', 'InnerFadeUpLen'],
      [duck.maximumPause, 'AutoDuck', 'MaximumPause'],
      [generate.frequency, 'Tone', 'Frequency'],
      [generate.frequency, 'Chirp', 'StartFreq'],
      [generate.endFrequency, 'Chirp', 'EndFreq'],
      [generate.amplitude, 'Tone', 'Amplitude'],
      [generate.dutyCycle, 'DtmfTones', 'Duty Cycle'],
      [generate.tempo, 'RhythmTrack', 'TEMPO'],
      [generate.beatsPerBar, 'RhythmTrack', 'TIMESIG'],
      [generate.swing, 'RhythmTrack', 'SWING'],
    ] as const) {
      const [min, max] = range(schema);
      const native = describeCommand(id)?.params?.find((param) => param.key === key);
      expect(min, `${id}.${key}`).toBeGreaterThanOrEqual(native?.minimum ?? -Infinity);
      expect(max, `${id}.${key}`).toBeLessThanOrEqual(native?.maximum ?? Infinity);
    }
  });
});
