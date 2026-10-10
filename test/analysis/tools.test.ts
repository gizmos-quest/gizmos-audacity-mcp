import { writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { z } from 'zod';
import { TARGETS } from '../../src/analysis/targets.js';
import { registerAnalysisTools } from '../../src/analysis/tools.js';
import { temporary, wav } from '../helpers/audio-fixture.js';
import { fakeOps, label, voice } from '../helpers/render-fixture.js';
import { toolRecorder } from '../helpers/tool-recorder.js';

/** Registers the analysis tools over a rendered-export fake; each Export2 writes the next sample list. */
function tools(exports: number[][] = []) {
  const session = fakeOps([voice, { ...voice, name: 'Room', selected: 0 }, label]);
  const original = session.mock.command.getMockImplementation()!;
  session.mock.command.mockImplementation(async (id, params, timeout) => {
    const samples = id === 'Export2' ? exports.shift() : undefined;
    if (!samples) return original(id, params, timeout);
    await writeFile(String(params.Filename), wav(samples));
    return '';
  });
  const recorder = toolRecorder();
  registerAnalysisTools(recorder.register, session.ops);
  return { ...session, call: recorder.call };
}
async function file(samples: number[]): Promise<string> {
  const path = join(await temporary(), 'source.wav');
  await writeFile(path, wav(samples));
  return path;
}

describe('analysis tool registrations', () => {
  it('registers eight strictly typed analysis tools with useful descriptions', async () => {
    const tools = new Map<
      string,
      { shape: z.ZodRawShape; handler: (args: never) => Promise<unknown>; description: string }
    >();
    const register: Parameters<typeof registerAnalysisTools>[0] = (name, description, shape, handler) => {
      tools.set(name, { shape, handler: handler as (args: never) => Promise<unknown>, description });
    };
    const { ops } = fakeOps([voice]);
    registerAnalysisTools(register, ops);
    expect([...tools.keys()]).toEqual([
      'audacity_loudness_target',
      'audacity_silence',
      'audacity_probe_file',
      'audacity_measure',
      'audacity_measure_file',
      'audacity_compare_files',
      'audacity_targets',
      'audacity_contrast',
    ]);
    for (const { shape, description } of tools.values()) {
      expect(description.length).toBeGreaterThan(80);
      expect(z.object(shape).strict().safeParse({ arbitrary: 1 }).success).toBe(false);
    }
    expect(tools.get('audacity_loudness_target')!.description).toContain(
      'dryRun returns the measured input and Amplify plan without applying gain',
    );
    for (const name of ['audacity_measure', 'audacity_measure_file'])
      expect(tools.get(name)!.description).toContain(
        'With targets, returns {measurement,targetCheck}; otherwise returns the measurement directly',
      );
    const targetTool = tools.get('audacity_targets')!;
    expect(await targetTool.handler({} as never)).toMatchObject({ presets: TARGETS });
    const silence = tools.get('audacity_silence')!;
    const args = z.object(silence.shape).strict().parse({ track: 0 });
    expect(await silence.handler(args as never)).toMatchObject({
      regions: [{ start: 2, end: 2.5, duration: 0.5 }],
      count: 1,
      truncated: false,
    });
    const invalidArgs = z.object(silence.shape).strict().parse({ file: 'source.wav', track: 0 });
    await expect(silence.handler(invalidArgs as never)).rejects.toThrow(/file cannot be combined/);
  });
  it('validates both contrast ranges before contacting Audacity or changing selection', async () => {
    const handlers = new Map<string, (args: unknown) => Promise<unknown>>();
    const register: Parameters<typeof registerAnalysisTools>[0] = (name, _description, shape, handler) => {
      handlers.set(name, (args) => handler(z.object(shape).strict().parse(args)));
    };
    const { ops, mock } = fakeOps([voice]);
    registerAnalysisTools(register, ops);
    await expect(
      handlers.get('audacity_contrast')!({
        foreground: { track: 0, start: 2, end: 3 },
        background: { track: 0, start: 3, end: 2 },
      }),
    ).rejects.toThrow(/end must be after start/);
    expect(mock.tracks).not.toHaveBeenCalled();
    expect(mock.command).not.toHaveBeenCalled();
  });
  it.each([1, 2])(
    'preflights nonexistent or non-audio background track %i before exporting the foreground',
    async (track) => {
      const handlers = new Map<string, (args: unknown) => Promise<unknown>>();
      const register: Parameters<typeof registerAnalysisTools>[0] = (name, _description, shape, handler) => {
        handlers.set(name, (args) => handler(z.object(shape).strict().parse(args)));
      };
      const { ops, mock } = fakeOps([voice, label]);
      registerAnalysisTools(register, ops);
      await expect(
        handlers.get('audacity_contrast')!({
          foreground: { track: 0, start: 2, end: 3 },
          background: { track, start: 2, end: 3 },
        }),
      ).rejects.toThrow();
      expect(mock.command).not.toHaveBeenCalled();
      expect(mock.run).not.toHaveBeenCalled();
    },
  );

  it('returns a flat measurement, or the measurement with its target check when targets are given', async () => {
    const { call } = tools();
    const flat = await call('audacity_measure', { track: 0, backend: 'wav' });
    expect(flat).toMatchObject({ peak: 0.5, backend: 'native-wav', scope: { tracks: [0], start: 2, end: 3 } });
    const checked = await call('audacity_measure', { track: 0, backend: 'wav', targets: { peakDbfs: { max: -1 } } });
    expect(checked).toMatchObject({ measurement: { peak: 0.5 }, targetCheck: { status: 'met' } });
  });

  it('measures and compares files with the same settings and checks targets on the result', async () => {
    const { call, mock } = tools();
    const before = await file([0.5, -0.5, 0.5, -0.5]);
    const after = await file([0.25, -0.25, 0.25, -0.25]);
    expect(await call('audacity_measure_file', { file: after, backend: 'wav' })).toMatchObject({ peak: 0.25 });
    const compared = await call('audacity_compare_files', {
      before,
      after,
      backend: 'wav',
      targets: { peakDbfs: { max: -10 } },
    });
    expect(compared).toMatchObject({
      before: { peak: 0.5 },
      after: { peak: 0.25 },
      delta: { peakDbfs: { change: expect.closeTo(-6.0206, 4) } },
      targetCheck: { status: 'met' },
    });
    expect(compared).not.toHaveProperty('delta.integratedLufs');
    expect(mock.command).not.toHaveBeenCalled();
  });

  it('reports file silence in file seconds without touching Audacity', async () => {
    const { call, mock } = tools();
    const source = await file([0.5, ...Array(10).fill(0), 0.5]);
    expect(await call('audacity_silence', { file: source, minimumSeconds: 0.5 })).toMatchObject({
      regions: [{ start: 0.1, end: 1.1, duration: 1 }],
      count: 1,
      truncated: false,
      file: source,
    });
    expect(mock.tracks).not.toHaveBeenCalled();
  });

  it.each([
    [[0.03125, -0.03125, 0.03125, -0.03125], 'met', 24.0824],
    [[0.25, -0.25, 0.25, -0.25], 'missed', 6.0206],
    [[0, 0, 0, 0], 'unknown', null],
  ])('compares foreground and background RMS (%j -> %s)', async (background, status, difference) => {
    const { call } = tools([[0.5, -0.5, 0.5, -0.5], background]);
    const result = await call('audacity_contrast', {
      foreground: { track: 0, start: 2, end: 3 },
      background: { track: 'Room', start: 2, end: 3 },
    });
    expect(result).toMatchObject({ status, minimumDb: 20 });
    if (difference === null) expect(result).toMatchObject({ differenceDb: null, reason: expect.any(String) });
    else expect((result as { differenceDb: number }).differenceDb).toBeCloseTo(difference, 4);
  });
});
