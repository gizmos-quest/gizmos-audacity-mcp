import { spawnSync } from 'node:child_process';
import { expect, it } from 'vitest';
import { registerAnalysisTools } from '../../../src/analysis/tools.js';
import { temporary } from '../../helpers/audio-fixture.js';
import { fakeOps } from '../../helpers/render-fixture.js';
import { toolRecorder } from '../../helpers/tool-recorder.js';

type Call = (name: string, args?: Record<string, unknown>) => Promise<Record<string, unknown>>;
interface Workflow {
  assertStopped: (state: { running: boolean; entries: string[]; windows: { dialog: boolean }[] }) => void;
  runWorkflow: (call: Call, source: { bed: string; voice: string }, directory: string) => Promise<unknown>;
}
const workflow = (await import(new URL('../../../examples/voiceover/workflow.mjs', import.meta.url).href)) as Workflow;
const source = { bed: 'bed.wav', voice: 'voice.wav' };

function fixture(override?: Call) {
  const calls: { name: string; args: Record<string, unknown> }[] = [];
  const tracks: { name: string; kind: string; mute: number; solo: number }[] = [];
  let voiceMeasures = 0;
  let bedMeasures = 0;
  const call: Call = async (name, args = {}) => {
    calls.push({ name, args });
    if (override) {
      const result = await override(name, args);
      if (Object.keys(result).length) return result;
    }
    if (name === 'audacity_status') return { running: true, tracks: [...tracks] };
    if (name === 'audacity_info') return { Start: 0, End: 12 };
    if (name === 'audacity_import') tracks.push({ name: String(args.name), kind: 'wave', mute: 0, solo: 0 });
    if (name === 'audacity_labels_set') tracks.push({ name: String(args.trackName), kind: 'label', mute: 0, solo: 0 });
    if (name === 'audacity_track_set') {
      const track =
        typeof args.track === 'number' ? tracks[args.track] : tracks.find((track) => track.name === args.track);
      if (!track) throw new Error('fake track does not exist');
      if (args.name !== undefined) track.name = String(args.name);
      if (args.mute !== undefined) track.mute = args.mute ? 1 : 0;
      if (args.solo !== undefined) track.solo = args.solo ? 1 : 0;
    }
    if (name === 'audacity_measure') {
      if (args.track === 'Voice') return { rms: 0.1, dcOffset: voiceMeasures++ ? 0.0001 : 0.008 };
      return { rms: bedMeasures++ ? 0.006 : 0.01 };
    }
    if (name === 'audacity_pipeline') {
      return {
        dryRun: args.dryRun,
        steps: [{ command: 'Normalize' }, { command: 'High-passFilter' }, { command: 'Compressor' }],
      };
    }
    if (name === 'audacity_auto_duck') return { dryRun: args.dryRun };
    if (name === 'audacity_track_edit') {
      tracks.splice(2, 0, { name: 'Mix', kind: 'wave', mute: 0, solo: 0 });
      return { tracks: [...tracks] };
    }
    if (name === 'audacity_loudness_target') {
      return { dryRun: args.dryRun, plan: { achievable: true }, targetCheck: { status: 'met' } };
    }
    if (name === 'audacity_measure_file') {
      return {
        measurement: { duration: 12, sampleRate: 48_000, channels: 2, clippedSamples: 0 },
        targetCheck: { status: 'met' },
      };
    }
    return {};
  };
  return { call, calls };
}

it('requires explicit opt-in before any native lifecycle access', () => {
  const result = spawnSync(process.execPath, ['examples/voiceover/run.mjs'], { encoding: 'utf8', windowsHide: true });
  expect(result.status).toBe(1);
  expect(result.stderr).toContain('Opt in with:');
});

it('refuses running applications, recovery entries and dialogs without changing their state', () => {
  expect(() => workflow.assertStopped({ running: false, entries: [], windows: [] })).not.toThrow();
  for (const state of [
    { running: true, entries: [], windows: [] },
    { running: false, entries: ['retained.aup3'], windows: [] },
    { running: false, entries: [], windows: [{ dialog: true }] },
  ])
    expect(() => workflow.assertStopped(state)).toThrow(/preserve and quit/);
});

it('backs up reviewed edits, retains and mutes originals, and independently checks delivery export', async () => {
  const { call, calls } = fixture();
  await workflow.runWorkflow(call, source, 'example-output');
  expect(calls.filter((entry) => entry.name === 'audacity_import').map((entry) => entry.args.name)).toEqual([
    'Bed',
    'Voice',
  ]);
  const pipeline = calls.findIndex((entry) => entry.name === 'audacity_pipeline' && entry.args.dryRun === false);
  const duck = calls.findIndex((entry) => entry.name === 'audacity_auto_duck' && entry.args.dryRun === false);
  const loudness = calls.findIndex((entry) => entry.name === 'audacity_loudness_target' && entry.args.dryRun === false);
  for (const index of [pipeline, duck, loudness]) {
    expect(calls[index - 1]?.name).toBe('audacity_project');
    expect(calls[index - 1]?.args.action).toBe('save');
  }
  const rename = calls.find((entry) => entry.name === 'audacity_track_set' && entry.args.name === 'Delivery');
  expect(rename?.args.track).toBe(2);
  const mutes = calls.filter((entry) => entry.name === 'audacity_track_set' && entry.args.mute === true);
  expect(mutes.map((entry) => entry.args.track)).toEqual(['Bed', 'Voice']);
  expect(calls.indexOf(mutes[1]!)).toBeLessThan(loudness);
  expect(calls.at(-1)).toMatchObject({ name: 'audacity_measure_file', args: { backend: 'ffmpeg' } });
  expect(calls.filter((entry) => entry.name === 'audacity_labels_file').map((entry) => entry.args.format)).toEqual([
    'chapters',
    'tsv',
    'srt',
  ]);
});

it('refuses a pre-existing project before imports or other mutations', async () => {
  const { call, calls } = fixture(async (name) =>
    name === 'audacity_status' ? { running: true, tracks: [{ name: 'Existing' }] } : {},
  );
  await expect(workflow.runWorkflow(call, source, 'example-output')).rejects.toThrow(/newly launched empty/);
  expect(calls.map((entry) => entry.name)).toEqual(['audacity_status']);
});

it('stops before saving or applying if a cleanup preview changes selection', async () => {
  let selections = 0;
  const { call, calls } = fixture(async (name) => (name === 'audacity_info' ? { Start: selections++, End: 12 } : {}));
  await expect(workflow.runWorkflow(call, source, 'example-output')).rejects.toThrow(/preview changed selection/);
  expect(calls.some((entry) => entry.name === 'audacity_project')).toBe(false);
  expect(calls.some((entry) => entry.name === 'audacity_pipeline' && entry.args.dryRun === false)).toBe(false);
});

it('stops at an unreachable static loudness plan rather than applying gain or exporting', async () => {
  const { call, calls } = fixture(async (name) =>
    name === 'audacity_loudness_target' ? { dryRun: true, plan: { achievable: false } } : {},
  );
  await expect(workflow.runWorkflow(call, source, 'example-output')).rejects.toThrow(/review dynamics/);
  expect(calls.some((entry) => entry.name === 'audacity_loudness_target' && entry.args.dryRun === false)).toBe(false);
  expect(calls.some((entry) => entry.name === 'audacity_export')).toBe(false);
});

it('treats an unknown delivery metric as a failed example rather than a pass', async () => {
  const { call } = fixture(async (name) =>
    name === 'audacity_measure_file' ? { targetCheck: { status: 'unknown' } } : {},
  );
  await expect(workflow.runWorkflow(call, source, 'example-output')).rejects.toThrow(/failed delivery targets/);
});

it('rejects changed output duration even when the requested LUFS and true-peak check passes', async () => {
  const { call } = fixture(async (name) =>
    name === 'audacity_measure_file'
      ? {
          measurement: { duration: 24, sampleRate: 48_000, channels: 2, clippedSamples: 0 },
          targetCheck: { status: 'met' },
        }
      : {},
  );
  await expect(workflow.runWorkflow(call, source, 'example-output')).rejects.toThrow(/unexpected duration/);
});

it('refuses final export if an original track remains audible', async () => {
  let statuses = 0;
  const { call, calls } = fixture(async (name) => {
    if (name !== 'audacity_status' || ++statuses !== 3) return {};
    return {
      running: true,
      tracks: [
        { name: 'Bed', kind: 'wave', mute: 0, solo: 0 },
        { name: 'Voice', kind: 'wave', mute: 1, solo: 0 },
        { name: 'Delivery', kind: 'wave', mute: 0, solo: 0 },
      ],
    };
  });
  await expect(workflow.runWorkflow(call, source, 'example-output')).rejects.toThrow(/original audio must be muted/);
  expect(calls.some((entry) => entry.name === 'audacity_export')).toBe(false);
});

it('consumes the actual measurement envelope returned by the production tool registration', async () => {
  const generator = (await import(new URL('../../../examples/voiceover/generate.mjs', import.meta.url).href)) as {
    generateSource: (directory: string) => { bed: string; voice: string };
  };
  const sources = generator.generateSource(await temporary());
  const { ops, mock } = fakeOps([]);
  const recorder = toolRecorder();
  registerAnalysisTools(recorder.register, ops);
  // Exercise real output shape/file metrics without requiring ffmpeg in hosted unit tests.
  // The live runner separately establishes its LUFS and true-peak targets.
  const { call } = fixture(async (name) =>
    name === 'audacity_measure_file'
      ? ((await recorder.call(name, {
          file: sources.bed,
          backend: 'wav',
          targets: { peakDbfs: { max: 0 } },
        })) as Record<string, unknown>)
      : {},
  );
  const summary = await workflow.runWorkflow(call, sources, 'example-output');
  expect(summary).toMatchObject({
    measured: { duration: 12, sampleRate: 48_000, channels: 2, clippedSamples: 0 },
    deliveryCheck: { targetCheck: { status: 'met' }, measurement: { backend: 'native-wav' } },
  });
  expect(mock.command).not.toHaveBeenCalled();
});
