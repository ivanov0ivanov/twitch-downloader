import fs from 'node:fs/promises';
import path from 'node:path';
import { log } from './logger.js';

const GiB = 1024 ** 3;
const MiB = 1024 ** 2;

/** Human-readable size: GB above 1 GiB, MB below. */
export function formatSize(bytes) {
  if (bytes >= GiB) return `${(bytes / GiB).toFixed(2)} GB`;
  if (bytes >= MiB) return `${(bytes / MiB).toFixed(1)} MB`;
  return `${(bytes / 1024).toFixed(0)} KB`;
}

/** Human-readable duration from milliseconds. */
export function formatDuration(ms) {
  const totalSec = Math.max(1, Math.round(ms / 1000));
  const h = Math.floor(totalSec / 3600);
  const m = Math.floor((totalSec % 3600) / 60);
  const s = totalSec % 60;
  if (h > 0) return `${h}h ${m}m ${s}s`;
  if (m > 0) return `${m}m ${s}s`;
  return `${s}s`;
}

/**
 * Collect stats for a downloads directory. Pure I/O helper, safe on missing dir.
 * @returns {Promise<{files: Array<{name, size, partial}>, count: number, totalBytes: number}>}
 */
export async function collectStats(dir) {
  let entries;
  try {
    entries = await fs.readdir(dir, { withFileTypes: true });
  } catch (err) {
    if (err.code === 'ENOENT') return { files: [], count: 0, totalBytes: 0 };
    throw err;
  }
  const files = [];
  let totalBytes = 0;
  for (const entry of entries) {
    if (!entry.isFile()) continue;
    const full = path.join(dir, entry.name);
    const stat = await fs.stat(full);
    totalBytes += stat.size;
    files.push({ name: entry.name, size: stat.size, partial: entry.name.endsWith('.part') });
  }
  files.sort((a, b) => b.size - a.size);
  return { files, count: files.length, totalBytes };
}

/** Print download stats per the logging convention. */
export async function showStats(downloadsDir) {
  log.step('Reading downloads folder');
  const { files, count, totalBytes } = await collectStats(downloadsDir);
  if (count === 0) {
    log.info('Downloads folder is empty');
    return;
  }
  log.ok(`${count} file${count === 1 ? '' : 's'}, ${(totalBytes / GiB).toFixed(2)} GB total`);
  for (const f of files) {
    log.detail(`${formatSize(f.size).padStart(10)}  ${f.name}${f.partial ? '  (partial)' : ''}`);
  }
}
