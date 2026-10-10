import { describe, expect, it } from 'vitest';
import { parseMacro } from '../../src/controls/macros.js';

describe('safe saved macros', () => {
  it('parses explicit types and default Fade Ends macro', () => {
    expect(
      parseMacro(
        'Select:Start="0" End="1"\nFadeIn:Use_Preset="<Current Settings>"\nSelect:Start="0" End="1" RelativeTo="ProjectEnd"\nFadeOut:\n',
      ),
    ).toEqual([
      { command: 'Select', params: { Start: 0, End: 1 } },
      { command: 'FadeIn', params: {} },
      { command: 'Select', params: { Start: 0, End: 1, RelativeTo: 'ProjectEnd' } },
      { command: 'FadeOut', params: {} },
    ]);
    expect(parseMacro('Amplify:Ratio="0.5" AllowClipping="1"')[0]?.params).toEqual({ Ratio: 0.5, AllowClipping: true });
    expect(parseMacro('SelectTracks:Track=1 TrackCount=2 Mode=Set')[0]?.params).toEqual({
      Track: 1,
      TrackCount: 2,
      Mode: 'Set',
    });
  });
  it.each(
    ['SetTrack', 'SetTrackStatus', 'SetTrackAudio', 'SetTrackVisuals', 'SetClip', 'SetEnvelope'].flatMap((command) =>
      ['Track', 'TrackCount', 'Channel', 'ChannelCount'].map((parameter) => ({ command, parameter })),
    ),
  )('rejects undeclared $command.$parameter scope in saved macros', ({ command, parameter }) => {
    expect(() => parseMacro(`${command}:${parameter}=1`)).toThrow();
  });
  it('translates an export only with a known explicit destination', () => {
    expect(parseMacro('ExportMP3:', 'out.mp3')).toEqual([
      { command: 'Export2', params: { Filename: 'out.mp3', NumChannels: 2 } },
    ]);
    expect(() => parseMacro('ExportMP3:')).toThrow('outputTo');
    expect(() => parseMacro('ExportMP3:', 'out.wav')).toThrow('.mp3');
  });
  it.each([
    'New:',
    'Preferences:',
    'Record1stChoice:',
    'Record2ndChoice:',
    'Drag:',
    'MeasureRms:',
    'Repair:',
    'ClickRemoval:Threshold=200 Width=20',
    'SaveProject2:Filename=x',
    'Amplify:Ratio="bogus"',
    'Amplify:Bogus=1',
    'Amplify:Use_Preset="<Current Settings>"',
    'Undo:Param=1',
    'Amplify:Ratio=1 Ratio=2',
    'No colon',
    '',
  ])('rejects unsafe/incomplete macro %j', (macro) => {
    expect(() => parseMacro(macro)).toThrow();
  });
});
