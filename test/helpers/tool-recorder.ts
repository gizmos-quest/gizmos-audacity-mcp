import { z } from 'zod';
import type { ToolProgress, ToolRegistrar } from '../../src/tools.js';

export function toolRecorder() {
  const handlers = new Map<string, (input: unknown, progress?: ToolProgress) => Promise<unknown>>();
  const register: ToolRegistrar = (name, _description, shape, handler) => {
    handlers.set(name, async (input, progress) => handler(z.object(shape).strict().parse(input), progress));
  };
  return {
    register,
    call: (name: string, input: unknown = {}, progress?: ToolProgress) => handlers.get(name)!(input, progress),
  };
}
