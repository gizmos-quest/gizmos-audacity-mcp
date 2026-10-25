import { afterEach, describe, expect, it, vi } from 'vitest';
import { COMMAND_IDS, MENU_IDS } from '../src/catalogue.js';
import { catalogueCommand, formatCommand, parseInfoJson } from '../src/format.js';
import { parseReply } from '../src/pipe.js';

afterEach(() => {
  vi.restoreAllMocks();
});

describe('formatCommand', () => {
  it('writes booleans as 1/0, because Audacity reads "True" as false', () => {
    expect(formatCommand('SetTrack', { Mute: true, Solo: false })).toBe('SetTrack: Mute=1 Solo=0');
  });

  it('quotes values with spaces and skips undefined', () => {
    expect(formatCommand('Import2', { Filename: '/tmp/a b/c.wav', Other: undefined }, 'linux')).toBe(
      'Import2: Filename="/tmp/a b/c.wav"',
    );
  });

  it('refuses quotes and line breaks it cannot escape', () => {
    expect(() => formatCommand('SetLabel', { Text: 'say "hi"' })).toThrow();
    expect(() => formatCommand('SetLabel', { Text: 'a\nb' })).toThrow();
  });

  it('sends Windows file paths with forward slashes so native Unescape keeps \\n folders', () => {
    expect(formatCommand('Import2', { Filename: 'C:\\new\\a b.wav' }, 'win32')).toBe(
      'Import2: Filename="C:/new/a b.wav"',
    );
    expect(formatCommand('SampleDataExport', { FILENAME: '\\\\server\\notes\\x.txt' }, 'win32')).toBe(
      'SampleDataExport: FILENAME=//server/notes/x.txt',
    );
    expect(() => formatCommand('Import2', { Filename: '/tmp/odd\\name.wav' }, 'linux')).toThrow(/parameter parser/);
  });

  it('sends relative file paths as absolute, since Audacity resolves them against its own directory', () => {
    expect(formatCommand('Export2', { Filename: 'mix.wav' }, 'linux')).toMatch(
      /^Export2: Filename="?\/.*\/mix\.wav"?$/,
    );
  });

  it.each([
    ['mix.wav', 'D:/audio/session/mix.wav'],
    ['..\\mix.wav', 'D:/audio/mix.wav'],
    ['\\mix.wav', 'D:/mix.wav'],
    ['D:mix.wav', 'D:/audio/session/mix.wav'],
    ['C:\\new\\mix.wav', 'C:/new/mix.wav'],
    ['\\\\server\\share\\mix.wav', '//server/share/mix.wav'],
  ])('resolves Windows path %j independently of the host filesystem', (Filename, absolute) => {
    vi.spyOn(process, 'cwd').mockReturnValue('D:\\audio\\session');
    expect(formatCommand('Export2', { Filename }, 'win32')).toBe(
      `Export2: Filename=${absolute.includes(':') ? `"${absolute}"` : absolute}`,
    );
  });

  it.each(['a\\nb', 'a\\\\b', 'ends\\'])('refuses text %j that native parsing would change', (Text) => {
    expect(() => formatCommand('SetLabel', { Text }, 'win32')).toThrow(/parameter parser/);
  });

  it('keeps other backslashes in text, which native parsing leaves alone', () => {
    expect(formatCommand('SetTrack', { Name: 'C:\\temp mix' }, 'win32')).toBe('SetTrack: Name="C:\\temp mix"');
  });
});

describe('catalogue', () => {
  it('covers effects and scripting commands and keeps dialog menu items out', () => {
    expect(COMMAND_IDS).toEqual(
      expect.arrayContaining(['Compressor', 'High-passFilter', 'SetEnvelope', 'Export2', 'AutoDuck']),
    );
    expect(MENU_IDS).toEqual(expect.arrayContaining(['Play', 'Stop', 'NewLabelTrack', 'AddLabel']));
    expect(MENU_IDS).not.toContain('Exit');
    expect(MENU_IDS).not.toContain('Open');
  });

  it('validates parameters against the catalogue', () => {
    expect(catalogueCommand('High-passFilter', { FREQUENCY: 80, ROLLOFF: 'dB12' })).toBe(
      'High-passFilter: FREQUENCY=80 ROLLOFF=dB12',
    );
    expect(() => catalogueCommand('High-passFilter', { ROLLOFF: 'dB7' })).toThrow();
    expect(() => catalogueCommand('Amplify', { Bogus: 1 })).toThrow();
    expect(catalogueCommand('SetEnvelope', { Time: 1, Value: 0.5 })).toBe('SetEnvelope: Time=1 Value=0.5');
    expect(() => catalogueCommand('SetEnvelope', { Track: 2, Time: 1, Value: 0.5 })).toThrow();
  });
});

describe('replies', () => {
  it('splits body and status', () => {
    expect(parseReply('line\r\nBatchCommand finished: OK\n')).toEqual({ ok: true, body: 'line', status: 'OK' });
    expect(parseReply('BatchCommand finished: Failed!\n').ok).toBe(false);
  });

  it('reads GetInfo JSON with unescaped Windows paths', () => {
    expect(parseInfoJson('[ { "default":"C:\\Users\\x.wav" } ]')).toEqual([{ default: 'C:\\Users\\x.wav' }]);
  });

  it('decodes native strings where only quotes are escaped', () => {
    // Native output for: UNC path, literal backslash-n text, a quote, a backslash before a quote.
    expect(parseInfoJson(String.raw`[{"a":"\\server\new\t.wav","b":"x\ny","c":"say \"hi\"","d":"x\\"y"}]`)).toEqual([
      { a: String.raw`\\server\new\t.wav`, b: String.raw`x\ny`, c: 'say "hi"', d: String.raw`x\"y` },
    ]);
  });

  it.each(['', 'No readable project information', 'null'])(
    'does not turn missing GetInfo JSON %j into an empty project',
    (body) => {
      expect(() => parseInfoJson(body)).toThrow(/project state is unknown/);
    },
  );
});
