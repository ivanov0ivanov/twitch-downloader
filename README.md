# twitch-downloader

Interactive Windows CLI for downloading Twitch **VODs, clips and live streams** via [yt-dlp](https://github.com/yt-dlp/yt-dlp).
One command → a clean menu → paste a link, pick quality and format, watch the progress.

```
 _____          _ _       _         ____  _
|_   _|_      _(_) |_ ___| |__     |  _ \| |
  | | \ \ /\ / / | __/ __| '_ \    | | | | |
  | |  \ V  V /| | || (__| | | |   | |_| | |___
  |_|   \_/\_/ |_|\__\___|_| |_|   |____/|_____|
```

## Requirements

- **Windows 11** (uses `winget`, `explorer`, Windows paths)
- **Node.js ≥ 20**
- **yt-dlp** and **ffmpeg** — checked on startup; if missing, the menu offers to install them via winget (pip fallback for yt-dlp)

## Run

```powershell
npm install
npm start
```

> Tip: run it in Windows Terminal / PowerShell. If you start it via `npm start` and press Ctrl+C, cmd may ask "Terminate batch job (Y/N)?" after the app exits — that prompt comes from npm's wrapper, not from the app. Starting with `node src/index.js` avoids it.

## Menu

| Item | What it does |
|------|--------------|
| 📡 Record live stream | Takes a channel URL, records the native stream while the channel is live (stop with Ctrl+C), then optionally rebuilds to mp4/mkv |
| 🎬 Download VOD / clip | Takes a VOD or clip URL, lets you pick a real quality from `yt-dlp -F` and a final format |
| 📊 Download stats | File count in `downloads/`, per-file sizes and the total in GB |
| 📂 Open downloads folder | Opens `downloads/` in Explorer |
| ❌ Exit | Quits |

After every successful download the summary is printed and Explorer opens with the file focused.

## How downloading works (two stages)

1. **Stage 1 — native download.** The stream is pulled in its native container (`.ts` for VODs/live, `.mp4` for clips) with no ffmpeg conversion — fast and interruption-tolerant. Partial VOD downloads leave a `.part` file and **resume automatically** when you run the same URL again.
2. **Stage 2 — build the chosen format.** After a successful download the file is remuxed (`ffmpeg -c copy`, no re-encoding) into your chosen container (mp4/mkv). If you pick `ts`, stage 2 is skipped entirely.

The intermediate native file is **kept by default**; right after the format selection the app asks whether to keep it. If you choose *No*, it is deleted only after a **successful** remux. If the remux fails, the native file always remains as a working result.

Output naming: `uploader - title - id.ext` in `./downloads/`, sanitized for Windows (`--windows-filenames`, trimmed to stay under the path limit).

## Twitch VOD retention limits

Past broadcasts are removed by Twitch automatically: after **7 days** for most accounts, and after **14–60 days** for Turbo / Prime / Partner accounts (Twitch has changed the exact partner window over time — check their current docs if it matters). If a VOD link fails with "does not exist", it most likely expired or was deleted by the streamer. Highlights live longer than plain past broadcasts.

## Common errors

| Message | Cause | What to do |
|---------|-------|------------|
| `That doesn't look like a Twitch link` | Not a twitch.tv URL, typo, empty input | Paste a link like `https://www.twitch.tv/videos/123456789` |
| `This VOD does not exist or is no longer available` | VOD expired (see retention limits) or deleted | Nothing to do — the source is gone |
| `This VOD is subscriber-only` | The streamer restricts VODs to subscribers | This tool does not handle authenticated downloads |
| `Channel is not live right now` | Live recording of an offline channel | Use "Check again" or download a VOD instead |
| `The chosen quality is no longer available` | Formats changed between listing and download | The app re-fetches the list and lets you pick again |
| `Remux failed — native .ts kept as the result` | ffmpeg error or missing ffmpeg during stage 2 | The native file is intact; retry the remux or keep the .ts |
| `Network problem while talking to Twitch` | Connection drop mid-download | Re-run the same URL — the `.part` file resumes |
| `Low disk space` warning | Free space < ~2.2× the estimated size | The two-stage build briefly needs native + target side by side |
| File already exists prompt | Same VOD downloaded before (any quality — the name doesn't include quality) | Choose Resume / Overwrite / Skip — nothing is overwritten silently |

## Development

```powershell
npm test   # node:test suite: URL classification, -F parsing, argument building, stats
```

Project layout:

```
twitch-downloader/
├── src/
│   ├── index.js       # entry: banner, startup checks, menu loop
│   ├── menu.js        # interactive flows (@clack/prompts)
│   ├── downloader.js  # two-stage pipeline, Ctrl+C handling, conflicts, disk check
│   ├── formats.js     # yt-dlp -F fetch + parser
│   ├── args.js        # pure yt-dlp/ffmpeg argument builders
│   ├── url.js         # Twitch URL classification
│   ├── checks.js      # yt-dlp/ffmpeg detection and winget/pip install
│   ├── stats.js       # downloads/ statistics
│   ├── errors.js      # yt-dlp stderr → plain-language messages
│   ├── logger.js      # unified … ✓ ✖ ⚠ ℹ status lines
│   └── banner.js
├── tests/             # node:test suites (url, formats, args, stats)
├── downloads/         # created at runtime, gitignored
├── README.md
└── ROADMAP.md         # MVP 2 plan (not implemented yet)
```

See [ROADMAP.md](ROADMAP.md) for the MVP 2 plan (global CLI, non-interactive mode, config, history, doctor).
