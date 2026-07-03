import { spawn } from 'node:child_process';
import fs from 'node:fs/promises';
import path from 'node:path';
import readline from 'node:readline';
import { fileURLToPath } from 'node:url';
import { runCommand, killTree } from './checks.js';
import { buildMetaArgs, buildStage1Args, buildRemuxArgs } from './args.js';
import { appErrorFrom, AppError } from './errors.js';
import { log } from './logger.js';
import { formatSize, formatDuration } from './stats.js';
import { classifyLine, createProgressRenderer } from './progress.js';
import { openStageLog, DEBUG_LOG_PATH } from './debuglog.js';

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

/**
 * Delete with retries on EBUSY/EPERM: right after a confirmed stop the killed
 * worker can hold file handles for a moment longer than taskkill takes to return.
 */
async function rmWithRetry(target) {
  for (let attempt = 1; ; attempt += 1) {
    try {
      await fs.rm(target, { force: true });
      return;
    } catch (err) {
      if ((err.code === 'EBUSY' || err.code === 'EPERM') && attempt < 5) {
        await new Promise((r) => setTimeout(r, 300));
        continue;
      }
      throw err;
    }
  }
}

/** Remove a finished file and any .part leftovers so a download restarts clean. */
export async function clearForFresh(nativePath) {
  const targets = [nativePath, `${nativePath}.part`];
  const dir = path.dirname(nativePath);
  const base = path.basename(nativePath);
  for (const entry of await fs.readdir(dir).catch(() => [])) {
    if (entry.startsWith(`${base}.part-Frag`) || entry === `${base}.ytdl`) {
      targets.push(path.join(dir, entry));
    }
  }
  for (const target of targets) {
    await rmWithRetry(target);
  }
}

/** Best-effort terminal repair after a child stage: cursor + input mode. */
function restoreTerminal() {
  if (process.stdout.isTTY) process.stdout.write('\x1b[?25h');
  if (process.stdin.isTTY && process.stdin.isRaw) {
    try {
      process.stdin.setRawMode(false);
    } catch {
      /* best effort */
    }
  }
}

/** The stage currently talking to a child process (one at a time by design). */
let activeStage = null;

/** True while a download/remux child is running — index.js routes SIGINT here. */
export function hasActiveStage() {
  return activeStage !== null;
}

/** PID of the active stage child, for the synchronous exit-hook cleanup. */
export function getActiveStagePid() {
  return activeStage?.child.pid ?? null;
}

/** Route a console Ctrl+C into the active stage's confirm-stop flow. */
export function requestInterrupt() {
  activeStage?.interrupt();
}

/**
 * Run one stage child (yt-dlp or ffmpeg) with:
 *  - process-group isolation: console Ctrl+C never reaches the child, so a
 *    not-yet-confirmed interrupt truly keeps the download running;
 *  - piped output: raw lines go to logs/debug.log; the UI shows only a compact
 *    progress line, deduplicated info notes and a short warning summary;
 *  - confirm-stop flow: SIGINT pauses rendering and asks `confirmStop()`;
 *    "no" resumes seamlessly, "yes" kills the whole child tree.
 *
 * @returns {Promise<{code:number, stderrTail:string, stopRequested:boolean, warnings:number, missing:boolean}>}
 */
function runStage({ cmd, args, stageName, progressPrefix, confirmStop, elapsedFrom }) {
  return new Promise((resolve) => {
    const logSink = openStageLog(stageName);
    let child;
    try {
      child = spawn(cmd, args, {
        stdio: ['ignore', 'pipe', 'pipe'],
        detached: true, // own process group + no shared console → Ctrl+C is ours alone
        windowsHide: true,
      });
    } catch (err) {
      logSink.close();
      resolve({ code: -1, stderrTail: String(err), stopRequested: false, warnings: 0, missing: true });
      return;
    }

    const renderer = createProgressRenderer({ prefix: progressPrefix });
    const started = elapsedFrom ?? Date.now();
    const shownInfo = new Set();
    let stderrTail = '';
    let warnings = 0;
    let firstWarningShown = false;
    let stopRequested = false;
    let stopAfterFinish = false;
    let confirmOpen = false;
    let exited = false;
    let finalized = false;
    let pendingInterrupt = null;
    const remainders = { out: '', err: '' };

    const handleLine = (line) => {
      const c = classifyLine(line);
      if (c.kind === 'progress') {
        renderer.update(`${c.text} · ${formatDuration(Date.now() - started)}`);
      } else if (c.kind === 'info') {
        // No UI writes while the confirm prompt is open or a stop is underway
        // (the killed child can still flush buffered output for a beat).
        if (!shownInfo.has(c.text) && !confirmOpen && !stopRequested) {
          shownInfo.add(c.text);
          renderer.pause();
          log.info(c.text);
          renderer.resume();
        }
      } else if (c.kind === 'warning') {
        warnings += 1;
        if (!firstWarningShown && !confirmOpen && !stopRequested) {
          firstWarningShown = true;
          renderer.pause();
          log.warn(`Stream warning: ${c.text}`);
          renderer.resume();
        }
      }
    };

    const handleChunk = (key, chunk) => {
      logSink.write(chunk);
      const text = remainders[key] + chunk.toString('utf8');
      const lines = text.split(/\r\n|\n|\r/);
      remainders[key] = lines.pop() ?? '';
      for (const line of lines) handleLine(line);
      if (key === 'err') stderrTail = (stderrTail + chunk).slice(-8192);
    };

    child.stdout.on('data', (d) => handleChunk('out', d));
    child.stderr.on('data', (d) => handleChunk('err', d));

    // Trap Ctrl+C as a keystroke while the stage runs: in raw mode the console
    // generates no CTRL_C_EVENT at all, so wrapper processes (npm, cmd, the
    // shell) survive the keypress — with a console signal they die and steal
    // the terminal mid-confirm (observed with `npm start`). SIGINT stays as
    // the non-TTY fallback.
    // Uses the same node:readline keypress machinery as @clack prompts (shared
    // decoder on stdin) and never calls pause(): extra pause/resume cycles on
    // the Windows console are what left the TTY deaf after a stage.
    let keyTrapActive = false;
    const onKeypress = (str, key) => {
      if (str === '\u0003' || (key?.ctrl && key.name === 'c')) interrupt();
    };
    const attachKeyTrap = () => {
      if (keyTrapActive || !process.stdin.isTTY) return;
      try {
        readline.emitKeypressEvents(process.stdin);
        process.stdin.setRawMode(true);
        process.stdin.on('keypress', onKeypress);
        process.stdin.resume();
        keyTrapActive = true;
      } catch {
        /* non-interactive stdin */
      }
    };
    const detachKeyTrap = () => {
      if (!keyTrapActive) return;
      keyTrapActive = false;
      process.stdin.off('keypress', onKeypress);
      try {
        process.stdin.setRawMode(false);
      } catch {
        /* best effort */
      }
      // No pause() here: the next prompt (or the exit path) owns the stream.
    };

    const interrupt = () => {
      if (confirmOpen || exited) return;
      if (stopRequested) {
        killTree(child); // impatient second Ctrl+C after a confirmed stop
        return;
      }
      confirmOpen = true;
      detachKeyTrap(); // hand the terminal to the confirm prompt
      renderer.pause();
      pendingInterrupt = (async () => {
        // The child keeps downloading while we ask — it never saw the Ctrl+C.
        const shouldStop = await confirmStop();
        confirmOpen = false;
        if (exited) {
          // Finished naturally while the user was deciding: honor a "stop" by
          // telling the caller not to auto-continue the pipeline.
          if (shouldStop) stopAfterFinish = true;
          return;
        }
        if (shouldStop) {
          stopRequested = true;
          log.step('Stopping — saving what has been downloaded');
          await killTree(child);
        } else {
          log.info('Continuing');
          renderer.resume();
          attachKeyTrap(); // keep catching Ctrl+C for the next interrupt
        }
      })().catch(() => {
        confirmOpen = false;
        if (!exited && !stopRequested) {
          renderer.resume();
          attachKeyTrap();
        }
      });
    };
    activeStage = { child, interrupt };
    attachKeyTrap();

    const finalize = async (code, missing) => {
      // A failed spawn fires BOTH 'error' and 'close' (verified on win32) —
      // run the teardown exactly once.
      if (finalized) return;
      finalized = true;
      exited = true;
      activeStage = null;
      if (pendingInterrupt) await pendingInterrupt; // never overlap the confirm prompt
      for (const key of ['out', 'err']) {
        if (remainders[key]) handleLine(remainders[key]);
      }
      detachKeyTrap();
      renderer.finish();
      logSink.close();
      restoreTerminal();
      if (warnings > 0) {
        log.warn(`${warnings} stream warning${warnings === 1 ? '' : 's'} — details in ${DEBUG_LOG_PATH}`);
      }
      resolve({ code, stderrTail, stopRequested, stopAfterFinish, warnings, missing });
    };

    child.on('error', (err) => {
      stderrTail = String(err);
      finalize(-1, err.code === 'ENOENT');
    });
    child.on('close', (code) => finalize(code ?? -1, false));
  });
}

/**
 * Stage 1 — download/record the native stream.
 * @param {object} opts
 * @param {() => Promise<boolean>} [opts.confirmStop] asked on Ctrl+C; default stops immediately
 * @returns {Promise<{status: 'ok'|'interrupted'|'error', fileBytes?, elapsedMs?, error?: AppError, partBytes?, stopped?: boolean}>}
 */
export async function runStage1({ url, formatId, nativePath, isLive, label, confirmStop }) {
  log.step(label);
  const started = Date.now();
  const res = await runStage({
    cmd: 'yt-dlp',
    args: buildStage1Args({ url, formatId, outputPath: nativePath, isLive }),
    stageName: `stage 1 · ${label} · ${url}`,
    progressPrefix: isLive ? '⏺' : '⬇',
    confirmStop: confirmStop ?? (async () => true),
    elapsedFrom: started,
  });
  const elapsedMs = Date.now() - started;
  const finalStat = await statOrNull(nativePath);

  if (res.missing) {
    return {
      status: 'error',
      elapsedMs,
      error: new AppError('yt-dlp is not available.', 'Install it from the menu and retry.'),
    };
  }

  // A finished download always wins: if the child completed on its own a beat
  // before (or while) the user confirmed a stop, the file is whole — report
  // success and let the caller decide whether to continue the pipeline.
  if (res.code === 0 && finalStat && finalStat.size > 0) {
    log.ok(`Downloaded: ${formatSize(finalStat.size)} in ${formatDuration(elapsedMs)}`);
    return {
      status: 'ok',
      fileBytes: finalStat.size,
      elapsedMs,
      stopAfterFinish: res.stopAfterFinish || res.stopRequested,
    };
  }

  if (res.stopRequested) {
    if (isLive && finalStat && finalStat.size > 0) {
      // Stopping a live recording is the normal way to end it.
      log.ok(`Recording stopped: ${formatSize(finalStat.size)} in ${formatDuration(elapsedMs)}`);
      return { status: 'ok', fileBytes: finalStat.size, elapsedMs, stopped: true };
    }
    const partStat = await statOrNull(`${nativePath}.part`);
    return { status: 'interrupted', elapsedMs, partBytes: partStat?.size ?? finalStat?.size ?? 0 };
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
 * On a confirmed stop the unfinished output is removed and the native file stays untouched.
 * @param {object} opts
 * @param {() => Promise<boolean>} [opts.confirmStop]
 * @returns {Promise<{status: 'ok'|'interrupted'|'error', fileBytes?, elapsedMs?, error?: AppError}>}
 */
export async function runStage2({ nativePath, targetPath, targetExt, confirmStop }) {
  log.step(`Remuxing to ${targetExt} (stage 2/2)`);
  const started = Date.now();
  const res = await runStage({
    cmd: 'ffmpeg',
    args: buildRemuxArgs({ inputPath: nativePath, outputPath: targetPath }),
    stageName: `stage 2 · remux to ${targetExt} · ${path.basename(nativePath)}`,
    progressPrefix: '🔄',
    confirmStop: confirmStop ?? (async () => true),
    elapsedFrom: started,
  });
  const elapsedMs = Date.now() - started;

  if (res.missing) {
    return {
      status: 'error',
      elapsedMs,
      error: new AppError('ffmpeg is not available.', 'Install it from the menu, the native file is kept.'),
    };
  }
  const stat = await statOrNull(targetPath);
  // A remux that completed on its own wins over a stop confirmed a beat late —
  // never delete a finished, valid output.
  if (res.code === 0 && stat && stat.size > 0) {
    return { status: 'ok', fileBytes: stat.size, elapsedMs };
  }
  if (res.stopRequested) {
    await rmWithRetry(targetPath);
    return { status: 'interrupted', elapsedMs };
  }
  await rmWithRetry(targetPath);
  return { status: 'error', elapsedMs, error: appErrorFrom(res.stderrTail) };
}

/** Delete the intermediate native file (only called after a successful remux). */
export async function removeNative(nativePath) {
  await rmWithRetry(nativePath);
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
