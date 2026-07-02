import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { collectStats, formatSize, formatDuration } from '../src/stats.js';

async function makeFixtureDir(files) {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'twitch-dl-stats-'));
  for (const [name, size] of Object.entries(files)) {
    await fs.writeFile(path.join(dir, name), Buffer.alloc(size));
  }
  return dir;
}

test('collects file count, per-file sizes and total bytes', async (t) => {
  const dir = await makeFixtureDir({
    'a.ts': 1024 * 1024,
    'b.mp4': 2 * 1024 * 1024,
    'c.mkv.part': 512 * 1024,
  });
  t.after(() => fs.rm(dir, { recursive: true, force: true }));

  const stats = await collectStats(dir);
  assert.equal(stats.count, 3);
  assert.equal(stats.totalBytes, 3.5 * 1024 * 1024);
  assert.equal(stats.files[0].name, 'b.mp4'); // sorted by size desc
  assert.equal(stats.files.find((f) => f.name === 'c.mkv.part').partial, true);
});

test('subdirectories are ignored', async (t) => {
  const dir = await makeFixtureDir({ 'a.ts': 1000 });
  t.after(() => fs.rm(dir, { recursive: true, force: true }));
  await fs.mkdir(path.join(dir, 'nested'));
  await fs.writeFile(path.join(dir, 'nested', 'b.ts'), Buffer.alloc(1000));

  const stats = await collectStats(dir);
  assert.equal(stats.count, 1);
  assert.equal(stats.totalBytes, 1000);
});

test('empty and missing directories are safe', async (t) => {
  const dir = await makeFixtureDir({});
  t.after(() => fs.rm(dir, { recursive: true, force: true }));
  assert.deepEqual(await collectStats(dir), { files: [], count: 0, totalBytes: 0 });
  assert.deepEqual(await collectStats(path.join(dir, 'does-not-exist')), { files: [], count: 0, totalBytes: 0 });
});

test('formatSize picks sensible units', () => {
  assert.equal(formatSize(3.42 * 1024 ** 3), '3.42 GB');
  assert.equal(formatSize(101.4 * 1024 ** 2), '101.4 MB');
  assert.equal(formatSize(5 * 1024), '5 KB');
});

test('formatDuration renders h/m/s', () => {
  assert.equal(formatDuration(12 * 60 * 1000 + 40 * 1000), '12m 40s');
  assert.equal(formatDuration(3 * 3600 * 1000 + 5 * 60 * 1000 + 2 * 1000), '3h 5m 2s');
  assert.equal(formatDuration(900), '1s');
});
