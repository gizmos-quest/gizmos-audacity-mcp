// Real stdio MCP integration against Audacity 3.7.x. Only AUDACITY_LIVE=1
// enables process or pipe access. User projects are backed up persistently;
// every test edit happens in the hidden, disposable test project.

import { expect, it } from 'vitest';
import { type LiveContext, testTimeout, type Windows } from './session.js';

export function registerHardware(context: LiveContext) {
  const { call, refuse, tracks, clearTracks, importVoice } = context;
  it(
    'reports device-independent transport status and stop',
    async () => {
      expect(await call('audacity_transport', { action: 'status' })).toHaveProperty('positionSource');
      expect(await call('audacity_transport', { action: 'stop' })).toMatchObject({ state: 'stopped' });
    },
    testTimeout,
  );
  it.skipIf(process.env.AUDACITY_LIVE_DEVICE_INDEPENDENT === '1')(
    'plays with estimated position, pauses/resumes/stops and records a short real input',
    async () => {
      await importVoice();
      await call('audacity_track_set', { track: 'Voice', mute: true });
      const playing = await call<{ state: string; positionSeconds: number }>('audacity_transport', {
        action: 'play',
        track: 'Voice',
        start: 0,
        end: 2,
      });
      expect(playing.positionSeconds).toBeGreaterThanOrEqual(0);
      expect(await call('audacity_transport', { action: 'status' })).toHaveProperty('positionSource');
      expect(await call('audacity_transport', { action: 'pause' })).toMatchObject({ state: 'paused' });
      await call('audacity_transport', { action: 'resume' });
      expect(await call('audacity_transport', { action: 'stop' })).toMatchObject({ state: 'stopped' });
      await clearTracks();
      expect(await call('audacity_transport', { action: 'record', duration: 0.15, newTrack: true })).toMatchObject({
        state: 'stopped',
      });
      const recording = (await tracks()).find((track) => track.kind === 'wave')!;
      expect(recording).toBeDefined();
      expect(recording.end).toBeGreaterThan(recording.start);
      const channels = Number(
        (await call<{ value: string }>('audacity_preferences', { action: 'get', name: '/AudioIO/RecordChannels' }))
          .value,
      );
      expect([1, 2]).toContain(channels);
      await call('audacity_generate', {
        kind: 'tone',
        name: 'Append target',
        channels,
        duration: 0.25,
        amplitude: 0.1,
      });
      await call('audacity_select', { track: recording.name });
      const beforeAppend = await tracks();
      expect(
        await call('audacity_transport', { action: 'record', track: 'Append target', duration: 0.15, newTrack: false }),
      ).toMatchObject({ state: 'stopped' });
      const afterAppend = await tracks();
      expect(afterAppend.length).toBe(beforeAppend.length);
      expect(afterAppend.find((track) => track.name === 'Append target')!.end).toBeGreaterThan(0.25);
      expect(afterAppend.find((track) => track.name === recording.name)!.end).toBe(recording.end);
      await call('audacity_generate', {
        kind: 'tone',
        name: 'Wrong channels',
        channels: channels === 1 ? 2 : 1,
        duration: 0.25,
        amplitude: 0.1,
      });
      const beforeRefusal = await tracks();
      const selection = await call('audacity_info', { type: 'Selection' });
      await expect(
        refuse('audacity_transport', { action: 'record', track: 'Wrong channels', duration: 0.15, newTrack: false }),
      ).rejects.toThrow(/channels/i);
      await expect(refuse('audacity_transport', { action: 'record', duration: 0.15, newTrack: false })).rejects.toThrow(
        /track/i,
      );
      expect(await tracks()).toEqual(beforeRefusal);
      expect(await call('audacity_info', { type: 'Selection' })).toEqual(selection);
      expect((await call<Windows>('audacity_dialogs')).windows.filter((window) => window.dialog)).toEqual([]);
    },
    testTimeout,
  );
}
