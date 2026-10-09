import { spawn } from 'node:child_process';

export function powershell(script: string): Promise<string> {
  return new Promise((resolve, reject) => {
    const child = spawn('powershell.exe', ['-NoProfile', '-NonInteractive', '-Command', script], { windowsHide: true });
    let out = '';
    let err = '';
    let cancelled: Error | undefined;
    const timer = setTimeout(() => {
      cancelled = new Error('Audacity Windows helper timed out after 30000 ms');
      child.kill();
    }, 30_000);
    child.stdout.on('data', (d) => {
      if (out.length + d.length > 1_000_000) {
        cancelled = new Error('Audacity Windows helper output exceeds 1 MB');
        child.kill();
      } else out += d;
    });
    child.stderr.on('data', (d) => (err = (err + d).slice(-4096)));
    child.on('error', (error) => {
      clearTimeout(timer);
      reject(error);
    });
    child.on('close', (code) => {
      clearTimeout(timer);
      if (cancelled) reject(cancelled);
      else if (code === 0) resolve(out.trim());
      else reject(new Error(err.trim() || `exit ${code}`));
    });
  });
}
