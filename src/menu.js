import path from 'node:path';
import fs from 'node:fs/promises';
import * as p from '@clack/prompts';
import pc from 'picocolors';
import { classifyUrl, URL_EXAMPLES } from './url.js';
import { fetchFormats, buildQualityOptions } from './formats.js';
import { nativeExtFor, planStages, targetPathFor } from './args.js';
import { checkDependencies, checkFfmpeg, installYtDlp, installFfmpeg } from './checks.js';
import * as dl from './downloader.js';
import { showStats, formatSize, formatDuration } from './stats.js';
import { log } from './logger.js';
import { AppError } from './errors.js';

async function pathExists(p_) {
  try {
    await fs.stat(p_);
    return true;
  } catch {
    return false;
  }
}

/**
 * Session-scoped defaults: the last confirmed selections become the
 * pre-selected answers next time (survives interrupted downloads).
 * Persistent config is an MVP 2 item (see ROADMAP).
 */
const sessionDefaults = { formatId: undefined, chosenExt: undefined, keepNative: undefined };

/** Ctrl+C confirm for a running stage; treats a second Ctrl+C (cancel) as "stop". */
function makeConfirmStop(message) {
  return async () => {
    const answer = await p.confirm({ message, initialValue: false });
    return p.isCancel(answer) ? true : answer;
  };
}

/** true when the user pressed Ctrl+C / Esc inside a prompt. */
function cancelled(value) {
  if (p.isCancel(value)) {
    log.info('Cancelled');
    return true;
  }
  return false;
}

/** Ask for a URL; validation re-prompts in place until a Twitch link is entered. */
async function promptUrl(exampleKey) {
  const value = await p.text({
    message: exampleKey === 'channel' ? 'Paste the channel link' : 'Paste the VOD or clip link',
    placeholder: URL_EXAMPLES[exampleKey],
    validate: (v) => {
      switch (classifyUrl(v ?? '').type) {
        case 'empty':
          return 'Paste a Twitch link';
        case 'invalid':
          return `That doesn't look like a Twitch link — e.g. ${URL_EXAMPLES[exampleKey]}`;
        case 'not-twitch':
          return `Only twitch.tv links are supported — e.g. ${URL_EXAMPLES[exampleKey]}`;
        case 'unknown':
          return 'This Twitch page is not downloadable — use a VOD, clip or channel link';
        default:
          return undefined;
      }
    },
  });
  if (cancelled(value)) return null;
  return classifyUrl(value);
}

async function requireYtDlp(deps) {
  if (deps.ytDlp.found) return true;
  log.fail('yt-dlp is required for this action');
  const answer = await p.confirm({ message: 'Install yt-dlp now (winget, pip fallback)?', initialValue: true });
  if (cancelled(answer) || !answer) {
    log.info('Use "Install missing tools" from the menu when ready');
    return false;
  }
  const ok = await installYtDlp();
  Object.assign(deps, await checkDependencies({ quiet: true }));
  return ok;
}

async function offerFfmpegInstall(deps, why) {
  log.warn(`ffmpeg is missing — ${why}`);
  const answer = await p.confirm({ message: 'Install ffmpeg now via winget?', initialValue: true });
  if (cancelled(answer) || !answer) return false;
  const ok = await installFfmpeg();
  Object.assign(deps, await checkDependencies({ quiet: true }));
  return ok;
}

/** Container choices for the final-format select. */
function containerOptions(nativeExt, ffmpegFound) {
  if (nativeExt === 'mp4') {
    // Clips are plain MP4 files — mp4 is already the native container.
    const opts = [{ value: 'mp4', label: 'mp4', hint: 'native — no rebuild needed' }];
    if (ffmpegFound) opts.push({ value: 'mkv', label: 'mkv', hint: 'rebuild via remux (no re-encoding)' });
    return opts;
  }
  const opts = [];
  if (ffmpegFound) {
    opts.push({ value: 'mp4', label: 'mp4', hint: 'remux after download (no re-encoding)' });
    opts.push({ value: 'mkv', label: 'mkv', hint: 'remux after download (no re-encoding)' });
  }
  opts.push({ value: 'ts', label: 'ts', hint: 'native — keep exactly as downloaded' });
  return opts;
}

/**
 * Handle "file already exists" before stage 1.
 * @returns {Promise<'fresh'|'resume'|null>} null = back to menu
 */
async function resolveConflict(nativePath, { isLive }) {
  const kind = await dl.detectConflict(nativePath);
  if (!kind) return 'fresh';
  const existing = kind === 'part' ? `${path.basename(nativePath)}.part` : path.basename(nativePath);
  log.warn(`File already exists: ${existing}`);
  const options = [];
  if (!isLive) {
    options.push({
      value: 'resume',
      label: 'Resume',
      hint: kind === 'part' ? 'continue the partial download' : 'let yt-dlp verify the finished file',
    });
  }
  options.push({ value: 'overwrite', label: 'Overwrite', hint: 'delete it and start from scratch' });
  options.push({ value: 'skip', label: 'Skip', hint: 'back to menu' });
  const choice = await p.select({ message: 'How should the existing file be handled?', options });
  if (cancelled(choice) || choice === 'skip') return null;
  if (choice === 'overwrite') {
    await dl.clearForFresh(nativePath);
    log.ok('Existing files removed');
    return 'fresh';
  }
  return 'resume';
}

/**
 * Quality + container + keep-intermediate selection, then the two-stage pipeline.
 */
async function runSelectionsAndDownload({ deps, urlInfo, meta, isLive }) {
  const nativeExt = nativeExtFor(urlInfo.type);

  // Quality — real list from yt-dlp -F
  let formats = [];
  try {
    formats = await fetchFormats(urlInfo.url);
  } catch (err) {
    log.fail(err.message);
    if (err.hint) log.info(err.hint);
    return;
  }
  let formatId = null;
  let estimateBytes = null;
  if (formats.length === 0) {
    log.info('Proceeding with "Best (auto)"');
  } else {
    const qualityOptions = buildQualityOptions(formats);
    const rememberedQuality =
      sessionDefaults.formatId !== undefined && qualityOptions.some((o) => o.value === sessionDefaults.formatId)
        ? sessionDefaults.formatId
        : undefined;
    const choice = await p.select({ message: 'Quality', options: qualityOptions, initialValue: rememberedQuality });
    if (cancelled(choice)) return;
    sessionDefaults.formatId = choice;
    formatId = choice;
    const sizes = formats.map((f) => f.sizeBytes).filter(Boolean);
    estimateBytes = formatId
      ? formats.find((f) => f.id === formatId)?.sizeBytes ?? null
      : sizes.length
        ? Math.max(...sizes)
        : null;
  }

  // Final container
  if (nativeExt === 'ts' && !deps.ffmpeg.found) {
    await offerFfmpegInstall(deps, 'mp4/mkv rebuild is unavailable without it');
  }
  const formatOptions = containerOptions(nativeExt, deps.ffmpeg.found);
  const rememberedExt = formatOptions.some((o) => o.value === sessionDefaults.chosenExt)
    ? sessionDefaults.chosenExt
    : isLive
      ? 'ts'
      : deps.ffmpeg.found || nativeExt === 'mp4'
        ? 'mp4'
        : 'ts';
  const chosenExt = await p.select({
    message: 'Final format',
    options: formatOptions,
    initialValue: rememberedExt,
  });
  if (cancelled(chosenExt)) return;
  sessionDefaults.chosenExt = chosenExt;

  // Keep the intermediate native file? (only relevant when a remux will happen)
  let keepNative = true;
  if (chosenExt !== nativeExt) {
    const answer = await p.confirm({
      message: `Keep the intermediate native .${nativeExt} after remux?`,
      initialValue: sessionDefaults.keepNative ?? true,
    });
    if (cancelled(answer)) return;
    keepNative = answer;
    sessionDefaults.keepNative = answer;
  }

  // Existing file conflict
  const mode = await resolveConflict(meta.nativePath, { isLive });
  if (!mode) return;

  // Disk space (only when we know the size)
  const plan = planStages({ chosenExt, nativeExt, keepNative });
  if (estimateBytes) {
    const { low } = await dl.checkDiskSpace(estimateBytes, { needsRemux: plan.needsRemux });
    if (low) {
      const goOn = await p.confirm({ message: 'Disk space looks low — continue anyway?', initialValue: false });
      if (cancelled(goOn) || !goOn) return;
    }
  } else if (!isLive) {
    log.info('Video size unknown — skipping disk space check');
  }

  await executeDownload({ deps, url: urlInfo.url, meta, formatId, chosenExt, keepNative, isLive, nativeExt });
}

/** The two-stage pipeline itself: stage 1 native download, stage 2 optional remux. */
async function executeDownload({ deps, url, meta, formatId, chosenExt, keepNative, isLive, nativeExt }) {
  const plan = planStages({ chosenExt, nativeExt, keepNative });
  const startedAt = Date.now();
  const stagePrefix = plan.needsRemux ? 'stage 1/2, ' : '';
  const verb = isLive ? 'Recording live stream' : 'Downloading';

  // Stage 1 (with a re-select loop if the chosen quality vanished meanwhile)
  let currentFormat = formatId;
  let s1;
  for (;;) {
    s1 = await dl.runStage1({
      url,
      formatId: currentFormat,
      nativePath: meta.nativePath,
      isLive,
      label: `${verb} (${stagePrefix}native .${nativeExt})`,
      confirmStop: makeConfirmStop(
        isLive
          ? 'Stop the recording? Everything recorded so far will be kept.'
          : 'Stop the download? The partial file can be resumed later.',
      ),
    });
    if (s1.status === 'error' && s1.error?.code === 'format') {
      log.fail(s1.error.message);
      let fresh = [];
      try {
        fresh = await fetchFormats(url);
      } catch {
        /* fall through to Best (auto) */
      }
      const options = fresh.length
        ? buildQualityOptions(fresh)
        : [{ value: null, label: 'Best (auto)', hint: 'highest available video+audio' }];
      const again = await p.select({ message: 'Pick an available quality', options });
      if (cancelled(again)) return;
      sessionDefaults.formatId = again;
      currentFormat = again;
      continue;
    }
    break;
  }

  if (s1.status === 'interrupted') {
    if (isLive) {
      // Live lands here only when nothing usable hit the disk (a stopped
      // recording with data returns status ok) — recordings don't resume.
      log.warn(`Recording stopped after ${formatDuration(s1.elapsedMs || 0)} — nothing was captured`);
      log.info('The stream may have only just started; try recording again');
    } else {
      log.warn(`Stopped: ${formatSize(s1.partBytes || 0)} downloaded in ${formatDuration(s1.elapsedMs || 0)}`);
      log.info('Partial file kept in downloads/ — run the same URL again and choose Resume to continue');
    }
    return;
  }
  if (s1.status === 'error') {
    log.fail(s1.error.message);
    if (s1.error.hint) log.info(s1.error.hint);
    if ((s1.elapsedMs || 0) > 3000) {
      log.info(`Elapsed before the failure: ${formatDuration(s1.elapsedMs)}`);
    }
    return;
  }

  let finalPath = meta.nativePath;
  let finalBytes = s1.fileBytes;

  // If the download completed while the user was confirming a stop, don't
  // barrel into a multi-minute remux they just tried to abort — ask first.
  let doStage2 = plan.needsRemux;
  if (doStage2 && s1.stopAfterFinish) {
    log.info('The download finished while you were deciding to stop');
    const proceed = await p.confirm({ message: `Build the ${plan.targetExt} as planned?`, initialValue: true });
    if (cancelled(proceed) || !proceed) {
      log.info(`Native .${nativeExt} kept as the result`);
      doStage2 = false;
    }
  }

  // Stage 2 — remux (skipped when the user chose the native container)
  if (doStage2) {
    const targetPath = targetPathFor(meta.nativePath, plan.targetExt);
    // Tools can vanish between start and now — re-check (spec requirement).
    const ff = await checkFfmpeg();
    let doRemux = ff.found;
    if (!ff.found) {
      log.fail('ffmpeg is not available — cannot remux');
      log.info(`Native .${nativeExt} kept as the result: ${path.basename(meta.nativePath)}`);
    }
    if (doRemux && (await pathExists(targetPath))) {
      log.warn(`Target file already exists: ${path.basename(targetPath)}`);
      const ow = await p.confirm({ message: 'Overwrite it?', initialValue: false });
      if (cancelled(ow) || !ow) {
        log.info(`Keeping native .${nativeExt} as the result`);
        doRemux = false;
      }
    }
    while (doRemux) {
      const s2 = await dl.runStage2({
        nativePath: meta.nativePath,
        targetPath,
        targetExt: plan.targetExt,
        confirmStop: makeConfirmStop('Stop the remux? The native file stays intact.'),
      });
      if (s2.status === 'ok') {
        log.ok(`Saved: ${path.basename(targetPath)} (${formatSize(s2.fileBytes)})`);
        finalPath = targetPath;
        finalBytes = s2.fileBytes;
        if (plan.deleteNativeAfter) await dl.removeNative(meta.nativePath);
        else log.info(`Intermediate .${nativeExt} kept: ${path.basename(meta.nativePath)}`);
        break;
      }
      if (s2.status === 'interrupted') {
        log.warn('Remux interrupted — unfinished output removed, native file kept as the result');
        break;
      }
      log.fail('Remux failed');
      if (s2.error) {
        log.detail(s2.error.message);
        if (s2.error.hint) log.info(s2.error.hint);
      }
      const retry = await p.select({
        message: 'What next?',
        options: [
          { value: 'retry', label: 'Retry the remux' },
          { value: 'keep', label: 'Finish with the native file' },
        ],
      });
      if (cancelled(retry) || retry === 'keep') {
        log.info(`Native .${nativeExt} kept as the result`);
        break;
      }
    }
  }

  log.blank();
  console.log(
    pc.green(pc.bold(`✓ Done: ${path.basename(finalPath)} · ${formatSize(finalBytes)} · ${formatDuration(Date.now() - startedAt)}`)),
  );
  dl.openExplorerSelect(finalPath);
}

/** Menu item 2 — Download VOD / clip. `preset` lets the live flow hand a URL over. */
async function vodFlow(deps, preset) {
  if (!(await requireYtDlp(deps))) return;
  let urlInfo = preset ?? null;
  for (;;) {
    urlInfo = urlInfo ?? (await promptUrl('vod'));
    if (!urlInfo) return;

    if (urlInfo.type === 'channel') {
      log.warn('This is a channel link, not a VOD or clip');
      const choice = await p.select({
        message: 'What next?',
        options: [
          { value: 'live', label: "Record this channel's live stream instead" },
          { value: 'again', label: 'Enter a different URL' },
          { value: 'menu', label: 'Back to menu' },
        ],
      });
      if (cancelled(choice) || choice === 'menu') return;
      if (choice === 'live') return liveFlow(deps, urlInfo);
      urlInfo = null;
      continue;
    }

    let meta;
    try {
      meta = await dl.fetchMeta({ url: urlInfo.url, nativeExt: nativeExtFor(urlInfo.type) });
    } catch (err) {
      log.fail(err.message);
      if (err.hint) log.info(err.hint);
      const choice = await p.select({
        message: 'What next?',
        options: [
          { value: 'again', label: 'Try another URL' },
          { value: 'menu', label: 'Back to menu' },
        ],
      });
      if (cancelled(choice) || choice === 'menu') return;
      urlInfo = null;
      continue;
    }
    await runSelectionsAndDownload({ deps, urlInfo, meta, isLive: false });
    return;
  }
}

/** Menu item 1 — Record live stream. `preset` lets the VOD flow hand a URL over. */
async function liveFlow(deps, preset) {
  if (!(await requireYtDlp(deps))) return;
  if (!deps.ffmpeg.found) {
    // yt-dlp records live HLS through ffmpeg, so it is a hard requirement here.
    const ok = await offerFfmpegInstall(deps, 'recording live streams requires it');
    if (!ok) return;
  }
  let urlInfo = preset ?? null;
  for (;;) {
    urlInfo = urlInfo ?? (await promptUrl('channel'));
    if (!urlInfo) return;

    if (urlInfo.type === 'vod' || urlInfo.type === 'clip') {
      log.warn(`This is a ${urlInfo.type === 'vod' ? 'VOD' : 'clip'} link, not a channel`);
      const choice = await p.select({
        message: 'What next?',
        options: [
          { value: 'vod', label: 'Download it as a VOD/clip instead' },
          { value: 'again', label: 'Enter a different URL' },
          { value: 'menu', label: 'Back to menu' },
        ],
      });
      if (cancelled(choice) || choice === 'menu') return;
      if (choice === 'vod') return vodFlow(deps, urlInfo);
      urlInfo = null;
      continue;
    }

    let meta;
    try {
      meta = await dl.fetchMeta({ url: urlInfo.url, nativeExt: nativeExtFor(urlInfo.type) });
    } catch (err) {
      log.fail(err.message);
      if (err.hint) log.info(err.hint);
      const isOffline = err.code === 'offline';
      const choice = await p.select({
        message: 'What next?',
        options: [
          ...(isOffline ? [{ value: 'retry', label: 'Check again' }] : []),
          { value: 'again', label: 'Enter another URL' },
          { value: 'menu', label: 'Back to menu' },
        ],
      });
      if (cancelled(choice) || choice === 'menu') return;
      if (choice === 'again') urlInfo = null;
      continue; // 'retry' keeps the same urlInfo
    }
    if (!meta.isLive) {
      log.warn('yt-dlp did not report this as a live stream — recording may stop immediately');
    }
    await runSelectionsAndDownload({ deps, urlInfo, meta, isLive: true });
    return;
  }
}

async function installMissing(deps) {
  if (deps.ytDlp.found && deps.ffmpeg.found) {
    log.ok('All tools are already installed');
    return;
  }
  if (!deps.ytDlp.found) await installYtDlp();
  if (!deps.ffmpeg.found) await installFfmpeg();
  Object.assign(deps, await checkDependencies());
}

/** Main menu loop. Never throws: every action failure returns to the menu. */
export async function runApp(deps) {
  await dl.ensureDownloadsDir();
  for (;;) {
    log.blank();
    const missingTools = [
      !deps.ytDlp.found && 'yt-dlp',
      !deps.ffmpeg.found && 'ffmpeg',
    ].filter(Boolean);
    const action = await p.select({
      message: 'What do you want to do?',
      options: [
        { value: 'live', label: '📡 Record live stream' },
        { value: 'vod', label: '🎬 Download VOD / clip' },
        { value: 'stats', label: '📊 Download stats' },
        { value: 'open', label: '📂 Open downloads folder' },
        ...(missingTools.length
          ? [{ value: 'install', label: '🔧 Install missing tools', hint: missingTools.join(', ') }]
          : []),
        { value: 'exit', label: '❌ Exit' },
      ],
    });
    if (p.isCancel(action) || action === 'exit') {
      p.outro('Bye!');
      return;
    }
    try {
      switch (action) {
        case 'live':
          Object.assign(deps, await checkDependencies({ quiet: true }));
          await liveFlow(deps);
          break;
        case 'vod':
          Object.assign(deps, await checkDependencies({ quiet: true }));
          await vodFlow(deps);
          break;
        case 'stats':
          await dl.ensureDownloadsDir();
          await showStats(dl.DOWNLOADS_DIR);
          break;
        case 'open':
          await dl.ensureDownloadsDir();
          dl.openExplorerFolder();
          break;
        case 'install':
          await installMissing(deps);
          break;
      }
    } catch (err) {
      if (err instanceof AppError) {
        log.fail(err.message);
        if (err.hint) log.info(err.hint);
      } else {
        log.fail(`Unexpected error: ${err?.message ?? err}`);
      }
      log.info('Returning to menu');
    }
  }
}
