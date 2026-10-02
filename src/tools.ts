import type { z } from 'zod';
export type ToolRegistrar = <S extends z.ZodRawShape>(name: string, description: string, shape: S,
  handler: (args: z.infer<z.ZodObject<S>>) => Promise<unknown>, readOnly?: boolean) => void;
