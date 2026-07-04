/**
 * Classification of child-process output lines (yt-dlp / ffmpeg), pure
 * progress-text composition and a compact single-line renderer. Parsers and
 * composers are pure and unit-tested; raw lines never reach the console UI —
 * they go to the debug log instead.
 */

import { formatDuration } from './stats.js';

// [download]  42.1% of ~  1.42GiB at    3.20MiB/s ETA 00:42 (frag 112/324)
const YTDLP_PROGRESS_RE =
  /\[download\]\s+([\d.]+)%\s+of\s+~?\s*([\d.]+\s*[KMGT]i?B)(?:\s+at\s+(~?\s*[\d.]+\s*[KMGT]i?B\/s|Unknown B\/s))?(?:\s+ETA\s+([\d:]+|Unknown))?/;

// frame= 913 fps=... size=  2310KiB time=00:00:30.31 bitrate= 624.2kbits/s speed=1.9e+03x
const FFMPEG_STATS_RE =
  /(?:^|\s)L?size=\s*([\d.]+\s*[kKMGT]i?B)\s+time=\s*([\d:.]+)\s+bitrate=\s*([\d.]+\s*[kKMG]?bits\/s)/;
const FFMPEG_SPEED_RE = /speed=\s*([\d.]+(?:e[+-]?\d+)?)x/i;

//   Duration: 01:42:38.57, start: 0.083000, bitrate: 8123 kb/s  (live inputs print "N/A")
const FFMPEG_DURATION_RE = /^Duration:\s*(\d+):(\d{2}):(\d{2})/;

const WARNING_RE = /(corrupt|discontinuity|invalid data|non-monotonic|dropping|deprecated pixel format)/i;

/** @returns {{percent:number, size:string, speed:string|null, eta:string|null}|null} */
export function parseYtdlpProgress(line) {
  const m = YTDLP_PROGRESS_RE.exec(line);
  if (!m) return null;
  return {
    percent: Number(m[1]),
    size: m[2].replace(/\s+/g, ''),
    speed: m[3] ? m[3].replace(/\s+/g, '') : null,
    eta: m[4] ?? null,
  };
}

/** @returns {{size:string, time:string, bitrate:string, speedX:number|null}|null} */
export function parseFfmpegStats(line) {
  const m = FFMPEG_STATS_RE.exec(line);
  if (!m) return null;
  const sp = FFMPEG_SPEED_RE.exec(line);
  return {
    size: m[1].replace(/\s+/g, ''),
    time: m[2].replace(/\.\d+$/, ''), // drop fractional seconds for display
    bitrate: m[3].replace(/\s+/g, ''),
    speedX: sp ? Number(sp[1]) : null, // media-seconds per wall-second ("23.4x")
  };
}

/** Input duration from the ffmpeg stderr header. @returns {number|null} seconds */
export function parseFfmpegDuration(line) {
  const m = FFMPEG_DURATION_RE.exec(line.trim());
  if (!m) return null;
  return Number(m[1]) * 3600 + Number(m[2]) * 60 + Number(m[3]);
}

const BIN_UNITS = { K: 1024, M: 1024 ** 2, G: 1024 ** 3, T: 1024 ** 4 };

/** '2310KiB' → bytes (returns null on unknown shapes). */
function binarySizeToBytes(label) {
  const m = /([\d.]+)([KMGT])i?B/i.exec(label);
  return m ? Number(m[1]) * BIN_UNITS[m[2].toUpperCase()] : null;
}

/** bytes → '1.50MiB' / '2.31GiB' — same unit style yt-dlp uses. */
function humanBinary(bytes) {
  if (bytes >= BIN_UNITS.G) return `${(bytes / BIN_UNITS.G).toFixed(2)}GiB`;
  if (bytes >= BIN_UNITS.M) return `${(bytes / BIN_UNITS.M).toFixed(2)}MiB`;
  return `${(bytes / BIN_UNITS.K).toFixed(0)}KiB`;
}

/** '01:42:38' → 6158 (returns null on unknown shapes). */
function clockToSeconds(hms) {
  const m = /^(\d+):(\d{2}):(\d{2})$/.exec(hms);
  return m ? Number(m[1]) * 3600 + Number(m[2]) * 60 + Number(m[3]) : null;
}

/** seconds → 'MM:SS' / 'H:MM:SS' — same style yt-dlp uses for ETA. */
function secondsToClock(sec) {
  const total = Math.max(0, Math.round(sec));
  const h = Math.floor(total / 3600);
  const m = Math.floor((total % 3600) / 60);
  const s = total % 60;
  const mmss = `${String(m).padStart(2, '0')}:${String(s).padStart(2, '0')}`;
  return h > 0 ? `${h}:${mmss}` : mmss;
}

/** Strip long URLs and cap length so a warning never floods the UI. */
function sanitizeWarning(line) {
  return line
    .replace(/https?:\/\/\S+/g, '<url>')
    .replace(/^\[[^\]]*@ [0-9a-fx]+\]\s*/i, '') // "[aist#0:0/aac @ 000001..] " prefixes
    .trim()
    .slice(0, 140);
}

/**
 * Classify one raw output line.
 * yt-dlp progress carries ready-to-print `text`; ffmpeg progress carries
 * structured `ffmpeg` data — the final line depends on stage context
 * (mode, input duration, size estimate), composed by formatFfmpegProgress.
 * @returns {{kind: 'progress'|'duration'|'warning'|'info'|'noise', text?: string,
 *            ffmpeg?: {sizeBytes:number|null, sizeLabel:string, time:string,
 *                      timeSec:number|null, speedX:number|null}, seconds?: number}}
 */
export function classifyLine(line) {
  const trimmed = (line ?? '').trim();
  if (!trimmed) return { kind: 'noise' };

  const yt = parseYtdlpProgress(trimmed);
  if (yt) {
    const parts = [`${yt.percent}% of ${yt.size}`];
    if (yt.speed) parts.push(yt.speed);
    if (yt.eta && yt.eta !== 'Unknown') parts.push(`ETA ${yt.eta}`);
    return { kind: 'progress', text: parts.join(' · ') };
  }

  const ff = parseFfmpegStats(trimmed);
  if (ff) {
    return {
      kind: 'progress',
      ffmpeg: {
        sizeBytes: binarySizeToBytes(ff.size),
        sizeLabel: ff.size,
        time: ff.time,
        timeSec: clockToSeconds(ff.time),
        speedX: ff.speedX,
      },
    };
  }

  const durationSec = parseFfmpegDuration(trimmed);
  if (durationSec !== null) {
    return { kind: 'duration', seconds: durationSec };
  }

  if (/has already been downloaded/.test(trimmed)) {
    return { kind: 'info', text: 'File has already been downloaded' };
  }
  if (/\bResuming download\b/i.test(trimmed)) {
    return { kind: 'info', text: 'Resuming previous partial download' };
  }

  // Fatal ERROR lines are not "stream warnings": they reach the user exactly
  // once, via the stderr tail → explainFailure mapping (and the debug log).
  if (/^ERROR:/i.test(trimmed)) {
    return { kind: 'noise' };
  }
  // Progress-ish and chatter lines must never be flagged as warnings.
  if (/^\[(download|info|twitch|hls|https|generic)\b/i.test(trimmed) && !WARNING_RE.test(trimmed)) {
    return { kind: 'noise' };
  }
  if (WARNING_RE.test(trimmed)) {
    return { kind: 'warning', text: sanitizeWarning(trimmed) };
  }
  return { kind: 'noise' };
}

/**
 * Compose the one-line progress text for ffmpeg-driven stages, mirroring the
 * yt-dlp line grammar: `progress · speed · [ETA] · elapsed`.
 *
 * - 'record' (live): the recording length IS the progress metric — no total
 *   exists, and wall elapsed would just duplicate it, so it is omitted:
 *   `REC 00:21:14 · 14.75MiB · 719KiB/s`
 * - 'remux'/'download' with known input duration: real percent from the media
 *   position, ETA from ffmpeg's speed multiplier, total size estimated by the
 *   caller (stream copy keeps output ≈ input, hence the `~`):
 *   `50.0% of ~7.90GiB · 105.02MiB/s · ETA 00:39 · 39s`
 * - fallback (duration unknown): `5.86GiB · 105.02MiB/s · 39s`
 *
 * Speed is real throughput (bytes written / wall time) — ffmpeg's `bitrate=`
 * is the media bitrate of the source and misleads during a fast remux.
 */
export function formatFfmpegProgress(ffmpeg, { mode, durationSec = null, totalBytes = null, elapsedMs }) {
  const size = ffmpeg.sizeBytes === null ? ffmpeg.sizeLabel : humanBinary(ffmpeg.sizeBytes);
  const speed =
    ffmpeg.sizeBytes !== null && elapsedMs >= 1500
      ? `${humanBinary(ffmpeg.sizeBytes / (elapsedMs / 1000))}/s`
      : null;

  if (mode === 'record') {
    const parts = [`REC ${ffmpeg.time}`, size];
    if (speed) parts.push(speed);
    return parts.join(' · ');
  }

  const parts = [];
  if (durationSec > 0 && ffmpeg.timeSec !== null) {
    const percent = Math.min(100, (ffmpeg.timeSec / durationSec) * 100).toFixed(1);
    parts.push(totalBytes ? `${percent}% of ~${humanBinary(totalBytes)}` : `${percent}%`);
    if (speed) parts.push(speed);
    if (ffmpeg.speedX > 0) {
      parts.push(`ETA ${secondsToClock((durationSec - ffmpeg.timeSec) / ffmpeg.speedX)}`);
    }
  } else {
    parts.push(size);
    if (speed) parts.push(speed);
  }
  parts.push(formatDuration(elapsedMs));
  return parts.join(' · ');
}

/**
 * Single-line progress renderer. TTY: redraws one line in place.
 * Non-TTY (piped/CI): prints at most one line every 3 seconds.
 */
export function createProgressRenderer({ stream = process.stdout, prefix = '⬇' } = {}) {
  const tty = stream.isTTY === true;
  let last = '';
  let paused = false;
  let lastPrintAt = 0;

  function draw(text) {
    if (tty) {
      stream.write(`\r\x1b[K  ${prefix} ${text}`);
    } else if (Date.now() - lastPrintAt >= 3000) {
      stream.write(`  ${prefix} ${text}\n`);
      lastPrintAt = Date.now();
    }
  }

  return {
    update(text) {
      last = text;
      if (!paused) draw(text);
    },
    /** Clear the line so prompts/log lines render cleanly. */
    pause() {
      if (paused) return;
      paused = true;
      if (tty && last) stream.write('\r\x1b[K');
    },
    resume() {
      if (!paused) return;
      paused = false;
      if (last) draw(last);
    },
    /** Clear and stop; the caller prints the final ✓/▲ line. */
    finish() {
      if (tty && !paused && last) stream.write('\r\x1b[K');
      paused = true;
      last = '';
    },
  };
}
