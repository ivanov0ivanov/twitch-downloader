/**
 * Translate raw yt-dlp / system error output into plain-language messages.
 * Pure module (no I/O).
 */

/** Ordered pattern table — first match wins. */
const PATTERNS = [
  {
    code: 'offline',
    re: /(is not currently live|channel is offline|stream is offline)/i,
    message: 'Channel is not live right now.',
    hint: 'Live recording only works while the channel is streaming.',
  },
  {
    code: 'subonly',
    re: /(subscriber|sub-only|subscription)/i,
    message: 'This VOD is subscriber-only.',
    hint: 'Downloading sub-only VODs requires an authenticated session, which this tool does not manage.',
  },
  {
    code: 'gone',
    re: /(does not exist|this video is unavailable|http error 404|\b404\b)/i,
    message: 'This VOD does not exist or is no longer available.',
    hint: 'Twitch removes past broadcasts after 7 days (14–60 days for Turbo/Prime/Partner accounts). The VOD may also have been deleted by the streamer.',
  },
  {
    code: 'format',
    re: /requested format is not available/i,
    message: 'The chosen quality is no longer available for this video.',
    hint: 'Pick another quality or use "Best (auto)".',
  },
  {
    code: 'unsupported',
    re: /unsupported url/i,
    message: 'yt-dlp does not recognize this URL as downloadable.',
    hint: 'Use a direct VOD, clip or channel link.',
  },
  {
    code: 'network',
    re: /(getaddrinfo|timed out|timeout|econnreset|econnrefused|unable to connect|temporary failure|network is unreachable)/i,
    message: 'Network problem while talking to Twitch.',
    hint: 'Check your connection and try again — partially downloaded files resume automatically.',
  },
  {
    code: 'disk',
    re: /(no space left|not enough space|disk full|errno 28|oserror.*28)/i,
    message: 'The disk ran out of space.',
    hint: 'Free up space on the downloads drive and retry — the download will resume.',
  },
  {
    code: 'ffmpeg',
    re: /(ffmpeg (?:not found|is not installed)|ffmpeg exited)/i,
    message: 'ffmpeg is missing or failed.',
    hint: 'Install ffmpeg (the menu offers installation) and retry.',
  },
];

/**
 * @param {string} stderrText raw (possibly multi-line) error output
 * @returns {{message: string, hint?: string, code?: string, raw?: string}}
 */
export function explainFailure(stderrText) {
  const text = (stderrText || '').trim();
  for (const p of PATTERNS) {
    if (p.re.test(text)) return { message: p.message, hint: p.hint, code: p.code };
  }
  const lines = text.split(/\r?\n/).filter((l) => l.trim());
  const lastErrorLine = lines.filter((l) => /error/i.test(l)).pop() || lines.pop() || 'Unknown error.';
  return {
    message: 'The operation failed.',
    hint: undefined,
    code: undefined,
    raw: lastErrorLine.replace(/^ERROR:\s*/i, '').slice(0, 300),
  };
}

/** Application-level error that already carries a user-friendly message. */
export class AppError extends Error {
  /**
   * @param {string} message user-facing message
   * @param {string} [hint] what to do next
   * @param {string} [code] machine-readable category (see PATTERNS)
   */
  constructor(message, hint, code) {
    super(message);
    this.name = 'AppError';
    this.hint = hint;
    this.code = code;
  }
}

/** Build an AppError straight from raw stderr output. */
export function appErrorFrom(stderrText) {
  const { message, hint, code, raw } = explainFailure(stderrText);
  return new AppError(raw ? `${message} (${raw})` : message, hint, code);
}
