import type { CallToolResult, McpServer, ServerContext } from '@modelcontextprotocol/server';
import { z } from 'zod';
import { AudacityTimeout, AudacityUnavailable } from './pipe.js';
import type { SerialQueue } from './queue.js';
import { toolAnnotations, toolTitle } from './tool-metadata.js';
import { outputSchema } from './tool-output.js';

/** Completed task stages, never a guessed native effect percentage. */
export type ToolProgress = (completed: number, total: number, message: string) => Promise<void>;
export type ToolRegistrar = <S extends z.ZodRawShape>(
  name: string,
  description: string,
  shape: S,
  handler: (args: z.infer<z.ZodObject<S>>, progress?: ToolProgress) => Promise<unknown>,
  readOnly?: boolean,
) => void;

export function toolResult(value: unknown, schema?: z.ZodType): CallToolResult {
  const text = typeof value === 'string' ? value : JSON.stringify(value, null, 1);
  const result: CallToolResult = { content: [{ type: 'text', text }] };
  // Legacy clients parse arrays directly from text. Never replace those with
  // an object envelope: some clients prefer structuredContent when present.
  if (schema) {
    // Validate the actual JSON representation: optional nested JS properties
    // are omitted on the wire, including scopes inside batch dry-run plans.
    schema.parse(JSON.parse(text));
    if (value && typeof value === 'object' && !Array.isArray(value)) {
      result.structuredContent = value as Record<string, unknown>;
    }
  }
  return result;
}

export function toolFailure(error: unknown): CallToolResult {
  let message =
    error instanceof z.ZodError ? z.prettifyError(error) : error instanceof Error ? error.message : String(error);
  if (error instanceof AudacityUnavailable) {
    message += error.uncertainOutcome
      ? ' Use audacity_dialogs and audacity_recover; do not replay edits blindly.'
      : ' Use audacity_launch.';
  } else if (error instanceof AudacityTimeout) {
    message += '. A modal dialog may be blocking Audacity: check audacity_dialogs.';
  }
  return { content: [{ type: 'text', text: message }], isError: true };
}

export function requestProgress(ctx: ServerContext): ToolProgress {
  const token = ctx.mcpReq._meta?.progressToken;
  return async (progress, total, message) => {
    ctx.mcpReq.signal.throwIfAborted();
    if (typeof token === 'string' || typeof token === 'number') {
      await ctx.mcpReq.notify({
        method: 'notifications/progress',
        params: { progressToken: token, progress, total, message },
      });
    }
  };
}

export function createToolRegistrar(server: McpServer, operations: SerialQueue): ToolRegistrar {
  return (name, description, shape, handler, readOnly = false) => {
    const inputSchema = z.object(shape).strict();
    const schema = outputSchema(name);
    server.registerTool(
      name,
      {
        title: toolTitle(name),
        description,
        inputSchema,
        ...(schema ? { outputSchema: schema } : {}),
        annotations: toolAnnotations(name, readOnly),
      },
      async (args, ctx) => {
        try {
          const parsed = inputSchema.parse(args);
          const invoke = () => handler(parsed, requestProgress(ctx));
          // These native window operations must remain available while pipe I/O
          // waits on a blocking dialog. They do not exchange pipe commands.
          const value = await (['audacity_dialogs', 'audacity_window'].includes(name)
            ? invoke()
            : operations.run(invoke));
          return toolResult(value, schema);
        } catch (error) {
          return toolFailure(error);
        }
      },
    );
  };
}
