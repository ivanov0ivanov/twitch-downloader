/**
 * Pure builders for yt-dlp / ffmpeg argument lists and the two-stage plan.
 * No I/O here — everything is unit-testable.
 */

/** Format selector used for the "Best (auto)" option. */
export const BEST_FORMAT = 'bv*+ba/b';

/** Output name template (without extension — the native extension is appended literally). */
const FILENAME_TEMPLATE = '%(uploader)s - %(title)s - %(id)s';

/** Keep final paths comfortably under the Windows path limit. */
const TRIM_FILENAME_LENGTH = 120;

/**
 * Native container for stage 1.
 * Twitch VODs and live streams are HLS (MPEG-TS segments); clips are plain MP4 files.
 */
export function nativeExtFor(urlType) {
  return urlType === 'clip' ? 'mp4' : 'ts';
}

/** Escape literal '%' so a path can be passed as a yt-dlp -o value verbatim. */
export function escapeOutputTemplate(path) {
  return path.replace(/%/g, '%%');
}

/**
 * yt-dlp on Windows writes pipes in the ANSI code page (PyInstaller builds
 * ignore PYTHONUTF8), which garbles Cyrillic titles/filenames on the Node
 * side. `--encoding utf-8` forces a clean UTF-8 channel — every invocation
 * whose output is parsed (titles, filenames, format lists) must carry it.
 */
const UTF8_ARGS = ['--encoding', 'utf-8'];

/**
 * Args for the metadata probe: validates the URL against Twitch, prints
 * uploader / title / id / is_live and the exact output filename yt-dlp
 * would produce for our template (already sanitized for Windows).
 */
export function buildMetaArgs({ url, downloadsDir, nativeExt }) {
  const template = `${escapeOutputTemplate(downloadsDir)}\\${FILENAME_TEMPLATE}.${nativeExt}`;
  return [
    ...UTF8_ARGS,
    '--no-warnings',
    '--windows-filenames',
    '--trim-filenames', String(TRIM_FILENAME_LENGTH),
    '-o', template,
    '--print', '%(uploader)s',
    '--print', '%(title)s',
    '--print', '%(id)s',
    '--print', '%(is_live)s',
    '--print', 'filename',
    url,
  ];
}

/** Args for listing available formats (yt-dlp -F). */
export function buildFormatListArgs(url) {
  return [...UTF8_ARGS, '-F', '--no-warnings', url];
}

/**
 * Args for stage 1 — download/record the native stream, no ffmpeg conversion.
 * `--fixup never` stops yt-dlp from silently remuxing TS→MP4 after HLS downloads;
 * stage 2 is our own explicit remux.
 */
export function buildStage1Args({ url, formatId, outputPath, isLive }) {
  const args = [
    ...UTF8_ARGS,
    '--no-warnings',
    '--progress',
    '-f', formatId || BEST_FORMAT,
    '--fixup', 'never',
    '--retries', '10',
    '--fragment-retries', '10',
    '-o', escapeOutputTemplate(outputPath),
  ];
  if (isLive) {
    // Write straight to the final name: a killed recording must stay playable.
    args.push('--no-part');
    // Quiet the ffmpeg HLS downloader at the source: drop info chatter
    // (Opening <url> …) but keep the stats progress line and real warnings.
    args.push('--downloader-args', 'ffmpeg:-loglevel warning -stats');
  } else {
    // Parallel fragments speed up long VODs; .part files enable resume.
    args.push('-N', '4', '--continue');
  }
  args.push(url);
  return args;
}

/**
 * Args for stage 2 — remux the native file into the chosen container.
 * Stream copy only (`-c copy`), identical in spirit to yt-dlp's --remux-video,
 * which cannot be applied to an already-downloaded local file.
 * `-dn` drops data streams: Twitch HLS carries a timed_id3 metadata stream
 * that the mov muxer writes into a structurally broken mp4 (missing moov).
 * `-fflags +genpts` heals missing PTS in live recordings (ad-splice
 * discontinuities otherwise fail the mov muxer); no-op on clean input.
 */
export function buildRemuxArgs({ inputPath, outputPath }) {
  return [
    '-hide_banner',
    '-loglevel', 'warning',
    '-stats',
    '-y',
    '-fflags', '+genpts',
    '-i', inputPath,
    '-map', '0',
    '-dn',
    '-c', 'copy',
    outputPath,
  ];
}

/** Replace the extension of a path (naive, extension without dot). */
export function targetPathFor(nativePath, targetExt) {
  return nativePath.replace(/\.[^./\\]+$/, `.${targetExt}`);
}

/**
 * Decide what the two-stage pipeline looks like for a chosen container.
 *
 * @param {object} opts
 * @param {string} opts.chosenExt      user-selected container: 'mp4' | 'mkv' | 'ts'
 * @param {string} opts.nativeExt      stage-1 container ('ts' for VOD/live, 'mp4' for clips)
 * @param {boolean} opts.keepNative    user's answer to "keep the intermediate file?"
 * @returns {{needsRemux: boolean, targetExt: string, deleteNativeAfter: boolean}}
 */
export function planStages({ chosenExt, nativeExt, keepNative }) {
  const needsRemux = chosenExt !== nativeExt;
  return {
    needsRemux,
    targetExt: chosenExt,
    // The native file may only be removed after a *successful* remux.
    deleteNativeAfter: needsRemux && !keepNative,
  };
}
