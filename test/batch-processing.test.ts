import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { isAbsolute, join, relative, resolve } from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { z } from 'zod';
import { registerBatchTool } from '../src/batch.js';
import type { Ops, TrackInfo, TrackRef } from '../src/ops.js';
import { AudacityTimeout } from '../src/pipe.js';
import type { ToolRegistrar } from '../src/tools.js';

vi.mock('../src/source-rate.js', () => ({ measureSourceRate: vi.fn(async () => 48_000) }));

let directory: string;
let input: string;
let secondInput: string;
let output: string;
let _secondOutput: string;

beforeEach(() => {
  directory = mkdtempSync(join(tmpdir(), 'gizmos-audacity-batch-unit-'));
  input = join(directory, 'input.wav');
  secondInput = join(directory, 'second.wav');
  output = join(directory, 'output.wav');
  _secondOutput = join(directory, 'second-output.wav');
  // File preflight does not decode audio; rendering belongs to live tests.
  writeFileSync(input, 'first source fixture');
  writeFileSync(secondInput, 'second source fixture');
});

afterEach(() => {
  const descendant = relative(resolve(tmpdir()), resolve(directory));
  if (
    !descendant ||
    descendant.startsWith('..') ||
    isAbsolute(descendant) ||
    !descendant.startsWith('gizmos-audacity-batch-unit-')
  ) {
    throw new Error('refusing to remove a batch fixture outside the expected temporary directory');
  }
  rmSync(directory, { recursive: true, force: true });
});

/** Exercise the same strict shape registration and handler validation as the server. */
function _registeredBatch() {
  const accesses: string[] = [];
  const ops = new Proxy(
    {},
    {
      get: (_target, key) => {
        accesses.push(String(key));
        throw new Error(`batch touched Ops.${String(key)} before preflight completed`);
      },
    },
  ) as Ops;
  let name: string | undefined;
  let schema: z.ZodType | undefined;
  let handler: ((args: unknown) => Promise<unknown>) | undefined;
  const register: ToolRegistrar = (toolName, _description, shape, action) => {
    if (name) throw new Error('batch registered more than one tool');
    name = toolName;
    schema = z.object(shape).strict();
    handler = action as (args: unknown) => Promise<unknown>;
  };
  registerBatchTool(register, ops);
  return { accesses, name, schema: schema!, call: async (args: unknown) => handler!(schema!.parse(args)) };
}

function processingBatch() {
  const tracks: TrackInfo[] = [{ name: 'Original', kind: 'wave', start: 2, end: 4, selected: 1, focused: 1 }];
  let removed = { track: 0, count: 1 };
  const ops = {
    pipe: { needsRecovery: false },
    tracks: vi.fn(async () => structuredClone(tracks)),
    info: vi.fn(async (type: string) =>
      type === 'Clips'
        ? tracks.map((track, index) => ({ track: index, start: track.start, end: track.end }))
        : { Start: 2.5, End: 3 },
    ),
    trackIndex: vi.fn(async (track: TrackRef) => {
      const index = typeof track === 'number' ? track : tracks.findIndex((value) => value.name === track);
      if (!tracks[index]) throw new Error('track does not exist');
      return index;
    }),
    importTrack: vi.fn(async (_file: string, name: string) => {
      const track = tracks.length;
      tracks.push({ name, kind: 'wave', start: 0, end: 1 });
      return { track, name };
    }),
    select: vi.fn(async () => undefined),
    command: vi.fn(async (command: string, params: Record<string, unknown>) => {
      if (command === 'SelectTracks') removed = { track: Number(params.Track), count: Number(params.TrackCount) };
      if (command === 'Export2') writeFileSync(String(params.Filename), 'processed output');
      return '';
    }),
    run: vi.fn(async (command: string) => {
      if (command === 'RemoveTracks') tracks.splice(removed.track, removed.count);
      return '';
    }),
  };
  let handler: ((args: unknown) => Promise<unknown>) | undefined;
  const register: ToolRegistrar = (_name, _description, shape, action) => {
    handler = (args) => action(z.object(shape).strict().parse(args));
  };
  registerBatchTool(register, ops as unknown as Ops);
  return { tracks, ops, call: (args: unknown) => handler!(args) };
}

describe('batch isolation and failure recovery', () => {
  it('cleans temporary tracks and restores the original focus, sparse selection and time', async () => {
    const { call, tracks, ops } = processingBatch();
    expect(await call({ jobs: [{ file: input, output }], measure: false })).toMatchObject({ completed: 1 });
    expect(tracks).toEqual([{ name: 'Original', kind: 'wave', start: 2, end: 4, selected: 1, focused: 1 }]);
    expect(readFileSync(output, 'utf8')).toBe('processed output');
    expect(ops.command.mock.calls.slice(-4)).toEqual([
      ['SelectTracks', { Track: 0, TrackCount: 1, Mode: 'Set' }],
      ['SetTrackStatus', { Focused: true }],
      ['SelectTracks', { Track: 0, TrackCount: 1, Mode: 'Add' }],
      ['SelectTime', { Start: 2.5, End: 3, RelativeTo: 'ProjectStart' }],
    ]);
  });

  it('refuses pause shortening with existing tracks before imports or selection changes', async () => {
    const { call, ops, tracks } = processingBatch();
    await expect(
      call({ jobs: [{ file: input, output, options: { shortenPauses: {} } }], measure: false }),
    ).rejects.toThrow('sync-lock can shift existing tracks');
    expect(ops.importTrack).not.toHaveBeenCalled();
    expect(ops.select).not.toHaveBeenCalled();
    expect(ops.command).not.toHaveBeenCalled();
    expect(ops.run).not.toHaveBeenCalled();
    expect(tracks).toHaveLength(1);
  });

  it('removes all temporary tracks when a confirmed multi-stream import is refused', async () => {
    const { call, ops, tracks } = processingBatch();
    ops.importTrack.mockImplementationOnce(async () => {
      tracks.push(
        { name: 'Stream 1', kind: 'wave', start: 0, end: 1 },
        { name: 'Stream 2', kind: 'wave', start: 0, end: 1 },
      );
      throw new Error('import added 2 tracks; this tool requires one audio track');
    });
    await expect(call({ jobs: [{ file: input, output }], measure: false })).rejects.toThrow('import added 2 tracks');
    expect(tracks).toHaveLength(1);
    expect(ops.command).toHaveBeenCalledWith('SelectTracks', { Track: 1, TrackCount: 2, Mode: 'Set' });
    expect(ops.run).toHaveBeenCalledWith('RemoveTracks');
    expect(ops.select).not.toHaveBeenCalled();
  });

  it('retains an uncertain import and its original timeout class without cleanup or further edits', async () => {
    const { call, ops, tracks } = processingBatch();
    const failure = new AudacityTimeout('lost import reply');
    ops.importTrack.mockImplementationOnce(async () => {
      tracks.push({ name: 'Uncertain import', kind: 'wave', start: 0, end: 1 });
      ops.pipe.needsRecovery = true;
      throw failure;
    });
    await expect(call({ jobs: [{ file: input, output }], measure: false })).rejects.toBe(failure);
    expect(failure).toBeInstanceOf(AudacityTimeout);
    expect(failure.message).toContain('after 0 completed jobs: lost import reply');
    expect(ops.command).not.toHaveBeenCalled();
    expect(ops.run).not.toHaveBeenCalled();
    expect(tracks).toHaveLength(2);
  });

  it('retains native processing context if cleanup and selection restoration also fail', async () => {
    const { call, ops } = processingBatch();
    ops.command.mockImplementation(async (command) => {
      if (command === 'High-passFilter') throw new Error('native processing rejected');
      if (command === 'SelectTime') throw new Error('restore rejected');
      return '';
    });
    ops.run.mockImplementation(async (command) => {
      if (command === 'RemoveTracks') throw new Error('cleanup rejected');
      return '';
    });
    await expect(call({ jobs: [{ file: input, output }], measure: false })).rejects.toThrow(
      /native processing rejected.*cleanup also failed: cleanup rejected.*Selection restoration also failed: restore rejected/,
    );
  });
});
