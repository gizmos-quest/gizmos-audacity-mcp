import { describe, expect, it, vi } from 'vitest';
import { catalogueCommand } from '../../src/format.js';
import { generate } from '../../src/tasks.js';

vi.mock('../../src/source-rate.js', () => ({ measureSourceRate: vi.fn(async () => 48_000) }));

import { expectNoMutation, mockOps, wave } from '../helpers/task-fixture.js';

describe('audio generation', () => {
  it('rejects channel overrides on existing tracks before reading or changing Audacity', async () => {
    const mocks = mockOps();
    await expect(generate(mocks.ops, { kind: 'tone', track: 0, channels: 2 })).rejects.toThrow(
      'existing tracks retain their channels',
    );
    expect(mocks.tracks).not.toHaveBeenCalled();
    expect(mocks.trackIndex).not.toHaveBeenCalled();
    expectNoMutation(mocks);
  });
  it.each([
    ['tone', 'Tone', { Frequency: 440, Amplitude: 0.25, Waveform: 'Sine' }],
    ['noise', 'Noise', { Type: 'White', Amplitude: 0.25 }],
    ['silence', 'Silence', {}],
    [
      'chirp',
      'Chirp',
      { StartFreq: 440, EndFreq: 1320, StartAmp: 0.25, EndAmp: 0.1, Interpolation: 'Linear', Waveform: 'Sine' },
    ],
    ['dtmf', 'DtmfTones', { Sequence: '0123456789', 'Duty Cycle': 55, Amplitude: 0.25 }],
    [
      'rhythm',
      'RhythmTrack',
      {
        TEMPO: 120,
        TIMESIG: 4,
        SWING: 0,
        BARS: 0,
        'CLICK-TRACK-DUR': 2.5,
        OFFSET: 0,
        'CLICK-TYPE': 'Metronome',
        HIGH: 84,
        LOW: 80,
      },
    ],
  ])('generates %s with explicit safe catalogue parameters', async (kind, command, params) => {
    const mocks = mockOps();
    await generate(mocks.ops, { kind, track: 'Voice', start: 3, duration: 2.5 });
    expect(mocks.select).toHaveBeenCalledExactlyOnceWith({ track: 0, start: 3, end: 5.5 });
    expect(mocks.command).toHaveBeenCalledExactlyOnceWith(command, params, 600_000);
    expect(mocks.run).not.toHaveBeenCalled();
  });

  it.each([
    [1, 'NewMonoTrack'],
    [2, 'NewStereoTrack'],
  ])('creates a new %i-channel track without opening a project window', async (channels, command) => {
    const mocks = mockOps([wave('Existing')]);
    mocks.run.mockImplementation(async () => {
      mocks.trackList.push(wave('New', 0, 1));
      return 'OK';
    });
    await generate(mocks.ops, { kind: 'tone', channels, name: 'Test tone' });
    expect(mocks.run).toHaveBeenCalledExactlyOnceWith(command);
    expect(mocks.select).toHaveBeenCalledExactlyOnceWith({ track: 1, start: 0, end: 1 });
    expect(mocks.command.mock.calls[1]).toEqual(['SetTrack', { Name: 'Test tone' }]);
  });

  it('uppercases a validated DTMF sequence and formats its spaced parameter', async () => {
    const mocks = mockOps();
    await generate(mocks.ops, { kind: 'dtmf', track: 0, sequence: 'a1b2*#', dutyCycle: 75 });
    const params = mocks.command.mock.calls[0]![1]!;
    expect(catalogueCommand('DtmfTones', params)).toContain('"Duty Cycle"=75');
    expect(params.Sequence).toBe('A1B2*#');
  });

  it('refuses replacing audio on a non-audio track before selection', async () => {
    const mocks = mockOps([{ name: 'Labels', kind: 'label', start: 0, end: 1 }]);
    await expect(generate(mocks.ops, { kind: 'silence', track: 0 })).rejects.toThrow('not an audio track');
    expectNoMutation(mocks);
  });
});
