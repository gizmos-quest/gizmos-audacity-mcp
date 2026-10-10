import type { Ops } from '../ops.js';

/** Scripted Undo/Redo skip their menu flags and answer an empty history with a
 * modal "Nothing to undo"/"Nothing to redo" (Audacity-3.7.8 src/menus/
 * EditMenus.cpp:181-191, 210-220). The English menu label names the step only
 * while one exists (libraries/lib-menus/CommandManager.cpp:1438-1463). Live
 * 3.7.8, 2026-10-10: "Undo" in a fresh project, "Undo Split Delete" after an edit. */
export async function requireHistory(ops: Ops, id: 'Undo' | 'Redo'): Promise<void> {
  const menus = (await ops.info('Menus')) as { id?: unknown; label?: unknown }[];
  const label = menus.find((item) => item.id === id)?.label;
  if (typeof label !== 'string' || !label.startsWith(`${id} `))
    throw new Error(`Audacity has nothing to ${id.toLowerCase()} in its native history`);
}
