/**
 * Shared atomic JSON write helper — write-tmp-then-rename, with a retry and
 * copy fallback for filesystems where rename can transiently fail (matches
 * the hardened logic in lib/daemon/state.ts's writeState()).
 */

import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';

/** Less-atomic last resort when rename keeps failing: copy then unlink. */
function copyFallback(tempPath: string, filePath: string): void {
  try {
    fs.copyFileSync(tempPath, filePath);
    fs.unlinkSync(tempPath);
  } catch (copyErr) {
    try {
      fs.unlinkSync(tempPath);
    } catch {
      /* best-effort cleanup */
    }
    throw copyErr;
  }
}

function busyWaitMs(ms: number): void {
  const start = Date.now();
  while (Date.now() - start < ms);
}

/**
 * Atomically persist `data` as JSON to `filePath`. Creates the parent
 * directory if needed. Writes to a sibling temp file first, then renames
 * it into place so readers never observe a partially-written file.
 */
export function atomicWriteJson(filePath: string, data: unknown): void {
  const dir = path.dirname(filePath);
  if (!fs.existsSync(dir)) {
    fs.mkdirSync(dir, { recursive: true });
  }
  const tempPath = path.join(dir, `.tmp.${crypto.randomBytes(4).toString('hex')}`);
  const serialized = `${JSON.stringify(data, null, 2)}\n`;
  fs.writeFileSync(tempPath, serialized, 'utf8');

  for (let retries = 0; ; retries++) {
    try {
      fs.renameSync(tempPath, filePath);
      return;
    } catch {
      if (retries >= 5) {
        copyFallback(tempPath, filePath);
        return;
      }
      busyWaitMs(50 * (retries + 1));
    }
  }
}
