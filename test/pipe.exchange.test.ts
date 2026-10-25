// The production exchange: a disposable helper process against portable POSIX
// FIFOs that replay bytes recorded from Audacity 3.7.8.
import { afterEach, describe, expect, it } from 'vitest';
import { parseInfoJson } from '../src/format.js';
import { AudacityNeedsRecovery, AudacityPipe, AudacityTimeout, AudacityUnavailable } from '../src/pipe.js';
import { type Replay, recoveryReply, replayPipe, wire } from './helpers/replay-pipe.js';

const sessions: { pipe: AudacityPipe; replay: Awaited<ReturnType<typeof replayPipe>> }[] = [];
afterEach(async () => {
  for (const { pipe, replay } of sessions.splice(0)) {
    pipe.release();
    await replay.close();
  }
});
async function session(replay: Replay, timeoutMs = 30_000) {
  const fake = await replayPipe(replay);
  const pipe = new AudacityPipe(fake.paths, timeoutMs);
  sessions.push({ pipe, replay: fake });
  return { pipe, fake };
}

describe('helper process exchange', () => {
  it('returns a recorded reply through the spawned helper', async () => {
    const { pipe, fake } = await session(() => ({ bytes: wire('11-audio-tracks'), fragmentBytes: 7 }));
    const reply = await pipe.send('GetInfo: Type=Tracks Format=JSON');
    expect(reply).toMatchObject({ ok: true, status: 'OK' });
    expect(parseInfoJson(reply.body)).toEqual([expect.objectContaining({ name: 'Fixture café 音', kind: 'wave' })]);
    expect(fake.commands).toEqual(['GetInfo: Type=Tracks Format=JSON']);
    fake.assertHealthy();
  });

  it('latches an uncertain outcome when the reply ends before its status line', async () => {
    const { pipe, fake } = await session(() => ({ bytes: wire('07-new-mono'), truncateAt: 4 }));
    const error = await pipe.send('NewMonoTrack:').catch((caught: unknown) => caught);
    expect(error).toBeInstanceOf(AudacityUnavailable);
    expect(error).toMatchObject({ uncertainOutcome: true, message: expect.stringMatching(/disconnected/) });
    expect(pipe.needsRecovery).toBe(true);
    await expect(pipe.send('NewMonoTrack:')).rejects.toBeInstanceOf(AudacityNeedsRecovery);
    expect(fake.commands).toEqual(['NewMonoTrack:']);
  });

  it('ends a blocked exchange at its timeout by stopping only the helper', async () => {
    const { pipe } = await session(() => ({ bytes: wire('07-new-mono'), delayMs: 60_000 }), 1_500);
    await expect(pipe.send('NewMonoTrack:')).rejects.toBeInstanceOf(AudacityTimeout);
    expect(pipe.needsRecovery).toBe(true);
  });

  it('synchronizes through the recorded nonce barrier before reading tracks', async () => {
    const { pipe, fake } = await session((command) =>
      command.startsWith('Message: Text=') ? { bytes: recoveryReply(command) } : { bytes: wire('01-empty-tracks') },
    );
    expect((await pipe.reconnect()).body).toBe('[  ]');
    expect(pipe.needsRecovery).toBe(false);
    expect(fake.commands).toEqual([
      expect.stringMatching(/^Message: Text=gizmos-sync-/),
      'GetInfo: Type=Tracks Format=JSON',
    ]);
  });
});
