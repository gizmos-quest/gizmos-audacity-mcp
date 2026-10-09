import { spawn } from 'node:child_process';
import { stat } from 'node:fs/promises';
import { dirname, extname, join, resolve } from 'node:path';
import { unavailableLoudness } from './types.js';

export interface FfmpegMeasurement {
  integratedLufs: number | null;
  truePeakDbtp: number | null;
  loudnessRangeLu: number | null;
  peakDbfs: number | null;
  rmsDbfs: number | null;
}

/** Read only the final summary and overall statistics, never intermediate frame/channel readings. */
export function parseFfmpegMeasurement(text: string): FfmpegMeasurement {
  const summaryIndex = text.lastIndexOf('Summary:');
  if (summaryIndex < 0) throw new Error('ffmpeg did not return an EBU R128 summary');
  const summary = text.slice(summaryIndex);
  const overallIndex = text.lastIndexOf('Overall');
  const overall = overallIndex < 0 ? '' : text.slice(overallIndex);
  const value = (body: string, expression: RegExp) => {
    const match = expression.exec(body);
    if (!match) return null;
    const number = Number(match[1]);
    return Number.isFinite(number) ? number : null;
  };
  return {
    integratedLufs: value(summary, /Integrated loudness:[\s\S]*?\bI:\s*([-+\d.e]+)\s*LUFS/),
    loudnessRangeLu: value(summary, /Loudness range:[\s\S]*?\bLRA:\s*([-+\d.e]+)\s*LU/),
    truePeakDbtp: value(summary, /True peak:[\s\S]*?Peak:\s*([-+\d.e]+)\s*dBFS/),
    peakDbfs: value(overall, /Peak level dB:\s*([-+\d.e]+)/),
    rmsDbfs: value(overall, /RMS level dB:\s*([-+\d.e]+)/),
  };
}

/** Spawn a fixed executable with argument arrays. Bounds both runtime and captured diagnostic output. */
export function runFfmpeg(
  args: readonly string[],
  timeoutMs = 300_000,
  executable = process.env.AUDACITY_FFMPEG ?? 'ffmpeg',
): Promise<string> {
  if (!Number.isInteger(timeoutMs) || timeoutMs < 1 || timeoutMs > 600_000)
    return Promise.reject(new Error('ffmpeg timeoutMs must be between 1 and 600000'));
  return new Promise((resolveResult, reject) => {
    const child = spawn(executable, [...args], {
      windowsHide: true,
      stdio: ['ignore', 'ignore', 'pipe'],
      shell: false,
    });
    let output = '';
    let failure: Error | undefined;
    const timer = setTimeout(() => {
      failure = new Error(`ffmpeg exceeded ${timeoutMs} ms`);
      child.kill();
    }, timeoutMs);
    child.stderr.setEncoding('utf8');
    child.stderr.on('data', (chunk: string) => {
      if (output.length + chunk.length > 1_048_576) {
        failure = new Error('ffmpeg diagnostic output exceeded 1 MiB');
        child.kill();
      } else output += chunk;
    });
    child.on('error', (error) => {
      clearTimeout(timer);
      reject(new Error(`ffmpeg unavailable: ${error.message}. ${unavailableLoudness}`));
    });
    child.on('close', (code) => {
      clearTimeout(timer);
      if (failure) reject(failure);
      else if (code !== 0) reject(new Error(`ffmpeg exited ${code}: ${output.trim().slice(-8000)}`));
      else resolveResult(output);
    });
  });
}

export function parseProbe(text: string): { format: Record<string, unknown>; streams: Record<string, unknown>[] } {
  const raw: unknown = JSON.parse(text);
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) throw new Error('ffprobe returned invalid metadata');
  const object = raw as Record<string, unknown>;
  const format = object.format;
  if (!format || typeof format !== 'object' || Array.isArray(format) || !Array.isArray(object.streams))
    throw new Error('ffprobe returned no format or streams');
  const pick = (value: Record<string, unknown>, keys: readonly string[]) =>
    Object.fromEntries(keys.flatMap((key) => (value[key] === undefined ? [] : [[key, value[key]]])));
  return {
    format: pick(format as Record<string, unknown>, [
      'format_name',
      'format_long_name',
      'duration',
      'size',
      'bit_rate',
      'tags',
    ]),
    streams: object.streams.map((stream: unknown) => {
      if (!stream || typeof stream !== 'object' || Array.isArray(stream))
        throw new Error('ffprobe returned an invalid stream');
      return pick(stream as Record<string, unknown>, [
        'index',
        'codec_name',
        'codec_long_name',
        'codec_type',
        'sample_fmt',
        'sample_rate',
        'channels',
        'channel_layout',
        'duration',
        'bit_rate',
        'width',
        'height',
        'r_frame_rate',
        'tags',
      ]);
    }),
  };
}

export async function probeFile(
  file: string,
  timeoutMs = 30_000,
): Promise<{ file: string; format: Record<string, unknown>; streams: Record<string, unknown>[] }> {
  if (!Number.isInteger(timeoutMs) || timeoutMs < 1000 || timeoutMs > 120_000)
    throw new Error('ffprobe timeoutMs must be between 1000 and 120000');
  const path = resolve(file);
  if (!(await stat(path)).isFile()) throw new Error(`${path} is not a file`);
  const ffmpeg = process.env.AUDACITY_FFMPEG;
  const executable =
    process.env.AUDACITY_FFPROBE ??
    (ffmpeg && /[\\/]/.test(ffmpeg) ? join(dirname(ffmpeg), `ffprobe${extname(ffmpeg)}`) : 'ffprobe');
  const output = await new Promise<string>((resolveResult, reject) => {
    const child = spawn(
      executable,
      ['-v', 'error', '-show_format', '-show_streams', '-print_format', 'json', '-i', path],
      { windowsHide: true, stdio: ['ignore', 'pipe', 'pipe'], shell: false },
    );
    let stdout = '';
    let stderr = '';
    let failure: Error | undefined;
    const timer = setTimeout(() => {
      failure = new Error(`ffprobe exceeded ${timeoutMs} ms`);
      child.kill();
    }, timeoutMs);
    const capture = (text: string, stdoutStream: boolean) => {
      if (stdout.length + stderr.length + text.length > 1_048_576) {
        failure = new Error('ffprobe output exceeded 1 MiB');
        child.kill();
      } else if (stdoutStream) stdout += text;
      else stderr += text;
    };
    child.stdout.setEncoding('utf8');
    child.stderr.setEncoding('utf8');
    child.stdout.on('data', (text: string) => capture(text, true));
    child.stderr.on('data', (text: string) => capture(text, false));
    child.on('error', (error) => {
      clearTimeout(timer);
      reject(new Error(`ffprobe unavailable: ${error.message}. Install ffmpeg/ffprobe or set AUDACITY_FFPROBE.`));
    });
    child.on('close', (code) => {
      clearTimeout(timer);
      if (failure) reject(failure);
      else if (code !== 0) reject(new Error(`ffprobe exited ${code}: ${stderr.trim().slice(-8000)}`));
      else resolveResult(stdout);
    });
  });
  return { file: path, ...parseProbe(output) };
}
