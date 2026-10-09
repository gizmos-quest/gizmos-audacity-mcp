import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { Client, InMemoryTransport } from '@modelcontextprotocol/client';
import { describe, expect, it, vi } from 'vitest';
import { AudacityPipe, AudacityUnavailable } from '../src/pipe.js';
import { buildServer } from '../src/server.js';

vi.mock('../src/app.js', async (actual) => ({
  ...(await actual<typeof import('../src/app.js')>()),
  pipeExists: () => false,
  preflightExecutableOverride: async () => undefined,
  launch: async () => ({ started: false, visible: false, processes: [] }),
  quit: async () => ({}),
  setWindowVisible: async () => 0,
  listWindows: async () => [],
  isRunning: async () => false,
  recoveryEntries: () => [],
}));

async function session() {
  const transport = vi.fn(async () => {
    throw new AudacityUnavailable('contract fixture: native I/O deliberately unavailable');
  });
  const server = buildServer(new AudacityPipe({ to: 'contract-to', from: 'contract-from' }, 100, transport));
  const client = new Client(
    { name: 'generic-contract-test', version: '1' },
    { supportedProtocolVersions: ['2025-06-18'] },
  );
  const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
  await server.connect(serverTransport);
  await client.connect(clientTransport);
  return { client, server, transport };
}
const text = (result: Awaited<ReturnType<Client['callTool']>>) =>
  result.content
    .filter((item) => item.type === 'text')
    .map((item) => item.text)
    .join('\n');

describe('public MCP compatibility contract', () => {
  it('preserves tool names, top-level fields and required arguments', async () => {
    const { client, server } = await session();
    try {
      const tools = (await client.listTools()).tools;
      const actual = tools
        .map(({ name, title, inputSchema, outputSchema, annotations }) => ({
          name,
          title,
          inputSchema,
          ...(outputSchema ? { outputSchema } : {}),
          annotations,
        }))
        .sort((a, b) => a.name.localeCompare(b.name));
      expect(actual).toEqual(JSON.parse(readFileSync(new URL('./fixtures/tools.json', import.meta.url), 'utf8')));
      expect(tools.find((tool) => tool.name === 'audacity_import')?.inputSchema.properties).toHaveProperty(
        'start.default',
        0,
      );
      expect(tools.find((tool) => tool.name === 'audacity_envelope_set')?.inputSchema.properties).toHaveProperty(
        'replace.default',
        true,
      );
      expect(tools.find((tool) => tool.name === 'audacity_pipeline')?.inputSchema.properties).toHaveProperty(
        'preset.default',
        'voice',
      );
      for (const tool of tools) {
        expect(tool.title).toBeTruthy();
        expect(Object.keys(tool.annotations ?? {}).sort()).toEqual([
          'destructiveHint',
          'idempotentHint',
          'openWorldHint',
          'readOnlyHint',
        ]);
      }
      const status = await client.callTool({ name: 'audacity_status', arguments: {} });
      expect(JSON.parse(text(status))).toEqual({ running: false });
      expect(status.structuredContent).toEqual({ running: false });
    } finally {
      await client.close();
      await server.close();
    }
  });

  it('accepts generic production argument shapes without changing their defaults', async () => {
    const scratch = mkdtempSync(join(tmpdir(), 'audacity-contract-'));
    const source = join(scratch, 'source.wav');
    const project = join(scratch, 'source.aup3');
    writeFileSync(source, 'synthetic input');
    writeFileSync(project, 'synthetic project');
    const { client, server } = await session();
    const cases: [string, Record<string, unknown>][] = [
      ['audacity_command', { command: 'SetProject', params: { Rate: 48000, Name: 'Demo' } }],
      ['audacity_dialogs', {}],
      ['audacity_dialogs', { close: true }],
      ['audacity_effect', { effect: 'High-passFilter', params: { FREQUENCY: 80, ROLLOFF: 'dB12' }, track: 'Voice' }],
      [
        'audacity_effect',
        {
          effect: 'Compressor',
          params: {
            thresholdDb: -18,
            compressionRatio: 3,
            kneeWidthDb: 6,
            attackMs: 10,
            releaseMs: 150,
            lookaheadMs: 1,
            makeupGainDb: 0,
          },
          track: 'Voice',
        },
      ],
      [
        'audacity_effect',
        {
          effect: 'LoudnessNormalization',
          params: { LUFSLevel: -19, NormalizeTo: 0, DualMono: true, StereoIndependent: false },
          track: 'Voice',
        },
      ],
      [
        'audacity_effect',
        {
          effect: 'Limiter',
          params: { thresholdDb: -3, makeupTargetDb: -3, kneeWidthDb: 0, lookaheadMs: 5, releaseMs: 50 },
          track: 'Voice',
        },
      ],
      [
        'audacity_envelope_set',
        {
          track: 'Music',
          points: [
            { time: 0, value: 1 },
            { time: 2, value: 0.5 },
          ],
        },
      ],
      ['audacity_export', { file: join(scratch, 'mix.wav'), channels: 2, start: 0, end: 4 }],
      ['audacity_fresh', { visible: false, backupTo: join(scratch, 'backup.aup3') }],
      ['audacity_import', { file: source, name: 'Music' }],
      ['audacity_import', { file: source, name: 'Voice', start: 1.25 }],
      ['audacity_labels_set', { labels: [{ start: 1, text: 'Opening' }], trackName: 'Script' }],
      ['audacity_launch', { visible: true }],
      ['audacity_measure', { backend: 'ffmpeg' }],
      ['audacity_menu', { command: 'FitInWindow' }],
      ...[true, false].map((dryRun): [string, Record<string, unknown>] => [
        'audacity_pipeline',
        {
          preset: 'voice',
          removeDc: true,
          highPassHz: 80,
          compress: true,
          thresholdDb: -18,
          ratio: 3,
          attackMs: 10,
          releaseMs: 150,
          limitPeakDb: -3,
          track: 'Voice',
          loudness: 'lufs',
          lufs: -19,
          dryRun,
        },
      ]),
      ['audacity_project', { action: 'open', file: project }],
      ['audacity_project', { action: 'save', file: join(scratch, 'new.aup3') }],
      ['audacity_quit', {}],
      ['audacity_quit', { saveTo: join(scratch, 'kept.aup3') }],
      ['audacity_recover', { reconnect: true }],
      ['audacity_status', {}],
      ['audacity_track_set', { track: 'Music', gainDb: -9, pan: 0.5, mute: false, solo: true }],
      ['audacity_track_set', { track: 0, gainDb: 0, pan: 0, mute: true, solo: false }],
      ['audacity_window', { show: true }],
      ...['Clips', 'Envelopes', 'Labels'].map((type): [string, Record<string, unknown>] => ['audacity_info', { type }]),
      ['audacity_select', { track: 0 }],
      ['audacity_command', { command: 'SetEnvelope', params: { Delete: true } }],
    ];
    try {
      for (const [name, args] of cases) {
        const result = await client.callTool({ name, arguments: args });
        expect(text(result), `${name} ${JSON.stringify(args)}`).not.toMatch(/Input validation error|Unrecognized key/);
      }
    } finally {
      await client.close();
      await server.close();
      rmSync(scratch, { recursive: true, force: true });
    }
  });

  it('returns plans with omitted optional fields as SDK-valid structured content', async () => {
    const scratch = mkdtempSync(join(tmpdir(), 'audacity-contract-'));
    const source = join(scratch, 'source.wav');
    writeFileSync(source, 'synthetic input');
    const { client, server } = await session();
    try {
      for (const [name, args] of [
        ['audacity_batch', { dryRun: true, jobs: [{ file: source, output: join(scratch, 'out.wav') }] }],
        ['audacity_pipeline', { dryRun: true, track: 'Voice' }],
      ] as [string, Record<string, unknown>][]) {
        const result = await client.callTool({ name, arguments: args });
        expect(result.isError, text(result)).not.toBe(true);
        expect(result.structuredContent).toEqual(JSON.parse(text(result)));
      }
    } finally {
      await client.close();
      await server.close();
      rmSync(scratch, { recursive: true, force: true });
    }
  });

  it('rejects unknown root/nested fields and nonfinite values before native I/O', async () => {
    const { client, server, transport } = await session();
    try {
      for (const [name, args] of [
        ['audacity_status', { ignored: true }],
        ['audacity_envelope_set', { track: 0, points: [{ time: 0, value: 1, ignored: true }] }],
        ['audacity_labels_set', { labels: [{ start: 0, text: 'Cue', ignored: true }] }],
        ['audacity_track_set', { track: 0, gainDb: Number.POSITIVE_INFINITY }],
      ] as [string, Record<string, unknown>][]) {
        expect((await client.callTool({ name, arguments: args })).isError).toBe(true);
      }
      expect(transport).not.toHaveBeenCalled();
    } finally {
      await client.close();
      await server.close();
    }
  });
});
