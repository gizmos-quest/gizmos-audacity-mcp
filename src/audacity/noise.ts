import { measureScope } from '../analysis/render.js';
import type { Ops, TrackRef } from '../ops.js';
import { measureSourceRate } from '../source-rate.js';
import { Seconds, Track } from '../tool-input.js';
import { clipsInfo } from './info.js';

type CapturedProfile = { track: number; name: string; start: number; end: number; rate: number };

/** Native process-wide state belongs to an observed process lifetime. */
export class NoiseProfile {
  private profile: 'unknown' | CapturedProfile | undefined = 'unknown';
  private epoch: Promise<string | undefined> | undefined;
  constructor(
    private readonly ops: Ops,
    private readonly identity: () => Promise<string | undefined>,
  ) {}

  fresh(): void {
    this.profile = undefined;
    this.epoch = this.identity().catch(() => undefined);
  }
  unknown(): void {
    this.profile = 'unknown';
    this.epoch = undefined;
  }
  require(): void {
    if (!this.profile || this.profile === 'unknown') {
      throw new Error(
        'NoiseReduction needs a profile captured by this server in a fresh Audacity process. Use audacity_fresh with backupTo, then audacity_noise_profile. Audacity 3.7.8 has no profile-reset or effect-parameter scripting API.',
      );
    }
  }
  invalidate(id: string, params: Record<string, unknown>): void {
    if (
      this.profile &&
      this.profile !== 'unknown' &&
      ([
        'Import2',
        'OpenProject2',
        'RemoveTracks',
        'NewMonoTrack',
        'NewStereoTrack',
        'NewLabelTrack',
        'NewTimeTrack',
        'MixAndRender',
        'MixAndRenderToNewTrack',
        'StereoToMono',
        'SortByTime',
        'SortByName',
        'Duplicate',
        'SplitNew',
        'Cut',
        'SplitCut',
        'Join',
        'Undo',
        'Redo',
      ].includes(id) ||
        (['SetTrack', 'SetTrackStatus'].includes(id) && params.Name !== undefined))
    )
      this.unknown();
  }
  private async verifyEpoch(): Promise<void> {
    const bound = await this.epoch;
    const current = await this.identity();
    if (!bound || bound !== current) {
      this.unknown();
      throw new Error(
        'Audacity process identity changed or is unavailable; noise-profile state is unknown. Use audacity_fresh before capturing room tone.',
      );
    }
  }

  async reduce(command: string, timeoutMs?: number): Promise<string> {
    await this.verifyEpoch();
    const profile = this.profile;
    if (!profile || profile === 'unknown') throw new Error('noise-profile state changed');
    const selected = (await this.ops.tracks()).flatMap((t, i) =>
      t.kind === 'wave' && t.selected ? [{ ...t, index: i }] : [],
    );
    // Native 3.7.8 opens a modal on profile/source sample-rate mismatch.
    // Direct GetInfo omits source rates. Capture queries a silent sample-data
    // header; reduction conservatively stays on that unchanged tracked audio
    // track, invalidating after track-structure/history edits.
    if (selected.length !== 1 || selected[0]!.index !== profile.track || selected[0]!.name !== profile.name) {
      throw new Error(
        'NoiseReduction must select only the unchanged audio track used to capture this profile; cross-track reduction is not supported',
      );
    }
    const target = selected[0]!;
    if (
      (await measureSourceRate(this.ops, { track: profile.track, start: target.start, end: target.end })) !==
      profile.rate
    ) {
      this.unknown();
      throw new Error('NoiseReduction source sample rate changed; use audacity_fresh and capture room tone again');
    }
    await this.verifyEpoch();
    return this.ops.raw(command, timeoutMs);
  }

  /** Capture a noise profile from a stretch of pure noise (Noise Reduction step one). */
  async capture(track: TrackRef, start: number, end: number): Promise<void> {
    Track.parse(track);
    if (!Seconds.safeParse(start).success || !Seconds.safeParse(end).success || !(end > start))
      throw new Error('noise profile must be a non-empty interval inside an audio track');
    const index = await this.ops.trackIndex(track);
    const info = (await this.ops.tracks())[index]!;
    if (info.kind !== 'wave' || start < info.start || end > info.end || !(end > start))
      throw new Error('noise profile must be a non-empty interval inside an audio track');
    if (this.profile === 'unknown')
      throw new Error(
        'Existing Audacity noise-profile state is unknown. Use audacity_fresh with backupTo before capturing room tone.',
      );
    await this.verifyEpoch();
    if (this.profile !== undefined) {
      if (this.profile.track === index && this.profile.start === start && this.profile.end === end) return;
      throw new Error(
        'Audacity 3.7.8 can capture only one scripted noise profile per process. Use audacity_fresh with backupTo before choosing different room tone.',
      );
    }
    // Live verified 3.7.8: first no-parameter call profiles, subsequent calls
    // reduce; Reduction/Sensitivity/Smoothing are ignored, not controllable.
    // Prevent the native "profile too short" modal before the first call.
    const clips = clipsInfo(await this.ops.info('Clips'));
    const intersecting = clips.filter((clip) => clip.track === index && clip.start < end && start < clip.end);
    if (intersecting.length !== 1 || intersecting[0]!.start > start || intersecting[0]!.end < end) {
      throw new Error('noise profile must be contained in one audio clip, without timeline gaps or overlapping clips');
    }
    const measured = await measureScope(this.ops, { track: index, start, end }, { backend: 'wav' });
    if (measured.frames < 4096)
      throw new Error('noise profile must contain at least 4096 rendered samples; select a longer room-tone interval');
    // Live 3.7.8: an 8 kHz source rendered at 48 kHz can pass the WAV frame
    // minimum while still opening the native profile-too-short dialog.
    const rate = await measureSourceRate(this.ops, { track: index, start, end });
    if (Math.floor((end - start) * rate) < 4096) {
      throw new Error('noise profile must contain at least 4096 source samples; select a longer room-tone interval');
    }
    await this.verifyEpoch();
    await this.ops.select({ track: index, start, end });
    this.profile = 'unknown'; // A lost reply must never cause profile replay.
    await this.ops.run('NoiseReduction', {}, 120_000);
    this.profile = { track: index, name: info.name, start, end, rate };
  }
}
