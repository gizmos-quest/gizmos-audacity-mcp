// The operations behind the MCP tools. Each one is a short, ordered series
// of pipe commands; every reply is checked, so a failed step stops the rest.
import { AudacityPipe, type PipeReply } from './pipe.js';
import { catalogueCommand, formatCommand, parseInfoJson, type ParamValue } from './format.js';

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
}

export type TrackRef = number | string;

export class Ops {
  constructor(readonly pipe: AudacityPipe) {}

  async raw(command: string, timeoutMs?: number): Promise<string> {
    const reply = await this.pipe.send(command, timeoutMs);
    if (!reply.ok) throw new CommandFailed(command, reply);
    return reply.body;
  }

  run(id: string, params: Record<string, ParamValue | undefined> = {}, timeoutMs?: number): Promise<string> {
    return this.raw(formatCommand(id, params), timeoutMs);
  }

  /** A catalogue command (effects included), validated against Audacity's own parameter list. */
  command(id: string, params: Record<string, unknown> = {}, timeoutMs?: number): Promise<string> {
    return this.raw(catalogueCommand(id, params), timeoutMs);
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
    if (scope.track !== undefined) {
      params.Track = await this.trackIndex(scope.track);
      params.TrackCount = scope.trackCount ?? 1;
    }
    if (scope.start !== undefined || scope.end !== undefined) {
      params.Start = scope.start ?? 0;
      params.End = scope.end ?? (await this.projectEnd());
    }
    if (params.Track === undefined) {
      await this.run('SelectAll');
      if (params.Start === undefined) return;
      await this.run('SelectTime', { Start: params.Start, End: params.End });
      return;
    }
    if (params.Start === undefined) {
      params.Start = 0;
      params.End = await this.projectEnd();
    }
    await this.run('Select', params);
  }

  async projectEnd(): Promise<number> {
    const tracks = await this.tracks();
    return tracks.reduce((end, t) => Math.max(end, t.end ?? 0), 0);
  }

  /** Import a file as a new track, name it and place its clip at `start` seconds. */
  async importTrack(file: string, name?: string, start = 0): Promise<{ track: number; name: string }> {
    const before = (await this.tracks()).length;
    await this.run('Import2', { Filename: file }, 300_000);
    const after = await this.tracks();
    if (after.length <= before) throw new Error(`import added no track: ${file}`);
    const track = before; // a stereo file is one track
    if (name) await this.run('SetTrack', { Track: track, Name: name });
    if (start !== 0) {
      await this.run('Select', { Track: track, TrackCount: 1, Start: 0, End: 0.001, Mode: 'Set' });
      await this.run('SetClip', { Track: track, At: 0, Start: start });
    }
    return { track, name: (await this.tracks())[track]?.name ?? name ?? '' };
  }

  async moveClip(track: TrackRef, at: number, start: number): Promise<void> {
    const index = await this.trackIndex(track);
    await this.run('SetClip', { Track: index, At: at, Start: start });
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
    if (replace) await this.run('SetEnvelope', { Track: index, Delete: true });
    for (const point of points) {
      await this.run('SetEnvelope', { Track: index, Time: point.time, Value: point.value });
    }
    return points.length;
  }

  /** Add a label track (or reuse the last one) and write the labels in order. */
  async setLabels(labels: { start: number; end?: number; text: string }[], trackName = 'Labels'): Promise<number> {
    const existing = ((await this.info('Labels')) as [number, unknown[]][]).reduce((n, [, l]) => n + l.length, 0);
    const tracks = await this.tracks();
    let labelTrack = tracks.findIndex((t) => t.kind === 'label' && t.name === trackName);
    if (labelTrack < 0) {
      await this.run('NewLabelTrack');
      labelTrack = tracks.length;
      await this.run('SetTrack', { Track: labelTrack, Name: trackName });
    }
    for (const [i, label] of labels.entries()) {
      const end = label.end ?? label.start;
      await this.run('Select', { Track: labelTrack, TrackCount: 1, Start: label.start, End: end, Mode: 'Set' });
      await this.run('AddLabel');
      await this.run('SetLabel', { Label: existing + i, Text: label.text, Start: label.start, End: end });
    }
    return labels.length;
  }

  async applyEffect(
    effect: string,
    params: Record<string, unknown>,
    scope: { start?: number; end?: number; track?: TrackRef; trackCount?: number },
  ): Promise<string> {
    await this.select(scope);
    return this.command(effect, params, 600_000);
  }

  /** Capture a noise profile from a stretch of pure noise (Noise Reduction step one). */
  async captureNoiseProfile(track: TrackRef, start: number, end: number): Promise<void> {
    await this.select({ track, start, end });
    await this.run('NoiseReduction', {}, 120_000);
  }

  /** Export the mix of all unmuted tracks (or a time range of it) to a file. */
  async exportMix(file: string, channels = 2, start?: number, end?: number): Promise<void> {
    await this.run('SelectAll');
    if (start !== undefined || end !== undefined) {
      await this.run('SelectTime', { Start: start ?? 0, End: end ?? (await this.projectEnd()) });
    }
    await this.run('Export2', { Filename: file, NumChannels: channels }, 600_000);
  }
}
