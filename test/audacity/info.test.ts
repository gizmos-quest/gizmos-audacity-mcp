import { describe, expect, it } from 'vitest';
import { clipsInfo, labelsInfo, menusInfo, selectionTimes, tracksInfo } from '../../src/audacity/info.js';
import { parseInfoJson } from '../../src/format.js';
import { parseReply } from '../../src/pipe.js';
import { wire } from '../helpers/replay-pipe.js';

/** The JSON body of a reply recorded from Audacity 3.7.8. */
const recorded = (capture: string) => parseInfoJson(parseReply(wire(capture).toString('utf8')).body);

describe('GetInfo readers', () => {
  it('accepts recorded 3.7.8 Tracks and Clips replies and keeps their field order', () => {
    const tracks = tracksInfo(recorded('11-audio-tracks'));
    expect(tracks[0]).toMatchObject({ name: 'Fixture café 音', kind: 'wave', start: 0, end: 0.5, volume: 1 });
    expect(Object.keys(tracks[0]!).slice(0, 4)).toEqual(['name', 'focused', 'selected', 'kind']);
    expect(tracksInfo(recorded('01-empty-tracks'))).toEqual([]);
    expect(clipsInfo(recorded('12-clips'))).toEqual([{ track: 0, start: 0, end: 0.5, color: 0, name: 'Audio 1.1' }]);
  });
  it('accepts label and time tracks without an extent, as GetInfoCommand sends them', () => {
    expect(tracksInfo([{ name: 'Labels', focused: 0, selected: 0, kind: 'label' }])).toHaveLength(1);
    expect(tracksInfo([{ name: 'Time', focused: 0, selected: 0, kind: 'time' }])).toHaveLength(1);
  });
  it.each([
    [{}],
    [[{ kind: 'wave', start: 0, end: 1 }]],
    [[{ name: 'Voice', kind: 'wave' }]],
    [[{ name: 'Voice', kind: 'wave', start: '0', end: 1 }]],
  ])('refuses unexpected Tracks %j with the GetInfo type named', (value) => {
    expect(() => tracksInfo(value)).toThrow(/GetInfo Tracks has an unexpected shape/);
  });
  it('reads labels as track index plus [start, end, text] tuples', () => {
    expect(labelsInfo([[1, [[0, 1.5, 'Intro']]]])).toEqual([[1, [[0, 1.5, 'Intro']]]]);
    expect(() => labelsInfo([[1, [[0, 'end', 'Intro']]]])).toThrow(/GetInfo Labels/);
    expect(() => clipsInfo([{ track: -1, start: 0, end: 1 }])).toThrow(/GetInfo Clips/);
  });
  it('reads menu items with or without a scripting id', () => {
    const menus = [
      { depth: 0, flags: 1, label: 'Edit', accel: '' },
      { depth: 1, flags: 0, label: 'Undo Split', accel: 'Ctrl+Z', id: 'Undo' },
    ];
    expect(menusInfo(menus)).toBe(menus);
    expect(() => menusInfo([{ id: 'Undo' }])).toThrow(/GetInfo Menus/);
  });
  it('reads selection objects and Audacity casing variants', () => {
    expect(selectionTimes([{ start: 0.2, end: 1.2 }])).toEqual({ start: 0.2, end: 1.2 });
    expect(selectionTimes({ Start: 0.2, End: 1.2 })).toEqual({ start: 0.2, end: 1.2 });
  });
  it.each([
    null,
    [],
    {},
    { start: '0', end: 1 },
    { start: -1, end: 1 },
    { start: 2, end: 1 },
    { start: 0, end: Infinity },
  ])('refuses unreadable selection %j', (selection) => {
    expect(() => selectionTimes(selection)).toThrow();
  });
});
