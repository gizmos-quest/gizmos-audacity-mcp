import { describe, expect, it, vi } from 'vitest';
import { pipeline } from '../../src/tasks/pipeline.js';

vi.mock('../../src/source-rate.js', () => ({ measureSourceRate: vi.fn(async () => 48_000) }));

import { expectNoMutation, mockOps, wave } from '../helpers/task-fixture.js';

describe('pipeline execution', () => {
  it('returns an offline dry-run with no Audacity interaction', async () => {
    const mocks = mockOps();
    const result = await pipeline(mocks.ops, { track: 'unresolved', dryRun: true, preset: 'podcast' });
    expect(result).toMatchObject({ dryRun: true, preset: 'podcast', steps: expect.any(Array) });
    expectNoMutation(mocks);
    expect(mocks.tracks).not.toHaveBeenCalled();
  });

  it('selects only the target extent for each effect', async () => {
    const mocks = mockOps([wave('Other', 0, 30), wave('Voice', 2, 10)]);
    const result = await pipeline(mocks.ops, { track: 'Voice' });
    expect(mocks.select.mock.calls.map(([scope]) => scope)).toEqual(Array(3).fill({ track: 1, start: 2, end: 10 }));
    expect(mocks.command.mock.calls.map(([command]) => command)).toEqual([
      'Normalize',
      'High-passFilter',
      'Compressor',
    ]);
    expect(mocks.command.mock.calls.every(([, , timeout]) => timeout === 600_000)).toBe(true);
    expect(result).toMatchObject({ dryRun: false, applied: expect.any(Array) });
  });

  it('recalculates the default extent after shortening pauses', async () => {
    const mocks = mockOps();
    mocks.command.mockImplementation(async (id) => {
      if (id === 'TruncateSilence') mocks.trackList[0]!.end = 6;
      return 'OK';
    });
    await pipeline(mocks.ops, { track: 0, shortenPauses: { minimum: 1, truncateTo: 0.3 } });
    expect(mocks.select.mock.calls.map(([scope]) => scope.end)).toEqual([10, 10, 10, 6]);
  });

  it.each([
    { start: 1, end: 2.1 },
    { start: 9, end: 11 },
  ])('refuses an out-of-track noise profile before selection %#', async (noiseProfile) => {
    const mocks = mockOps();
    await expect(pipeline(mocks.ops, { track: 0, noiseProfile })).rejects.toThrow('noise profile must be inside');
    expectNoMutation(mocks);
  });

  it('preflights the processing extent before capturing a valid noise profile', async () => {
    const mocks = mockOps();
    await expect(pipeline(mocks.ops, { track: 0, start: 20, noiseProfile: { start: 2, end: 3 } })).rejects.toThrow(
      'nothing to process',
    );
    expectNoMutation(mocks);
  });

  it('stops after the failing step and includes Audacity error text and completed count', async () => {
    const mocks = mockOps();
    mocks.command.mockImplementation(async (id) => {
      if (id === 'High-passFilter') throw new Error('Audacity rejected: requires selected audio');
      return 'OK';
    });
    await expect(pipeline(mocks.ops, { track: 0 })).rejects.toThrow(
      /Remove low-frequency rumble.*1 completed steps.*Audacity rejected: requires selected audio/,
    );
    expect(mocks.command.mock.calls.map(([id]) => id)).toEqual(['Normalize', 'High-passFilter']);
  });

  it('refuses processing a label track before selection', async () => {
    const mocks = mockOps([{ name: 'Labels', kind: 'label', start: 0, end: 4 }]);
    await expect(pipeline(mocks.ops, { track: 0 })).rejects.toThrow('not an audio track');
    expectNoMutation(mocks);
  });
});
