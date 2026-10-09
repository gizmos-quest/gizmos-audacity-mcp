import { readFileSync } from 'node:fs';
import { McpServer } from '@modelcontextprotocol/server';
import { registerAnalysisTools } from './analysis.js';
import { registerBatchTool } from './batch.js';
import { registerControlTools } from './controls.js';
import { registerLabelTools } from './labels.js';
import { Ops } from './ops.js';
import { AudacityPipe } from './pipe.js';
import { SerialQueue } from './queue.js';
import { registerCatalogueTools } from './tool-catalogue.js';
import { registerEditingTools } from './tool-editing.js';
import { registerLifecycleTools } from './tool-lifecycle.js';
import { registerTaskTools } from './tool-tasks.js';
import { createToolRegistrar } from './tools.js';

const { version } = JSON.parse(readFileSync(new URL('../package.json', import.meta.url), 'utf8')) as {
  version: string;
};

export function buildServer(pipe = new AudacityPipe()): McpServer {
  const ops = new Ops(pipe);
  const server = new McpServer(
    { name: 'gizmos-audacity-mcp', version },
    {
      capabilities: { tools: {} },
      instructions:
        'Control one local English Audacity 3.7 session. Inspect status and describe effects before editing. ' +
        'Save a new project backup before destructive work; scripted effects have no per-call undo. Preview pipelines with dryRun. ' +
        'After an uncertain reply use dialogs and recover, inspect the project, and never replay an edit automatically.',
    },
  );
  const tool = createToolRegistrar(server, new SerialQueue());
  registerLifecycleTools(tool, ops);
  registerCatalogueTools(tool, ops);
  registerEditingTools(tool, ops);
  registerTaskTools(tool, ops);
  registerAnalysisTools(tool, ops);
  registerControlTools(tool, ops);
  registerLabelTools(tool, ops);
  registerBatchTool(tool, ops);
  return server;
}
