// Real native integration: one serial hidden session, domain tests and unconditional ordinary teardown.
import { describe, expect, it } from 'vitest';
import { registerAnalysis } from './live/analysis.js';
import { registerBatch } from './live/batch.js';
import { registerClips } from './live/clips.js';
import { registerControls } from './live/controls.js';
import { registerDiscovery } from './live/discovery.js';
import { registerEditing } from './live/editing.js';
import { registerGeneration } from './live/generation.js';
import { registerHardware } from './live/hardware.js';
import { registerImports } from './live/imports.js';
import { registerLabels } from './live/labels.js';
import { registerNativeGuards } from './live/native-guards.js';
import { registerNoise } from './live/noise.js';
import { registerPipelines } from './live/pipelines.js';
import { registerProcessEpoch } from './live/process-epoch.js';
import { registerProjects } from './live/projects.js';
import { registerRecovery } from './live/recovery.js';
import { installLiveSession } from './live/session.js';
import { registerTracks } from './live/tracks.js';

const live = process.env.AUDACITY_LIVE === '1';
describe.skipIf(!live)('live Audacity through built stdio MCP', () => {
  const context = installLiveSession();
  registerDiscovery(context);
  registerImports(context);
  registerTracks(context);
  registerGeneration(context);
  registerEditing(context);
  registerClips(context);
  registerPipelines(context);
  registerNoise(context);
  registerNativeGuards(context);
  registerProcessEpoch(context);
  registerLabels(context);
  registerAnalysis(context);
  registerBatch(context);
  registerHardware(context);
  registerControls(context);
  registerRecovery(context);
  registerProjects(context);
  it('accounts for attempted, successful and expected refused tool calls', () => {
    const { attempted, succeeded, refused, expectedRefusals, unavailable, registered } = context;
    console.log(
      'Native tool accounting:',
      JSON.stringify({
        attempted: [...attempted].sort(),
        succeeded: [...succeeded].sort(),
        refused: Object.fromEntries(refused),
        expectedRefusals: Object.fromEntries(expectedRefusals),
        unavailable: [...unavailable],
      }),
    );
    expect([...attempted].sort()).toEqual(registered);
    expect(registered.filter((name) => !succeeded.has(name) && !unavailable.has(name))).toEqual([]);
    expect([...expectedRefusals].every(([name, count]) => count > 0 && (refused.get(name) ?? 0) >= count)).toBe(true);
  });
});
