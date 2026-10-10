import { mkdtemp, rm, stat } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { errorMessage } from '../errors.js';
import { AnalysisBudget, AnalysisBudgetError, MAX_DECODED_BYTES } from './budget.js';
import { parseFfmpegMeasurement, runFfmpeg } from './executables.js';
import { type MeasureOptions, MeasureOptionsSchema } from './options.js';
import type { Measurement } from './types.js';
import { measureWavFile } from './wav-metrics.js';

export async function measureFile(file: string, options: MeasureOptions = {}): Promise<Measurement> {
  const validated = MeasureOptionsSchema.parse(options);
  const path = resolve(file);
  if (!(await stat(path)).isFile()) throw new Error(`${path} is not a file`);
  const { backend, dualMono, timeoutMs } = validated;
  const budget = new AnalysisBudget(timeoutMs);
  let result: Measurement;
  try {
    result = await measureWavFile(path, validated.silence, budget);
  } catch (nativeError) {
    if (backend === 'wav' || nativeError instanceof AnalysisBudgetError) throw nativeError;
    const directory = await mkdtemp(join(tmpdir(), 'gizmos-audacity-measure-'));
    try {
      const decoded = join(directory, 'decoded.wav');
      await runFfmpeg(
        [
          '-nostdin',
          '-hide_banner',
          '-loglevel',
          'error',
          '-i',
          path,
          '-map',
          '0:a:0',
          '-vn',
          '-c:a',
          'pcm_f32le',
          '-fs',
          String(MAX_DECODED_BYTES),
          decoded,
        ],
        budget.remaining(),
      );
      // ffmpeg -fs can return success with a truncated output. Such output
      // cannot establish full-file measurements, so refuse it explicitly.
      if ((await stat(decoded)).size >= MAX_DECODED_BYTES)
        throw new AnalysisBudgetError('decoded measurement output reached the 4 GiB WAV limit; select a shorter file');
      result = await measureWavFile(decoded, validated.silence, budget);
      result.backend = 'ffmpeg-decode+native-wav';
      result.notes.push('ffmpeg decoded the first audio stream without changing its sample rate or channel count.');
    } catch (error) {
      throw new Error(`Native WAV measurement: ${errorMessage(nativeError)}. ${errorMessage(error)}`);
    } finally {
      await rm(directory, { recursive: true, force: true });
    }
  }
  result.file = path;
  result.dualMono = dualMono;
  if (backend === 'wav') return result;
  try {
    const output = await runFfmpeg(
      [
        '-nostdin',
        '-hide_banner',
        '-loglevel',
        'info',
        '-i',
        path,
        '-map',
        '0:a:0',
        '-vn',
        '-af',
        `ebur128=peak=true:dualmono=${dualMono ? 'true' : 'false'}:framelog=quiet,astats=metadata=0:reset=0:measure_perchannel=none:measure_overall=Peak_level+RMS_level`,
        '-f',
        'null',
        '-',
      ],
      budget.remaining(),
    );
    const measured = parseFfmpegMeasurement(output);
    for (const key of ['integratedLufs', 'truePeakDbtp', 'loudnessRangeLu'] as const) {
      const metric = measured[key];
      // ebur128 returns a -70 LUFS sentinel for silence and short clips; a
      // sentinel cannot establish that a publishing target has passed.
      if (
        metric !== null &&
        (key !== 'integratedLufs' || (result.duration >= 0.4 && result.rms > 0 && metric > -70)) &&
        (key !== 'loudnessRangeLu' || result.duration >= 3)
      ) {
        result[key] = metric;
        delete result.unavailable[key];
      } else
        result.unavailable[key] = `${key} could not be established by ffmpeg (silence, short audio or absent summary).`;
    }
    result.backend += '+ffmpeg-ebur128';
    result.notes.push(
      `Integrated LUFS uses EBU R128 gating. Mono ${dualMono ? 'uses dual-mono compensation, matching Audacity LoudnessNormalization defaults' : 'uses its actual channel count without dual-mono compensation'}.`,
    );
  } catch (error) {
    if (backend === 'ffmpeg') throw error;
    const reason = errorMessage(error);
    for (const key of ['integratedLufs', 'truePeakDbtp', 'loudnessRangeLu']) result.unavailable[key] = reason;
  }
  return result;
}
