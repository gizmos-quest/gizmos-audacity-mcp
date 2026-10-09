import { access, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { dirname, resolve, sep } from 'node:path';
import { describe, expect, it } from 'vitest';
import type { TrackInfo } from '../src/ops.js';
import { AudacityTimeout } from '../src/pipe.js';
import { parseSampleDataRate } from '../src/source-rate.js';

describe('source sample rate header', () => {
  it.each([1, 8000, 44_100, 48_000, 768_000])('reads the native English %i Hz header', (rate) => {
    expect(
      parseSampleDataRate(
        `C:\\scratch\\samples.txt   1 channel (mono)\r\nSample Rate: ${rate} Hz. Sample values on linear scale.\r\nLength processed: 1 samples 0.0001 seconds.\r\n\r\n0.00000\r\n`,
      ),
    ).toBe(rate);
  });
  it('reads the stereo header with channel order preceding the rate', () => {
    expect(
      parseSampleDataRate(
        'samples.txt   2 channels (stereo)\nLeft channel then Right channel on same line.\nSample Rate: 8000 Hz. Sample values on linear scale.\n',
      ),
    ).toBe(8000);
  });
  it.each([
    '',
    'rate=48000',
    'prefix Sample Rate: 48000 Hz.',
    'Sample Rate: 48000.5 Hz.',
    'Sample Rate: 4.8e4 Hz.',
    'Sample Rate: -8000 Hz.',
    'Sample Rate: NaN Hz.',
    'Sample Rate: Infinity Hz.',
    'Sample Rate: 0 Hz.',
    'Sample Rate: 768001 Hz.',
    'Sample Rate: 99999999999999999999999999 Hz.',
    'Sample Rate: 48000 Hz.\nSample Rate: 8000 Hz.',
  ])('refuses absent, ambiguous or invalid rate %j', (header) => {
    expect(() => parseSampleDataRate(header)).toThrow();
  });
  it('bounds the header before parsing', () => {
    expect(() => parseSampleDataRate(`${'x'.repeat(4096)}\nSample Rate: 48000 Hz.`)).toThrow();
  });
});

import { fixture } from './helpers/source-fixture.js';

describe('source frame measurement', () => {
  it.each([8000, 44_100, 48_000])(
    'exposes the exact %i Hz source rate with the same silent query and restoration',
    async (rate) => {
      const project = fixture({ rate });
      const previous = project.tracks.map((track) => ({ ...track }));
      expect(await project.rate()).toBe(rate);
      expect(project.calls[1]?.command).toBe('SampleDataExport');
      expect(project.calls.at(-1)?.command).toBe('SelectTime');
      expect(project.tracks).toEqual(previous);
      expect(project.selection()).toEqual({ Start: 2, End: 4 });
      await expect(access(project.files[0]!)).rejects.toMatchObject({ code: 'ENOENT' });
    },
  );
  it.each(['export', 'restore'])(
    'retains in-flight scratch after an uncertain %s outcome and preserves the error class',
    async (failure) => {
      const error = new AudacityTimeout('native reply lost');
      const project = fixture(
        failure === 'export'
          ? { exportError: error, recoveryOnExport: true }
          : { focusError: error, recoveryOnRestore: true },
      );
      await expect(project.measure()).rejects.toBe(error);
      expect(error.message).toContain('scratch retained for inspection after audacity_recover');
      if (failure === 'export')
        expect(project.calls.map((call) => call.command)).toEqual(['select', 'SampleDataExport']);
      else expect(project.calls.at(-1)?.command).toBe('SetTrackStatus');
      const scratch = resolve(dirname(project.files[0]!));
      expect(scratch.startsWith(resolve(tmpdir()) + sep)).toBe(true);
      expect(scratch).toContain('gizmos-audacity-source-rate-');
      await access(scratch);
      await rm(scratch, { recursive: true, force: true });
    },
  );
  it('counts source frames rather than a higher-rate rendered WAV and restores sparse audio/label selection', async () => {
    const project = fixture({ rate: 8000 });
    const previous = project.tracks.map((track) => ({ ...track }));
    expect(await project.measure()).toBe(800); // A 48 kHz render would contain 4800 frames.
    expect(project.calls[0]).toEqual({ command: 'select', params: { track: 0, start: 0, end: 10 } });
    expect(project.calls[1]).toEqual({
      command: 'SampleDataExport',
      params: {
        NUMBER: 1,
        UNITS: 'Linear',
        FILENAME: project.files[0],
        FILEFORMAT: 'None',
        HEADER: 'Standard',
        OPTEXT: '',
        'CHANNEL-LAYOUT': 'SameLine',
        MESSAGES: 'None',
      },
    });
    expect(project.calls.slice(2)).toEqual([
      { command: 'SelectTracks', params: { Track: 1, TrackCount: 1, Mode: 'Set' } },
      { command: 'SetTrackStatus', params: { Focused: true } },
      { command: 'SelectNone' },
      { command: 'SelectTracks', params: { Track: 1, TrackCount: 1, Mode: 'Add' } },
      { command: 'SelectTracks', params: { Track: 2, TrackCount: 1, Mode: 'Add' } },
      { command: 'SelectTime', params: { Start: 2, End: 4, RelativeTo: 'ProjectStart' } },
    ]);
    expect(project.tracks).toEqual(previous);
    expect(project.selection()).toEqual({ Start: 2, End: 4 });
    expect(project.setterSelections).toEqual([[1]]);
    await expect(access(project.files[0]!)).rejects.toMatchObject({ code: 'ENOENT' });
  });
  it.each([
    { rate: 8000, end: 0.512, frames: 4096 },
    { rate: 48_000, end: 0.1, frames: 4800 },
  ])('measures exactly $frames source frames at $rate Hz', async ({ rate, end, frames }) => {
    const project = fixture({ rate });
    expect(await project.measure({ track: 0, start: 0, end })).toBe(frames);
  });
  it('queries a full low-rate track but reports zero samples for a sub-sample requested interval', async () => {
    const project = fixture({ rate: 1 });
    expect(await project.measure()).toBe(0);
    expect(project.ops.select).toHaveBeenCalledWith({ track: 0, start: 0, end: 10 });
  });
  it('restores an original selection with no selected tracks', async () => {
    const project = fixture({ tracks: [{ name: 'Source', kind: 'wave', start: 1, end: 3, selected: 0 }] });
    await project.measure({ track: 0, start: 1, end: 1.1 });
    expect(project.calls.slice(2)).toEqual([
      { command: 'SelectTracks', params: { Track: 0, TrackCount: 1, Mode: 'Set' } },
      { command: 'SetTrackStatus', params: { Focused: false } },
      { command: 'SelectNone' },
      { command: 'SelectTime', params: { Start: 2, End: 4, RelativeTo: 'ProjectStart' } },
    ]);
  });
  it.each([
    { name: 'focused unselected audio', focused: 1, selected: [2] },
    { name: 'focused unselected label', focused: 2, selected: [1] },
    { name: 'focused source remains unselected', focused: 0, selected: [1, 2] },
    { name: 'focus without any selected track', focused: 2, selected: [] },
    { name: 'originally unfocused project', focused: -1, selected: [1, 2] },
  ])('restores $name after SampleDataExport changes focus to the source', async ({ focused, selected }) => {
    const tracks: TrackInfo[] = ['wave', 'wave', 'label'].map((kind, index) => ({
      name: `Track ${index}`,
      kind,
      start: 0,
      end: 10,
      selected: Number(selected.includes(index)),
      focused: Number(index === focused),
    }));
    const project = fixture({ tracks });
    await project.measure();
    expect(project.tracks).toEqual(tracks);
    expect(project.selection()).toEqual({ Start: 2, End: 4 });
    // Focus restoration targets just one track before restoring unrelated
    // sparse selection; SetTrackStatus takes no unlisted Track scope keys.
    expect(project.setterSelections).toEqual([[focused >= 0 ? focused : 0]]);
    expect(project.calls.find((call) => call.command === 'SetTrackStatus')?.params).toEqual({ Focused: focused >= 0 });
    const focusCall = project.calls.findIndex((call) => call.command === 'SetTrackStatus');
    const deselectCall = project.calls.findIndex((call) => call.command === 'SelectNone');
    expect(focusCall).toBeLessThan(deselectCall);
  });
  it.each([
    { exportError: new Error('Native source export failed.'), message: 'Native source export failed.' },
    { header: 'The source rate is missing.', message: 'unambiguous source sample rate' },
  ])('restores original focus along with selection when the query fails: $message', async (options) => {
    const project = fixture(options);
    const previous = project.tracks.map((track) => ({ ...track }));
    await expect(project.measure()).rejects.toThrow(options.message);
    expect(project.tracks).toEqual(previous);
    expect(project.selection()).toEqual({ Start: 2, End: 4 });
    await expect(access(project.files[0]!)).rejects.toMatchObject({ code: 'ENOENT' });
  });
  it('reports both query and focus-restoration errors and removes scratch', async () => {
    const project = fixture({
      exportError: new Error('Native source export failed.'),
      focusError: new Error('Native focus setter failed.'),
    });
    await expect(project.measure()).rejects.toThrow(
      'Native source export failed.. Selection restoration also failed: Native focus setter failed.',
    );
    await expect(access(project.files[0]!)).rejects.toMatchObject({ code: 'ENOENT' });
  });
  it('reports focus-restoration failure after a successful query and removes scratch', async () => {
    const project = fixture({ focusError: new Error('Native focus setter failed.') });
    await expect(project.measure()).rejects.toThrow('Native focus setter failed.');
    await expect(access(project.files[0]!)).rejects.toMatchObject({ code: 'ENOENT' });
  });
  it.each([
    { start: 0, end: 0 },
    { start: 0, end: NaN },
    { start: -1, end: 10 },
  ])('rejects an empty or invalid native track extent before selection: %j', async (extent) => {
    const project = fixture({ tracks: [{ name: 'Invalid native track', kind: 'wave', ...extent }] });
    await expect(project.measure()).rejects.toThrow('inside one audio track');
    expect(project.calls).toEqual([]);
    expect(project.ops.info).not.toHaveBeenCalled();
  });
  it.each([
    { track: 0, start: 0, end: 0 },
    { track: 0, start: 1, end: 0 },
    { track: -1, start: 0, end: 1 },
    { track: 0.5, start: 0, end: 1 },
    { track: 0, start: NaN, end: 1 },
    { track: 0, start: 0, end: Infinity },
    { track: 0, start: 0, end: 86_401 },
    { track: 0, start: 0, end: 1, typo: 1 },
  ])('validates both frame and rate scope before Ops access: %j', async (scope) => {
    const project = fixture();
    await expect(project.measure(scope)).rejects.toThrow();
    await expect(project.rate(scope)).rejects.toThrow();
    expect(project.ops.tracks).not.toHaveBeenCalled();
    expect(project.calls).toEqual([]);
  });
  it.each([
    { track: 3, start: 0, end: 1 },
    { track: 2, start: 0, end: 1 },
    { track: 0, start: 0, end: 11 },
  ])('refuses unavailable/non-audio/out-of-track scope %j before mutation', async (scope) => {
    const project = fixture();
    await expect(project.measure(scope)).rejects.toThrow('inside one audio track');
    expect(project.calls).toEqual([]);
    expect(project.ops.info).not.toHaveBeenCalled();
  });
  it.each([
    { header: '', message: 'non-empty regular file' },
    { header: 'x'.repeat(65_537), message: '65536 bytes' },
    { header: `${'x'.repeat(4096)}\nSample Rate: 8000 Hz.\n`, message: 'unambiguous source sample rate' },
    { header: 'Sample Rate: 0 Hz.\n', message: 'integer from 1' },
    { missingFile: true, message: 'ENOENT' },
  ])('restores selection and cleans scratch when export output is unusable: $message', async (options) => {
    const project = fixture(options);
    await expect(project.measure()).rejects.toThrow(options.message);
    expect(project.calls.at(-1)?.command).toBe('SelectTime');
    await expect(access(project.files[0]!)).rejects.toMatchObject({ code: 'ENOENT' });
  });
  it('keeps native export error text while restoring selection and deleting scratch', async () => {
    const project = fixture({ exportError: new Error('The native sample export failed verbatim.') });
    await expect(project.measure()).rejects.toThrow('The native sample export failed verbatim.');
    expect(project.calls.at(-1)?.command).toBe('SelectTime');
    await expect(access(project.files[0]!)).rejects.toMatchObject({ code: 'ENOENT' });
  });
  it('reports both export and restoration errors without retaining its output file', async () => {
    const project = fixture({
      exportError: new Error('Native export failed.'),
      restoreError: new Error('Native restore failed.'),
    });
    await expect(project.measure()).rejects.toThrow(
      'Native export failed.. Selection restoration also failed: Native restore failed.',
    );
    await expect(access(project.files[0]!)).rejects.toMatchObject({ code: 'ENOENT' });
  });
  it('reports restoration failure after successful output and still cleans scratch', async () => {
    const project = fixture({ restoreError: new Error('Native restore failed.') });
    await expect(project.measure()).rejects.toThrow('Native restore failed.');
    await expect(access(project.files[0]!)).rejects.toMatchObject({ code: 'ENOENT' });
  });
});
