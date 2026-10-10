import { readFileSync } from 'node:fs';
import { Client, InMemoryTransport } from '@modelcontextprotocol/client';
import { describe, expect, it } from 'vitest';
import { buildServer } from '../src/server.js';

describe('public tool documentation', () => {
  it('lists every registered name once in the tool table and keeps README compact', async () => {
    const server = buildServer();
    const client = new Client(
      { name: 'documentation-check', version: '1' },
      { supportedProtocolVersions: ['2025-06-18'] },
    );
    const [left, right] = InMemoryTransport.createLinkedPair();
    await server.connect(right);
    await client.connect(left);
    try {
      const names = (await client.listTools()).tools.map((tool) => tool.name).sort();
      const reference = readFileSync(new URL('../docs/tools.md', import.meta.url), 'utf8');
      const documented = [...reference.matchAll(/^\| `(audacity_[a-z_]+)` \|/gm)].map((match) => match[1]).sort();
      expect(documented).toEqual(names);
      expect(readFileSync(new URL('../README.md', import.meta.url), 'utf8').split('\n').length).toBeLessThanOrEqual(
        180,
      );
    } finally {
      await client.close();
      await server.close();
    }
  });
});
