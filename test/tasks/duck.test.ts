import { describe, expect, it, vi } from 'vitest';
import { AutoDuckSchema, autoDuck } from '../../src/tasks/duck.js';

vi.mock('../../src/source-rate.js', () => ({ measureSourceRate: vi.fn(async () => 48_000) }));

import { expectNoMutation, mockOps, wave } from '../helpers/task-fixture.js';

describe('Auto Duck control-track semantics', () => {
  it('documents track order and native control units without changing defaults', () => {
    const { shape } = AutoDuckSchema;
    expect(shape.bed.description).toContain('must immediately precede the voice track');
    expect(shape.voice.description).toContain('must immediately follow the bed track');
    for (const field of ['duckDb', 'thresholdDb'] as const) expect(shape[field].description).toContain('in dB');
    for (const field of ['fadeDown', 'fadeUp', 'innerFadeDown', 'innerFadeUp', 'maximumPause'] as const)
      expect(shape[field].description).toContain('in seconds');
    expect(AutoDuckSchema.parse({ bed: 'Bed', voice: 'Voice' })).toEqual({
      bed: 'Bed',
      voice: 'Voice',
      duckDb: -12,
      thresholdDb: -30,
      fadeDown: 0.5,
      fadeUp: 0.5,
      innerFadeDown: 0,
      innerFadeUp: 0,
      maximumPause: 1,
      dryRun: false,
    });
  });

  it('gives supported next steps when the voice was imported before the bed', async () => {
    const mocks = mockOps([wave('Voice'), wave('Bed')]);
    await expect(autoDuck(mocks.ops, { bed: 'Bed', voice: 'Voice', dryRun: true })).rejects.toThrow(
      'use audacity_fresh with backupTo and import the bed before the voice for a new mix, or use audacity_envelope_set for editable ducking in the existing track order',
    );
    expectNoMutation(mocks);
  });

  it('selects only the bed and leaves the following voice unselected', async () => {
    const mocks = mockOps([wave('Bed', 0, 20), wave('Voice', 2, 10)]);
    const result = await autoDuck(mocks.ops, { bed: 'Bed', voice: 'Voice', start: 2, end: 10, duckDb: -9 });
    expect(mocks.select).toHaveBeenCalledExactlyOnceWith({ track: 0, start: 2, end: 10 });
    expect(mocks.command).toHaveBeenCalledExactlyOnceWith(
      'AutoDuck',
      {
        DuckAmountDb: -9,
        ThresholdDb: -30,
        OuterFadeDownLen: 0.5,
        OuterFadeUpLen: 0.5,
        InnerFadeDownLen: 0,
        InnerFadeUpLen: 0,
        MaximumPause: 1,
      },
      600_000,
    );
    expect(result).toMatchObject({ dryRun: false, bed: 0, voice: 1 });
  });

  it('refuses an intervening label before selecting the bed', async () => {
    const mocks = mockOps([wave('Bed'), { name: 'Labels', kind: 'label', start: 0, end: 5 }, wave('Voice')]);
    await expect(autoDuck(mocks.ops, { bed: 0, voice: 2 })).rejects.toThrow('immediately following audio track');
    expectNoMutation(mocks);
  });

  it.each([
    [0, 0],
    [0, 2],
    [1, 0],
  ])('refuses a non-adjacent control track before selection (bed=%i voice=%i)', async (bed, voice) => {
    const mocks = mockOps([wave('Bed'), wave('Other'), wave('Voice')]);
    await expect(autoDuck(mocks.ops, { bed, voice })).rejects.toThrow(
      'immediately following audio track below the bed',
    );
    expectNoMutation(mocks);
  });

  it('previews validated ducking parameters and resolved scope without selecting', async () => {
    const mocks = mockOps([wave('Bed', 0, 20), wave('Voice')]);
    const result = await autoDuck(mocks.ops, { bed: 0, voice: 1, dryRun: true, fadeDown: 0.2, innerFadeUp: 0.1 });
    expect(result).toMatchObject({
      dryRun: true,
      command: 'AutoDuck',
      scope: { track: 0, start: 0, end: 20 },
      voice: 1,
      params: { OuterFadeDownLen: 0.2, InnerFadeUpLen: 0.1 },
    });
    expectNoMutation(mocks);
  });
});
