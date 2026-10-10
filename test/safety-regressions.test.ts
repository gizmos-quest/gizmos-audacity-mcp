import { beforeEach, describe, expect, it, vi } from 'vitest';
import { preflightMacroEffects } from '../src/effects/macros.js';
import { Ops, type TrackInfo } from '../src/ops.js';
import { AudacityPipe } from '../src/pipe.js';
import { trackEdit } from '../src/tasks/editing.js';
import { generate } from '../src/tasks/generate.js';

const rate = vi.hoisted(() => vi.fn());
vi.mock('../src/source-rate.js', () => ({ measureSourceRate: rate }));
beforeEach(() => {
  rate.mockReset().mockResolvedValue(8000);
});

function fixture(tracks: TrackInfo[], end = 1) {
  const calls: string[] = [];
  const ops = new Ops(
    new AudacityPipe({ to: 'fixture.to', from: 'fixture.from' }, 100, async (_paths, command) => {
      calls.push(command);
      const body = command.includes('Type=Tracks')
        ? tracks
        : command.includes('Type=Selection')
          ? { Start: 0, End: end }
          : command.includes('Type=Clips')
            ? tracks.flatMap((t, track) => (t.kind === 'wave' ? [{ track, start: 0, end: 1 }] : []))
            : '';
      return { ok: true, status: 'OK', body: typeof body === 'string' ? body : JSON.stringify(body) };
    }),
  );
  return { ops, calls };
}
const wave = (name: string, selected = 1): TrackInfo => ({ name, kind: 'wave', start: 0, end: 1, selected });
const label: TrackInfo = { name: 'Markers', kind: 'label', start: 0, end: 1, selected: 0 };
const edits = (calls: string[]) => calls.filter((c) => !c.startsWith('GetInfo:'));

describe('shared native safety regressions', () => {
  it.each([
    [wave('Bed'), { ...label, selected: 1 }, wave('Voice', 0)],
    [wave('Bed'), label, wave('Voice', 0)],
    [wave('Bed')],
  ])('refuses unsafe generic AutoDuck topology before native processing %#', async (...tracks) => {
    const state = fixture(tracks);
    await expect(state.ops.command('AutoDuck')).rejects.toThrow('AutoDuck requires');
    expect(edits(state.calls)).toEqual([]);
  });
  it('refuses scoped AutoDuck before changing an unrelated current selection', async () => {
    const state = fixture([wave('Bed', 0), label, wave('Voice')]);
    await expect(state.ops.applyEffect('AutoDuck', {}, { track: 0 })).rejects.toThrow('immediately below');
    expect(edits(state.calls)).toEqual([]);
  });
  it('accepts adjacent unselected audio control for generic AutoDuck', async () => {
    const state = fixture([wave('Bed'), wave('Voice', 0)]);
    await state.ops.command('AutoDuck');
    expect(edits(state.calls)).toEqual(['AutoDuck:']);
  });
  it('rejects macro AutoDuck after unprovable selection changes before any edit', async () => {
    const state = fixture([wave('Bed'), wave('Voice', 0)]);
    await expect(
      preflightMacroEffects(state.ops, [
        { command: 'SelectTracks', params: { Track: 0 } },
        { command: 'AutoDuck', params: {} },
      ]),
    ).rejects.toThrow('selection-dependent');
    expect(edits(state.calls)).toEqual([]);
  });
  it.each(['BeatFinder', 'SampleDataExport'])('refuses a sub-source-frame analyzer %s', async (command) => {
    const state = fixture([wave('Source')], 0.000001);
    await expect(
      state.ops.command(
        command,
        command === 'SampleDataExport' ? { NUMBER: 1, FILENAME: 'samples.txt', MESSAGES: 'None' } : {},
      ),
    ).rejects.toThrow('at least 1 source frames');
    expect(edits(state.calls)).toEqual([]);
  });
  it('uses one source-rate proof for an exact scoped filter', async () => {
    const state = fixture([wave('Target', 0), wave('Distractor')]);
    await state.ops.applyEffect('High-passFilter', { FREQUENCY: 80 }, { track: 0 });
    expect(rate).toHaveBeenCalledOnce();
    expect(edits(state.calls)).toEqual([
      'Select: Mode=Set Track=0 TrackCount=1 Start=0 End=1',
      'High-passFilter: FREQUENCY=80',
    ]);
  });
});

describe('composed encoded command preflight', () => {
  const oversized = '音'.repeat(400);
  it('refuses a later label before creating a track or adding an earlier label', async () => {
    const state = fixture([]);
    await expect(
      state.ops.setLabels([
        { start: 0, text: 'First' },
        { start: 1, text: oversized },
      ]),
    ).rejects.toThrow('encoded bytes');
    expect(state.calls).toEqual([]);
  });
  it.each([
    (ops: Ops) => generate(ops, { kind: 'tone', name: oversized }),
    (ops: Ops) => trackEdit(ops, { action: 'add_mono', name: oversized }),
    (ops: Ops) => ops.importTrack('package.json', oversized),
  ])('refuses oversized generated/imported track metadata before mutation %#', async (action) => {
    const state = fixture([]);
    await expect(action(state.ops)).rejects.toThrow('encoded bytes');
    expect(state.calls).toEqual([]);
  });
});
