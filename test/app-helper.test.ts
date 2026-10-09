import { EventEmitter } from 'node:events';
import { PassThrough } from 'node:stream';
import { afterEach, describe, expect, it, vi } from 'vitest';

const fake = vi.hoisted(() => ({ spawn: vi.fn() }));
vi.mock('node:child_process', () => ({ spawn: fake.spawn }));

import { powershell } from '../src/app-helper.js';

afterEach(() => {
  vi.clearAllMocks();
  vi.useRealTimers();
});
function child() {
  const result = Object.assign(new EventEmitter(), {
    stdout: new PassThrough(),
    stderr: new PassThrough(),
    kill: vi.fn(),
  });
  fake.spawn.mockReturnValue(result);
  return result;
}
describe('bounded native helper', () => {
  it('returns trimmed output and preserves native stderr failures', async () => {
    const success = child();
    const output = powershell('read');
    success.stdout.write('  result\n');
    success.emit('close', 0);
    expect(await output).toBe('result');
    expect(fake.spawn).toHaveBeenCalledWith('powershell.exe', expect.any(Array), { windowsHide: true });
    const failure = child();
    const rejected = powershell('read');
    failure.stderr.write('native error');
    failure.emit('close', 1);
    await expect(rejected).rejects.toThrow('native error');
    const empty = child();
    const noError = powershell('read');
    empty.emit('close', 2);
    await expect(noError).rejects.toThrow('exit 2');
  });
  it('handles launch failure', async () => {
    const process = child();
    const result = powershell('read');
    process.emit('error', new Error('missing powershell'));
    await expect(result).rejects.toThrow('missing powershell');
  });
  it('terminates only its helper on deadline or output limit', async () => {
    vi.useFakeTimers();
    const process = child();
    const result = powershell('read');
    const assertion = expect(result).rejects.toThrow('timed out');
    await vi.advanceTimersByTimeAsync(30_000);
    process.emit('close', null);
    await assertion;
    expect(process.kill).toHaveBeenCalledOnce();
    const large = child();
    const exceeded = powershell('read');
    large.stdout.write(Buffer.alloc(1_000_001));
    large.emit('close', null);
    await expect(exceeded).rejects.toThrow('exceeds 1 MB');
    expect(large.kill).toHaveBeenCalledOnce();
  });
});
