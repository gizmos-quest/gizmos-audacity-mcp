import { writeFileSync } from 'node:fs';
import { expect, it } from 'vitest';
import {
  type Clip,
  type Envelope,
  type Label,
  type LiveContext,
  type Measurement,
  type Track,
  testTimeout,
} from './session.js';

export function registerTracks(context: LiveContext) {
  const { call, refuse, tracks, importVoice, output } = context;
  it(
    'rejects ignored Set* scope arguments and edits only the explicitly requested track',
    async () => {
      await importVoice('Target');
      await importVoice('Distractor');
      await call('audacity_select', { track: 'Distractor' });
      const initialSelection = await call('audacity_info', { type: 'Selection' });
      for (const command of [
        'SetTrack',
        'SetTrackStatus',
        'SetTrackAudio',
        'SetTrackVisuals',
        'SetClip',
        'SetEnvelope',
      ]) {
        for (const key of ['Track', 'TrackCount', 'Channel', 'ChannelCount']) {
          await expect(refuse('audacity_command', { command, params: { [key]: 0 } })).rejects.toThrow();
        }
      }
      expect(await call('audacity_info', { type: 'Selection' })).toEqual(initialSelection);
      expect((await tracks()).map((track) => track.selected)).toEqual([0, 1]);
      const unchangedControls = (track: Track) => ({
        name: track.name,
        volume: track.volume,
        pan: track.pan,
        mute: track.mute,
        solo: track.solo,
      });
      const originalDistractor = unchangedControls((await tracks())[1]!);
      await call('audacity_track_set', {
        track: 'Target',
        name: 'Edited target',
        gainDb: -6,
        pan: -0.4,
        mute: true,
        solo: false,
      });
      const properties = await tracks();
      expect(properties[0]).toMatchObject({ name: 'Edited target', pan: -0.4, mute: 1 });
      expect(properties[0]!.volume).toBeCloseTo(10 ** (-6 / 20), 4);
      expect(unchangedControls(properties[1]!)).toEqual(originalDistractor);
      await call('audacity_track_set', { track: 'Edited target', gainDb: 0, pan: 0, mute: false });

      const distractorClips = (await call<Clip[]>('audacity_info', { type: 'Clips' })).filter(
        (clip) => clip.track === 1,
      );
      await call('audacity_select', { track: 'Distractor' });
      await call('audacity_clip_move', { track: 'Edited target', at: 1, start: 1 });
      const moved = await call<Clip[]>('audacity_info', { type: 'Clips' });
      expect(moved.find((clip) => clip.track === 0)).toMatchObject({ start: 1, end: 3 });
      expect(moved.filter((clip) => clip.track === 1)).toEqual(distractorClips);

      await call('audacity_envelope_set', {
        track: 'Distractor',
        points: [
          { time: 0.25, value: 0.7 },
          { time: 1.75, value: 0.7 },
        ],
      });
      const distractorEnvelope = (await call<Envelope[]>('audacity_info', { type: 'Envelopes' })).filter(
        (entry) => entry.track === 1,
      );
      expect(distractorEnvelope.flatMap((entry) => entry.points).length).toBeGreaterThan(0);
      await call('audacity_select', { track: 'Distractor' });
      await call('audacity_envelope_set', {
        track: 'Edited target',
        points: [
          { time: 1.25, value: 1 },
          { time: 1.75, value: 0.25 },
        ],
      });
      const envelopes = await call<Envelope[]>('audacity_info', { type: 'Envelopes' });
      expect(envelopes.filter((entry) => entry.track === 1)).toEqual(distractorEnvelope);
      expect(
        envelopes
          .filter((entry) => entry.track === 0)
          .flatMap((entry) => entry.points)
          .map((point) => point.y),
      ).toEqual([1, 0.25]);

      const distractorAudio = await call<Measurement>('audacity_measure', { track: 'Distractor', backend: 'wav' });
      await call('audacity_select', { track: 'Distractor' });
      await call('audacity_clip_set', {
        track: 'Edited target',
        at: 1.5,
        name: 'Target clip',
        color: 'Color2',
        gainDb: -6,
      });
      const editedClips = await call<Clip[]>('audacity_info', { type: 'Clips' });
      expect(editedClips.find((clip) => clip.track === 0)?.name).toBe('Target clip');
      expect(editedClips.filter((clip) => clip.track === 1)).toEqual(distractorClips);
      expect((await call<Measurement>('audacity_measure', { track: 'Distractor', backend: 'wav' })).rms).toBeCloseTo(
        distractorAudio.rms,
        5,
      );
      expect(unchangedControls((await tracks())[1]!)).toEqual(originalDistractor);
      // Native SetClip treats a shared boundary as belonging to both neighbors.
      // The task must identify the second clip and move it using an interior time.
      await call('audacity_edit', { action: 'split', track: 'Edited target', start: 2, end: 2 });
      await call('audacity_select', { track: 'Distractor' });
      await call('audacity_clip_move', { track: 'Edited target', at: 2, start: 4 });
      const boundaryMove = await call<Clip[]>('audacity_info', { type: 'Clips' });
      expect(boundaryMove.filter((clip) => clip.track === 0).map(({ start, end }) => ({ start, end }))).toEqual([
        { start: 1, end: 2 },
        { start: 4, end: 5 },
      ]);
      expect(boundaryMove.filter((clip) => clip.track === 1)).toEqual(distractorClips);
    },
    testTimeout,
  );

  it(
    'names imported/generated/label tracks without renaming previously selected tracks',
    async () => {
      const { fixture } = context;
      await importVoice('Existing');
      const existing = (await tracks())[0]!;
      const preserveExisting = async () => {
        const current = (await tracks())[0]!;
        expect(current.name).toBe(existing.name);
        expect(current.kind).toBe(existing.kind);
        expect(current.start).toBe(existing.start);
        expect(current.end).toBe(existing.end);
        expect(current.volume).toBe(existing.volume);
        expect(current.pan).toBe(existing.pan);
        expect(current.mute).toBe(existing.mute);
        expect(current.solo).toBe(existing.solo);
      };
      await call('audacity_select', { track: 'Existing' });
      await call('audacity_import', { file: fixture, name: 'New import', start: 4 });
      expect((await tracks())[1]).toMatchObject({ name: 'New import', start: 4, end: 6 });
      await preserveExisting();
      await call('audacity_select', { track: 'Existing' });
      await call('audacity_generate', { kind: 'tone', name: 'Generated', duration: 0.25, amplitude: 0.1 });
      expect((await tracks())[2]?.name).toBe('Generated');
      await preserveExisting();
      await call('audacity_select', { track: 'Existing' });
      await call('audacity_track_edit', { action: 'add_mono', name: 'Added mono' });
      expect((await tracks())[3]?.name).toBe('Added mono');
      await preserveExisting();
      await call('audacity_select', { track: 'Existing' });
      await call('audacity_labels_set', {
        trackName: 'Story',
        labels: [
          { start: 0, text: 'Delete this' },
          { start: 1, text: 'Keep this' },
        ],
      });
      expect((await tracks())[4]).toMatchObject({ name: 'Story', kind: 'label' });
      await preserveExisting();
      const importedLabels = output('isolation-labels', 'tsv');
      writeFileSync(importedLabels, '0.25\t0.75\tImported label\n');
      await call('audacity_select', { track: 'Existing' });
      await call('audacity_labels_file', { action: 'import', file: importedLabels, trackName: 'Imported labels' });
      expect((await tracks())[5]).toMatchObject({ name: 'Imported labels', kind: 'label' });
      await preserveExisting();
      const deleted = (await call<Label[]>('audacity_labels', { action: 'find', query: 'Delete this' }))[0]!;
      await call('audacity_select', { track: 'Existing' });
      await call('audacity_labels', { action: 'delete', index: deleted.index });
      await preserveExisting();
      expect((await tracks()).map((track) => track.name)).toEqual([
        'Existing',
        'New import',
        'Generated',
        'Added mono',
        'Imported labels',
        'Story',
      ]);
      expect((await call<Label[]>('audacity_labels', { action: 'list' })).map((label) => label.text).sort()).toEqual([
        'Imported label',
        'Keep this',
      ]);
    },
    testTimeout,
  );
}
