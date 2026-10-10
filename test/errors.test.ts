import { describe, expect, it } from 'vitest';
import { errorMessage, errorWithContext, withCleanupFailure } from '../src/errors.js';
import { AudacityTimeout } from '../src/pipe.js';

describe('error helpers', () => {
  it('reads the message of an error or of any other thrown value', () => {
    expect(errorMessage(new Error('native failure'))).toBe('native failure');
    expect(errorMessage('plain text')).toBe('plain text');
    expect(errorMessage(42)).toBe('42');
  });

  it('rewrites an error message in place, so its class still selects the recovery advice', () => {
    const timeout = new AudacityTimeout('no reply');
    expect(errorWithContext(timeout, 'pipeline stopped: no reply')).toBe(timeout);
    expect(timeout).toMatchObject({ message: 'pipeline stopped: no reply' });
    expect(errorWithContext('thrown text', 'context')).toEqual(new Error('context'));
  });

  it('reports a cleanup failure alone, or after the operation failure it followed', () => {
    const cleanup = new Error('SelectNone failed');
    expect(withCleanupFailure(cleanup, undefined, 'Selection restoration')).toBe(cleanup);
    expect(cleanup.message).toBe('SelectNone failed');
    const timeout = new AudacityTimeout('Export2 reply lost');
    const reported = withCleanupFailure(timeout, new Error('export failed'), 'Selection restoration');
    expect(reported).toBe(timeout);
    expect(timeout.message).toBe('export failed. Selection restoration also failed: Export2 reply lost');
  });
});
