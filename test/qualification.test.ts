import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { Client, InMemoryTransport } from '@modelcontextprotocol/client';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const mocks = vi.hoisted(() => ({ helper: vi.fn() }));
vi.mock('../src/app-helper.js', () => ({ powershell: mocks.helper }));

import { qualifyAudacity } from '../src/app-process.js';
import { AudacityPipe, nativePipePaths, type PipeReply, type PipeTransport } from '../src/pipe.js';
import { buildServer } from '../src/server.js';

const reply: PipeReply = { ok: true, status: 'OK', body: '[]' };
const originalPlatform = process.platform;
let directory: string;
let executable: string;
beforeEach(() => {
  directory = mkdtempSync(join(tmpdir(), 'gizmos-qualify-'));
  executable = join(directory, 'Audacity.exe');
  writeFileSync(executable, '');
  Object.defineProperty(process, 'platform', { value: 'win32' });
  vi.stubEnv('AUDACITY_EXE', executable);
});
afterEach(() => {
  Object.defineProperty(process, 'platform', { value: originalPlatform });
  vi.unstubAllEnvs();
  vi.resetAllMocks();
  rmSync(directory, { recursive: true, force: true });
});
const running = (pid: number, fileVersion: string, file = executable) =>
  mocks.helper.mockResolvedValue(JSON.stringify([{ pid, executable: file, fileVersion, started: `t${pid}` }]));

describe('pipe qualification before edits', () => {
  it('qualifies once per operation before the first command that is not a read', async () => {
    const transport = vi.fn<PipeTransport>(async () => reply);
    const qualify = vi.fn(async () => undefined);
    const pipe = new AudacityPipe({ to: 'to', from: 'from' }, 100, transport, qualify);
    await pipe.send('GetInfo: Type=Tracks Format=JSON');
    expect(qualify).not.toHaveBeenCalled();
    await pipe.send('NewMonoTrack:');
    await pipe.send('Select: Start=0 End=1');
    expect(qualify).toHaveBeenCalledExactlyOnceWith({ to: 'to', from: 'from' });
    pipe.newOperation();
    await pipe.send('Stop:');
    expect(qualify).toHaveBeenCalledTimes(2);
    qualify.mockRejectedValueOnce(new Error('unsupported'));
    pipe.newOperation();
    await expect(pipe.send('Delete:')).rejects.toThrow('unsupported');
    expect(transport.mock.calls.map(([, command]) => command)).not.toContain('Delete:');
    expect(pipe.needsRecovery).toBe(false);
  });

  it('accepts the configured supported process and caches its version per process identity', async () => {
    running(101, '3,7,8,0');
    await qualifyAudacity(nativePipePaths());
    expect(mocks.helper).toHaveBeenCalledWith(expect.not.stringContaining('Get-CimInstance')); // no owner lookup
    running(101, '4,0,0,0');
    await qualifyAudacity(nativePipePaths()); // same identity: the version is not read again
    running(102, '4,0,0,0');
    await expect(qualifyAudacity(nativePipePaths())).rejects.toThrow('not supported');
    running(103, '3,7,5,0');
    await expect(qualifyAudacity(nativePipePaths())).rejects.toThrow('Unsupported Audacity version 3.7.5.0');
  });

  it('refuses a missing, duplicated or different running installation', async () => {
    mocks.helper.mockResolvedValue('[]');
    await expect(qualifyAudacity(nativePipePaths())).rejects.toThrow('found 0');
    running(104, '3,7,8,0', join(directory, 'Other.exe'));
    await expect(qualifyAudacity(nativePipePaths())).rejects.toThrow('running from');
    vi.stubEnv('AUDACITY_EXE', join(directory, 'missing.exe'));
    await expect(qualifyAudacity(nativePipePaths())).rejects.toThrow('not an existing executable');
  });

  it('checks only an explicit override for relay endpoints that no process owns', async () => {
    await qualifyAudacity({ to: 'relay.to', from: 'relay.from' });
    vi.stubEnv('AUDACITY_EXE', 'Z:/nonexistent-audacity.exe');
    await expect(qualifyAudacity({ to: 'relay.to', from: 'relay.from' })).rejects.toThrow('not an existing');
    expect(mocks.helper).not.toHaveBeenCalled();
  });

  it('requalifies every tool call of the server, never for reads', async () => {
    const transport = vi.fn<PipeTransport>(async () => reply);
    const qualify = vi.fn(async () => undefined);
    const server = buildServer(new AudacityPipe({ to: 'to', from: 'from' }, 100, transport, qualify));
    const client = new Client({ name: 'qualification-test', version: '1' });
    const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
    await server.connect(serverTransport);
    await client.connect(clientTransport);
    try {
      await client.callTool({ name: 'audacity_info', arguments: { type: 'Tracks' } });
      expect(qualify).not.toHaveBeenCalled();
      for (let call = 0; call < 2; call++)
        expect((await client.callTool({ name: 'audacity_menu', arguments: { command: 'Stop' } })).isError).toBeFalsy();
      expect(qualify).toHaveBeenCalledTimes(2);
      qualify.mockRejectedValueOnce(new Error('Audacity 4.0.0 is not supported'));
      const refused = await client.callTool({ name: 'audacity_menu', arguments: { command: 'NewMonoTrack' } });
      expect(refused.isError).toBe(true);
      expect(transport.mock.calls.map(([, command]) => command)).not.toContain('NewMonoTrack:');
    } finally {
      await client.close();
    }
  });
});
