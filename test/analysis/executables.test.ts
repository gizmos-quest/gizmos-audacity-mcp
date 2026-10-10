import { writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { describe, expect, it, vi } from 'vitest';
import { measureFile, parseFfmpegMeasurement, parseProbe, probeFile, runFfmpeg } from '../../src/analysis.js';

import { temporary, wav } from '../helpers/audio-fixture.js';

describe('optional process backends and output parsers', () => {
  it('reads only the final EBU R128 summary and overall astats', () => {
    const output = `Summary:
      Integrated loudness:
        I: -1 LUFS
      Loudness range:
        LRA: 99 LU
      True peak:
        Peak: 0 dBFS
      [astats] Channel: 1
      [astats] Peak level dB: -2
      [astats] RMS level dB: -3
      [astats] Overall
      [astats] Peak level dB: -4.2
      [astats] RMS level dB: -19.9
      [ebur128] t: 1 I: -99 LUFS
      [ebur128] Summary:
      Integrated loudness:
        I: -16.0 LUFS
      Loudness range:
        LRA: 3.5 LU
      True peak:
        Peak: -1.2 dBFS`;
    expect(parseFfmpegMeasurement(output)).toEqual({
      integratedLufs: -16,
      loudnessRangeLu: 3.5,
      truePeakDbtp: -1.2,
      peakDbfs: -4.2,
      rmsDbfs: -19.9,
    });
  });
  it('returns null for absent or nonfinite readings rather than a passing zero', () => {
    expect(parseFfmpegMeasurement('Summary:\nIntegrated loudness:\nI: -inf LUFS\nTrue peak:\nPeak: nan dBFS')).toEqual({
      integratedLufs: null,
      loudnessRangeLu: null,
      truePeakDbtp: null,
      peakDbfs: null,
      rmsDbfs: null,
    });
  });
  it('refuses ffmpeg output without a loudness summary', () =>
    expect(() => parseFfmpegMeasurement('Overall\nRMS level dB: -20')).toThrow(/summary/));
  it('filters probe output to useful audio and video metadata', () => {
    expect(
      parseProbe(
        JSON.stringify({
          format: { format_name: 'wav', duration: '2', ignored: 'junk' },
          streams: [
            {
              index: 0,
              codec_name: 'pcm_s16le',
              sample_rate: '48000',
              channels: 1,
              codec_type: 'audio',
              ignored: 'junk',
            },
          ],
        }),
      ),
    ).toEqual({
      format: { format_name: 'wav', duration: '2' },
      streams: [{ index: 0, codec_name: 'pcm_s16le', sample_rate: '48000', channels: 1, codec_type: 'audio' }],
    });
  });
  it.each([
    'null',
    '[]',
    '{}',
    '{"format":[],"streams":[]}',
    '{"format":{},"streams":[null]}',
    '{"format":{},"streams":[[]]}',
    'not json',
  ])('refuses invalid probe output %s', (text) => {
    expect(() => parseProbe(text)).toThrow();
  });
  it('spawns an argument array and captures process diagnostics', async () => {
    expect(
      await runFfmpeg(
        ['-e', 'process.stderr.write(process.argv[1])', 'spaces; $(do-not-execute)'],
        30_000,
        process.execPath,
      ),
    ).toBe('spaces; $(do-not-execute)');
  });
  it('preserves failed-process diagnostics', async () => {
    await expect(
      runFfmpeg(['-e', 'process.stderr.write("codec failed");process.exit(7)'], 30_000, process.execPath),
    ).rejects.toThrow(/exited 7: codec failed/);
  });
  it('reports unavailable executables with an installation hint', async () => {
    await expect(runFfmpeg([], 1000, join(await temporary(), 'absent-ffmpeg'))).rejects.toThrow(
      /ffmpeg unavailable.*Install ffmpeg/,
    );
  });
  it('bounds process runtime and terminates timed-out helper processes', async () => {
    await expect(runFfmpeg(['-e', 'setTimeout(()=>{},10000)'], 100, process.execPath)).rejects.toThrow(
      /exceeded 100 ms/,
    );
  });
  it('bounds diagnostic output', async () => {
    await expect(
      runFfmpeg(['-e', 'process.stderr.write("x".repeat(1048577))'], 30_000, process.execPath),
    ).rejects.toThrow(/exceeded 1 MiB/);
  });
  it.each([0, -1, NaN, 600001, 1.5])('rejects invalid helper timeout %s', async (timeout) => {
    await expect(runFfmpeg([], timeout, process.execPath)).rejects.toThrow(/timeoutMs/);
  });
  it('measures WAV without ffmpeg as a hard dependency', async () => {
    const file = join(await temporary(), 'audio.wav');
    await writeFile(file, wav([0.5, -0.5]));
    vi.stubEnv('AUDACITY_FFMPEG', join(await temporary(), 'absent-ffmpeg'));
    const native = await measureFile(file, { backend: 'wav' });
    expect(native).toMatchObject({ file, rms: 0.5, backend: 'native-wav' });
    const automatic = await measureFile(file);
    expect(automatic.rms).toBe(0.5);
    expect(automatic.integratedLufs).toBeNull();
    expect(automatic.unavailable.integratedLufs).toContain('ffmpeg unavailable');
    await expect(measureFile(file, { backend: 'ffmpeg' })).rejects.toThrow(/ffmpeg unavailable/);
  });
  it('reports both native and optional decoder failures for non-WAV files', async () => {
    const file = join(await temporary(), 'invalid.mp3');
    await writeFile(file, Buffer.alloc(44));
    vi.stubEnv('AUDACITY_FFMPEG', join(await temporary(), 'absent-ffmpeg'));
    await expect(measureFile(file)).rejects.toThrow(/Native WAV measurement:.*RIFF WAV.*ffmpeg unavailable/);
    await expect(measureFile(file, { backend: 'wav' })).rejects.toThrow(/RIFF WAV/);
  });
  it('rejects directories, missing paths and invalid options before measuring', async () => {
    const directory = await temporary();
    await expect(measureFile(directory)).rejects.toThrow(/not a file/);
    await expect(measureFile(join(directory, 'missing.wav'))).rejects.toThrow();
    await expect(measureFile(directory, { timeoutMs: 0 })).rejects.toThrow();
  });
  it('probe reports missing optional tools and rejects unsafe timeouts', async () => {
    const file = join(await temporary(), 'audio.wav');
    await writeFile(file, wav([0]));
    vi.stubEnv('AUDACITY_FFPROBE', join(await temporary(), 'absent-ffprobe'));
    await expect(probeFile(file)).rejects.toThrow(/ffprobe unavailable/);
    await expect(probeFile(file, 0)).rejects.toThrow(/timeoutMs/);
    await expect(probeFile(await temporary())).rejects.toThrow(/not a file/);
  });
});
