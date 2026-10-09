import { lstatSync } from 'node:fs';
import { isAbsolute } from 'node:path';

/** Endpoint overrides must never let an ordinary file be opened/truncated as a
 * scripting pipe. Missing FIFOs are allowed here for the bounded open retry;
 * native opens use O_WRONLY/O_RDONLY without O_CREAT or O_TRUNC. */
export function validatePipePaths(paths: { to: string; from: string }, platform = process.platform): void {
  for (const file of [paths.to, paths.from]) {
    if (!file || /[\r\n\0]/.test(file)) throw new Error('Pipe endpoint must be a nonempty single-line path');
    if (platform === 'win32') {
      if (!/^\\\\\.\\pipe\\[^\\/]+$/i.test(file))
        throw new Error('Windows endpoints must use the named-pipe namespace \\\\.\\pipe\\name');
    } else {
      if (!isAbsolute(file)) throw new Error('POSIX endpoints must be absolute FIFO paths');
      try {
        if (!lstatSync(file).isFIFO())
          throw new Error('POSIX scripting endpoints must be FIFOs, never regular files or symlinks');
      } catch (error) {
        if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error;
      }
    }
  }
}
