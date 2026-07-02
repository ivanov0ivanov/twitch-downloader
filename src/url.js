/**
 * Twitch URL validation and classification. Pure module (no I/O).
 *
 * Result types:
 *   vod      — https://www.twitch.tv/videos/<id>
 *   clip     — https://clips.twitch.tv/<slug> or https://www.twitch.tv/<chan>/clip/<slug>
 *   channel  — https://www.twitch.tv/<login>
 *   unknown  — a twitch.tv page that is not downloadable (directory, search, …)
 *   not-twitch — valid URL but a different site
 *   invalid  — not a URL at all
 *   empty    — empty / whitespace-only input
 */

const TWITCH_HOSTS = new Set(['twitch.tv', 'www.twitch.tv', 'm.twitch.tv', 'go.twitch.tv']);
const CLIP_HOSTS = new Set(['clips.twitch.tv', 'www.clips.twitch.tv']);

/** Path roots on twitch.tv that can never be a channel login. */
const RESERVED_PATHS = new Set([
  'videos', 'directory', 'downloads', 'settings', 'friends', 'subscriptions',
  'wallet', 'drops', 'search', 'p', 'jobs', 'turbo', 'store', 'clip', 'clips',
]);

const LOGIN_RE = /^[a-zA-Z0-9_]{2,25}$/;
const VOD_ID_RE = /^\d{6,}$/;

/**
 * Classify a raw user-typed string as a Twitch entity.
 * @param {string} raw
 * @returns {{type: string, url?: string, id?: string, login?: string, slug?: string}}
 */
export function classifyUrl(raw) {
  if (typeof raw !== 'string' || raw.trim() === '') return { type: 'empty' };

  const trimmed = raw.trim();
  if (/\s/.test(trimmed)) return { type: 'invalid' };

  let candidate = trimmed;
  if (!/^https?:\/\//i.test(candidate)) candidate = `https://${candidate}`;

  let parsed;
  try {
    parsed = new URL(candidate);
  } catch {
    return { type: 'invalid' };
  }

  const host = parsed.hostname.toLowerCase();
  const segments = parsed.pathname.split('/').filter(Boolean);

  if (CLIP_HOSTS.has(host)) {
    if (segments.length === 1) {
      return { type: 'clip', slug: segments[0], url: `https://clips.twitch.tv/${segments[0]}` };
    }
    return { type: 'unknown' };
  }

  if (!TWITCH_HOSTS.has(host)) return { type: 'not-twitch' };

  // twitch.tv/videos/<id>
  if (segments[0] === 'videos' && segments.length === 2 && VOD_ID_RE.test(segments[1])) {
    return { type: 'vod', id: segments[1], url: `https://www.twitch.tv/videos/${segments[1]}` };
  }

  // twitch.tv/<chan>/clip/<slug>
  if (segments.length === 3 && segments[1] === 'clip' && LOGIN_RE.test(segments[0]) && segments[2]) {
    return { type: 'clip', slug: segments[2], url: `https://clips.twitch.tv/${segments[2]}` };
  }

  // twitch.tv/<chan>/video/<id> (legacy) and twitch.tv/<chan>/videos/<id>
  if (
    segments.length === 3 &&
    (segments[1] === 'video' || segments[1] === 'videos') &&
    VOD_ID_RE.test(segments[2].replace(/^v/, ''))
  ) {
    const id = segments[2].replace(/^v/, '');
    return { type: 'vod', id, url: `https://www.twitch.tv/videos/${id}` };
  }

  // twitch.tv/<login> — a channel
  if (segments.length === 1 && LOGIN_RE.test(segments[0]) && !RESERVED_PATHS.has(segments[0].toLowerCase())) {
    const login = segments[0].toLowerCase();
    return { type: 'channel', login, url: `https://www.twitch.tv/${login}` };
  }

  return { type: 'unknown' };
}

/** Example strings shown to the user next to validation errors. */
export const URL_EXAMPLES = {
  vod: 'https://www.twitch.tv/videos/2158043818',
  clip: 'https://clips.twitch.tv/AwkwardSlickCatKappa',
  channel: 'https://www.twitch.tv/monstercat',
};
