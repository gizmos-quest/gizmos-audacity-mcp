import { describe, expect, it } from 'vitest';
import { formatCommand } from '../../src/format.js';
import { CommandFailed } from '../../src/ops.js';
import { edits, label, project, wave } from '../helpers/project-fixture.js';

describe('export and Audacity failures', () => {
  it('clears label editing through an explicit time/track selection before export', async () => {
    const fixture = project([wave('Voice', 1, 3), label('Cues'), wave('Bed', 0, 5)]);
    await fixture.ops.exportMix('mix.wav', 1);
    expect(edits(fixture.calls)).toEqual([
      'Select: Start=0 End=5 Track=0 TrackCount=3 Mode=Set',
      formatCommand('Export2', { Filename: 'mix.wav', NumChannels: 1 }),
    ]);
    expect(fixture.calls).not.toContain('SelectAll:');
  });

  it('refuses unsupported export formats before reading or changing the project', async () => {
    const fixture = project([wave('Voice')]);
    await expect(fixture.ops.exportMix('mix.aup3')).rejects.toThrow('filename');
    expect(fixture.calls).toEqual([]);
  });

  it.each([{ channels: 0 }, { channels: 3 }, { channels: NaN }, { channels: 2, start: Infinity }])(
    'validates export controls before changing selection %#',
    async ({ channels, start }) => {
      const fixture = project([wave('Voice')]);
      await expect(fixture.ops.exportMix('mix.wav', channels, start)).rejects.toThrow();
      expect(fixture.calls).toEqual([]);
    },
  );

  it('refuses empty exports without changing the selection', async () => {
    const fixture = project([wave('Voice')]);
    await expect(fixture.ops.exportMix('mix.wav', 2, 3, 3)).rejects.toThrow('nothing to export');
    expect(edits(fixture.calls)).toEqual([]);
  });

  it('retains Audacity failure text and stops before export after a failed selection', async () => {
    const fixture = project([wave('Voice')]);
    fixture.fail('Select', 'Selection outside project bounds.');
    await expect(fixture.ops.exportMix('mix.wav')).rejects.toThrow('Selection outside project bounds.');
    expect(fixture.calls.some((command) => command.startsWith('Export2:'))).toBe(false);
  });

  it('reports command, full reply and Audacity error text on effect failure', async () => {
    const fixture = project([wave('Voice')]);
    fixture.fail('Amplify', 'Amplification would cause clipping.');
    let error: unknown;
    try {
      await fixture.ops.applyEffect('Amplify', { Ratio: 4 }, { track: 0 });
    } catch (caught) {
      error = caught;
    }
    expect(error).toBeInstanceOf(CommandFailed);
    expect(error).toMatchObject({
      command: 'Amplify: Ratio=4',
      reply: { body: 'Amplification would cause clipping.', status: 'Failed!', ok: false },
    });
    expect((error as Error).message).toContain('Amplification would cause clipping.');
  });
});

describe('typed import and envelopes', () => {
  // Music Import guards and their restoration are covered in test/ops.import.test.ts.
  const trackEdits = (calls: string[]) => edits(calls).filter((command) => !/Preference:/.test(command));

  it('imports one audio track, names it and moves only its clip to the requested start', async () => {
    const fixture = project([wave('Voice', 0, 2)], [], [{ track: 0, start: 0, end: 2 }]);
    expect(await fixture.ops.importTrack('package.json', 'Music', 1.5)).toEqual({ track: 1, name: 'Music' });
    expect(trackEdits(fixture.calls).slice(1)).toEqual([
      'SelectTracks: Track=1 TrackCount=1 Mode=Set',
      'SetTrack: Name=Music',
      'Select: Track=1 TrackCount=1 Start=0 End=0.001 Mode=Set',
      'SetClip: At=0 Start=1.5',
    ]);
    expect(trackEdits(fixture.calls)[0]).toMatch(/^Import2: Filename="?[^"]*package\.json"?$/);
    expect(fixture.clips).toEqual([
      { track: 0, start: 0, end: 2 },
      { track: 1, start: 1.5, end: 2.5 },
    ]);
  });

  it('keeps the native name and start when neither is requested', async () => {
    const fixture = project([]);
    expect(await fixture.ops.importTrack('package.json')).toEqual({ track: 0, name: 'package' });
    expect(trackEdits(fixture.calls)).toHaveLength(1);
  });

  it.each([
    { name: 'Music', start: 0 },
    { name: undefined, start: 2 },
  ])(
    'refuses an unaddressable imported track before importing when later edits are requested %j',
    async ({ name, start }) => {
      const fixture = project(Array.from({ length: 101 }, (_, i) => wave(`Track ${i}`)));
      await expect(fixture.ops.importTrack('package.json', name, start)).rejects.toThrow();
      expect(edits(fixture.calls)).toEqual([]);
      expect(fixture.tracks).toHaveLength(101);
    },
  );

  it('can name and place an imported track at the maximum catalogue index', async () => {
    const fixture = project(Array.from({ length: 100 }, (_, i) => wave(`Track ${i}`)));
    expect(await fixture.ops.importTrack('package.json', 'Music', 2)).toEqual({ track: 100, name: 'Music' });
    expect(fixture.clips).toContainEqual({ track: 100, start: 2, end: 3 });
  });

  it.each([
    [[], 'import added no track'],
    [[wave('Left', 0, 1), wave('Right', 0, 1)], 'import added 2 tracks'],
    [[label('Notes')], 'did not add an audio track'],
  ])('refuses an import that added %j before naming or moving anything', async (added, error) => {
    const fixture = project([wave('Voice')]);
    fixture.importAs(added);
    await expect(fixture.ops.importTrack('package.json', 'Music', 2)).rejects.toThrow(error);
    expect(trackEdits(fixture.calls)).toEqual([expect.stringMatching(/^Import2: /)]);
    expect(fixture.tracks).toHaveLength(1 + added.length);
  });

  it.each([
    [true, ['SetEnvelope: Delete=1']],
    [false, []],
  ])('writes envelope points over the whole track (replace=%s)', async (replace, cleared) => {
    const fixture = project([wave('Voice', 0, 4), wave('Bed', 0, 10)]);
    const points = [
      { time: 0, value: 1 },
      { time: 2, value: 0.5 },
    ];
    expect(await fixture.ops.setEnvelope('Voice', points, replace)).toBe(2);
    expect(edits(fixture.calls)).toEqual([
      'Select: Track=0 TrackCount=1 Start=0 End=10 Mode=Set',
      ...cleared,
      'SetEnvelope: Time=0 Value=1',
      'SetEnvelope: Time=2 Value=0.5',
    ]);
  });
});
