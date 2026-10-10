import { join } from 'node:path';
import { DURATION, SAMPLE_RATE, VOICE_REGIONS } from './generate.mjs';

export const CLEANUP = {
  track: 'Voice',
  preset: 'voice',
  removeDc: true,
  highPassHz: 80,
  compress: true,
  thresholdDb: -18,
  ratio: 3,
  attackMs: 10,
  releaseMs: 150,
  loudness: 'none',
};
export const DUCK = {
  bed: 'Bed',
  voice: 'Voice',
  duckDb: -12,
  thresholdDb: -30,
  fadeDown: 0.15,
  fadeUp: 0.25,
  innerFadeDown: 0,
  innerFadeUp: 0,
  maximumPause: 0.2,
};
export const LOUDNESS = {
  track: 'Delivery',
  targetLufs: -16,
  truePeakCeilingDbtp: -1,
  maxBoostDb: 24,
  toleranceLu: 0.5,
};
export const HOUSE_TARGETS = { integratedLufs: { min: -16.5, max: -15.5 }, truePeakDbtp: { max: -1 } };

export function assertStopped(state) {
  if (state.running || state.entries.length || state.windows.some((window) => window.dialog)) {
    throw new Error(
      'Example requires stopped Audacity with no dialogs or recovery entries; preserve and quit it first.',
    );
  }
}

export async function assertEmptyProject(call) {
  const state = await call('audacity_status');
  if (!state.running || !Array.isArray(state.tracks) || state.tracks.length) {
    throw new Error('Example needs a newly launched empty project; existing project state was retained.');
  }
}

function requirePreview(preview, purpose) {
  if (preview.dryRun !== true) throw new Error(`${purpose} did not return a dry-run plan`);
}

/** The same tool calls a reviewing agent would make; every apply is a separate call. */
export async function runWorkflow(call, source, directory) {
  const output = (name) => join(directory, name);
  await assertEmptyProject(call);
  // Source and project/render sample rates are independent in Audacity.
  await call('audacity_command', {
    command: 'SetProject',
    params: { Rate: SAMPLE_RATE, Name: 'Synthetic voice-over' },
  });
  await call('audacity_import', { file: source.bed, name: 'Bed' });
  await call('audacity_import', { file: source.voice, name: 'Voice' });
  const voiceBefore = await call('audacity_measure', { track: 'Voice', backend: 'ffmpeg' });
  if (!(voiceBefore.rms > 0)) throw new Error('Generated voice is unexpectedly silent');
  const selection = await call('audacity_info', { type: 'Selection' });
  const cleanupPlan = await call('audacity_pipeline', { ...CLEANUP, dryRun: true });
  requirePreview(cleanupPlan, 'Cleanup');
  if (
    cleanupPlan.steps.some((step) =>
      ['NoiseReduction', 'LoudnessNormalization', 'Limiter', 'TruncateSilence'].includes(step.command),
    )
  ) {
    throw new Error('Cleanup plan unexpectedly includes noise reduction, loudness, limiting or timing edits');
  }
  if (JSON.stringify(await call('audacity_info', { type: 'Selection' })) !== JSON.stringify(selection)) {
    throw new Error('Cleanup preview changed selection');
  }
  await call('audacity_project', { action: 'save', file: output('before-cleanup.aup3') });
  await call('audacity_pipeline', { ...CLEANUP, dryRun: false });
  const voiceAfter = await call('audacity_measure', { track: 'Voice', backend: 'ffmpeg' });
  if (Math.abs(voiceAfter.dcOffset) >= Math.abs(voiceBefore.dcOffset)) {
    throw new Error('Cleanup did not reduce the deliberate DC offset');
  }

  await call('audacity_labels_set', {
    trackName: 'Chapters',
    labels: [
      { start: 0, text: 'Opening bed' },
      { start: 4, text: 'Demonstration' },
      { start: 7, text: 'Closing cue' },
    ],
  });
  await call('audacity_labels_set', {
    trackName: 'Script',
    labels: VOICE_REGIONS.map(([start, end], index) => ({
      start,
      end,
      text: `[Synthetic cue ${index + 1}; example text]`,
    })),
  });
  const bedBefore = await call('audacity_measure', { track: 'Bed', backend: 'wav' });
  const duckPlan = await call('audacity_auto_duck', { ...DUCK, dryRun: true });
  requirePreview(duckPlan, 'Ducking');
  await call('audacity_project', { action: 'save', file: output('before-duck.aup3') });
  await call('audacity_auto_duck', { ...DUCK, dryRun: false });
  const bedAfter = await call('audacity_measure', { track: 'Bed', backend: 'wav' });
  if (!(bedAfter.rms < bedBefore.rms * 0.9)) throw new Error('AutoDuck did not measurably reduce the bed');

  const beforeMix = (await call('audacity_status')).tracks;
  const mixed = await call('audacity_track_edit', {
    action: 'mix_new',
    track: 'Bed',
    trackCount: 2,
    start: 0,
    end: DURATION,
  });
  const originalNames = new Set(beforeMix.filter((track) => track.kind === 'wave').map((track) => track.name));
  const newAudio = mixed.tracks.flatMap((track, index) =>
    track.kind === 'wave' && !originalNames.has(track.name) ? [index] : [],
  );
  if (mixed.tracks.length !== beforeMix.length + 1 || newAudio.length !== 1) {
    throw new Error('Mix-to-new did not create exactly one identifiable audio track; inspect retained project');
  }
  // Native inserts the mix below the selected audio, before trailing labels.
  await call('audacity_track_set', { track: newAudio[0], name: 'Delivery', mute: false, solo: false });
  // Mix-to-new preserves originals: mute both to avoid exporting doubled audio.
  await call('audacity_track_set', { track: 'Bed', mute: true, solo: false });
  await call('audacity_track_set', { track: 'Voice', mute: true, solo: false });
  const loudnessPlan = await call('audacity_loudness_target', { ...LOUDNESS, dryRun: true });
  requirePreview(loudnessPlan, 'Loudness');
  if (!loudnessPlan.plan.achievable) {
    throw new Error(
      'Static gain cannot reach the house LUFS target within true-peak headroom; review dynamics before applying.',
    );
  }
  await call('audacity_project', { action: 'save', file: output('before-loudness.aup3') });
  const loudnessResult = await call('audacity_loudness_target', { ...LOUDNESS, dryRun: false });
  if (loudnessResult.targetCheck.status !== 'met')
    throw new Error('Rendered mix did not meet the reviewed loudness target');
  const deliveryTracks = (await call('audacity_status')).tracks;
  const deliveryTrack = deliveryTracks.find((track) => track.name === 'Delivery');
  const originals = deliveryTracks.filter((track) => originalNames.has(track.name));
  if (
    !deliveryTrack ||
    deliveryTrack.mute ||
    originals.length !== originalNames.size ||
    originals.some((track) => !track.mute || track.solo)
  ) {
    throw new Error('Delivery must be audible and original audio must be muted without solo before exporting');
  }
  const delivery = output('delivery.wav');
  await call('audacity_export', { file: delivery, channels: 2, start: 0, end: DURATION });
  for (const [name, format, trackName] of [
    ['chapters.txt', 'chapters', 'Chapters'],
    ['labels.tsv', 'tsv', 'Script'],
    ['subtitles.srt', 'srt', 'Script'],
  ])
    await call('audacity_labels_file', { action: 'export', file: output(name), format, trackName });
  const deliveryCheck = await call('audacity_measure_file', {
    file: delivery,
    backend: 'ffmpeg',
    targets: HOUSE_TARGETS,
  });
  const measured = deliveryCheck.measurement;
  if (deliveryCheck.targetCheck.status !== 'met' || measured?.clippedSamples !== 0) {
    throw new Error('Exported WAV failed delivery targets or contains clipped samples');
  }
  if (
    Math.abs(measured.duration - DURATION) > 1 / SAMPLE_RATE ||
    measured.sampleRate !== SAMPLE_RATE ||
    measured.channels !== 2
  ) {
    throw new Error('Exported WAV has unexpected duration, project sample rate or channel count');
  }
  return {
    voiceBefore,
    voiceAfter,
    bedBefore,
    bedAfter,
    loudnessPlan,
    loudnessResult,
    delivery,
    deliveryCheck,
    measured,
  };
}
