import type { Ops } from '../ops.js';
import { menusInfo } from './info.js';

/** Menu items whose handlers rely on enabling flags that scripted dispatch skips. */
export const STATEFUL_MENUS = ['Undo', 'Redo', 'NewTimeTrack'];

/** Scripted Undo/Redo skip their menu flags and answer an empty history with a
 * modal "Nothing to undo"/"Nothing to redo" (Audacity-3.7.8 src/menus/
 * EditMenus.cpp:181-191, 210-220). The English menu label names the step only
 * while one exists (libraries/lib-menus/CommandManager.cpp:1438-1463). Live
 * 3.7.8, 2026-10-10: "Undo" in a fresh project, "Undo Split Delete" after an edit.
 * NewTimeTrack always prepends a flat time track (src/tracks/timetrack/ui/
 * TimeTrackMenuItems.cpp:27-42); only its skipped flag (:45-58) keeps it unique,
 * and playback and export follow the first one (lib-time-track/TimeTrack.cpp:360-367). */
export async function requireMenuState(ops: Ops, id: string): Promise<void> {
  if (id === 'NewTimeTrack') {
    if ((await ops.tracks()).some((track) => track.kind === 'time'))
      throw new Error('the project already has a time track; a second one would replace its timing');
    return;
  }
  const label = menusInfo(await ops.info('Menus')).find((item) => item.id === id)?.label;
  if (!label?.startsWith(`${id} `))
    throw new Error(`Audacity has nothing to ${id.toLowerCase()} in its native history`);
}
