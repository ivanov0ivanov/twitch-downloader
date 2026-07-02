import { spawn } from 'node:child_process';
import fs from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { runCommand, killTree } from './checks.js';
import { buildMetaArgs, buildStage1Args, buildRemuxArgs } from './args.js';
import { appErrorFrom, AppError } from './errors.js';
import { log } from './logger.js';
import { formatSize, formatDuration } from './stats.js';

/** MVP 1 downloads into a fixed folder next to the package (see ROADMAP for MVP 2). */
export const DOWNLOADS_DIR = fileURLToPath(new URL('../downloads', import.meta.url));

export async function ensureDownloadsDir() {
  await fs.mkdir(DOWNLOADS_DIR, { recursive: true });
}

async function statOrNull(p) {
  try {
    return await fs.stat(p);
  } catch {
    return null;
  }
}

/**
 * Probe the URL: validates it against Twitch and returns metadata plus the
 * exact stage-1 output path yt-dlp would produce (sanitized for Windows).
 * @throws {AppError}
 */
export async function fetchMeta({ url, nativeExt }) {
  log.step('Fetching video info');
  const res = await runCommand(
    'yt-dlp',
    buildMetaArgs({ url, downloadsDir: DOWNLOADS_DIR, nativeExt }),
    { timeoutMs: 60000 },
  );
  if (res.code !== 0) {
    throw appErrorFrom(res.stderr);
  }
  const lines = res.stdout.split(/\r?\n/).filter((l) => l.trim() !== '');
  if (lines.length < 5) throw new AppError('Could not read video metadata from yt-dlp.');
  const [uploader, title, id, isLiveRaw] = lines;
  const nativePath = lines[lines.length - 1];
  const meta = {
    uploader,
    title,
    id,
    isLive: /^true$/i.test(isLiveRaw),
    nativePath,
  };
  log.ok(`Found: ${meta.uploader} — ${meta.title}`);
  return meta;
}

/**
 * @returns {Promise<{freeBytes: number|null, needBytes: number|null, low: boolean}>}
 */
export async function checkDiskSpace(estimateBytes, { needsRemux }) {
  if (!estimateBytes) return { freeBytes: null, needBytes: null, low: false };
  log.step('Checking free disk space');
  let freeBytes;
  try {
    const s = await fs.statfs(DOWNLOADS_DIR);
    freeBytes = Number(s.bsize) * Number(s.bavail);
  } catch {
    log.warn('Could not determine free disk space — continuing');
    return { freeBytes: null, needBytes: null, low: false };
  }
  // Remux temporarily needs native + target side by side.
  const needBytes = Math.ceil(estimateBytes * (needsRemux ? 2.2 : 1.1));
  const low = freeBytes < needBytes;
  if (low) {
    log.warn(`Low disk space: ${formatSize(freeBytes)} free, ~${formatSize(needBytes)} needed`);
  } else {
    log.ok(`${formatSize(freeBytes)} free (need ~${formatSize(needBytes)})`);
  }
  return { freeBytes, needBytes, low };
}

/** @returns {Promise<'file'|'part'|null>} what already exists at the stage-1 output path */
export async function detectConflict(nativePath) {
  if (await statOrNull(nativePath)) return 'file';
  if (await statOrNull(`${nativePath}.part`)) return 'part';
  return null;
}

/** Remove a finished file and any .part leftovers so a download restarts clean. */
export async function clearForFresh(nativePath) {
  await fs.rm(nativePath, { force: true });
  await fs.rm(`${nativePath}.part`, { force: true });
}

/**
 * Run a child process whose stdout streams straight to the terminal
 * (native progress rendering) while stderr is mirrored and captured.
 * Handles Ctrl+C: the child shares the console and receives it too; we
 * survive, note the interruption and let the caller decide what it means.
 */
function runChildWithSigint(cmd, args) {
  return new Promise((resolve) => {
    let child;
    try {
      child = spawn(cmd, args, { stdio: ['ignore', 'inherit', 'pipe'] });
    } catch (err) {
      resolve({ code: -1, stderrTail: String(err), interrupted: false, missing: true });
      return;
    }
    let stderrTail = '';
    let interrupted = false;
    let forceKillTimer;

    const onSigint = () => {
      if (!interrupted) {
        interrupted = true;
        // The child got Ctrl+C from the shared console; give it 5s to shut down.
        forceKillTimer = setTimeout(() => killTree(child), 5000);
      } else {
        killTree(child); // second Ctrl+C — force
      }
    };
    process.on('SIGINT', onSigint);

    child.stderr.on('data', (d) => {
      process.stderr.write(d);
      stderrTail = (stderrTail + d).slice(-8192);
    });
    child.on('error', (err) => {
      process.removeListener('SIGINT', onSigint);
      clearTimeout(forceKillTimer);
      resolve({ code: -1, stderrTail: String(err), interrupted, missing: err.code === 'ENOENT' });
    });
    child.on('close', (code) => {
      process.removeListener('SIGINT', onSigint);
      clearTimeout(forceKillTimer);
      resolve({ code: code ?? -1, stderrTail, interrupted, missing: false });
    });
  });
}

/**
 * Stage 1 — download/record the native stream.
 * @returns {Promise<{status: 'ok'|'interrupted'|'error', fileBytes?, elapsedMs?, error?: AppError, partBytes?}>}
 */
export async function runStage1({ url, formatId, nativePath, isLive, label }) {
  log.step(label);
  const started = Date.now();
  const res = await runChildWithSigint(
    'yt-dlp',
    buildStage1Args({ url, formatId, outputPath: nativePath, isLive }),
  );
  const elapsedMs = Date.now() - started;
  const finalStat = await statOrNull(nativePath);

  if (res.missing) {
    return { status: 'error', error: new AppError('yt-dlp is not available.', 'Install it from the menu and retry.') };
  }

  if (res.interrupted) {
    if (isLive && finalStat && finalStat.size > 0) {
      // Stopping a live recording with Ctrl+C is the normal way to end it.
      log.ok(`Recording stopped: ${formatSize(finalStat.size)} in ${formatDuration(elapsedMs)}`);
      return { status: 'ok', fileBytes: finalStat.size, elapsedMs, stopped: true };
    }
    const partStat = await statOrNull(`${nativePath}.part`);
    return { status: 'interrupted', elapsedMs, partBytes: partStat?.size ?? finalStat?.size ?? 0 };
  }

  if (res.code === 0 && finalStat && finalStat.size > 0) {
    log.ok(`Downloaded: ${formatSize(finalStat.size)} in ${formatDuration(elapsedMs)}`);
    return { status: 'ok', fileBytes: finalStat.size, elapsedMs };
  }

  // Live streams that end naturally can exit non-zero after the last fragment;
  // if the file is there and non-empty, treat it as a finished recording.
  if (isLive && finalStat && finalStat.size > 0) {
    log.ok(`Recording finished: ${formatSize(finalStat.size)} in ${formatDuration(elapsedMs)}`);
    return { status: 'ok', fileBytes: finalStat.size, elapsedMs };
  }

  return { status: 'error', elapsedMs, error: appErrorFrom(res.stderrTail) };
}

/**
 * Stage 2 — remux the native file into the chosen container via ffmpeg stream copy.
 * On Ctrl+C the unfinished output is removed and the native file stays untouched.
 * @returns {Promise<{status: 'ok'|'interrupted'|'error', fileBytes?, error?: AppError}>}
 */
export async function runStage2({ nativePath, targetPath, targetExt }) {
  log.step(`Remuxing to ${targetExt} (stage 2/2)`);
  const res = await runChildWithSigint('ffmpeg', buildRemuxArgs({ inputPath: nativePath, outputPath: targetPath }));

  if (res.missing) {
    return { status: 'error', error: new AppError('ffmpeg is not available.', 'Install it from the menu, the native file is kept.') };
  }
  if (res.interrupted) {
    await fs.rm(targetPath, { force: true });
    return { status: 'interrupted' };
  }
  const stat = await statOrNull(targetPath);
  if (res.code === 0 && stat && stat.size > 0) {
    return { status: 'ok', fileBytes: stat.size };
  }
  await fs.rm(targetPath, { force: true });
  return { status: 'error', error: appErrorFrom(res.stderrTail) };
}

/** Delete the intermediate native file (only called after a successful remux). */
export async function removeNative(nativePath) {
  await fs.rm(nativePath, { force: true });
  log.info(`Intermediate file removed: ${path.basename(nativePath)}`);
}

/** Open Explorer with the given file focused. */
export function openExplorerSelect(filePath) {
  log.step('Opening downloads folder in Explorer');
  spawn('explorer.exe', [`/select,"${filePath}"`], {
    windowsVerbatimArguments: true,
    detached: true,
    stdio: 'ignore',
  }).unref();
  log.ok('Explorer opened');
}

/** Open Explorer at the downloads folder. */
export function openExplorerFolder() {
  log.step('Opening downloads folder in Explorer');
  spawn('explorer.exe', [DOWNLOADS_DIR], { detached: true, stdio: 'ignore' }).unref();
  log.ok('Explorer opened');
}
