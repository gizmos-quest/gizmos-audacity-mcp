import { registerMacroTool } from './controls/macros.js';
import { registerPreferenceTool } from './controls/preferences.js';
import { registerProjectInfoTools } from './controls/project-info.js';
import { registerRecoveryTool } from './controls/recovery.js';
import { registerTransportTool } from './controls/transport.js';
import type { Ops } from './ops.js';
import type { ToolRegistrar } from './tools.js';

export function registerControlTools(tool: ToolRegistrar, ops: Ops): void {
  registerTransportTool(tool, ops);
  registerProjectInfoTools(tool, ops);
  registerPreferenceTool(tool, ops);
  registerMacroTool(tool, ops);
  registerRecoveryTool(tool, ops);
}
