import { z } from 'zod';
import { SafeString } from '../catalogue.js';
import type { Ops } from '../ops.js';
import type { ToolRegistrar } from '../tools.js';

export const PreferenceValue = z.union([z.string(), z.number(), z.boolean()]);
export function safePreference(name: string, value: string | number | boolean): string {
  // Get/SetPreference keys verified on live 3.7.8 (2026-10-02); no module/device/language changes.
  if (name === '/SamplingRate/DefaultProjectSampleRate')
    return String(
      z
        .union([
          z.literal(8000),
          z.literal(11025),
          z.literal(16000),
          z.literal(22050),
          z.literal(32000),
          z.literal(44100),
          z.literal(48000),
          z.literal(88200),
          z.literal(96000),
          z.literal(176400),
          z.literal(192000),
        ])
        .parse(value),
    );
  if (name === '/AudioIO/RecordChannels') return String(z.union([z.literal(1), z.literal(2)]).parse(value));
  throw new Error(
    'writable preferences: /SamplingRate/DefaultProjectSampleRate (supported numeric rate), /AudioIO/RecordChannels (1 or 2)',
  );
}

export function registerPreferenceTool(tool: ToolRegistrar, ops: Ops): void {
  tool(
    'audacity_preferences',
    'Get a preference or list available preferences. Set is restricted to default project sample rate and recording channel count; never changes modules, UI language, devices or pipe settings. Original value and readback are returned.',
    { action: z.enum(['get', 'list', 'set']), name: SafeString.min(1).optional(), value: PreferenceValue.optional() },
    async ({ action, name, value }) => {
      if (action === 'list') {
        if (name !== undefined || value !== undefined) throw new Error('list takes no name/value');
        return ops.info('Preferences');
      }
      if (!name) throw new Error('name is required');
      if (action === 'get') {
        if (value !== undefined) throw new Error('get takes no value');
        return { name, value: await ops.command('GetPreference', { Name: name }) };
      }
      if (value === undefined) throw new Error('value is required');
      const encoded = safePreference(name, value);
      const before = await ops.command('GetPreference', { Name: name });
      await ops.run('SetPreference', { Name: name, Value: encoded, Reload: false });
      return { name, before, value: await ops.command('GetPreference', { Name: name }) };
    },
  );
}
