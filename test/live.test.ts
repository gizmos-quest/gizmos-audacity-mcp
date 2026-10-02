// End to end against a running Audacity 3.x with mod-script-pipe, through the
// real stdio server. Skipped unless AUDACITY_LIVE=1. It works in a new
// project and discards it, so an open project of the user stays untouched
// only if none is open: run it against a hidden test instance.
import { describe, expect, it, beforeAll, afterAll } from 'vitest';
import { Client } from '@modelcontextprotocol/client';
import { StdioClientTransport } from '@modelcontextprotocol/client/stdio';
import { mkdtempSync, existsSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';

const live = process.env.AUDACITY_LIVE === '1';
const root = fileURLToPath(new URL('..', import.meta.url));

function tone(path: string, seconds: number): void {
  // 16-bit mono 48 kHz sine, written without external tools.
  const rate = 48_000;
  const samples = Math.round(seconds * rate);
  const data = Buffer.alloc(samples * 2);
  for (let i = 0; i < samples; i++) data.writeInt16LE(Math.round(Math.sin((2 * Math.PI * 440 * i) / rate) * 12_000), i * 2);
  const header = Buffer.alloc(44);
  header.write('RIFF', 0);
  header.writeUInt32LE(36 + data.length, 4);
  header.write('WAVEfmt ', 8);
  header.writeUInt32LE(16, 16);
  header.writeUInt16LE(1, 20);
  header.writeUInt16LE(1, 22);
  header.writeUInt32LE(rate, 24);
  header.writeUInt32LE(rate * 2, 28);
  header.writeUInt16LE(2, 32);
  header.writeUInt16LE(16, 34);
  header.write('data', 36);
  header.writeUInt32LE(data.length, 40);
  writeFileSync(path, Buffer.concat([header, data]));
}

describe.skipIf(!live)('live Audacity', () => {
  const dir = mkdtempSync(join(tmpdir(), 'gizmos-audacity-live-'));
  let client: Client;

  const call = async (name: string, args: Record<string, unknown> = {}) => {
    const result = (await client.callTool({ name, arguments: args })) as { content: { text: string }[]; isError?: boolean };
    const text = result.content[0]?.text ?? '';
    if (result.isError) throw new Error(`${name}: ${text}`);
    try {
      return JSON.parse(text) as unknown;
    } catch {
      return text;
    }
  };

  beforeAll(async () => {
    client = new Client({ name: 'live-test', version: '0' });
    await client.connect(new StdioClientTransport({ command: process.execPath, args: [join(root, 'dist', 'main.js')] }));
    await call('audacity_launch', { visible: false });
    await call('audacity_project', { action: 'new' });
  }, 90_000);

  afterAll(async () => {
    await client?.close();
    rmSync(dir, { recursive: true, force: true });
  });

  it('lists every catalogue command as a tool argument', async () => {
    const tools = await client.listTools();
    expect(tools.tools.map((t) => t.name)).toContain('audacity_envelope_set');
  });

  it('imports at a position, writes an envelope and labels, applies an effect and exports', async () => {
    const wav = join(dir, 'tone.wav');
    tone(wav, 2);
    const imported = (await call('audacity_import', { file: wav, name: 'Voice', start: 1.5 })) as { track: number };
    const status = (await call('audacity_status')) as { tracks: { name: string; start: number }[] };
    const voice = status.tracks[imported.track]!;
    expect(voice.name).toBe('Voice');
    expect(voice.start).toBeCloseTo(1.5, 2);

    await call('audacity_envelope_set', { track: 'Voice', points: [{ time: 1.5, value: 1 }, { time: 2.5, value: 0.25 }] });
    const envelopes = (await call('audacity_info', { type: 'Envelopes' })) as { points: { t: number; y: number }[] }[];
    expect(envelopes.flatMap((e) => e.points).map((p) => p.y)).toEqual([1, 0.25]);

    await call('audacity_labels_set', { labels: [{ start: 1.5, text: 'line one' }, { start: 2, end: 3, text: 'region' }] });
    const labels = (await call('audacity_info', { type: 'Labels' })) as [number, [number, number, string][]][];
    expect(labels.flatMap(([, l]) => l.map((x) => x[2]))).toEqual(['line one', 'region']);

    await call('audacity_effect', { effect: 'Amplify', params: { Ratio: 0.5 }, track: 'Voice' });
    await expect(call('audacity_effect', { effect: 'Amplify', params: { Bogus: 1 }, track: 'Voice' })).rejects.toThrow();

    const out = join(dir, 'mix.wav');
    await call('audacity_export', { file: out, channels: 1 });
    expect(existsSync(out)).toBe(true);
  }, 120_000);
});
