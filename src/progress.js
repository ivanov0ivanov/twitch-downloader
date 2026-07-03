/**
 * Classification of child-process output lines (yt-dlp / ffmpeg) and a
 * compact single-line progress renderer. Parsers are pure and unit-tested;
 * raw lines never reach the console UI — they go to the debug log instead.
 */

// [download]  42.1% of ~  1.42GiB at    3.20MiB/s ETA 00:42 (frag 112/324)
const YTDLP_PROGRESS_RE =
  /\[download\]\s+([\d.]+)%\s+of\s+~?\s*([\d.]+\s*[KMGT]i?B)(?:\s+at\s+(~?\s*[\d.]+\s*[KMGT]i?B\/s|Unknown B\/s))?(?:\s+ETA\s+([\d:]+|Unknown))?/;

// frame= 913 fps=... size=  2310KiB time=00:00:30.31 bitrate= 624.2kbits/s speed=...
const FFMPEG_STATS_RE =
  /(?:^|\s)L?size=\s*([\d.]+\s*[kKMGT]i?B)\s+time=\s*([\d:.]+)\s+bitrate=\s*([\d.]+\s*[kKMG]?bits\/s)/;

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

/** @returns {{size:string, time:string, bitrate:string}|null} */
export function parseFfmpegStats(line) {
  const m = FFMPEG_STATS_RE.exec(line);
  if (!m) return null;
  return {
    size: m[1].replace(/\s+/g, ''),
    time: m[2].replace(/\.\d+$/, ''), // drop fractional seconds for display
    bitrate: m[3].replace(/\s+/g, ''),
  };
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
 * @returns {{kind: 'progress'|'warning'|'info'|'noise', text?: string}}
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
    return { kind: 'progress', text: `${ff.time} · ${ff.size} · ${ff.bitrate}` };
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
    /** Clear and stop; the caller prints the final ✓/⚠ line. */
    finish() {
      if (tty && !paused && last) stream.write('\r\x1b[K');
      paused = true;
      last = '';
    },
  };
}
