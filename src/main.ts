#!/usr/bin/env node
import { serveStdio } from '@modelcontextprotocol/server/stdio';
import { buildServer } from './server.js';

serveStdio(() => buildServer(), { legacy: 'serve' });
