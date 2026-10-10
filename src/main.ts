#!/usr/bin/env node
import { serveStdio } from '@modelcontextprotocol/server/stdio';
import { runDoctor } from './doctor.js';
import { errorMessage } from './errors.js';
import { buildServer } from './server.js';

if (process.argv[2] === 'doctor') {
  await runDoctor(process.argv.slice(3)).catch((error: unknown) => {
    process.stderr.write(`${errorMessage(error)}\n`);
    process.exitCode = 1;
  });
} else if (process.argv.length > 2) {
  process.stderr.write('Usage: gizmos-audacity-mcp [doctor [--fix]]\n');
  process.exitCode = 1;
} else {
  await serveStdio(() => buildServer(), { legacy: 'serve' });
}
