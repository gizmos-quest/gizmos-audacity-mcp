import { z } from 'zod';
import { selectionTimes } from '../audacity/info.js';
import type { Ops } from '../ops.js';
import { CommandFailed } from '../ops.js';
import { Seconds, Track } from '../tool-input.js';
import type { ToolRegistrar } from '../tools.js';

export function registerTransportTool(tool: ToolRegistrar, ops: Ops): void {
  let playback: {
    mode: 'playing' | 'paused' | 'recording' | 'stopped';
    start: number;
    end: number;
    at: number;
    epoch: number;
  } = { mode: 'stopped', start: 0, end: 0, at: 0, epoch: 0 };
  let pausedMode: 'playing' | 'recording' = 'playing';
  const position = () =>
    playback.mode === 'playing' || playback.mode === 'recording'
      ? Math.min(playback.end, playback.at + (performance.now() - playback.epoch) / 1000)
      : playback.at;
  tool(
    'audacity_transport',
    'Play a selected region, pause/resume, stop, or record using Audacity’s configured input. Appending requires an explicit audio track matching the configured recording channels (1 or 2). Record mode respects Audacity’s new-track preference, and recording always starts from a cursor point to avoid batch progress waits. status reports selection and a monotonic estimated position; manual transport changes are not tracked. record returns immediately unless duration is supplied.',
    {
      action: z.enum(['play', 'pause', 'resume', 'stop', 'record', 'status']),
      start: Seconds.optional(),
      end: Seconds.optional(),
      track: Track.optional(),
      duration: z.number().positive().max(60).optional(),
      newTrack: z.boolean().default(true),
    },
    async ({ action, start, end, track, duration, newTrack }) => {
      if (end !== undefined && start !== undefined && end < start) throw new Error('end must be at least start');
      if (duration !== undefined && action !== 'record') throw new Error('duration is used only by record');
      if (!newTrack && action !== 'record') throw new Error('newTrack is used only by record');
      if (action === 'record' && end !== undefined)
        throw new Error('record takes start and optional duration, not end');
      if (!['play', 'record'].includes(action) && [start, end, track].some((v) => v !== undefined))
        throw new Error('scope is used only by play/record');
      if (action === 'play') {
        const scope = await ops.resolveSelection({ start, end, track });
        if (!(Number(scope.End) > Number(scope.Start))) throw new Error('play requires a positive-duration time range');
        await ops.run('Stop');
        await ops.run('Select', scope);
        const selection = selectionTimes(await ops.info('Selection'));
        await ops.run('Play');
        playback = {
          mode: 'playing',
          start: selection.start,
          end: selection.end,
          at: selection.start,
          epoch: performance.now(),
        };
      } else if (action === 'record') {
        // Official 3.7.8 ProjectAudioManager::OnRecord shows modal errors for
        // mismatched selected-track rates or too few compatible channels.
        // A single channel-matched audio track is safe for append recording;
        // native recording adopts that track's rate even when project rate differs.
        // Live pinned 3.7.8 (2026-10-02): selected 48 kHz stereo append under
        // a 44.1 kHz default extended only that target, with no modal dialog.
        if (!newTrack && track === undefined) throw new Error('append recording requires an explicit audio track');
        let recordTrack: number | undefined;
        let targetEnd = 0;
        if (track !== undefined) {
          recordTrack = await ops.trackIndex(track);
          const target = (await ops.tracks())[recordTrack]!;
          if (target.kind !== 'wave') throw new Error('recording track must be an audio track');
          targetEnd = target.end;
          if (!newTrack) {
            const channels = await ops.command('GetPreference', { Name: '/AudioIO/RecordChannels' });
            if (!['1', '2'].includes(channels))
              throw new Error('append recording supports configured input channels 1 or 2 only');
            if (target.channels !== Number(channels))
              throw new Error('append recording track channels must match the configured input channels');
          }
        }
        let preferNew: string;
        try {
          preferNew = await ops.command('GetPreference', { Name: '/GUI/PreferNewTrackRecord' });
        } catch (error) {
          // The native 3.7.8 default is false; only an absent preference (empty
          // Failed reply) gets that fallback. Keep other Audacity errors intact.
          if (error instanceof CommandFailed && !error.reply.body) preferNew = '0';
          else throw error;
        }
        if (!['0', '1'].includes(preferNew))
          throw new Error('unsupported new-track recording preference; expected 0 or 1');
        const recordCommand = newTrack === (preferNew === '1') ? 'Record1stChoice' : 'Record2ndChoice';
        const cursor = start ?? selectionTimes(await ops.info('Selection')).start;
        await ops.run('Stop');
        if (recordTrack !== undefined) await ops.select({ track: recordTrack, start: cursor, end: cursor });
        else {
          await ops.run('SelectNone');
          await ops.command('SelectTime', { Start: cursor, End: cursor, RelativeTo: 'ProjectStart' });
        }
        const selection = selectionTimes(await ops.info('Selection'));
        // TransportUtilities::RecordAndWait waits when the time range is
        // non-empty; the explicit cursor above keeps this operation asynchronous.
        // Raw recording commands are reserved from generic menus/macros.
        await ops.record(recordCommand);
        const recordingStart = newTrack ? selection.start : Math.max(selection.start, targetEnd);
        playback = {
          mode: 'recording',
          start: recordingStart,
          end: 86400,
          at: recordingStart,
          epoch: performance.now(),
        };
        if (duration !== undefined) {
          await new Promise((resolve) => setTimeout(resolve, duration * 1000));
          const at = position();
          await ops.run('Stop');
          playback = { ...playback, mode: 'stopped', at };
        }
      } else if (action === 'stop') {
        const at = position();
        await ops.run('Stop');
        playback = { ...playback, mode: 'stopped', at };
      } else if (action === 'pause') {
        if (!['playing', 'recording'].includes(playback.mode))
          throw new Error('no server-started playback or recording to pause');
        pausedMode = playback.mode as 'playing' | 'recording';
        const at = position();
        await ops.run('Pause');
        playback = { ...playback, mode: 'paused', at };
      } else if (action === 'resume') {
        if (playback.mode !== 'paused') throw new Error('transport is not paused');
        await ops.run('Pause');
        playback = { ...playback, mode: pausedMode, epoch: performance.now() };
      }
      const at = position();
      return {
        state: playback.mode === 'playing' && at >= playback.end ? 'stopped' : playback.mode,
        positionSeconds: at,
        positionSource: 'estimated monotonic clock; manual changes are unknown',
        selection: await ops.info('Selection'),
      };
    },
  );
}
