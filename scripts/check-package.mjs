import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { Client } from '@modelcontextprotocol/client';
import { StdioClientTransport } from '@modelcontextprotocol/client/stdio';

const root = fileURLToPath(new URL('..', import.meta.url));
const npmCli = process.env.npm_execpath;
function npm(args, cwd = root) {
  assert(npmCli, 'invoke package validation with npm run check:package');
  const result = spawnSync(process.execPath, [npmCli, ...args], {
    cwd,
    encoding: 'utf8',
    windowsHide: true,
    timeout: 120_000,
  });
  assert.equal(result.status, 0, result.stderr || result.error?.message || result.stdout);
  return result.stdout;
}

const [packed] = JSON.parse(npm(['pack', '--dry-run', '--json', '--ignore-scripts']));
assert(packed.size < 512_000, 'compressed package exceeds 500 KiB');
assert(packed.unpackedSize < 2_097_152, 'unpacked package exceeds 2 MiB');
const paths = new Set(packed.files.map((file) => file.path));
for (const required of [
  'dist/main.js',
  'dist/pipe-worker.js',
  'catalogue/commands.json',
  'catalogue/menus.json',
  'catalogue/parameters.json',
  'LICENSE',
  'NOTICE.md',
  'README.md',
  'server.json',
  'package.json',
])
  assert(paths.has(required), `missing ${required}`);
for (const path of paths)
  assert(
    /^(dist\/|catalogue\/|LICENSE$|NOTICE\.md$|README\.md$|server\.json$|package\.json$)/.test(path),
    `unexpected package content: ${path}`,
  );
for (const path of paths)
  if (path.startsWith('dist/')) {
    assert(path.endsWith('.js'), `unexpected compiled artifact: ${path}`);
    assert(existsSync(join(root, 'src', path.slice(5).replace(/\.js$/, '.ts'))), `stale compiled module: ${path}`);
  }
const metadata = JSON.parse(readFileSync(join(root, 'package.json'), 'utf8'));
assert.equal(metadata.private, undefined);
assert.equal(metadata.bin['gizmos-audacity-mcp'], 'dist/main.js');
assert.equal(metadata.engines.node, '>=24.21.0');
const registry = JSON.parse(readFileSync(join(root, 'server.json'), 'utf8'));
assert.equal(registry.name, metadata.mcpName);
assert.equal(registry.version, metadata.version);
assert.equal(registry.packages[0].identifier, metadata.name);
assert.equal(registry.packages[0].version, metadata.version);
assert.deepEqual(registry.packages[0].transport, { type: 'stdio' });
assert(readFileSync(join(root, 'dist/main.js'), 'utf8').startsWith('#!/usr/bin/env node'));

const scratch = mkdtempSync(join(tmpdir(), 'audacity-package-'));
const client = new Client({ name: 'package-check', version: '1' });
try {
  const [tarball] = JSON.parse(npm(['pack', '--json', '--ignore-scripts', '--pack-destination', scratch]));
  writeFileSync(join(scratch, 'package.json'), '{"name":"package-smoke","version":"1.0.0","private":true}\n');
  npm(
    ['install', '--ignore-scripts', '--omit=dev', '--no-audit', '--no-fund', resolve(scratch, tarball.filename)],
    scratch,
  );
  const installed = join(scratch, 'node_modules', ...metadata.name.split('/'), 'dist/main.js');
  await client.connect(new StdioClientTransport({ command: process.execPath, args: [installed], stderr: 'pipe' }));
  const tools = (await client.listTools()).tools;
  assert.equal(tools.length, 45);
  assert(tools.some((tool) => tool.name === 'audacity_status'));
  console.log(
    `Package verified: ${paths.size} files, ${packed.size} compressed bytes; installed stdio lists ${tools.length} tools.`,
  );
} finally {
  await client.close();
  rmSync(scratch, { recursive: true, force: true });
}
