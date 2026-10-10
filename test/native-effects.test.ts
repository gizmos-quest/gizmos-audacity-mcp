import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { COMMAND_IDS, MENU_IDS } from '../src/catalogue.js';
import { paulstretchBuffer } from '../src/effects/native.js';
import { Ops, preflightCommand, type TrackInfo } from '../src/ops.js';
import { AudacityPipe } from '../src/pipe.js';

const mocks = vi.hoisted(() => ({ measureSourceRate: vi.fn() }));
vi.mock('../src/source-rate.js', () => ({ measureSourceRate: mocks.measureSourceRate }));

function fixture(rates: number[], selection = { Start: 0, End: 1 }, history = { Undo: 'Undo', Redo: 'Redo' }) {
  const tracks: TrackInfo[] = rates.map((_, i) => ({
    name: `Audio ${i}`,
    kind: 'wave',
    start: 0,
    end: 4,
    selected: 1,
  }));
  const calls: string[] = [];
  const ops = new Ops(
    new AudacityPipe({ to: 'fixture.to', from: 'fixture.from' }, 100, async (_paths, command) => {
      calls.push(command);
      const menus = Object.entries(history).map(([id, label]) => ({ id, label }));
      const body = command.includes('Type=Tracks')
        ? JSON.stringify(tracks)
        : command.includes('Type=Selection')
          ? JSON.stringify(selection)
          : command.includes('Type=Menus')
            ? JSON.stringify(menus)
            : '';
      return { ok: true, status: 'OK', body };
    }),
  );
  mocks.measureSourceRate.mockImplementation(async (_ops: Ops, scope: { track: number }) => rates[scope.track]);
  return { ops, tracks, calls, edits: () => calls.filter((call) => !call.startsWith('GetInfo:')) };
}
beforeEach(() => {
  mocks.measureSourceRate.mockReset();
});

describe('built-in effects with selection- and rate-dependent dialogs', () => {
  it('computes the Paulstretch buffer the way PaulstretchBase::GetBufferSize does', () => {
    expect(paulstretchBuffer(48_000, 0.25)).toBe(8192);
    expect(paulstretchBuffer(8000, 0.001)).toBe(128);
    expect(paulstretchBuffer(48_000, 3.4e38)).toBe(0);
  });

  it('refuses Paulstretch when a track holds less than two buffers of selected source audio', async () => {
    const short = fixture([48_000], { Start: 0, End: 0.3 });
    await expect(short.ops.command('Paulstretch', { 'Time Resolution': 0.25 })).rejects.toThrow('Time Resolution');
    expect(short.edits()).toEqual([]);
    const long = fixture([48_000], { Start: 0, End: 0.35 });
    await long.ops.command('Paulstretch', { 'Time Resolution': 0.25 });
    expect(long.edits()).toEqual(['Paulstretch: "Time Resolution"=0.25']);
  });

  it('refuses an Echo delay longer than the selection, which only enlarges the native buffer', async () => {
    const state = fixture([48_000], { Start: 0, End: 1 });
    await expect(state.ops.command('Echo', { Delay: 1.5 })).rejects.toThrow('Echo Delay');
    await state.ops.command('Echo', { Delay: 0.5 });
    expect(state.edits()).toEqual(['Echo: Delay=0.5']);
  });

  it('needs at least one truncated Echo history sample per source rate and bounds the buffer', async () => {
    const low = fixture([48_000, 800]);
    // 800 Hz x float(0.001) truncates to zero samples, which EchoBase writes out of bounds.
    await expect(low.ops.command('Echo', { Delay: Math.fround(0.001) })).rejects.toThrow('0 samples on track 1');
    await low.ops.command('Echo', { Delay: 0.00125 });
    expect(low.edits()).toEqual(['Echo: Delay=0.00125']);
    const long = fixture([48_000], { Start: 0, End: 600 });
    long.tracks[0]!.end = 600;
    await expect(long.ops.command('Echo', { Delay: 400 })).rejects.toThrow('19200000 samples');
    await long.ops.command('Echo', { Delay: 300 });
    expect(long.edits()).toEqual(['Echo: Delay=300']);
  });

  it('allows independent TruncateSilence on one selected audio track only', async () => {
    const two = fixture([48_000, 48_000]);
    await expect(two.ops.command('TruncateSilence', { Independent: true })).rejects.toThrow('one selected');
    await two.ops.command('TruncateSilence', { Independent: false });
    const one = fixture([48_000]);
    await one.ops.command('TruncateSilence', { Independent: true });
    expect([...two.edits(), ...one.edits()]).toEqual([
      'TruncateSilence: Independent=0',
      'TruncateSilence: Independent=1',
    ]);
  });

  it.each(['FilterCurve', 'GraphicEq', 'ClassicFilters'])(
    'refuses %s across tracks of different source rates',
    async (id) => {
      const mixed = fixture([48_000, 8000]);
      await expect(mixed.ops.command(id)).rejects.toThrow('one source sample rate');
      expect(mixed.edits()).toEqual([]);
      const same = fixture([44_100, 44_100]);
      await same.ops.command(id);
      expect(same.edits()).toEqual([`${id}:`]);
    },
  );

  it('checks equalization rates on one track but leaves a single Classic Filters track alone', async () => {
    const low = fixture([40]);
    await expect(low.ops.command('FilterCurve')).rejects.toThrow('above 40 Hz');
    const classic = fixture([40]);
    await classic.ops.command('ClassicFilters');
    expect(classic.edits()).toEqual(['ClassicFilters:']);
    expect(mocks.measureSourceRate).toHaveBeenCalledOnce();
  });

  it('refuses a typed effect on an empty range or a time track before selecting', async () => {
    const state = fixture([48_000]);
    await expect(state.ops.applyEffect('Amplify', { Ratio: 2 }, { track: 0, start: 1, end: 1 })).rejects.toThrow(
      'non-empty time selection',
    );
    state.tracks[0]!.kind = 'time';
    await expect(state.ops.applyEffect('Amplify', { Ratio: 2 }, { track: 0 })).rejects.toThrow('audio or label track');
    expect(state.edits()).toEqual([]);
  });
});

describe('menu and command reservations from the source audit', () => {
  it('runs Undo and Redo only while the native menu names a history step', async () => {
    const empty = fixture([48_000]);
    await expect(empty.ops.run('Undo')).rejects.toThrow('nothing to undo');
    await expect(empty.ops.run('Redo')).rejects.toThrow('nothing to redo');
    expect(empty.edits()).toEqual([]);
    const edited = fixture([48_000], undefined, { Undo: 'Undo Split Delete', Redo: 'Redo Split Delete' });
    await edited.ops.run('Undo');
    await edited.ops.run('Redo');
    expect(edited.edits()).toEqual(['Undo:', 'Redo:']);
  });

  it('refuses a second time track, which would replace the timing of the first', async () => {
    const state = fixture([48_000]);
    await state.ops.run('NewTimeTrack');
    state.tracks.unshift({ name: 'Time Track', kind: 'time', start: 0, end: 0, selected: 0 });
    await expect(state.ops.run('NewTimeTrack')).rejects.toThrow('already has a time track');
    expect(state.edits()).toEqual(['NewTimeTrack:']);
  });

  it('refuses typed imports of project and list files before any pipe exchange', async () => {
    const directory = mkdtempSync(join(tmpdir(), 'audit-typed-import-'));
    try {
      const project = join(directory, 'old.aup3');
      writeFileSync(project, '');
      const state = fixture([48_000]);
      await expect(state.ops.importTrack(project, 'Old')).rejects.toThrow('imports audio');
      expect(state.calls).toEqual([]);
    } finally {
      rmSync(directory, { recursive: true, force: true });
    }
  });

  it('keeps clipboard, stretched-clip and device menus and DTMF out of the safe surface', () => {
    for (const id of ['Paste', 'ZeroCross', 'RescanDevices']) expect(MENU_IDS).not.toContain(id);
    expect(COMMAND_IDS).not.toContain('DtmfTones');
  });

  it('refuses project and list imports and unbounded FindClipping buffers before I/O', () => {
    const directory = mkdtempSync(join(tmpdir(), 'audit-import-'));
    try {
      for (const name of ['old.aup3', 'old.aup', 'files.lof']) {
        const file = join(directory, name);
        writeFileSync(file, '');
        expect(() => preflightCommand('Import2', { Filename: file })).toThrow('imports audio');
      }
    } finally {
      rmSync(directory, { recursive: true, force: true });
    }
    expect(() => preflightCommand('FindClipping', { 'Duty Cycle Start': 16_778 })).toThrow('Duty Cycle Start');
    expect(preflightCommand('FindClipping', { 'Duty Cycle Start': 16_777 })).toBe(
      'FindClipping: "Duty Cycle Start"=16777',
    );
  });
});
