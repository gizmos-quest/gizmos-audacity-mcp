import { afterEach, describe, expect, it, vi } from 'vitest';
import { replayPipe, wire } from './helpers/replay-pipe.js';

const io = vi.hoisted(() => ({ open: vi.fn(), spawn: vi.fn(() => ({ status: 0, stderr: '' })) }));
vi.mock('node:fs/promises', async (actual) => ({
  ...(await actual<typeof import('node:fs/promises')>()),
  open: io.open,
}));
vi.mock('node:child_process', async (actual) => ({
  ...(await actual<typeof import('node:child_process')>()),
  spawnSync: io.spawn,
}));

const platform = Object.getOwnPropertyDescriptor(process, 'platform')!;
afterEach(() => {
  Object.defineProperty(process, 'platform', platform);
  vi.useRealTimers();
  vi.clearAllMocks();
});

describe('POSIX replay harness teardown', () => {
  it('does not open another FIFO writer when closing during delayed delivery', async () => {
    Object.defineProperty(process, 'platform', { ...platform, value: 'linux' });
    vi.useFakeTimers();
    const input = {
      read: vi.fn(async (buffer: Buffer) => {
        const command = Buffer.from('Stop:\n');
        command.copy(buffer);
        return { bytesRead: command.length };
      }),
      close: vi.fn(async () => undefined),
    };
    const output = { writeFile: vi.fn(async () => undefined), close: vi.fn(async () => undefined) };
    io.open
      .mockResolvedValueOnce(input)
      .mockResolvedValueOnce(output)
      .mockImplementation(() => new Promise(() => undefined));
    const fake = await replayPipe(() => ({ bytes: wire('07-new-mono'), delayMs: 10_000 }));
    await vi.waitFor(() => expect(fake.commands).toEqual(['Stop:']));
    const closing = fake.close();
    await vi.advanceTimersByTimeAsync(10_000);
    await closing;
    expect(io.open).toHaveBeenCalledTimes(2);
    expect(input.close).toHaveBeenCalledOnce();
    expect(output.close).toHaveBeenCalledOnce();
  });
});
