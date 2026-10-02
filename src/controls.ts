import { readFile, readdir } from 'node:fs/promises';
import { dirname, join } from 'node:path';
import { z } from 'zod';
import { COMMAND_IDS, MENU_IDS, SafeString, describeCommand } from './catalogue.js';
import { type ParamValue } from './format.js';
import { configPath, discardStaleRecovery, isRunning, launch, listWindows, recoveryEntries } from './app.js';
import { measureScope, selectionTimes } from './analysis.js';
import type { Ops } from './ops.js';
import { preflightCommand } from './ops.js';
import type { ToolRegistrar } from './tools.js';

export interface MacroStep { command: string; params: Record<string, ParamValue> }
/** Parse saved Audacity macros, validating every step before any of them runs. */
export function parseMacro(source: string, outputTo?: string): MacroStep[] {
  const steps: MacroStep[] = [];
  const add = (step: MacroStep) => {
    steps.push(step); if (steps.length > 1000) throw new Error('macro exceeds 1000 steps');
  };
  for (const [lineNumber, line] of source.split(/\r?\n/).entries()) {
    if (!line.trim() || line.trim().startsWith('#')) continue;
    const match = /^([A-Za-z][A-Za-z0-9_-]*):\s*(.*)$/.exec(line.trim());
    if (!match) throw new Error(`invalid macro line ${lineNumber + 1}`);
    let command = match[1]!; const text = match[2]!;
    if (['ExportMP3', 'ExportWav', 'ExportFlac', 'ExportOgg'].includes(command)) {
      if (text.trim()) throw new Error(`macro ${command} takes no parameters`);
      if (!outputTo) throw new Error(`macro ${command} needs outputTo; automatic destinations are refused`);
      const expected = { ExportMP3: '.mp3', ExportWav: '.wav', ExportFlac: '.flac', ExportOgg: '.ogg' }[command];
      if (!outputTo.toLowerCase().endsWith(expected!)) throw new Error(`${command} requires a ${expected} outputTo`);
      const step = { command: 'Export2', params: { Filename: outputTo, NumChannels: 2 } };
      preflightCommand(step.command, step.params); add(step); continue;
    }
    if (!COMMAND_IDS.includes(command) && !MENU_IDS.includes(command)) throw new Error(`unsafe or unavailable macro command: ${command}`);
    const params: Record<string, ParamValue> = {};
    const tokens = /\s*(?:"([A-Za-z_][A-Za-z0-9_ -]*)"|([A-Za-z_][A-Za-z0-9_ -]*?))=(?:"([^"\r\n]*)"|([^\s]+))/y;
    let offset = 0;
    while (offset < text.length) {
      tokens.lastIndex = offset; const token = tokens.exec(text);
      if (!token) { if (!text.slice(offset).trim()) break; throw new Error(`invalid parameters on macro line ${lineNumber + 1}`); }
      offset = tokens.lastIndex;
      const key = (token[1] ?? token[2])!; const value = (token[3] ?? token[4])!;
      if (key === 'Use_Preset') {
        if (value !== '<Current Settings>' || (describeCommand(command)?.params?.length ?? 0) > 0) {
          throw new Error(`macro preset ${value} is implicit; use explicit catalogue parameters`);
        }
        continue;
      }
      if (key in params) throw new Error(`duplicate macro parameter: ${key}`);
      const type = describeCommand(command)?.params?.find((p) => p.key === key)?.type;
      if (type === 'bool') {
        if (!['0', '1'].includes(value)) throw new Error(`macro boolean ${key} must be 1/0`);
        params[key] = value === '1';
      } else if (type && ['double', 'float', 'int', 'size_t'].includes(type) || ['Track', 'TrackCount', 'Channel', 'ChannelCount'].includes(key)) {
        params[key] = Number(value);
      } else params[key] = value;
    }
    if (MENU_IDS.includes(command) && !describeCommand(command)) {
      if (Object.keys(params).length) throw new Error(`menu ${command} takes no parameters`);
    } else preflightCommand(command, params);
    if (command === 'SampleDataExport' && params.MESSAGES !== 'None') throw new Error('macro SampleDataExport requires MESSAGES=None');
    add({ command, params });
  }
  if (!steps.length) throw new Error('macro has no commands');
  return steps;
}

export const PreferenceValue = z.union([z.string(), z.number().finite(), z.boolean()]);
export function safePreference(name: string, value: string | number | boolean): string {
  // Get/SetPreference keys verified on live 3.7.8 (2026-10-02); no module/device/language changes.
  if (name === '/SamplingRate/DefaultProjectSampleRate') return String(z.union([
    z.literal(8000), z.literal(11025), z.literal(16000), z.literal(22050), z.literal(32000), z.literal(44100),
    z.literal(48000), z.literal(88200), z.literal(96000), z.literal(176400), z.literal(192000),
  ]).parse(value));
  if (name === '/AudioIO/RecordChannels') return String(z.union([z.literal(1), z.literal(2)]).parse(value));
  throw new Error('writable preferences: /SamplingRate/DefaultProjectSampleRate (supported numeric rate), /AudioIO/RecordChannels (1 or 2)');
}

export function registerControlTools(tool: ToolRegistrar, ops: Ops): void {
  let playback: { mode: 'playing' | 'paused' | 'recording' | 'stopped'; start: number; end: number; at: number; epoch: number } =
    { mode: 'stopped', start: 0, end: 0, at: 0, epoch: 0 };
  let pausedMode: 'playing' | 'recording' = 'playing';
  const position = () => playback.mode === 'playing' || playback.mode === 'recording' ?
    Math.min(playback.end, playback.at + (performance.now() - playback.epoch) / 1000) : playback.at;
  tool('audacity_transport',
    'Play a selected region, pause/resume, stop, or record using Audacity’s configured input. status reports selection and a monotonic estimated playback position (the pipe has no audio-clock query); manual transport changes are not tracked. record returns immediately unless duration is supplied.',
    { action: z.enum(['play', 'pause', 'resume', 'stop', 'record', 'status']), start: z.number().finite().min(0).max(86400).optional(),
      end: z.number().finite().min(0).max(86400).optional(), track: z.union([z.number().int().nonnegative(), SafeString.min(1)]).optional(),
      duration: z.number().finite().positive().max(60).optional(), newTrack: z.boolean().default(true) },
    async ({ action, start, end, track, duration, newTrack }) => {
      if (end !== undefined && start !== undefined && end < start) throw new Error('end must be at least start');
      if (duration !== undefined && action !== 'record') throw new Error('duration is used only by record');
      if (action === 'record' && end !== undefined) throw new Error('record takes start and optional duration, not end');
      if (!['play', 'record'].includes(action) && [start, end, track].some((v) => v !== undefined)) throw new Error('scope is used only by play/record');
      if (action === 'play') {
        await ops.run('Stop'); await ops.select({ start, end, track });
        const selection = selectionTimes(await ops.info('Selection'));
        await ops.run('Play'); playback = { mode: 'playing', start: selection.start, end: selection.end, at: selection.start, epoch: performance.now() };
      } else if (action === 'record') {
        await ops.run('Stop');
        if (track !== undefined || start !== undefined) await ops.select({ track, start: start ?? 0, end: start ?? 0 });
        const selection = selectionTimes(await ops.info('Selection'));
        await ops.run(newTrack ? 'Record2ndChoice' : 'Record1stChoice');
        playback = { mode: 'recording', start: selection.start, end: 86400, at: selection.start, epoch: performance.now() };
        if (duration !== undefined) {
          await new Promise((resolve) => setTimeout(resolve, duration * 1000));
          const at = position(); await ops.run('Stop'); playback = { ...playback, mode: 'stopped', at };
        }
      } else if (action === 'stop') {
        const at = position(); await ops.run('Stop'); playback = { ...playback, mode: 'stopped', at };
      } else if (action === 'pause') {
        if (!['playing', 'recording'].includes(playback.mode)) throw new Error('no server-started playback or recording to pause');
        pausedMode = playback.mode as 'playing' | 'recording';
        const at = position(); await ops.run('Pause'); playback = { ...playback, mode: 'paused', at };
      } else if (action === 'resume') {
        if (playback.mode !== 'paused') throw new Error('transport is not paused');
        await ops.run('Pause'); playback = { ...playback, mode: pausedMode, epoch: performance.now() };
      }
      const at = position();
      return { state: playback.mode === 'playing' && at >= playback.end ? 'stopped' : playback.mode,
        positionSeconds: at, positionSource: 'estimated monotonic clock; manual changes are unknown', selection: await ops.info('Selection') };
    });
  tool('audacity_history', 'Undo or redo one or more audio edits. Stops at Audacity’s own first error; does not claim checkpoint rollback across manual edits or saves.',
    { action: z.enum(['undo', 'redo']), steps: z.number().int().min(1).max(100).default(1) }, async ({ action, steps }) => {
      let completed = 0;
      for (; completed < steps; completed++) await ops.run(action === 'undo' ? 'Undo' : 'Redo');
      return { action, completed };
    });
  tool('audacity_project_info', 'Read project tracks, clips, selection, length, active project paths and actual render sample rate. Rate is measured by a tiny temporary WAV export with selection restored; an empty project returns rate=null and its default preference separately.',
    {}, async () => {
      const tracks = await ops.tracks(); const audio = tracks.findIndex((t) => t.kind === 'wave' && t.end > t.start);
      const rate = audio < 0 ? null : (await measureScope(ops, { track: audio, start: tracks[audio]!.start, end: Math.min(tracks[audio]!.end, tracks[audio]!.start + 0.01) }, { backend: 'wav' })).sampleRate;
      return { tracks, clips: await ops.info('Clips'), selection: await ops.info('Selection'), lengthSeconds: await ops.projectEnd(),
        rate, defaultRate: Number(await ops.command('GetPreference', { Name: '/SamplingRate/DefaultProjectSampleRate' })),
        activeProjectFiles: recoveryEntries(), fileSource: 'Audacity config ActiveProjects; entries can include unsaved session databases' };
    });
  tool('audacity_preferences', 'Get a preference or list available preferences. Set is restricted to default project sample rate and recording channel count; never changes modules, UI language, devices or pipe settings. Original value and readback are returned.',
    { action: z.enum(['get', 'list', 'set']), name: SafeString.min(1).optional(), value: PreferenceValue.optional() },
    async ({ action, name, value }) => {
      if (action === 'list') { if (name !== undefined || value !== undefined) throw new Error('list takes no name/value'); return ops.info('Preferences'); }
      if (!name) throw new Error('name is required');
      if (action === 'get') { if (value !== undefined) throw new Error('get takes no value'); return { name, value: await ops.command('GetPreference', { Name: name }) }; }
      if (value === undefined) throw new Error('value is required');
      const encoded = safePreference(name, value); const before = await ops.command('GetPreference', { Name: name });
      await ops.run('SetPreference', { Name: name, Value: encoded, Reload: false });
      return { name, before, value: await ops.command('GetPreference', { Name: name }) };
    });
  tool('audacity_macros', 'List or apply saved local Audacity macros without opening the Macro Manager. Every step is parsed and checked first; dryRun lists steps. Modal/lifecycle commands and implicit effect presets are refused. Export macros need explicit outputTo.',
    { action: z.enum(['list', 'apply']), name: SafeString.min(1).optional(), dryRun: z.boolean().default(false), outputTo: SafeString.min(1).optional() },
    async ({ action, name, dryRun, outputTo }) => {
      const directory = join(dirname(configPath()), 'Macros');
      const files = (await readdir(directory)).filter((f) => f.toLowerCase().endsWith('.txt')).sort();
      if (action === 'list') {
        return { directory, macros: await Promise.all(files.map(async (file) => {
          try { return { name: file.slice(0, -4), steps: parseMacro(await readFile(join(directory, file), 'utf8')), safe: true }; }
          catch (e) { return { name: file.slice(0, -4), safe: false, reason: (e as Error).message }; }
        })) };
      }
      const file = files.find((f) => f.slice(0, -4) === name);
      if (!file) throw new Error('macro name does not exist; use list');
      const steps = parseMacro(await readFile(join(directory, file), 'utf8'), outputTo);
      if (dryRun) return { name, dryRun, steps };
      if (steps.some((step) => step.command === 'NoiseReduction')) ops.requireNoiseProfile();
      for (const step of steps) {
        if (step.command === 'Export2') await ops.exportMix(String(step.params.Filename), Number(step.params.NumChannels));
        else if (COMMAND_IDS.includes(step.command)) await ops.command(step.command, step.params, 600_000);
        else await ops.run(step.command, step.params, 600_000);
      }
      return { name, dryRun, completed: steps.length };
    });
  tool('audacity_recover', 'Inspect process, pipe and crash-recovery entries; optionally close blocking dialogs and reconnect after a timeout. Never kills Audacity or replays edits. discardRecovery clears stale config entries only while Audacity is stopped, saving the config first and retaining all project files.',
    { closeDialogs: z.boolean().default(false), reconnect: z.boolean().default(true), discardRecovery: z.boolean().default(false),
      visible: z.boolean().default(false) }, async ({ closeDialogs, reconnect, discardRecovery, visible }) => {
      const running = await isRunning(); const entries = recoveryEntries();
      const windows = process.platform === 'win32' ? await listWindows(closeDialogs) : [];
      if (discardRecovery && running) throw new Error('stop Audacity cleanly before discarding stale recovery entries');
      const discarded = discardRecovery && entries.length ? await discardStaleRecovery() : null;
      if (!reconnect) return { running, entries, windows, discarded, needsRecovery: ops.pipe.needsRecovery };
      if (windows.some((w) => w.dialog && !w.closed)) throw new Error('blocking dialogs remain; use closeDialogs=true');
      ops.pipe.reset();
      if (!running) { await launch(visible); ops.freshApplication(); }
      const tracks = await ops.tracks();
      await ops.restoreImportPreferences();
      return { running: true, entries: recoveryEntries(), windows: process.platform === 'win32' ? await listWindows(false) : [], discarded, tracks };
    });
}
