import { describe, expect, it, vi } from 'vitest';
import { registerPreferenceTool, safePreference } from '../../src/controls/preferences.js';
import type { Ops } from '../../src/ops.js';
import { toolRecorder } from '../helpers/tool-recorder.js';

function fixture() {
  const values = new Map([
    ['/SamplingRate/DefaultProjectSampleRate', '44100'],
    ['/AudioIO/RecordChannels', '1'],
  ]);
  const ops = {
    info: vi.fn(async (type: string) => ({ type })),
    command: vi.fn(async (_command: string, params: { Name: string }) => values.get(params.Name) ?? ''),
    run: vi.fn(async (command: string, params?: { Name: string; Value: string }) => {
      if (command === 'SetPreference' && params) values.set(params.Name, params.Value);
      return '';
    }),
  };
  const tools = toolRecorder();
  registerPreferenceTool(tools.register, ops as unknown as Ops);
  return { ops, call: tools.call };
}

describe('restricted preference writes', () => {
  it('restricts preferences to numeric supported sample rates and one/two record channels', () => {
    expect(safePreference('/SamplingRate/DefaultProjectSampleRate', 48000)).toBe('48000');
    expect(safePreference('/AudioIO/RecordChannels', 1)).toBe('1');
    expect(() => safePreference('/Module/mod-script-pipe', 0)).toThrow('writable');
    expect(() => safePreference('/SamplingRate/DefaultProjectSampleRate', '48000')).toThrow();
    expect(() => safePreference('/AudioIO/RecordChannels', 32)).toThrow();
  });
  it('lists and reads preferences, then returns original and readback for a supported write', async () => {
    const state = fixture();
    expect(await state.call('audacity_preferences', { action: 'list' })).toEqual({ type: 'Preferences' });
    expect(await state.call('audacity_preferences', { action: 'get', name: '/AudioIO/RecordChannels' })).toEqual({
      name: '/AudioIO/RecordChannels',
      value: '1',
    });
    expect(
      await state.call('audacity_preferences', { action: 'set', name: '/AudioIO/RecordChannels', value: 2 }),
    ).toEqual({ name: '/AudioIO/RecordChannels', before: '1', value: '2' });
    expect(state.ops.run).toHaveBeenCalledWith('SetPreference', {
      Name: '/AudioIO/RecordChannels',
      Value: '2',
      Reload: false,
    });
  });
  it.each([
    { action: 'list', name: 'unused' },
    { action: 'list', value: 1 },
    { action: 'get' },
    { action: 'get', name: '/AudioIO/RecordChannels', value: 1 },
    { action: 'set', name: '/AudioIO/RecordChannels' },
    { action: 'set', name: '/Module/mod-script-pipe', value: 1 },
  ])('rejects unsupported or ignored preference fields before mutation %#', async (args) => {
    const state = fixture();
    await expect(state.call('audacity_preferences', args)).rejects.toThrow();
    expect(state.ops.run).not.toHaveBeenCalled();
    expect(state.ops.command).not.toHaveBeenCalled();
  });
});
