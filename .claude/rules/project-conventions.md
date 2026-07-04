# Project conventions

## Code style

- ES modules with `node:` prefix for built-ins; no build step, no TypeScript
- Small pure functions for anything unit-testable (see `src/args.js`, `src/url.js`, parser in `src/formats.js`)
- User-facing errors are `AppError` (message + hint + machine `code`); raw yt-dlp stderr is translated in `src/errors.js` — never surface raw stack traces to the user

## Patterns

- Pure builders (args, URL classification, parsing, stage planning) are separated from orchestration (menu flows) and process I/O (downloader, checks) — keep new logic in the right layer
- All terminal status output goes through `src/logger.js` (`… ✓ ✖ ▲ ●` convention: `[icon] [short action] [key detail]`, one line per action). Icons and progress prefixes must be non-emoji glyphs (the @clack/prompts family): emoji-class codepoints (`⚠` U+26A0, `ℹ` U+2139, `⏺` U+23FA, …) get one terminal cell but render via the two-cell Segoe UI Emoji fallback and visually collide with the following text
- Interactive prompts are @clack/prompts only; every prompt result must be checked with `isCancel` and return to the menu gracefully

## Naming conventions

- Files: lowercase single-word module names (`downloader.js`, `formats.js`)
- Functions: verb-first camelCase (`buildStage1Args`, `fetchMeta`, `resolveConflict`)

## Testing conventions

- Framework: node:test + node:assert/strict
- Location: `tests/` (one suite per pure module)
- Naming: `*.test.js`
- Style: one behavior per test; fixtures inline in the suite (real yt-dlp -F output captured from stress runs)
- Only pure logic is unit-tested; process spawning and interactive flows are verified by manual stress scenarios (see README Development section)
