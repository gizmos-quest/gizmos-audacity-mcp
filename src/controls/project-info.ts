import { z } from 'zod';
import { measureScope } from '../analysis.js';
import { recoveryEntries } from '../app.js';
import type { Ops } from '../ops.js';
import type { ToolRegistrar } from '../tools.js';

export function registerProjectInfoTools(tool: ToolRegistrar, ops: Ops): void {
  tool(
    'audacity_history',
    'Undo or redo existing native menu/import history entries. Individual scripted effects and pipelines add no undo entry; save a project backup before destructive processing. Stops at Audacity’s own first error and does not claim checkpoint rollback.',
    { action: z.enum(['undo', 'redo']), steps: z.number().int().min(1).max(100).default(1) },
    async ({ action, steps }) => {
      let completed = 0;
      for (; completed < steps; completed++) await ops.run(action === 'undo' ? 'Undo' : 'Redo');
      return { action, completed };
    },
  );
  tool(
    'audacity_project_info',
    'Read project tracks, clips, selection, length, active project paths and actual render sample rate. Rate is measured by a tiny temporary WAV export with selection restored; an empty project returns rate=null and its default preference separately.',
    {},
    async () => {
      const tracks = await ops.tracks();
      const audio = tracks.findIndex((t) => t.kind === 'wave' && t.end > t.start);
      const rate =
        audio < 0
          ? null
          : (
              await measureScope(
                ops,
                {
                  track: audio,
                  start: tracks[audio]!.start,
                  end: Math.min(tracks[audio]!.end, tracks[audio]!.start + 0.01),
                },
                { backend: 'wav' },
              )
            ).sampleRate;
      return {
        tracks,
        clips: await ops.info('Clips'),
        selection: await ops.info('Selection'),
        lengthSeconds: await ops.projectEnd(),
        rate,
        defaultRate: Number(await ops.command('GetPreference', { Name: '/SamplingRate/DefaultProjectSampleRate' })),
        activeProjectFiles: recoveryEntries(),
        fileSource: 'Audacity config ActiveProjects; entries can include unsaved session databases',
      };
    },
  );
}
