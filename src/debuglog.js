import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

/** Technical log target — raw yt-dlp/ffmpeg output lands here, not in the UI. */
export const LOGS_DIR = fileURLToPath(new URL('../logs', import.meta.url));
export const DEBUG_LOG_PATH = path.join(LOGS_DIR, 'debug.log');

const MAX_LOG_BYTES = 5 * 1024 * 1024;

/**
 * Open an append sink for one stage. The file is truncated when it outgrows
 * MAX_LOG_BYTES so it never eats the disk.
 *
 * Writes go through a raw fd synchronously: the volume is tiny (progress
 * lines), and unlike a buffered WriteStream the log survives a hard
 * process.exit() from the crash guards — losing the buffered tail would drop
 * exactly the lines needed to diagnose the crash.
 * @returns {{write(chunk: Buffer|string): void, close(): void}}
 */
export function openStageLog(stageName) {
  try {
    fs.mkdirSync(LOGS_DIR, { recursive: true });
    try {
      if (fs.statSync(DEBUG_LOG_PATH).size > MAX_LOG_BYTES) fs.rmSync(DEBUG_LOG_PATH, { force: true });
    } catch {
      /* no log yet */
    }
    const fd = fs.openSync(DEBUG_LOG_PATH, 'a');
    fs.writeSync(fd, `\n===== ${new Date().toISOString()} · ${stageName} =====\n`);
    let closed = false;
    return {
      write(chunk) {
        if (closed) return;
        try {
          fs.writeSync(fd, chunk);
        } catch {
          /* logging must never break a download */
        }
      },
      close() {
        if (closed) return;
        closed = true;
        try {
          fs.closeSync(fd);
        } catch {
          /* already closed */
        }
      },
    };
  } catch {
    // Logging must never break a download.
    return { write() {}, close() {} };
  }
}
