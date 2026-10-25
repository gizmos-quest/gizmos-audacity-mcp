import assert from 'node:assert/strict';
import { constants, readFileSync } from 'node:fs';
import fs, { type FileHandle } from 'node:fs/promises';
import { syncBuiltinESMExports } from 'node:module';

// Preload only in the disposable Linux helper: keep its real stdin/stdout,
// entry point and process exit, replacing Windows handles with a blocked read.
Object.defineProperty(process, 'platform', { value: 'win32' });
let bytes: Buffer = readFileSync(
  new URL('../fixtures/audacity-3.7.8/02-no-project-tracks.response.bin', import.meta.url),
);
let blocked: ReturnType<typeof setInterval> | undefined;
fs.open = async (path, flags) => {
  if (flags === constants.O_WRONLY) {
    assert.equal(path, '\\\\.\\pipe\\portable-to');
    return {
      async writeFile(command: string) {
        assert.equal(command, 'GetInfo: Type=Tracks Format=JSON\r\n\0');
      },
      async close() {},
    } as unknown as FileHandle;
  }
  assert.equal(flags, constants.O_RDONLY);
  assert.equal(path, '\\\\.\\pipe\\portable-from');
  return {
    async read(buffer: Buffer) {
      if (!bytes.length) {
        // An unresolved Promise alone cannot model a native read keeping Node
        // alive. This referenced timer requires the worker to end itself.
        blocked = setInterval(() => {}, 1_000);
        await new Promise(() => {});
      }
      const bytesRead = bytes.copy(buffer);
      bytes = bytes.subarray(bytesRead);
      return { bytesRead, buffer };
    },
    async close() {
      clearInterval(blocked);
    },
  } as unknown as FileHandle;
};
syncBuiltinESMExports();
