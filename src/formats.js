import { runCommand } from './checks.js';
import { buildFormatListArgs } from './args.js';
import { log } from './logger.js';
import { appErrorFrom } from './errors.js';

/**
 * Parse the human-readable table printed by `yt-dlp -F`. Pure function.
 *
 * Typical Twitch rows (columns separated by '│' or '|'):
 *   Audio_Only  mp4 audio only    │ ~55.71MiB  128k m3u8 │ audio only mp4a.40.2
 *   720p60      mp4 1280x720   60 │ ~ 1.42GiB 3348k m3u8 │ avc1.4D4020 ...
 *   1080p60__source_ mp4 1920x1080 60 │ ...
 *
 * @param {string} text raw stdout of `yt-dlp -F`
 * @returns {Array<{id, ext, resolution, fps, height, sizeBytes, sizeLabel, isSource, isAudioOnly}>}
 */
export function parseFormatList(text) {
  if (!text) return [];
  const lines = text.split(/\r?\n/);
  const headerIdx = lines.findIndex((l) => /^ID\s+EXT\s+RESOLUTION/i.test(l.trim()));
  if (headerIdx === -1) return [];

  const formats = [];
  for (const line of lines.slice(headerIdx + 1)) {
    const trimmed = line.trim();
    if (!trimmed) continue;
    if (/^[─-]+$/.test(trimmed)) continue; // separator row

    const cols = trimmed.split(/[│|]/);
    const head = cols[0].trim().split(/\s+/);
    if (head.length < 2) continue;

    const [id, ext, ...rest] = head;
    if (!id || /^\[/.test(id)) continue; // extractor log lines
    if (ext === 'mhtml') continue; // storyboard previews, not video

    let resolution;
    let fps = null;
    if (rest[0] === 'audio' && rest[1] === 'only') {
      resolution = 'audio only';
    } else {
      resolution = rest[0] || '';
      if (rest[1] && /^\d+$/.test(rest[1])) fps = Number(rest[1]);
    }

    let sizeBytes = null;
    let sizeLabel = null;
    const sizeSource = cols[1] || '';
    const sizeMatch = sizeSource.match(/([\d.]+)\s*([KMGT])iB/i);
    if (sizeMatch) {
      const mult = { K: 1024, M: 1024 ** 2, G: 1024 ** 3, T: 1024 ** 4 }[sizeMatch[2].toUpperCase()];
      sizeBytes = Math.round(Number(sizeMatch[1]) * mult);
      sizeLabel = `~${sizeMatch[1]} ${sizeMatch[2].toUpperCase()}iB`;
    }

    const resMatch = resolution.match(/(\d+)x(\d+)/);
    const idMatch = id.match(/(\d+)p(\d+)?/i);
    const height = resMatch ? Number(resMatch[2]) : idMatch ? Number(idMatch[1]) : 0;
    if (fps === null && idMatch?.[2]) fps = Number(idMatch[2]);

    formats.push({
      id,
      ext,
      resolution,
      fps,
      height,
      sizeBytes,
      sizeLabel,
      isSource: /source/i.test(id),
      isAudioOnly: resolution === 'audio only',
    });
  }
  return formats;
}

/** Sort for display: source first, then by height desc, audio-only last. */
export function sortFormats(formats) {
  return [...formats].sort((a, b) => {
    if (a.isAudioOnly !== b.isAudioOnly) return a.isAudioOnly ? 1 : -1;
    if (a.isSource !== b.isSource) return a.isSource ? -1 : 1;
    if (b.height !== a.height) return b.height - a.height;
    return (b.fps || 0) - (a.fps || 0);
  });
}

/**
 * Build @clack/prompts select options from parsed formats.
 * First option is always "Best (auto)".
 */
export function buildQualityOptions(formats) {
  const options = [{ value: null, label: 'Best (auto)', hint: 'highest available video+audio' }];
  for (const f of sortFormats(formats)) {
    const parts = [];
    if (f.isAudioOnly) parts.push('audio only');
    else parts.push(`${f.resolution}${f.fps ? `@${f.fps}` : ''}`);
    if (f.isSource) parts.push('source');
    if (f.sizeLabel) parts.push(f.sizeLabel);
    options.push({ value: f.id, label: f.id, hint: parts.join(' · ') });
  }
  return options;
}

/**
 * Fetch and parse the format list for a URL.
 * @returns {Promise<Array>} parsed formats ([] when yt-dlp listed none)
 * @throws {AppError} when yt-dlp itself fails
 */
export async function fetchFormats(url) {
  log.step('Fetching available formats');
  const res = await runCommand('yt-dlp', buildFormatListArgs(url), { timeoutMs: 60000 });
  if (res.code !== 0) {
    throw appErrorFrom(res.stderr);
  }
  const formats = parseFormatList(res.stdout);
  if (formats.length === 0) log.warn('No format list returned');
  else log.ok(`${formats.length} quality options found`);
  return formats;
}
