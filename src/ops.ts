// The operations behind the MCP tools. Each one is a short, ordered series
// of pipe commands; every reply is checked, so a failed step stops the rest.
import { AudacityPipe, type PipeReply } from './pipe.js';
import { catalogueCommand, formatCommand, parseInfoJson, type ParamValue } from './format.js';
import { COMMAND_IDS, MENU_IDS, commandSchema } from './catalogue.js';
import { existsSync, statSync } from 'node:fs';
import { dirname, extname, resolve } from 'node:path';

export class CommandFailed extends Error {
  constructor(
    readonly command: string,
    readonly reply: PipeReply,
  ) {
    super(`Audacity rejected "${command}": ${reply.body || reply.status}`);
  }
}

export interface TrackInfo {
  name: string;
  kind: string;
  start: number;
  end: number;
  volume?: number;
  pan?: number;
  mute?: number;
  solo?: number;
  channels?: number;
  selected?: number;
  focused?: number;
}

export type TrackRef = number | string;

export class Ops {
  constructor(readonly pipe: AudacityPipe) {}
  private noiseProfile: 'unknown' | { track: number; name: string; start: number; end: number } | undefined = 'unknown';
  private importPreferences: { name: string; value: string }[] = [];

  /** Only call after starting a new Audacity process, never after a pipe reset. */
  freshApplication(): void { this.noiseProfile = undefined; }

  requireNoiseProfile(): void {
    if (this.noiseProfile === undefined || this.noiseProfile === 'unknown') {
      throw new Error('NoiseReduction needs a profile captured by this server in a fresh Audacity process. Use audacity_fresh with backupTo, then audacity_noise_profile. Audacity 3.7.8 has no profile-reset or effect-parameter scripting API.');
    }
  }

  private invalidateNoiseProfile(id: string, params: Record<string, unknown>): void {
    if (this.noiseProfile && this.noiseProfile !== 'unknown' &&
        (['Import2', 'OpenProject2', 'RemoveTracks', 'NewMonoTrack', 'NewStereoTrack', 'NewLabelTrack', 'MixAndRender', 'MixAndRenderToNewTrack', 'Duplicate', 'SplitNew', 'Undo', 'Redo'].includes(id) ||
         (['SetTrack', 'SetTrackStatus'].includes(id) && params.Name !== undefined))) this.noiseProfile = 'unknown';
  }

  async raw(command: string, timeoutMs?: number): Promise<string> {
    const reply = await this.pipe.send(command, timeoutMs);
    if (!reply.ok) throw new CommandFailed(command, reply);
    return reply.body;
  }

  /** Only the transport tool may call this, after its recording preflight. */
  record(command: 'Record1stChoice' | 'Record2ndChoice'): Promise<string> {
    // Recording can add tracks before a reply arrives. Never keep a profile
    // whose source identity might have changed after an uncertain send.
    this.noiseProfile = 'unknown';
    return this.raw(formatCommand(command));
  }

  run(id: string, params: Record<string, ParamValue | undefined> = {}, timeoutMs?: number): Promise<string> {
    if (!COMMAND_IDS.includes(id) && !MENU_IDS.includes(id) && !['SaveProject2', 'OpenProject2', 'SetPreference'].includes(id)) {
      throw new Error(`command is not in the safe Audacity catalogue: ${id}`);
    }
    if (!MENU_IDS.includes(id)) commandSchema(id).parse(Object.fromEntries(Object.entries(params).filter(([,v]) => v !== undefined)));
    this.invalidateNoiseProfile(id, params);
    const command = formatCommand(id, params);
    return id === 'Import2' ? this.importWithoutTempoDetection(command, timeoutMs) : this.raw(command, timeoutMs);
  }

  /** A catalogue command (effects included), validated against Audacity's own parameter list. */
  command(id: string, params: Record<string, unknown> = {}, timeoutMs?: number): Promise<string> {
    const command = preflightCommand(id, params);
    if (id === 'NoiseReduction') {
      this.requireNoiseProfile();
      return this.reduceProfiledNoise(command, timeoutMs);
    }
    this.invalidateNoiseProfile(id, params);
    return id === 'Import2' ? this.importWithoutTempoDetection(command, timeoutMs) : this.raw(command, timeoutMs);
  }

  /** Restore pending import guards after an explicitly recovered pipe. */
  async restoreImportPreferences(): Promise<void> {
    while (this.importPreferences.length) {
      const pref = this.importPreferences[0]!;
      await this.raw(formatCommand('SetPreference', { Name: pref.name, Value: pref.value, Reload: false }));
      this.importPreferences.shift();
    }
  }

  private async importWithoutTempoDetection(command: string, timeoutMs?: number): Promise<string> {
    await this.restoreImportPreferences();
    // Live 3.7.8 (2026-10-02): Import2 can return OK before asynchronous
    // "Music Import" dialogs appear. These two verified preference values
    // disable detection for empty/existing projects without changing timing.
    const guards = [
      { name: '/FileFormats/MusicFileImportSettingChoice', safe: 'No', fallback: 'Ask', values: ['Yes', 'Ask', 'No'] },
      { name: '/FileFormats/MusicFileImportOnExistingProjectSettingChoice', safe: 'DoNothing', fallback: 'MatchIfBeatsAndMeasures', values: ['Match', 'MatchIfBeatsAndMeasures', 'DoNothing'] },
    ];
    let operationError: unknown;
    try {
      for (const guard of guards) {
        const reply = await this.pipe.send(formatCommand('GetPreference', { Name: guard.name }));
        // An absent preference returns Failed with no body; these are the
        // native 3.7.8 defaults, restored as explicit canonical choices.
        if (!reply.ok && reply.body) throw new CommandFailed('GetPreference', reply);
        const value = reply.body || guard.fallback;
        if (!guard.values.includes(value)) throw new Error(`unsupported music-import preference ${guard.name}: ${value}`);
        this.importPreferences.push({ name: guard.name, value });
        await this.raw(formatCommand('SetPreference', { Name: guard.name, Value: guard.safe, Reload: false }));
      }
      return await this.raw(command, timeoutMs);
    } catch (error) { operationError = error; throw error; }
    finally {
      // A timeout has unknown outcome. Keep the saved preferences for explicit
      // recovery instead of attempting another exchange against a blocked pipe.
      if (!this.pipe.needsRecovery) {
        try { await this.restoreImportPreferences(); }
        catch (error) {
          if (operationError !== undefined) throw new Error(`${operationError instanceof Error ? operationError.message : String(operationError)}. Import preference restoration also failed: ${error instanceof Error ? error.message : String(error)}`);
          throw error;
        }
      }
    }
  }

  private async reduceProfiledNoise(command: string, timeoutMs?: number): Promise<string> {
    const profile = this.noiseProfile;
    if (!profile || profile === 'unknown') throw new Error('noise-profile state changed');
    const selected = (await this.tracks()).flatMap((t, i) => t.kind === 'wave' && t.selected ? [{ ...t, index: i }] : []);
    // Native 3.7.8 opens a modal on profile/source sample-rate mismatch.
    // Direct GetInfo omits source rates. Capture queries a silent sample-data
    // header; reduction conservatively stays on that unchanged tracked audio
    // track, invalidating after track-structure/history edits.
    if (selected.length !== 1 || selected[0]!.index !== profile.track || selected[0]!.name !== profile.name) {
      throw new Error('NoiseReduction must select only the unchanged audio track used to capture this profile; cross-track reduction is not supported');
    }
    return this.raw(command, timeoutMs);
  }

  async info(type: string): Promise<unknown> {
    return parseInfoJson(await this.run('GetInfo', { Type: type, Format: 'JSON' }));
  }

  async tracks(): Promise<TrackInfo[]> {
    return (await this.info('Tracks')) as TrackInfo[];
  }

  async trackIndex(ref: TrackRef): Promise<number> {
    const tracks = await this.tracks();
    if (typeof ref === 'number') {
      if (!Number.isInteger(ref) || ref < 0 || ref >= tracks.length) {
        throw new Error(`track ${ref} does not exist (the project has ${tracks.length})`);
      }
      return ref;
    }
    const matches = tracks.flatMap((t, i) => (t.name === ref ? [i] : []));
    if (matches.length !== 1) {
      throw new Error(`track name "${ref}" matches ${matches.length} tracks; use a unique name or the index`);
    }
    return matches[0]!;
  }

  async select(scope: { start?: number; end?: number; track?: TrackRef; trackCount?: number }): Promise<void> {
    const params: Record<string, ParamValue | undefined> = { Mode: 'Set' };
    if (scope.trackCount !== undefined && scope.track === undefined) throw new Error('trackCount requires track');
    if (scope.start !== undefined && scope.end !== undefined && scope.end < scope.start) throw new Error('end must be at least start');
    if (scope.track !== undefined) {
      params.Track = await this.trackIndex(scope.track);
      params.TrackCount = scope.trackCount ?? 1;
      if ((params.Track as number) + (params.TrackCount as number) > (await this.tracks()).length) throw new Error('trackCount exceeds the available tracks');
    }
    if (scope.start !== undefined || scope.end !== undefined) {
      if (scope.track === undefined) {
        params.Start = scope.start ?? 0;
        params.End = scope.end ?? (await this.projectEnd());
      }
    }
    if (params.Track === undefined) {
      const tracks = await this.tracks();
      if (!tracks.length) throw new Error('the project has no tracks to select');
      await this.run('Select', { Track: 0, TrackCount: tracks.length, Start: params.Start ?? 0,
        End: params.End ?? await this.projectEnd(), Mode: 'Set' });
      return;
    }
    if (params.Start === undefined) {
      // Only the tracks' own extent: an effect over empty timeline would fill it with silence clips.
      const tracks = (await this.tracks()).slice(params.Track as number, (params.Track as number) + (params.TrackCount as number));
      params.Start = scope.start ?? Math.min(...tracks.map((t) => t.start ?? 0));
      params.End = scope.end ?? Math.max(...tracks.map((t) => t.end ?? 0));
    }
    if ((params.End as number) < (params.Start as number)) throw new Error('end must be at least start within the selected tracks');
    await this.run('Select', params);
  }

  async projectEnd(): Promise<number> {
    const tracks = await this.tracks();
    return tracks.reduce((end, t) => Math.max(end, t.end ?? 0), 0);
  }

  /** Import a file as a new track, name it and place its clip at `start` seconds. */
  async importTrack(file: string, name?: string, start = 0): Promise<{ track: number; name: string }> {
    if (!existsSync(file) || !statSync(file).isFile()) throw new Error(`${file} is not an existing audio file`);
    const before = (await this.tracks()).length;
    await this.run('Import2', { Filename: file }, 300_000);
    const after = await this.tracks();
    if (after.length <= before) throw new Error(`import added no track: ${file}`);
    const track = before; // a stereo file is one track
    if (name) {
      await this.run('SelectTracks', { Track: track, TrackCount: 1, Mode: 'Set' });
      await this.run('SetTrack', { Name: name });
    }
    if (start !== 0) {
      await this.run('Select', { Track: track, TrackCount: 1, Start: 0, End: 0.001, Mode: 'Set' });
      await this.run('SetClip', { At: 0, Start: start });
    }
    return { track, name: (await this.tracks())[track]?.name ?? name ?? '' };
  }

  async moveClip(track: TrackRef, at: number, start: number): Promise<void> {
    const index = await this.trackIndex(track);
    const clips = await this.info('Clips') as { track: number; start: number; end: number }[];
    const matches = clips.filter((clip) => clip.track === index && clip.start <= at && at < clip.end);
    if (matches.length !== 1) throw new Error(`time ${at}s identifies ${matches.length} clips on track ${index}; choose a point inside one clip`);
    const clip = matches[0]!;
    // Native SetClip includes both ends (live 3.7.8). Resolve the half-open
    // public range first, then use an interior point to avoid moving neighbors.
    const interior = at > clip.start ? at : clip.start + (clip.end - clip.start) / 2;
    // Live 3.7.8: SetClip ignores a Track wire key and visits selected tracks.
    await this.run('SelectTracks', { Track: index, TrackCount: 1, Mode: 'Set' });
    await this.run('SetClip', { At: interior, Start: start });
  }

  /**
   * Replace (or extend) a track's volume envelope. Values are linear gain
   * factors (1 = unchanged, 0.5 = -6 dB); points apply to every clip of the
   * track that covers their time.
   */
  async setEnvelope(track: TrackRef, points: { time: number; value: number }[], replace = true): Promise<number> {
    const index = await this.trackIndex(track);
    const end = await this.projectEnd();
    await this.run('Select', { Track: index, TrackCount: 1, Start: 0, End: Math.max(end, 0.001), Mode: 'Set' });
    if (replace) await this.run('SetEnvelope', { Delete: true });
    for (const point of points) {
      await this.run('SetEnvelope', { Time: point.time, Value: point.value });
    }
    return points.length;
  }

  /** Add a label track (or reuse the last one) and write the labels in order. */
  async setLabels(unsorted: { start: number; end?: number; text: string }[], trackName = 'Labels'): Promise<number> {
    // SetLabel uses a flat index across label tracks. Audacity sorts insertions
    // by time, so identify the added tuple rather than assuming an append index.
    const labels = [...unsorted].sort((a, b) => a.start - b.start);
    if (labels.some((label) => label.end !== undefined && label.end < label.start)) throw new Error('label end must be at least start');
    const tracks = await this.tracks();
    const matchingTracks = tracks.flatMap((t, i) => t.kind === 'label' && t.name === trackName ? [i] : []);
    if (matchingTracks.length > 1) throw new Error(`multiple label tracks named ${trackName}; rename them uniquely`);
    let labelTrack = matchingTracks[0] ?? -1;
    if (labelTrack < 0) {
      await this.run('NewLabelTrack');
      labelTrack = tracks.length;
      await this.run('SelectTracks', { Track: labelTrack, TrackCount: 1, Mode: 'Set' });
      await this.run('SetTrack', { Name: trackName });
    }
    for (const label of labels) {
      const end = label.end ?? label.start;
      const before = await this.info('Labels') as [number, [number, number, string][]][];
      await this.run('Select', { Track: labelTrack, TrackCount: 1, Start: label.start, End: end, Mode: 'Set' });
      await this.run('AddLabel');
      const after = await this.info('Labels') as [number, [number, number, string][]][];
      let offset = 0; let inserted = -1;
      for (const [track, values] of after) {
        if (track === labelTrack) {
          const old = before.find(([t]) => t === track)?.[1] ?? [];
          // Find the added tuple as a multiset difference, including identical times.
          const remaining = [...old]; const added: number[] = [];
          for (const [i, value] of values.entries()) {
            const prior = remaining.findIndex((v) => JSON.stringify(v) === JSON.stringify(value));
            if (prior >= 0) remaining.splice(prior, 1);
            else added.push(i);
          }
          // The one added tuple is authoritative; printed times may round high-precision selections.
          if (added.length === 1) inserted = offset + added[0]!;
        }
        if (inserted >= 0) break;
        offset += values.length;
      }
      if (inserted < 0) throw new Error('Audacity did not expose the newly added label');
      await this.run('SetLabel', { Label: inserted, Text: label.text, Start: label.start, End: end, Selected: false });
    }
    // AddLabel leaves the last label in text editing, where Select All would select its text.
    await this.run('SelectNone');
    return labels.length;
  }

  async applyEffect(
    effect: string,
    params: Record<string, unknown>,
    scope: { start?: number; end?: number; track?: TrackRef; trackCount?: number },
  ): Promise<string> {
    preflightCommand(effect, params); // Validate safety as well as types before changing selection.
    if (effect === 'NoiseReduction') this.requireNoiseProfile();
    await this.select(scope);
    return this.command(effect, params, 600_000);
  }

  /** Capture a noise profile from a stretch of pure noise (Noise Reduction step one). */
  async captureNoiseProfile(track: TrackRef, start: number, end: number): Promise<void> {
    const index = await this.trackIndex(track);
    const info = (await this.tracks())[index]!;
    if (info.kind !== 'wave' || start < info.start || end > info.end || !(end > start)) throw new Error('noise profile must be a non-empty interval inside an audio track');
    if (this.noiseProfile === 'unknown') throw new Error('Existing Audacity noise-profile state is unknown. Use audacity_fresh with backupTo before capturing room tone.');
    if (this.noiseProfile !== undefined) {
      if (this.noiseProfile.track === index && this.noiseProfile.start === start && this.noiseProfile.end === end) return;
      throw new Error('Audacity 3.7.8 can capture only one scripted noise profile per process. Use audacity_fresh with backupTo before choosing different room tone.');
    }
    // Live verified 3.7.8: first no-parameter call profiles, subsequent calls
    // reduce; Reduction/Sensitivity/Smoothing are ignored, not controllable.
    // Prevent the native "profile too short" modal before the first call.
    const clips = await this.info('Clips') as { track: number; start: number; end: number }[];
    const intersecting = clips.filter((clip) => clip.track === index && clip.start < end && start < clip.end);
    if (intersecting.length !== 1 || intersecting[0]!.start > start || intersecting[0]!.end < end) {
      throw new Error('noise profile must be contained in one audio clip, without timeline gaps or overlapping clips');
    }
    const { measureScope } = await import('./analysis.js');
    const measured = await measureScope(this, { track: index, start, end }, { backend: 'wav' });
    if (measured.frames < 4096) throw new Error('noise profile must contain at least 4096 rendered samples; select a longer room-tone interval');
    // Live 3.7.8: an 8 kHz source rendered at 48 kHz can pass the WAV frame
    // minimum while still opening the native profile-too-short dialog.
    const { measureSourceFrames } = await import('./source-rate.js');
    if (await measureSourceFrames(this, { track: index, start, end }) < 4096) {
      throw new Error('noise profile must contain at least 4096 source samples; select a longer room-tone interval');
    }
    await this.select({ track: index, start, end });
    this.noiseProfile = 'unknown'; // A lost reply must never cause profile replay.
    await this.run('NoiseReduction', {}, 120_000);
    this.noiseProfile = { track: index, name: info.name, start, end };
  }

  /** Export the mix of all unmuted tracks (or a time range of it) to a file. */
  async exportMix(file: string, channels = 2, start?: number, end?: number): Promise<void> {
    validateExportFile(file);
    // An explicit time and track selection, never Select All: with a label in text editing
    // Select All selects the label's text and the export comes out empty.
    const tracks = await this.tracks();
    if (tracks.length === 0) throw new Error('the project has no tracks to export');
    const from = start ?? 0;
    const to = end ?? (await this.projectEnd());
    if (!(to > from)) throw new Error(`nothing to export between ${from}s and ${to}s`);
    await this.run('Select', { Start: from, End: to, Track: 0, TrackCount: tracks.length, Mode: 'Set' });
    await this.run('Export2', { Filename: file, NumChannels: channels }, 600_000);
  }
}

/** Public track pan is normalized; native SetTrack Pan is a percentage. */
export function trackPanPercent(value: number): number {
  if (!Number.isFinite(value) || value < -1 || value > 1) throw new RangeError('pan must be finite and between -1 and 1');
  return value * 100;
}

export function validateExportFile(file: string): void {
  // Opus Export2 opens a modal error; AIFF fails (live 3.7.8, 2026-10-02).
  if (!['.wav', '.flac', '.mp3', '.ogg'].includes(extname(file).toLowerCase())) {
    throw new Error('export requires a .wav, .flac, .mp3 or .ogg filename');
  }
  const parent = dirname(resolve(file));
  if (!existsSync(parent) || !statSync(parent).isDirectory()) throw new Error(`${parent} is not an existing export directory`);
  if (existsSync(file) && !statSync(file).isFile()) throw new Error(`${file} is not a regular export file`);
}

export function validateProjectFile(file: string, save: boolean): void {
  if (extname(file).toLowerCase() !== '.aup3') throw new Error('project paths must end in .aup3');
  if (save && existsSync(file)) throw new Error(`${file} exists; save under a new name to avoid a blocking modal error`);
  if (!save && (!existsSync(file) || !statSync(file).isFile())) throw new Error(`${file} is not an existing project file`);
  const parent = dirname(resolve(file));
  if (!existsSync(parent) || !statSync(parent).isDirectory()) throw new Error(`${parent} is not an existing project directory`);
}

/** Shared by generic commands and macro preflight, before any preceding edit can run. */
export function preflightCommand(id: string, params: Record<string, unknown> = {}): string {
  if (!COMMAND_IDS.includes(id)) throw new Error(`command is reserved or not in the safe catalogue: ${id}`);
  const command = catalogueCommand(id, params);
  if (id === 'Export2') validateExportFile(String(params.Filename ?? ''));
  if (id === 'Import2' && (!existsSync(String(params.Filename ?? '')) || !statSync(String(params.Filename)).isFile())) throw new Error('import file does not exist or is not a regular file');
  if (id === 'SampleDataExport' && (params.MESSAGES !== 'None' || !params.FILENAME)) {
    throw new Error('SampleDataExport requires MESSAGES=None and an explicit FILENAME to avoid modal result dialogs');
  }
  if (id === 'NoiseGate' && params.MODE === 'Analyze') throw new Error('NoiseGate Analyze opens a result dialog; use audacity_measure');
  if (id === 'RegularIntervalLabels' && params.VERBOSE !== 'None') throw new Error('RegularIntervalLabels requires VERBOSE=None; use audacity_labels regular');
  return command;
}
