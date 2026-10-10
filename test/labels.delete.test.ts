import { describe, expect, it } from 'vitest';
import { z } from 'zod';
import { registerLabelTools } from '../src/labels.js';
import type { Ops } from '../src/ops.js';
import type { ToolRegistrar } from '../src/tools.js';
import { edits, type LabelTuple, label, project, wave } from './helpers/project-fixture.js';

describe('label deletion preflight', () => {
  const labelHandler = (ops: Ops) => {
    const handlers = new Map<string, (args: unknown) => Promise<unknown>>();
    const register: ToolRegistrar = (name, _description, shape, handler) => {
      handlers.set(name, (args) => handler(z.object(shape).strict().parse(args)));
    };
    registerLabelTools(register, ops);
    return handlers.get('audacity_labels')!;
  };

  it('refuses duplicate track names before deleting any track', async () => {
    const fixture = project(
      [label('Cues'), label('Cues')],
      [
        [0, [[0, 0, 'remove']]],
        [1, [[1, 1, 'keep']]],
      ],
    );
    await expect(labelHandler(fixture.ops)({ action: 'delete', index: 0 })).rejects.toThrow('unique');
    expect(edits(fixture.calls)).toEqual([]);
    expect(fixture.labelTracks).toEqual([
      [0, [[0, 0, 'remove']]],
      [1, [[1, 1, 'keep']]],
    ]);
  });

  it('refuses an unaddressable replacement track before removing any labels', async () => {
    const original: LabelTuple[] = [
      [0, 0, 'remove'],
      [1, 1, 'keep'],
    ];
    const fixture = project(
      [label('Cues'), ...Array.from({ length: 101 }, (_, i) => wave(`Audio ${i}`))],
      [[0, original]],
    );
    await expect(labelHandler(fixture.ops)({ action: 'delete', index: 0 })).rejects.toThrow();
    expect(edits(fixture.calls)).toEqual([]);
    expect(fixture.tracks).toHaveLength(102);
    expect(fixture.labelTracks).toEqual([[0, original]]);
  });

  it('refuses reconstruction with the native label naming dialog enabled before removing any labels', async () => {
    const original: LabelTuple[] = [
      [0, 0, 'remove'],
      [1, 1, 'keep'],
    ];
    const fixture = project([label('Cues')], [[0, original]]);
    fixture.labelDialog('1');
    await expect(labelHandler(fixture.ops)({ action: 'delete', index: 0 })).rejects.toThrow('label naming dialog');
    expect(edits(fixture.calls)).toEqual([]);
    expect(fixture.tracks).toHaveLength(1);
    expect(fixture.labelTracks).toEqual([[0, original]]);
  });

  it('refuses an unaddressable future label index before removing the original label track', async () => {
    const original: LabelTuple[] = [
      [0, 0, 'remove'],
      [1, 1, 'keep'],
    ];
    const other: LabelTuple[] = Array.from({ length: 10001 }, (_, i) => [i, i, `Other ${i}`]);
    const fixture = project(
      [label('Cues'), label('Other')],
      [
        [0, original],
        [1, other],
      ],
    );
    await expect(labelHandler(fixture.ops)({ action: 'delete', index: 0 })).rejects.toThrow();
    expect(edits(fixture.calls)).toEqual([]);
    expect(fixture.tracks.map((track) => track.name)).toEqual(['Cues', 'Other']);
    expect(fixture.labelTracks).toEqual([
      [0, original],
      [1, other],
    ]);
  });

  it('reconstructs preserved labels at the largest supported native flat index', async () => {
    const original: LabelTuple[] = [
      [0, 0, 'remove'],
      [1, 1, 'keep'],
    ];
    const other: LabelTuple[] = Array.from({ length: 10000 }, (_, i) => [i, i, `Other ${i}`]);
    const fixture = project(
      [label('Cues'), label('Other')],
      [
        [0, original],
        [1, other],
      ],
    );
    const result = (await labelHandler(fixture.ops)({ action: 'delete', index: 0 })) as { index: number }[];
    expect(result).toHaveLength(10001);
    expect(result.at(-1)).toMatchObject({ index: 10000, text: 'keep' });
    expect(fixture.tracks.map((track) => track.name)).toEqual(['Other', 'Cues']);
    expect(fixture.labelTracks).toEqual([
      [0, other],
      [1, original.slice(1)],
    ]);
  });

  it('refuses unrepresentable preserved label text before deleting any track', async () => {
    const fixture = project(
      [label('Cues')],
      [
        [
          0,
          [
            [0, 0, 'remove'],
            [1, 1, 'say "hello"'],
          ],
        ],
      ],
    );
    await expect(labelHandler(fixture.ops)({ action: 'delete', index: 0 })).rejects.toThrow('double quotes');
    expect(edits(fixture.calls)).toEqual([]);
    expect(fixture.labelTracks[0]?.[1]).toHaveLength(2);
  });

  it('refuses oversized preserved wire text before removing the label track', async () => {
    const fixture = project(
      [label('Cues')],
      [
        [
          0,
          [
            [0, 0, 'remove'],
            [1, 1, '音'.repeat(400)],
          ],
        ],
      ],
    );
    await expect(labelHandler(fixture.ops)({ action: 'delete', index: 0 })).rejects.toThrow('encoded bytes');
    expect(edits(fixture.calls)).toEqual([]);
    expect(fixture.labelTracks[0]?.[1]).toHaveLength(2);
  });

  it('reconstructs a native label track larger than the public insertion limit without losing remaining labels', async () => {
    const nativeLabels: LabelTuple[] = Array.from({ length: 502 }, (_, i) => [i, i + 1, `Native label ${i}`]);
    const fixture = project(
      [label('Cues'), wave('Audio'), label('Other')],
      [
        [0, nativeLabels],
        [2, [[0, 2, 'preserve other track']]],
      ],
    );
    const result = (await labelHandler(fixture.ops)({ action: 'delete', index: 0 })) as {
      track: number;
      text: string;
    }[];
    expect(fixture.tracks.map((track) => track.name)).toEqual(['Audio', 'Other', 'Cues']);
    expect(fixture.labelTracks).toEqual([
      [1, [[0, 2, 'preserve other track']]],
      [2, nativeLabels.slice(1)],
    ]);
    expect(result).toHaveLength(502);
    expect(result[0]).toMatchObject({ track: 1, text: 'preserve other track' });
    expect(result.at(-1)).toMatchObject({ track: 2, text: 'Native label 501' });
  });
});
