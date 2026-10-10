import { spawnSync } from 'node:child_process';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, writeFileSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { Client } from '@modelcontextprotocol/client';
import { StdioClientTransport } from '@modelcontextprotocol/client/stdio';
import { generateSource } from './generate.mjs';
import { assertStopped, runWorkflow } from './workflow.mjs';

const root = fileURLToPath(new URL('../..', import.meta.url));

async function main() {
  if (process.argv[2] !== '--live' || process.argv.length > 4) {
    throw new Error('Opt in with: node examples/voiceover/run.mjs --live [new-output-directory]');
  }
  if (process.platform !== 'win32') throw new Error('This example runner qualifies native lifecycle on Windows only');
  const { audacityExe, audacityProcesses, executableVersion } = await import('../../dist/app-process.js');
  const { recoveryEntries } = await import('../../dist/app-config.js');
  const executable = audacityExe();
  if ((await executableVersion(executable)) !== '3.7.8.0') {
    throw new Error(
      'Example requires the actual English Audacity 3.7.8.0 executable; set AUDACITY_EXE to that installation.',
    );
  }
  if ((await audacityProcesses()).length || recoveryEntries().length) {
    throw new Error('Preserve and quit Audacity and inspect recovery entries before running this example.');
  }
  const ffmpeg = process.env.AUDACITY_FFMPEG ?? 'ffmpeg';
  if (spawnSync(ffmpeg, ['-version'], { windowsHide: true, stdio: 'ignore', timeout: 10_000 }).status !== 0) {
    throw new Error('ffmpeg is required for measured LUFS/true peak; put it on PATH or set AUDACITY_FFMPEG.');
  }
  let directory;
  if (process.argv[3]) {
    directory = resolve(process.argv[3]);
    if (existsSync(directory)) throw new Error('Output directory already exists; use a new destination.');
    mkdirSync(directory, { recursive: true });
  } else {
    const work = join(root, '.work');
    mkdirSync(work, { recursive: true });
    directory = mkdtempSync(join(work, 'voiceover-'));
  }
  const journal = { outcome: 'running', audacityVersion: '3.7.8.0', calls: [] };
  const record = () => writeFileSync(join(directory, 'workflow.json'), `${JSON.stringify(journal, null, 2)}\n`);
  record();
  console.log(`Retained example outputs: ${directory}`);
  const client = new Client({ name: 'voiceover-example', version: '1' });
  const env = Object.fromEntries(
    ['AUDACITY_EXE', 'AUDACITY_CONFIG', 'AUDACITY_FFMPEG', 'AUDACITY_FFPROBE'].flatMap((key) =>
      process.env[key] === undefined ? [] : [[key, process.env[key]]],
    ),
  );
  let ownsSession = false;
  let ownedProcess;
  let summary;
  const call = async (name, args = {}) => {
    const entry = { name, arguments: args, startedAt: new Date().toISOString() };
    journal.calls.push(entry);
    record();
    const started = performance.now();
    try {
      const result = await client.callTool({ name, arguments: args }, { timeout: 900_000 });
      const text = result.content
        .filter((item) => item.type === 'text')
        .map((item) => item.text)
        .join('\n');
      entry.elapsedMs = Math.round(performance.now() - started);
      if (result.isError) throw new Error(`${name}: ${text}`);
      try {
        entry.result = result.structuredContent ?? JSON.parse(text);
      } catch {
        entry.result = text;
      }
      record();
      console.log(`${name}: ${entry.elapsedMs} ms`);
      return entry.result;
    } catch (error) {
      entry.elapsedMs = Math.round(performance.now() - started);
      entry.error = error instanceof Error ? error.message : String(error);
      record();
      throw error;
    }
  };
  try {
    await client.connect(
      new StdioClientTransport({ command: process.execPath, args: [join(root, 'dist', 'main.js')], env }),
    );
    assertStopped(await call('audacity_recover', { reconnect: false }));
    if ((await call('audacity_status')).running)
      throw new Error('Audacity started during preflight; existing state was retained.');
    const launched = await call('audacity_launch', { visible: false });
    if (!launched.started) throw new Error('Audacity started outside this runner; existing state was retained.');
    ownsSession = true;
    ownedProcess = launched.processes[0];
    const processes = await audacityProcesses();
    if (
      processes.length !== 1 ||
      resolve(processes[0].executable ?? '').toLowerCase() !== resolve(executable).toLowerCase() ||
      processes[0].fileVersion?.replaceAll(',', '.') !== '3.7.8.0'
    ) {
      throw new Error('Launched process does not match the verified Audacity executable/version.');
    }
    journal.nodeArchitecture = process.arch;
    summary = await runWorkflow(call, generateSource(join(directory, 'source')), directory);
    for (const [file, expected] of [
      ['chapters.txt', '00:00:04.000 Demonstration'],
      ['labels.tsv', '[Synthetic cue 1; example text]'],
      ['subtitles.srt', '00:00:01,000 --> 00:00:03,000'],
    ]) {
      if (!readFileSync(join(directory, file), 'utf8').includes(expected))
        throw new Error(`${file} has unexpected example content`);
    }
    await call('audacity_quit', { saveTo: join(directory, 'result.aup3') });
    ownsSession = false;
    assertStopped(await call('audacity_recover', { reconnect: false }));
    if ((await audacityProcesses()).length || recoveryEntries().length)
      throw new Error('Orderly exit verification failed');
    journal.outcome = 'passed';
    journal.summary = summary;
    record();
    console.log(
      `Passed: ${summary.measured.integratedLufs} LUFS, ${summary.measured.truePeakDbtp} dBTP; project and backups retained.`,
    );
  } catch (error) {
    journal.outcome = 'failed';
    journal.error = error instanceof Error ? error.message : String(error);
    if (ownsSession) {
      try {
        const processes = await audacityProcesses();
        if (
          processes.length !== 1 ||
          processes[0].pid !== ownedProcess?.pid ||
          processes[0].started !== ownedProcess?.started
        ) {
          throw new Error('Audacity process changed; retaining the current project for inspection.');
        }
        await call('audacity_dialogs', { close: true });
        await call('audacity_recover', { closeDialogs: true, reconnect: true });
        await call('audacity_transport', { action: 'stop' });
        await call('audacity_quit', { saveTo: join(directory, 'failed-project.aup3') });
        assertStopped(await call('audacity_recover', { reconnect: false }));
      } catch (cleanupError) {
        journal.cleanupError = cleanupError instanceof Error ? cleanupError.message : String(cleanupError);
      }
    }
    record();
    throw new Error(
      `${journal.error}. Outputs retained at ${directory}.${journal.cleanupError ? ` Audacity cleanup failed: ${journal.cleanupError}` : ''}`,
    );
  } finally {
    await client.close();
  }
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  main().catch((error) => {
    console.error(error.message);
    process.exitCode = 1;
  });
}
