import type { CallToolResult, McpServer, ServerContext } from '@modelcontextprotocol/server';
import { describe, expect, it, vi } from 'vitest';
import { z } from 'zod';
import { COMMAND_IDS, describeCommand } from '../src/catalogue.js';
import { AudacityTimeout, AudacityUnavailable } from '../src/pipe.js';
import { SerialQueue } from '../src/queue.js';
import { toolAnnotations, toolTitle } from '../src/tool-metadata.js';
import { outputSchema } from '../src/tool-output.js';
import { createToolRegistrar, requestProgress, toolFailure, toolResult } from '../src/tools.js';

function context(token?: unknown, signal = new AbortController().signal) {
  const notify = vi.fn(async () => undefined);
  return {
    ctx: {
      mcpReq: { signal, notify, _meta: token === undefined ? undefined : { progressToken: token } },
    } as unknown as ServerContext,
    notify,
  };
}
function session() {
  const callbacks = new Map<string, (args: unknown, ctx: ServerContext) => Promise<CallToolResult>>();
  const configs = new Map<string, Record<string, unknown>>();
  const server = {
    registerTool: (
      name: string,
      config: Record<string, unknown>,
      callback: (args: unknown, ctx: ServerContext) => Promise<CallToolResult>,
    ) => {
      callbacks.set(name, callback);
      configs.set(name, config);
    },
  } as unknown as McpServer;
  const tool = createToolRegistrar(server, new SerialQueue());
  return {
    tool,
    configs,
    call: (name: string, args: unknown = {}, ctx = context().ctx) => callbacks.get(name)!(args, ctx),
  };
}

describe('MCP result compatibility', () => {
  it('adds structured object reports while retaining exact JSON text and legacy arrays/strings', () => {
    const value = { running: false };
    const result = toolResult(value, outputSchema('audacity_status'));
    expect(result.structuredContent).toEqual(value);
    expect(result.content).toEqual([{ type: 'text', text: JSON.stringify(value, null, 1) }]);
    expect(toolResult([1, 2])).toEqual({ content: [{ type: 'text', text: '[\n 1,\n 2\n]' }] });
    expect(toolResult('selected')).toEqual({ content: [{ type: 'text', text: 'selected' }] });
    expect(outputSchema('audacity_info')).toBeUndefined();
    expect(outputSchema('audacity_labels')).toBeUndefined();
    expect(() => toolResult({ running: 'yes' }, outputSchema('audacity_status'))).toThrow();
  });

  it('never turns a completed edit into an error because a report carries an extra field', () => {
    const report = { points: 2, note: 'informational' };
    expect(toolResult(report, outputSchema('audacity_envelope_set')).structuredContent).toEqual(report);
  });

  it('describes every bundled command within the advertised output schema', () => {
    for (const id of COMMAND_IDS)
      expect(outputSchema('audacity_describe')!.safeParse(describeCommand(id)).success).toBe(true);
  });

  it('validates the serialized JSON shape for optional nested task fields', () => {
    const report = {
      dryRun: true,
      jobs: [
        {
          file: 'source.wav',
          output: 'out.wav',
          plan: {
            steps: [{ command: 'FadeIn', params: {}, scope: { track: 'Voice', start: undefined, end: undefined } }],
          },
        },
      ],
      requiresEmptyProject: false,
    };
    const structured = toolResult(report, outputSchema('audacity_batch')).structuredContent;
    expect(structured).toEqual(report);
    // The SDK validates structured content against the schema again: the raw
    // object's undefined scope times would fail there after a completed batch.
    expect(outputSchema('audacity_batch')!.safeParse(structured).success).toBe(true);
    expect(outputSchema('audacity_batch')!.safeParse(report).success).toBe(false);
    const recover = {
      running: true,
      entries: [],
      windows: [],
      discarded: null,
      tracks: [],
      synchronized: true,
      previousOutcome: 'unknown',
      note: 'Review the project.',
    };
    expect(toolResult(recover, outputSchema('audacity_recover')).structuredContent).toEqual(recover);
    expect(outputSchema('audacity_clip_set')?.safeParse({ track: 0, start: 0, end: 1, name: 'Clip' }).success).toBe(
      true,
    );
  });

  it('retains native errors and adds only relevant recovery guidance', () => {
    expect(toolFailure(new Error('native error'))).toEqual({
      content: [{ type: 'text', text: 'native error' }],
      isError: true,
    });
    expect(toolFailure('wire failure').isError).toBe(true);
    expect(toolFailure(new AudacityUnavailable('pipe missing')).content[0]).toMatchObject({
      text: expect.stringContaining('audacity_launch'),
    });
    expect(toolFailure(new AudacityUnavailable('partial reply', true)).content[0]).toMatchObject({
      text: expect.stringContaining('do not replay'),
    });
    expect(toolFailure(new AudacityUnavailable('pipe busy.', false, ' Retry later.')).content[0]).toEqual({
      type: 'text',
      text: 'pipe busy. Retry later.',
    });
    expect(toolFailure(new AudacityTimeout('wait exceeded')).content[0]).toMatchObject({
      text: expect.stringContaining('audacity_dialogs'),
    });
    expect(toolFailure(z.object({ count: z.number() }).safeParse({ count: 'bad' }).error!).content[0]).toMatchObject({
      text: expect.stringContaining('count'),
    });
  });
});

describe('metadata and progress', () => {
  it('conservatively describes actual mutation, idempotence and file interaction', () => {
    expect(toolTitle('audacity_project_info')).toBe('Project Info');
    expect(toolAnnotations('audacity_status')).toEqual({
      readOnlyHint: true,
      destructiveHint: false,
      idempotentHint: true,
      openWorldHint: false,
    });
    expect(toolAnnotations('audacity_export')).toMatchObject({
      destructiveHint: true,
      idempotentHint: false,
      openWorldHint: true,
    });
    expect(toolAnnotations('audacity_window')).toMatchObject({ destructiveHint: false, idempotentHint: true });
    expect(toolAnnotations('audacity_measure')).toMatchObject({ readOnlyHint: false, destructiveHint: false });
    expect(toolAnnotations('audacity_example', true)).toMatchObject({ readOnlyHint: true, destructiveHint: false });
    expect(toolAnnotations('audacity_pipeline')).toMatchObject({ destructiveHint: true, idempotentHint: false });
  });

  it.each(['task', 0])('scopes stage notifications to the supplied token %j', async (token) => {
    const { ctx, notify } = context(token);
    await requestProgress(ctx)(1, 3, 'Completed stage');
    expect(notify).toHaveBeenCalledExactlyOnceWith({
      method: 'notifications/progress',
      params: { progressToken: token, progress: 1, total: 3, message: 'Completed stage' },
    });
  });
  it('sends strictly increasing progress while still checking cancellation at every stage', async () => {
    const controller = new AbortController();
    const { ctx, notify } = context('task', controller.signal);
    const progress = requestProgress(ctx);
    for (const [value, message] of [
      [0, 'Start one'],
      [1, 'Completed one'],
      [1, 'Start two'],
      [2, 'Completed two'],
    ] as const)
      await progress(value, 2, message);
    const sent = notify.mock.calls as unknown as [{ params: { progress: number } }][];
    expect(sent.map(([note]) => note.params.progress)).toEqual([0, 1, 2]);
    controller.abort(new Error('cancelled'));
    await expect(progress(2, 2, 'Repeated')).rejects.toThrow('cancelled');
  });
  it.each([undefined, false, {}])('does not invent a progress token %j', async (token) => {
    const { ctx, notify } = context(token);
    await requestProgress(ctx)(0, 3, 'Starting');
    expect(notify).not.toHaveBeenCalled();
  });
  it('stops future stages on cancellation without pretending a native edit was rolled back', async () => {
    const controller = new AbortController();
    controller.abort(new Error('cancelled'));
    const { ctx, notify } = context('task', controller.signal);
    await expect(requestProgress(ctx)(1, 3, 'Next stage')).rejects.toThrow('cancelled');
    expect(notify).not.toHaveBeenCalled();
  });
});

describe('shared registrar boundary', () => {
  it('validates before the handler and exposes meaningful schema/annotations', async () => {
    const { tool, configs, call } = session();
    const handler = vi.fn(async () => ({ running: false }));
    tool('audacity_status', 'Inspect status', {}, handler, true);
    expect(configs.get('audacity_status')).toMatchObject({
      title: 'Status',
      outputSchema: expect.anything(),
      annotations: { readOnlyHint: true, destructiveHint: false },
    });
    expect((await call('audacity_status', { ignored: true })).isError).toBe(true);
    expect(handler).not.toHaveBeenCalled();
    expect((await call('audacity_status')).structuredContent).toEqual({ running: false });
    expect(handler).toHaveBeenCalledOnce();
  });
  it('serializes selection-dependent operations while native dialog controls bypass the blocked queue', async () => {
    const { tool, call } = session();
    let resolveStarted!: () => void;
    const started = new Promise<void>((resolve) => {
      resolveStarted = resolve;
    });
    let resolveBlocked!: (value: string) => void;
    const blocked = new Promise<string>((resolve) => {
      resolveBlocked = resolve;
    });
    const events: string[] = [];
    tool('audacity_effect', 'Apply', {}, async () => {
      events.push('effect');
      resolveStarted();
      return blocked;
    });
    tool('audacity_select', 'Select', {}, async () => {
      events.push('select');
      return 'selected';
    });
    tool('audacity_dialogs', 'Dialogs', {}, async () => {
      events.push('dialogs');
      return { windows: [] };
    });
    const first = call('audacity_effect');
    await started;
    const second = call('audacity_select');
    expect((await call('audacity_dialogs')).isError).not.toBe(true);
    expect(events).toEqual(['effect', 'dialogs']);
    resolveBlocked('applied');
    await first;
    await second;
    expect(events).toEqual(['effect', 'dialogs', 'select']);
  });
  it('never starts a queued operation whose request was cancelled while it waited', async () => {
    const { tool, call } = session();
    let release!: () => void;
    const blocked = new Promise<void>((resolve) => {
      release = resolve;
    });
    const second = vi.fn(async () => 'sent');
    tool('audacity_effect', 'Apply', {}, async () => blocked);
    tool('audacity_menu', 'Menu', {}, second);
    const first = call('audacity_effect');
    const controller = new AbortController();
    const queued = call('audacity_menu', {}, context(undefined, controller.signal).ctx);
    controller.abort(new Error('user cancelled queued edit'));
    release();
    await first;
    expect(await queued).toMatchObject({ isError: true, content: [{ text: 'user cancelled queued edit' }] });
    expect(second).not.toHaveBeenCalled();
  });
  it('returns handler failures as MCP tool errors without losing text', async () => {
    const { tool, call } = session();
    tool('audacity_example', 'Example', {}, async () => {
      throw new Error('native failure');
    });
    expect(await call('audacity_example')).toEqual({
      content: [{ type: 'text', text: 'native failure' }],
      isError: true,
    });
  });
});
