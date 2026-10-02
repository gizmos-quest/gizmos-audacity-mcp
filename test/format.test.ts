import { describe, expect, it } from 'vitest';
import { catalogueCommand, formatCommand, parseInfoJson } from '../src/format.js';
import { COMMAND_IDS, MENU_IDS } from '../src/catalogue.js';
import { parseReply } from '../src/pipe.js';

describe('formatCommand', () => {
  it('writes booleans as 1/0, because Audacity reads "True" as false', () => {
    expect(formatCommand('SetTrack', { Mute: true, Solo: false })).toBe('SetTrack: Mute=1 Solo=0');
  });

  it('quotes values with spaces and skips undefined', () => {
    expect(formatCommand('Import2', { Filename: 'C:\\a b\\c.wav', Other: undefined })).toBe('Import2: Filename="C:\\a b\\c.wav"');
  });

  it('refuses quotes and line breaks it cannot escape', () => {
    expect(() => formatCommand('SetLabel', { Text: 'say "hi"' })).toThrow();
    expect(() => formatCommand('SetLabel', { Text: 'a\nb' })).toThrow();
  });
});

describe('catalogue', () => {
  it('covers effects and scripting commands and keeps dialog menu items out', () => {
    expect(COMMAND_IDS).toEqual(expect.arrayContaining(['Compressor', 'High-passFilter', 'SetEnvelope', 'Export2', 'AutoDuck']));
    expect(MENU_IDS).toEqual(expect.arrayContaining(['Play', 'Stop', 'NewLabelTrack', 'AddLabel']));
    expect(MENU_IDS).not.toContain('Exit');
    expect(MENU_IDS).not.toContain('Open');
  });

  it('validates parameters against the catalogue', () => {
    expect(catalogueCommand('High-passFilter', { FREQUENCY: 80, ROLLOFF: 'dB12' })).toBe('High-passFilter: FREQUENCY=80 ROLLOFF=dB12');
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
});
