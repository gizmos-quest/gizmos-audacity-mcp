import { describe, expect, it } from 'vitest';
import { evaluate, splitArgs, squash, stripCode } from '../scripts/source-cpp.js';
import { builtinEffects, scriptingCommands } from '../scripts/source-declarations.js';
import { CppIndex } from '../scripts/source-index.js';
import { parseChoices, parseNyquist, unquote } from '../scripts/source-nyquist.js';

const FLT_MAX = 3.4028234663852886e38;
const effect = (header: string, body: string) =>
  new CppIndex([
    { path: 'libraries/lib-builtin-effects/GainBase.h', text: header },
    { path: 'libraries/lib-builtin-effects/GainBase.cpp', text: body },
  ]);
const HEADER = `
#define MAX_STAGES 24
class FX_API GainBase final : public Effect
{
public:
   enum kModes { kSoft, kHard, nModes };
   static const EnumValueSymbol kModeStrings[nModes];
   static constexpr double widthDefault = 0.5;
   double mRatio; // linear
   int mMode; float mWidth; bool mFlag; int mStages;
   static constexpr EffectParameter Ratio { &GainBase::mRatio, L"Ratio", 0.9f, 0.003162f, 316.227766f, 1.0f };
   static constexpr EnumParameter Mode { &GainBase::mMode, L"Mode", kHard, 0, nModes - 1, 1, kModeStrings, nModes };
   static constexpr EffectParameter Width { &GainBase::mWidth, L"Width", widthDefault, 0.1, FLT_MAX, 1 };
   static constexpr EffectParameter Flag { &GainBase::mFlag, L"Flag on", false, false, true, 1 };
   static constexpr EffectParameter Stages { &GainBase::mStages, L"Stages", 2, 2, MAX_STAGES, 1 };
};`;
const BODY = `
const EnumValueSymbol GainBase::kModeStrings[nModes] = { { XO("Soft") }, { wxT("Hard"), XO("Hard limit") } };
const EffectParameterMethods& GainBase::Parameters() const
{
   static CapturedParameters<GainBase, Ratio, Mode> parameters;
   static CapturedParameters<GainBase, Ratio, Mode, Width, Flag, Stages> batchParameters;
   return IsBatchProcessing() ? batchParameters : parameters;
}
/* i18n-hint: a "stage" */
const ComponentInterfaceSymbol GainBase::Symbol { XO("Gain stage") };`;

describe('C++ declaration reader', () => {
  it('casts effect limits like CapturedParameters and picks the batch list', () => {
    expect(builtinEffects(effect(HEADER, BODY), () => true)).toEqual([
      {
        id: 'GainStage',
        kind: 'effect',
        file: 'libraries/lib-builtin-effects/GainBase.cpp',
        params: [
          {
            key: 'Ratio',
            type: 'double',
            default: Math.fround(0.9),
            min: Math.fround(0.003162),
            max: Math.fround(316.227766),
          },
          { key: 'Mode', type: 'enum', default: 'Hard', choices: ['Soft', 'Hard'] },
          { key: 'Width', type: 'float', default: 0.5, min: Math.fround(0.1), max: FLT_MAX },
          { key: 'Flag on', type: 'bool', default: false },
          { key: 'Stages', type: 'int', default: 2, min: 2, max: 24 },
        ],
      },
    ]);
  });

  it('reads command Define calls with optional flags, implicit int limits, overloads and delegation', () => {
    const index = new CppIndex([
      {
        path: 'src/commands/PartCommand.h',
        text: `class PartCommand : public AudacityCommand { double mLevel; int mCount; bool bHasLevel; wxString mName; };
class WholeCommand : public AudacityCommand {
   PartCommand mPart; double mScale;
   template<bool Const> bool VisitSettings( SettingsVisitorBase<Const> &S ) {
      return mPart.VisitSettings(S) && S.Define( mScale, wxT("Scale"), 0.0f, 0.0f, 0.01f );
   };
};`,
      },
      {
        path: 'src/commands/PartCommand.cpp',
        text: `template<bool Const>
bool PartCommand::VisitSettings( SettingsVisitorBase<Const> & S ){
   S.OptionalN( bHasLevel ).Define( mLevel, wxT("Level"), 0.0, -100.0, (double)FLT_MAX );
   S.Define( mCount, wxT("Count"), 1 );
   S.Define( mName, wxT("Name"), fn.GetFullPath() );
   return true;
}
bool PartCommand::VisitSettings( SettingsVisitor & S ) { return VisitSettings<false>(S); }
const ComponentInterfaceSymbol PartCommand::Symbol { XO("Part") };
const ComponentInterfaceSymbol WholeCommand::Symbol { XO("Whole thing") };`,
      },
    ]);
    const level = { key: 'Level', type: 'double', default: 0, min: -100, max: FLT_MAX, optional: true };
    const count = { key: 'Count', type: 'int', default: 1, min: 0, max: 100_000 };
    const name = { key: 'Name', type: 'string' };
    expect(scriptingCommands(index, () => true)).toEqual([
      { id: 'Part', kind: 'command', file: 'src/commands/PartCommand.cpp', params: [level, count, name] },
      {
        id: 'WholeThing',
        kind: 'command',
        file: 'src/commands/PartCommand.cpp',
        params: [level, count, name, { key: 'Scale', type: 'float', default: 0, min: 0, max: Math.fround(0.01) }],
      },
    ]);
  });

  it.each([
    ['an unsupported expression', HEADER.replace('0.9f', 'Clamp(0.9f)'), BODY, 'unsupported expression'],
    ['a missing member', HEADER.replace('double mRatio;', ''), BODY, 'cannot find member'],
    ['an unresolved constant', HEADER.replace('widthDefault = 0.5', 'otherDefault = 0.5'), BODY, 'cannot resolve'],
    ['an ambiguous list', HEADER, BODY.replace('batchParameters', 'otherParameters'), 'cannot choose'],
    ['an unsupported symbol', HEADER, BODY.replace('XO("Gain stage")', 'Name()'), 'unsupported symbol'],
  ])('fails loudly on %s', (_, header, body, message) => {
    expect(() => builtinEffects(effect(header, body), () => true)).toThrow(message);
  });

  it('fails loudly on a double command parameter without limits and on an ambiguous global', () => {
    const command = (define: string) =>
      new CppIndex([
        {
          path: 'src/commands/X.cpp',
          text: `class XCommand : public AudacityCommand { double mX; };
const double kLimit = 1; const double kLimit = 2;
template<bool Const> bool XCommand::VisitSettings( SettingsVisitorBase<Const> & S ){ S.${define}; return true; }
const ComponentInterfaceSymbol XCommand::Symbol { XO("X") };`,
        },
      ]);
    expect(() => scriptingCommands(command('Define( mX, wxT("X"), 0.0 )'), () => true)).toThrow('explicit limits');
    expect(() => scriptingCommands(command('Define( mX, wxT("X"), 0.0, 0.0, kLimit )'), () => true)).toThrow(
      'ambiguous',
    );
  });

  it('strips comments and #if 0 branches but keeps literals', () => {
    expect(stripCode('a = "//x"; // gone\nb = \'"\'; /* gone */ c')).toBe('a = "//x"; \nb = \'"\';   c');
    expect(stripCode('#if 0\nold\n#else\nnew\n#endif')).toBe('\nnew\n#endif');
    expect(() => stripCode('#if 0\n#ifdef X\n#endif\n#endif')).toThrow('nested');
    expect(splitArgs('a, f(b, c), {d, e}, Base<T, U>')).toEqual(['a', 'f(b, c)', '{d, e}', 'Base<T, U>']);
    expect(squash(' Change  Speed and PITCH ')).toBe('ChangeSpeedAndPitch');
    expect(evaluate('-60 / step + (int)2.7', () => ({ type: 'double', value: 0.1 }))).toEqual({
      type: 'double',
      value: -598,
    });
    expect(evaluate('7 / 2', () => ({ type: 'int', value: 0 }))).toEqual({ type: 'int', value: 3 });
  });
});

describe('Nyquist header reader', () => {
  const HEADER_NY = `$nyquist plug-in
$type process
$name (_ "Test Filter")
;; ordinary comment
;i18n-hint: an unbalanced ( in a plain comment line does not continue
$control FREQ (_ "Frequency") float-text "" 1000 0 nil
$control MODE (_ "Mode") choice (("Fast" (_ "Fast mode"))
;i18n-hint: a comment inside a wrapped header
                               (_ "Slow")) 1
$control COUNT (_ "Count") int-text "" 5 nil nil
$control GAIN (_ "Gain (dB)
second line") real "" 3 -10 0
$control text (_ "A note")
$control NAME (_ "Name") string "" (_ "Default name")
$control WHEN (_ "When") time "" 2 nil nil
$control OLD (_ "Old") choice "One, Two" 0
`;

  it('reads controls the way NyquistBase::Parse does', () => {
    expect(parseNyquist(HEADER_NY, 'plug-ins/test.ny')).toEqual({
      id: 'TestFilter',
      kind: 'nyquist',
      file: 'plug-ins/test.ny',
      params: [
        { key: 'FREQ', type: 'double', default: 1000, min: 0, max: FLT_MAX },
        { key: 'MODE', type: 'enum', default: 'Slow', choices: ['Fast', 'Slow'] },
        { key: 'COUNT', type: 'int', default: 5, min: -2_147_483_648, max: 2_147_483_647 },
        { key: 'GAIN', type: 'double', default: 0, min: -10, max: 0 },
        { key: 'NAME', type: 'string', default: 'Default name' },
        { key: 'WHEN', type: 'double', default: 2, min: 0, max: FLT_MAX },
        { key: 'OLD', type: 'enum', default: 'One', choices: ['One', 'Two'] },
      ],
    });
    expect(unquote('(_ "Label")')).toBe('Label');
    expect(parseChoices('((_ "A") ("Bee" (_ "B")))')).toEqual(['A', 'Bee']);
  });

  it.each([
    ['an unknown control type', '$control X (_ "X") slider "" 1 0 2', 'unsupported $control type'],
    ['a numeric control without limits', '$control X (_ "X") float "" 1', 'lacks minimum/maximum'],
    ['a default outside the choices', '$control X (_ "X") choice ((_ "A")) 3', 'not a choice'],
  ])('fails loudly on %s', (_, control, message) => {
    expect(() => parseNyquist(`$name (_ "X")\n${control}`, 'plug-ins/x.ny')).toThrow(message);
  });

  it('requires a plug-in name', () => {
    expect(() => parseNyquist('$control X (_ "X") float "" 1 0 2', 'plug-ins/x.ny')).toThrow('no $name');
  });
});
