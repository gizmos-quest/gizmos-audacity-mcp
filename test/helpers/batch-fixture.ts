import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { isAbsolute, join, relative, resolve } from 'node:path';
import { afterEach, beforeEach } from 'vitest';
import { z } from 'zod';
import { registerBatchTool } from '../../src/batch.js';
import type { Ops } from '../../src/ops.js';
import type { ToolRegistrar } from '../../src/tools.js';

// Live bindings: each test reads the paths of its own temporary directory.
export let directory = '';
export let input = '';
export let secondInput = '';
export let output = '';
export let secondOutput = '';

export function useBatchFiles(): void {
  beforeEach(() => {
    directory = mkdtempSync(join(tmpdir(), 'gizmos-audacity-batch-unit-'));
    input = join(directory, 'input.wav');
    secondInput = join(directory, 'second.wav');
    output = join(directory, 'output.wav');
    secondOutput = join(directory, 'second-output.wav');
    // File preflight does not decode audio; rendering belongs to live tests.
    writeFileSync(input, 'first source fixture');
    writeFileSync(secondInput, 'second source fixture');
  });
  afterEach(() => {
    const descendant = relative(resolve(tmpdir()), resolve(directory));
    if (
      !descendant ||
      descendant.startsWith('..') ||
      isAbsolute(descendant) ||
      !descendant.startsWith('gizmos-audacity-batch-unit-')
    ) {
      throw new Error('refusing to remove a batch fixture outside the expected temporary directory');
    }
    rmSync(directory, { recursive: true, force: true });
  });
}

/** Exercise the same strict shape registration and handler validation as the server. */
export function registeredBatch() {
  const accesses: string[] = [];
  const ops = new Proxy(
    {},
    {
      get: (_target, key) => {
        accesses.push(String(key));
        throw new Error(`batch touched Ops.${String(key)} before preflight completed`);
      },
    },
  ) as Ops;
  let name: string | undefined;
  let schema: z.ZodType | undefined;
  let handler: ((args: unknown) => Promise<unknown>) | undefined;
  const register: ToolRegistrar = (toolName, _description, shape, action) => {
    if (name) throw new Error('batch registered more than one tool');
    name = toolName;
    schema = z.object(shape).strict();
    handler = action as (args: unknown) => Promise<unknown>;
  };
  registerBatchTool(register, ops);
  return { accesses, name, schema: schema!, call: async (args: unknown) => handler!(schema!.parse(args)) };
}
