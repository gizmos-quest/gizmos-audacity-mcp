import type { ToolAnnotations } from '@modelcontextprotocol/server';

const READ_ONLY = new Set([
  'audacity_status',
  'audacity_info',
  'audacity_describe',
  'audacity_targets',
  'audacity_probe_file',
  'audacity_measure_file',
  'audacity_compare_files',
]);
const NON_DESTRUCTIVE = new Set([
  ...READ_ONLY,
  'audacity_launch',
  'audacity_window',
  'audacity_dialogs',
  'audacity_select',
  'audacity_import',
  'audacity_project_info',
  'audacity_measure',
  'audacity_silence',
  'audacity_contrast',
  'audacity_label_regions_export',
]);
const IDEMPOTENT = new Set([...READ_ONLY, 'audacity_window', 'audacity_select', 'audacity_track_set']);
const OPEN_WORLD = new Set([
  'audacity_launch',
  'audacity_fresh',
  'audacity_quit',
  'audacity_recover',
  'audacity_import',
  'audacity_export',
  'audacity_project',
  'audacity_command',
  'audacity_macros',
  'audacity_preferences',
  'audacity_project_info',
  'audacity_labels_file',
  'audacity_label_regions_export',
  'audacity_measure',
  'audacity_measure_file',
  'audacity_compare_files',
  'audacity_probe_file',
  'audacity_silence',
  'audacity_contrast',
  'audacity_loudness_target',
  'audacity_batch',
]);

/** Mixed-action tools describe their most powerful action conservatively. */
export function toolAnnotations(name: string, readOnly = false): ToolAnnotations {
  const reads = readOnly || READ_ONLY.has(name);
  return {
    readOnlyHint: reads,
    destructiveHint: !reads && !NON_DESTRUCTIVE.has(name),
    idempotentHint: reads || IDEMPOTENT.has(name),
    openWorldHint: OPEN_WORLD.has(name),
  };
}

export function toolTitle(name: string): string {
  return name
    .replace(/^audacity_/, '')
    .split('_')
    .map((part) => part[0]!.toUpperCase() + part.slice(1))
    .join(' ');
}
