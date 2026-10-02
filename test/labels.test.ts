import { describe, expect, it, vi } from 'vitest';
import { z } from 'zod';
import { parseLabelsFile, registerLabelTools } from '../src/labels.js';
import type { Ops } from '../src/ops.js';
import type { ToolRegistrar } from '../src/tools.js';

function labelsTool() {
  const ops = { tracks: vi.fn(async () => []), info: vi.fn(async () => []), setLabels: vi.fn(async () => 1), command: vi.fn(), run: vi.fn() };
  const handlers = new Map<string, (args: unknown) => Promise<unknown>>();
  const register: ToolRegistrar = (name, _description, shape, handler) => handlers.set(name, (args) => handler(z.object(shape).strict().parse(args)));
  registerLabelTools(register, ops as unknown as Ops);
  return { ops, call: handlers.get('audacity_labels')! };
}

describe('operation-specific label fields', () => {
  it.each([
    { action: 'list', index: 0 }, { action: 'list', query: 'ignored' }, { action: 'find' },
    { action: 'find', query: 'x', interval: 1 }, { action: 'edit', index: 0 },
    { action: 'edit', text: 'new' }, { action: 'edit', index: 0, text: 'new', trackName: 'ignored' },
    { action: 'delete' }, { action: 'delete', index: 0, text: 'ignored' },
    { action: 'regular', start: 1, end: 0, interval: 1 },
    { action: 'regular', start: 0, end: 1, interval: 1, index: 0 },
  ])('refuses invalid or ignored action fields before reading or mutating Audacity %#', async (args) => {
    const { call, ops } = labelsTool();
    await expect(call(args)).rejects.toThrow();
    expect(ops.tracks).not.toHaveBeenCalled(); expect(ops.info).not.toHaveBeenCalled();
    expect(ops.command).not.toHaveBeenCalled(); expect(ops.run).not.toHaveBeenCalled(); expect(ops.setLabels).not.toHaveBeenCalled();
  });

  it('keeps regular marker rounding within the requested inclusive end', async () => {
    const { call, ops } = labelsTool();
    await call({ action: 'regular', start: 0, end: 0.3, interval: 0.1 });
    expect(ops.setLabels).toHaveBeenCalledExactlyOnceWith([
      { start: 0, text: 'Marker 1' }, { start: 0.1, text: 'Marker 2' },
      { start: 0.2, text: 'Marker 3' }, { start: 0.3, text: 'Marker 4' },
    ], 'Labels');
  });

  it('accepts a UTF-8 BOM in JSON label exports', () => {
    expect(parseLabelsFile('\uFEFF[{"start":0,"text":"Opening"}]', 'json')).toEqual([{ start: 0, text: 'Opening' }]);
  });
});
