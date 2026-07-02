# Pipeline invariants (hard-won, see agent-data/troubleshooting.md)

These were each diagnosed from real failures during MVP 1 stress testing. Breaking any of them
reintroduces a silent, hard-to-debug bug.

## ffmpeg remux (stage 2)

- Remux args MUST keep `-dn`: Twitch HLS carries a `timed_id3` data stream that the mov muxer
  writes into a structurally broken mp4 (missing moov) — **with exit code 0**.
- Remux args MUST keep `-fflags +genpts` (input option, before `-i`): live recordings can contain
  packets with missing PTS around ad-splice boundaries; the mov muxer rejects them. No-op on clean input.
- ffmpeg exit 0 does not guarantee a valid mp4 — verify with ffprobe when debugging.
- A failed or interrupted stage 2 must never delete or damage the native file. Delete the
  intermediate only after a successful remux and only when the user chose not to keep it.

## yt-dlp download (stage 1)

- Stage 1 MUST keep `--fixup never` + a literal output extension in the `-o` template — otherwise
  yt-dlp silently remuxes TS→MP4 after HLS downloads and the "native" stage is a lie.
- The exact output filename comes from `yt-dlp --print filename` (single source of truth) —
  never re-implement `--windows-filenames` sanitization in JS.
- Live recordings use `--no-part` so a killed recording stays playable; VODs keep `.part` for resume.

## Windows process management

- Never `child.kill()` yt-dlp — it's a PyInstaller onefile launcher; the real worker is its child
  process and survives. Use `killTree()` from `src/checks.js` (`taskkill /PID <pid> /T /F`).
- Console Ctrl+C is unaffected: CTRL_C_EVENT reaches the whole console group.
- After winget installs, re-read the registry PATH (`refreshProcessPath`) before spawning tools —
  winget portable packages append to the registry PATH, which a running process never sees.
