# twitch-downloader

## Project overview

Interactive Windows-only CLI (menu-driven) for downloading Twitch VODs, clips and live streams via yt-dlp.
Two-stage pipeline: stage 1 downloads the **native** stream (`.ts` for VOD/live, `.mp4` for clips) with no ffmpeg work; stage 2 optionally remuxes to mp4/mkv via ffmpeg stream copy. MVP 2 ideas live in `ROADMAP.md` — do not implement them until MVP 1 is battle-tested.

## Tech stack

- Node.js ≥ 20, ES modules, no build step
- `@clack/prompts` (menu/prompts), `picocolors` (colors) — keep dependencies minimal
- `node:test` for tests; external tools: yt-dlp + ffmpeg (winget-installed)

## Key paths

- `src/index.js` — entry: banner → dependency check → menu loop
- `src/menu.js` — all interactive flows; `src/downloader.js` — spawn/Ctrl+C/conflicts/disk
- `src/args.js` — **pure** yt-dlp/ffmpeg argument builders (unit-tested; change args only here)
- `src/formats.js` — `yt-dlp -F` fetch + parser; `src/url.js` — URL classification
- `src/checks.js` — tool detection/install, `runCommand`, `killTree`
- `tests/` — url / formats / args / stats suites; `downloads/` — runtime output (gitignored)
- `agent-data/` — progress, troubleshooting, arch-decisions (gitignored, read at session start)

## Commands

- `npm start` — run the CLI; `npm test` — run node:test suites

## Invariants (hard-won, see agent-data/troubleshooting.md)

- Remux args MUST keep `-dn` (Twitch timed_id3 stream corrupts mp4) and `-fflags +genpts` (live PTS gaps); ffmpeg exit 0 does not guarantee a valid mp4 — verify with ffprobe when debugging.
- Stage 1 MUST keep `--fixup never` + literal output extension — otherwise yt-dlp silently remuxes and the "native" stage is a lie.
- Never `child.kill()` yt-dlp on Windows — it's a PyInstaller launcher; use `killTree()` (`taskkill /T /F`).
- After winget installs, re-read the registry PATH (`refreshProcessPath`) before spawning tools.
- The exact output filename comes from `yt-dlp --print filename` (single source of truth) — never re-implement sanitization in JS.
- A failed/interrupted stage 2 must never delete or damage the native file; delete the intermediate only after a successful remux and only when the user chose not to keep it.
