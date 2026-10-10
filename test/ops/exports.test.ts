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
