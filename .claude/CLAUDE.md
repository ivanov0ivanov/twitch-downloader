# twitch-downloader

## Project overview

Interactive Windows-only CLI (menu-driven) for downloading Twitch VODs, clips and live streams via yt-dlp.
Two-stage pipeline: stage 1 downloads the **native** stream (`.ts` for VOD/live, `.mp4` for clips) with no ffmpeg work; stage 2 optionally remuxes to mp4/mkv via ffmpeg stream copy. MVP 2 ideas live in `ROADMAP.md` — do not implement them until MVP 1 is battle-tested.

## Tech stack

- Language: JavaScript (ES modules, no build step)
- Runtime: Node.js ≥ 20, Windows 11 only
- Key dependencies: `@clack/prompts` (menu), `picocolors` (colors) — keep dependencies minimal
- External tools: yt-dlp + ffmpeg (winget-installed, auto-detected at startup)

## Key paths

- Source code: `src/`
- Entry point: `src/index.js` — banner → dependency check → menu loop
- `src/menu.js` — all interactive flows; `src/downloader.js` — two-stage pipeline, Ctrl+C, conflicts, disk
- `src/args.js` — **pure** yt-dlp/ffmpeg argument builders (unit-tested; change args only here)
- `src/formats.js` — `yt-dlp -F` fetch + parser; `src/url.js` — URL classification
- `src/checks.js` — tool detection/install, `runCommand`, `killTree`
- Tests: `tests/` (url / formats / args / stats suites)
- Documentation: `docs/` (DOCS-MAP, SYSTEM-MAP), `README.md`, `ROADMAP.md`
- Runtime output: `downloads/` (gitignored)
- Agent memory: `agent-data/` (gitignored, read at session start)

## Commands

- Install: `npm install`
- Run: `npm start`
- Test: `npm test`

## Architecture constraints

- Argument building is pure and unit-tested — never inline yt-dlp/ffmpeg flags outside `src/args.js`
- Remux is stream copy only — never re-encode
- Hard invariants (ffmpeg/yt-dlp pitfalls): see `.claude/rules/pipeline-invariants.md`

## Quality gates

- Tests must pass: yes (`npm test`)
- Lint must pass: n/a (no linter configured)

## Testing

- Test framework: node:test (built-in)
- Test command: `npm test`
- Test directory: `tests/`
- Test types used: unit (pure logic only: URL classification, -F parsing, arg building, stats)
- Naming: `*.test.js`

## Forbidden zones

- Do not modify: `node_modules/`, `downloads/` (runtime output)

## Project-specific rules

- Pipeline invariants: `.claude/rules/pipeline-invariants.md`
- Conventions: `.claude/rules/project-conventions.md`
- Workflow: `.claude/rules/workflow.md`

## Required actions during work

- **Progress**: read `agent-data/progress.md` at session start. Update Active task on new task. Mark `[x]` immediately on subtask completion. Move to Done on task completion.
- **Troubleshooting**: after any diagnosed and fixed bug — immediately log via `/troubleshooting`. Do not defer to session end.
- **Memory decisions**: log architectural decisions to `agent-data/arch-decisions.md` when made.
- **Commits**: always use `/git-commit` skill — never commit directly via `git commit`. No exceptions, even for batch commits.
