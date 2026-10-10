import { describe, expect, it, vi } from 'vitest';
import { fade } from '../../src/tasks/editing.js';

vi.mock('../../src/source-rate.js', () => ({ measureSourceRate: vi.fn(async () => 48_000) }));

import { expectNoMutation, mockOps, wave } from '../helpers/task-fixture.js';

describe('fades', () => {
  it.each([
    ['in', 'FadeIn'],
    ['out', 'FadeOut'],
  ])('applies fade %s to the track extent', async (direction, command) => {
    const mocks = mockOps();
    expect(await fade(mocks.ops, { direction, track: 'Voice' })).toEqual({ track: 0, start: 2, end: 10, direction });
    expect(mocks.select).toHaveBeenCalledExactlyOnceWith({ track: 0, start: 2, end: 10 });
    expect(mocks.command).toHaveBeenCalledExactlyOnceWith(command, {}, 600_000);
  });

  it('honors a supplied fade region without selecting adjacent audio', async () => {
    const mocks = mockOps();
    await fade(mocks.ops, { direction: 'out', track: 0, start: 9, end: 10 });
    expect(mocks.select).toHaveBeenCalledExactlyOnceWith({ track: 0, start: 9, end: 10 });
  });

  it('refuses an empty target before selection', async () => {
    const mocks = mockOps([wave('Empty', 0, 0)]);
    await expect(fade(mocks.ops, { direction: 'in', track: 0 })).rejects.toThrow('nothing to process');
    expectNoMutation(mocks);
  });
});
