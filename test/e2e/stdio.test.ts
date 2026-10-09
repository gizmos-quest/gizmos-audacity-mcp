import { createHash } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { Client } from '@modelcontextprotocol/client';
import { StdioClientTransport } from '@modelcontextprotocol/client/stdio';
import { describe, expect, it } from 'vitest';
import { recoveryReply, replayPipe, wire } from '../helpers/replay-pipe.js';

const entry = fileURLToPath(new URL('../../dist/main.js', import.meta.url));
const body = (result: Awaited<ReturnType<Client['callTool']>>) =>
  result.content
    .filter((item) => item.type === 'text')
    .map((item) => item.text)
    .join('\n');

describe('built stdio server with recorded Audacity bytes', () => {
  it('verifies the immutable byte corpus before replay', () => {
    const fixtureRoot = new URL('../fixtures/audacity-3.7.8/', import.meta.url);
    const manifest = JSON.parse(readFileSync(new URL('manifest.json', fixtureRoot), 'utf8'));
    expect(manifest.audacity.fileVersion).toBe('3,7,8,0');
    expect(manifest.architecture).toBe('ARM64');
    for (const capture of manifest.captures)
      for (const kind of ['request', 'response']) {
        const bytes = readFileSync(new URL(capture[kind].file, fixtureRoot));
        expect(bytes.length).toBe(capture[kind].bytes);
        expect(createHash('sha256').update(bytes).digest('hex')).toBe(capture[kind].sha256);
        expect(bytes.toString('utf8')).not.toMatch(/[A-Za-z]:[\\/]|\\\\[\w.-]+\\/);
      }
  });

  it('negotiates older supported MCP, fragments UTF-8, composes generation and blocks uncertain edits', async () => {
    let created = false;
    let disconnect = false;
    const pipe = await replayPipe((command) => {
      if (command.startsWith('Message: Text='))
        return {
          // Deliberately prepend an old, same-shaped Tracks response. Only the nonce synchronizes recovery.
          bytes: Buffer.concat([wire('11-audio-tracks'), recoveryReply(command)]),
          fragmentBytes: 5,
        };
      if (command === 'GetInfo: Type=Tracks Format=JSON')
        return {
          bytes: wire(created ? '11-audio-tracks' : '01-empty-tracks'),
          fragmentBytes: 1,
        };
      if (command === 'GetInfo: Type=Clips Format=JSON')
        return { bytes: wire('12-clips'), fragmentBytes: 7, delayMs: 1 };
      if (command === 'GetInfo: Type=Selection Format=JSON') return { bytes: wire('05-selection') };
      if (command.startsWith('GetPreference:')) return { bytes: wire('06-known-rejection') };
      if (command === 'NewMonoTrack:') created = true;
      if (command === 'Stop:' && disconnect) return { bytes: wire('07-new-mono'), truncateAt: 8 };
      return { bytes: wire('07-new-mono') };
    });
    const client = new Client(
      { name: 'recorded-wire-test', version: '1' },
      { supportedProtocolVersions: ['2024-11-05'] },
    );
    try {
      await client.connect(
        new StdioClientTransport({
          command: process.execPath,
          args: [entry],
          env: {
            AUDACITY_PIPE_TO: pipe.paths.to,
            AUDACITY_PIPE_FROM: pipe.paths.from,
          },
        }),
      );
      const tools = (await client.listTools()).tools;
      expect(tools).toHaveLength(45);
      const beforeInvalid = pipe.commands.length;
      const invalid = await client.callTool({ name: 'audacity_track_set', arguments: { track: 0, ignored: true } });
      expect(invalid.isError).toBe(true);
      expect(body(invalid)).toContain('Input validation error');
      expect(pipe.commands).toHaveLength(beforeInvalid);
      const generated = await client.callTool({
        name: 'audacity_generate',
        arguments: {
          kind: 'tone',
          duration: 0.5,
          amplitude: 0.2,
        },
      });
      expect(generated.isError).not.toBe(true);
      expect(JSON.parse(body(generated))).toMatchObject({ track: 0, kind: 'tone', end: 0.5, name: 'Fixture café 音' });
      expect(pipe.commands).toContain('NewMonoTrack:');
      expect(pipe.commands.some((command) => command.startsWith('Select:') && command.includes('Track=0'))).toBe(true);
      expect(pipe.commands).toContain('Tone: Frequency=440 Amplitude=0.2 Waveform=Sine');
      const tracks = await client.callTool({ name: 'audacity_info', arguments: { type: 'Tracks' } });
      expect(JSON.parse(body(tracks))[0].name).toBe('Fixture café 音');
      expect(tracks.structuredContent).toBeUndefined();
      const failed = await client.callTool({
        name: 'audacity_command',
        arguments: {
          command: 'GetPreference',
          params: { Name: '/audit/nonexistent' },
        },
      });
      expect(failed.isError).toBe(true);
      expect(body(failed)).toContain('Failed!');
      disconnect = true;
      expect((await client.callTool({ name: 'audacity_menu', arguments: { command: 'Stop' } })).isError).toBe(true);
      const afterDisconnect = pipe.commands.length;
      const blocked = await client.callTool({ name: 'audacity_menu', arguments: { command: 'Stop' } });
      expect(blocked.isError).toBe(true);
      expect(body(blocked)).toContain('unknown');
      expect(pipe.commands).toHaveLength(afterDisconnect);
      disconnect = false;
      // Recover's OS diagnostics are covered separately; this built-server regression proves the transport latch.
      expect(pipe.commands.filter((command) => command === 'Stop:')).toHaveLength(1);
      pipe.assertHealthy();
    } finally {
      await client.close();
      await pipe.close();
    }
  });
});
