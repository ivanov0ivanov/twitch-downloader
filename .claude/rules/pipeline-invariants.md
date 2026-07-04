# Pipeline invariants (hard-won, see agent-data/troubleshooting.md)

These were each diagnosed from real failures during MVP 1 stress testing. Breaking any of them
reintroduces a silent, hard-to-debug bug.

## ffmpeg remux (stage 2)

- Remux args MUST keep `-dn`: Twitch HLS carries a `timed_id3` data stream that the mov muxer
  writes into a structurally broken mp4 (missing moov) — **with exit code 0**.
- Remux args MUST keep `-fflags +genpts` (input option, before `-i`): live recordings can contain
  packets with missing PTS around ad-splice boundaries; the mov muxer rejects them. No-op on clean input.
- ffmpeg exit 0 does not guarantee a valid mp4 — verify with ffprobe when debugging.
- Remux args MUST keep `-loglevel info` (not warning) + `-stats`: the input `Duration:` header is
  info-level output and is the denominator for the remux percent/ETA line; at `warning` it is never
  printed and the UI silently degrades to the size-only fallback. Header chatter stays out of the
  UI — the classifier routes it to logs/debug.log.
- A failed or interrupted stage 2 must never delete or damage the native file. Delete the
  intermediate only after a successful remux and only when the user chose not to keep it.

## yt-dlp output channel

- Every yt-dlp invocation **whose output is parsed** (titles, filenames, format lists) MUST carry
  `--encoding utf-8`: the PyInstaller build writes pipes in the ANSI code page (cp1251 on Cyrillic
  locales) and ignores PYTHONUTF8, garbling titles and — worse — the printed filename we reuse as
  `-o`. Verified: `--encoding utf-8` fixes it; env vars do not. (The bare `--version` probe in
  checks.js is exempt — its output is ASCII by definition.)

## yt-dlp download (stage 1)

- Stage 1 MUST keep `--fixup never` + a literal output extension in the `-o` template — otherwise
  yt-dlp silently remuxes TS→MP4 after HLS downloads and the "native" stage is a lie.
- The exact output filename comes from `yt-dlp --print filename` (single source of truth) —
  never re-implement `--windows-filenames` sanitization in JS.
- Live recordings use `--no-part` so a killed recording stays playable; VODs keep `.part` for resume.

## Windows process management

- Never `child.kill()` yt-dlp — it's a PyInstaller onefile launcher; the real worker is its child
  process and survives. Use `killTree()` from `src/checks.js` (`taskkill /PID <pid> /T /F`).
- Stage children MUST be spawned `detached` with piped stdio: sharing the console means Ctrl+C
  (CTRL_C_EVENT) kills the child before the user can confirm, and a dying python/ffmpeg corrupts
  the console input mode (dead arrow keys in the menu). Detached children never see Ctrl+C and
  never touch the console — the confirm-stop flow depends on this.
- While a stage runs, stdin MUST be in raw mode with Ctrl+C read as the `\x03` byte (key trap in
  `runStage`): a cooked-mode Ctrl+C raises CTRL_C_EVENT for the whole console group and kills the
  `npm start` wrapper (cmd/npm) — the shell then steals the terminal mid-confirm while the CLI and
  the recording keep running orphaned. SIGINT stays only as the non-TTY fallback.
- Because stage children are detached, the CLI must reap them on its own death — see the
  synchronous `taskkill` in the `process.on('exit')` hook in `src/index.js`. `runCommand`
  children (hidden consoles) are reaped there too. SIGHUP/SIGBREAK handlers MUST exist:
  without them, closing the terminal window (CTRL_CLOSE_EVENT) kills node WITHOUT emitting
  `exit`, and the invisible detached tree records for hours.
- After a confirmed stop, file handles outlive taskkill by a beat: await `killTree()` and retry
  deletions on EBUSY (see `rmWithRetry` in `src/downloader.js`).
- After winget installs, re-read the registry PATH (`refreshProcessPath`) before spawning tools —
  winget portable packages append to the registry PATH, which a running process never sees.
