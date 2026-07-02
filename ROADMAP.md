# ROADMAP — MVP 2 (Global CLI)

> **MVP 2 is a future plan. NOT implementing now:** first we battle-test MVP 1, collect real usage pain points, then pick items from here by priority.

## 1. Global install

Add a `bin` entry to package.json exposing a `twitch-dl` command, installable with `npm i -g` (or runnable ad-hoc via `npx`). The tool must stop assuming it lives in a project folder: no relative paths, everything resolved from the install location or the invocation context. This is the foundation the rest of MVP 2 builds on.

## 2. Download to the current folder

Today everything lands in a fixed `downloads/` next to the package; a global command should default to the **cwd** it was invoked from, which matches how people actually use CLI downloaders. An explicit `-o/--output <path>` flag overrides the destination per invocation. The two-stage temp files stay next to the final output so cross-drive moves are never needed.

## 3. Non-interactive mode

`twitch-dl <url> --quality best --format mp4` runs the whole pipeline without a menu — for scripts, schedulers and power users. Flags mirror the interactive choices one-to-one (quality, format, keep-intermediate) so both modes share a single code path. With no arguments the interactive menu remains the default behavior.

## 4. Config resolution

Layered config: local `.twitchdlrc` in the folder > global config in `~/.config` > built-in defaults. It stores the preferred quality, format and keep-intermediate answer, so repeat users stop answering the same three questions. Explicit CLI flags always win over any config layer.

## 5. Download history

A local JSON log of every completed download: what, when, source URL, size, where it was saved. A `twitch-dl history` command prints it in a table, which also makes "did I already grab this VOD?" answerable without scanning folders. History doubles as input for future dedupe warnings.

## 6. Self-diagnostics

`twitch-dl doctor` checks yt-dlp/ffmpeg presence, their versions, PATH visibility, downloads-folder writability and free disk space, then prints concrete fix suggestions per failed check. This turns "it doesn't work" reports into copy-pasteable diagnostics. Most of the checks already exist internally — doctor just surfaces them as a first-class command.

## 7. yt-dlp update check

Twitch frequently changes its internals and breaks extractors, so a stale yt-dlp is the #1 cause of sudden failures; a fresh one is critical. Offer `yt-dlp -U` on demand (menu item / `--update-deps` flag) and a lightweight reminder when the installed version looks old. Never auto-update silently — show the version jump and ask.

## 8. Later candidates

- **Multi-URL queue** — paste several links, download sequentially with one shared summary.
- **Scheduled stream recording** — watch a channel and start recording automatically the moment it goes live (poll with backoff).
- **Windows notification on completion** — a toast when a long download or recording finishes, since these runs often happen in a background terminal.
