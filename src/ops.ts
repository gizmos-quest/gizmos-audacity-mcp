// The operations behind the MCP tools. Each one is a short, ordered series
// of pipe commands; every reply is checked, so a failed step stops the rest.

import { currentProcessIdentity } from './app-process.js';
import { tracksInfo } from './audacity/info.js';
import { preflightLabelCreation, setLabels } from './audacity/labels.js';
import { requireMenuState, STATEFUL_MENUS } from './audacity/menu-state.js';
import { NoiseProfile } from './audacity/noise.js';
import { preflightCommand } from './audacity/policy.js';
import { resolveSelection } from './audacity/selection.js';
import { exportMix, importTrack, moveClip, setEnvelope } from './audacity/tracks.js';
import { COMMAND_IDS, commandSchema, MENU_IDS } from './catalogue.js';
import { needsEffectContext, preflightEffect, requireEffectSelection } from './effects/context.js';
import { withCleanupFailure } from './errors.js';
import { formatCommand, type ParamValue, parseInfoJson } from './format.js';
import type { AudacityPipe, PipeReply } from './pipe.js';

export class CommandFailed extends Error {
  constructor(
    readonly command: string,
    readonly reply: PipeReply,
  ) {
    super(`Audacity rejected "${command}": ${reply.body || reply.status}`);
  }
}

/** One GetInfo track (validated in audacity/info.ts). Flags are 0/1. */
export interface TrackInfo {
  name: string;
  kind: string;
  /** Reported for audio tracks only: label and time tracks have no extent, so check `kind` first. */
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
  private readonly noise: NoiseProfile;
  private importPreferences: { name: string; value: string }[] = [];
  constructor(
    readonly pipe: AudacityPipe,
    identity = currentProcessIdentity,
  ) {
    this.noise = new NoiseProfile(this, identity);
  }
  /** Only after starting a new process, never after reconnecting a pipe. */
  freshApplication(): void {
    this.noise.fresh();
  }
  unknownApplication(): void {
    this.noise.unknown();
  }
  requireNoiseProfile(): void {
    this.noise.require();
  }

  async raw(command: string, timeoutMs?: number): Promise<string> {
    let reply: PipeReply;
    try {
      reply = await this.pipe.send(command, timeoutMs);
    } catch (error) {
      if (this.pipe.needsRecovery) this.unknownApplication();
      throw error;
    }
    if (!reply.ok) throw new CommandFailed(command, reply);
    return reply.body;
  }

  /** Only the transport tool may call this, after its recording preflight. */
  record(command: 'Record1stChoice' | 'Record2ndChoice'): Promise<string> {
    // Recording can add tracks before a reply arrives. Never keep a profile
    // whose source identity might have changed after an uncertain send.
    this.noise.unknown();
    return this.raw(formatCommand(command));
  }

  run(id: string, params: Record<string, ParamValue | undefined> = {}, timeoutMs?: number): Promise<string> {
    if (
      !COMMAND_IDS.includes(id) &&
      !MENU_IDS.includes(id) &&
      !['SaveProject2', 'OpenProject2', 'SetPreference'].includes(id)
    ) {
      throw new Error(`command is not in the safe Audacity catalogue: ${id}`);
    }
    if (!MENU_IDS.includes(id))
      commandSchema(id).parse(Object.fromEntries(Object.entries(params).filter(([, v]) => v !== undefined)));
    const command = formatCommand(id, params);
    if (STATEFUL_MENUS.includes(id) || ['AddLabel', 'AddLabelPlaying'].includes(id))
      return (STATEFUL_MENUS.includes(id) ? requireMenuState(this, id) : preflightLabelCreation(this)).then(() => {
        this.noise.invalidate(id, params);
        return this.raw(command, timeoutMs);
      });
    this.noise.invalidate(id, params);
    return id === 'Import2' ? this.importWithoutTempoDetection(command, timeoutMs) : this.raw(command, timeoutMs);
  }

  /** A catalogue command (effects included), validated against Audacity's own parameter list. */
  command(id: string, params: Record<string, unknown> = {}, timeoutMs?: number): Promise<string> {
    const command = preflightCommand(id, params);
    if (id === 'NoiseReduction') {
      this.requireNoiseProfile();
      return this.noise.reduce(command, timeoutMs);
    }
    if (needsEffectContext(id)) return this.guardedEffect(id, params, command, timeoutMs);
    this.noise.invalidate(id, params);
    return id === 'Import2' ? this.importWithoutTempoDetection(command, timeoutMs) : this.raw(command, timeoutMs);
  }

  private async guardedEffect(
    id: string,
    params: Record<string, unknown>,
    command: string,
    timeoutMs?: number,
  ): Promise<string> {
    await preflightEffect(this, id, params);
    return this.raw(command, timeoutMs);
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
      {
        name: '/FileFormats/MusicFileImportOnExistingProjectSettingChoice',
        safe: 'DoNothing',
        fallback: 'MatchIfBeatsAndMeasures',
        values: ['Match', 'MatchIfBeatsAndMeasures', 'DoNothing'],
      },
    ];
    let operationError: unknown;
    try {
      for (const guard of guards) {
        const reply = await this.pipe.send(formatCommand('GetPreference', { Name: guard.name }));
        // An absent preference returns Failed with no body; these are the
        // native 3.7.8 defaults, restored as explicit canonical choices.
        if (!reply.ok && reply.body) throw new CommandFailed('GetPreference', reply);
        const value = reply.body || guard.fallback;
        if (!guard.values.includes(value))
          throw new Error(`unsupported music-import preference ${guard.name}: ${value}`);
        this.importPreferences.push({ name: guard.name, value });
        await this.raw(formatCommand('SetPreference', { Name: guard.name, Value: guard.safe, Reload: false }));
      }
      return await this.raw(command, timeoutMs);
    } catch (error) {
      operationError = error;
      throw error;
    } finally {
      // A timeout has unknown outcome. Keep the saved preferences for explicit
      // recovery instead of attempting another exchange against a blocked pipe.
      if (!this.pipe.needsRecovery) {
        try {
          await this.restoreImportPreferences();
        } catch (error) {
          // biome-ignore lint/correctness/noUnsafeFinally: A failed restoration must replace success and retain the original failure context.
          throw withCleanupFailure(error, operationError, 'Import preference restoration');
        }
      }
    }
  }

  async info(type: string): Promise<unknown> {
    return parseInfoJson(await this.run('GetInfo', { Type: type, Format: 'JSON' }));
  }

  async tracks(): Promise<TrackInfo[]> {
    return tracksInfo(await this.info('Tracks'));
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
    await this.run('Select', await this.resolveSelection(scope));
  }

  /** Resolve and validate a selection without changing it, for transport preflight. */
  resolveSelection(scope: {
    start?: number;
    end?: number;
    track?: TrackRef;
    trackCount?: number;
  }): Promise<Record<string, ParamValue | undefined>> {
    return resolveSelection(this, scope);
  }

  async projectEnd(): Promise<number> {
    const tracks = await this.tracks();
    return tracks.reduce((end, t) => Math.max(end, t.end ?? 0), 0);
  }

  /** Import a file as a new track, name it and place its clip at `start` seconds. */
  importTrack(file: string, name?: string, start = 0): Promise<{ track: number; name: string }> {
    return importTrack(this, file, name, start);
  }

  moveClip(track: TrackRef, at: number, start: number): Promise<void> {
    return moveClip(this, track, at, start);
  }

  /**
   * Replace (or extend) a track's volume envelope. Values are linear gain
   * factors (1 = unchanged, 0.5 = -6 dB); points apply to every clip of the
   * track that covers their time.
   */
  setEnvelope(track: TrackRef, points: { time: number; value: number }[], replace = true): Promise<number> {
    return setEnvelope(this, track, points, replace);
  }

  /** Add a label track (or reuse the last one) and write the labels in order. */
  setLabels(labels: { start: number; end?: number; text: string }[], trackName = 'Labels'): Promise<number> {
    return setLabels(this, labels, trackName);
  }

  async applyEffect(
    effect: string,
    params: Record<string, unknown>,
    scope: { start?: number; end?: number; track?: TrackRef; trackCount?: number },
  ): Promise<string> {
    const command = preflightCommand(effect, params); // Validate before changing selection.
    if (effect === 'NoiseReduction') this.requireNoiseProfile();
    const selected = await this.resolveSelection(scope);
    const range = {
      track: Number(selected.Track),
      trackCount: Number(selected.TrackCount),
      start: Number(selected.Start),
      end: Number(selected.End),
    };
    if (needsEffectContext(effect)) await preflightEffect(this, effect, params, range);
    else await requireEffectSelection(this, effect, range);
    await this.run('Select', selected);
    // This serialized operation already proved this exact scope. Dispatch it
    // once instead of querying source rates again through generic command().
    if (effect === 'NoiseReduction') return this.noise.reduce(command, 600_000);
    this.noise.invalidate(effect, params);
    return this.raw(command, 600_000);
  }

  captureNoiseProfile(track: TrackRef, start: number, end: number): Promise<void> {
    return this.noise.capture(track, start, end);
  }

  /** Export the mix of all unmuted tracks (or a time range of it) to a file. */
  exportMix(file: string, channels = 2, start?: number, end?: number): Promise<void> {
    return exportMix(this, file, channels, start, end);
  }
}

/** Public track pan is normalized; native SetTrack Pan is a percentage. */
export function trackPanPercent(value: number): number {
  if (!Number.isFinite(value) || value < -1 || value > 1)
    throw new RangeError('pan must be finite and between -1 and 1');
  return value * 100;
}
