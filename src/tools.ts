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
    // Use the JSON representation for both: optional nested JS properties (for
    // example undefined scope times in batch plans) are omitted on the wire, and
    // the SDK validates structured content against the same schema again.
    const json: unknown = JSON.parse(text);
    schema.parse(json);
    if (json && typeof json === 'object' && !Array.isArray(json)) {
      result.structuredContent = json as Record<string, unknown>;
    }
  }
  return result;
}

export function toolFailure(error: unknown): CallToolResult {
  let message =
    error instanceof z.ZodError ? z.prettifyError(error) : error instanceof Error ? error.message : String(error);
  if (error instanceof AudacityUnavailable) {
    message += error.advice;
  } else if (error instanceof AudacityTimeout) {
    message += '. A modal dialog may be blocking Audacity: check audacity_dialogs.';
  }
  return { content: [{ type: 'text', text: message }], isError: true };
}

export function requestProgress(ctx: ServerContext): ToolProgress {
  const token = ctx.mcpReq._meta?.progressToken;
  let sent = -1;
  return async (progress, total, message) => {
    ctx.mcpReq.signal.throwIfAborted();
    // MCP progress must increase with every notification; a stage start that
    // repeats the previous completion count is not sent again.
    if ((typeof token === 'string' || typeof token === 'number') && progress > sent) {
      sent = progress;
      await ctx.mcpReq.notify({
        method: 'notifications/progress',
        params: { progressToken: token, progress, total, message },
      });
    }
  };
}

export function createToolRegistrar(
  server: McpServer,
  operations: SerialQueue,
  beforeOperation: () => void = () => undefined,
): ToolRegistrar {
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
            : operations.run(() => {
                // A request cancelled while it waited never starts; nothing was sent for it.
                ctx.mcpReq.signal.throwIfAborted();
                beforeOperation();
                return invoke();
              }));
          return toolResult(value, schema);
        } catch (error) {
          return toolFailure(error);
        }
      },
    );
  };
}
