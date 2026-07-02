# Documentation Dependency Map

When making a change, consult this map to know **which files need updating**.
Read this BEFORE applying changes, not after.

## Change → Impact Matrix

### Feature changes (add/modify/remove a menu action or flow)

| Update | File |
|--------|------|
| Feature code | `src/menu.js`, `src/downloader.js` (+ the relevant pure module) |
| Unit tests (pure logic only) | `tests/` |
| README menu table / features | `README.md` |
| Key paths (if new module) | `.claude/CLAUDE.md` |
| Architecture diagram (if new module/flow) | `docs/SYSTEM-MAP.md` |

### yt-dlp / ffmpeg argument changes

| Update | File |
|--------|------|
| Argument builders (only place for flags) | `src/args.js` |
| Argument tests | `tests/args.test.js` |
| Invariants (if a flag is load-bearing) | `.claude/rules/pipeline-invariants.md` |
| README "How downloading works" | `README.md` |

### Error handling / user messaging changes

| Update | File |
|--------|------|
| Pattern table / AppError | `src/errors.js` |
| README "Common errors" table | `README.md` |
| Logging convention compliance | `src/logger.js` callers |

### Config / dependency changes

| Update | File |
|--------|------|
| Manifest | `package.json` |
| README Requirements / Run | `README.md` |
| Tech stack section | `.claude/CLAUDE.md` |

### Architecture changes

| Update | File |
|--------|------|
| Architecture diagram (FIRST) | `docs/SYSTEM-MAP.md` |
| Project memory | `.claude/CLAUDE.md` |
| Rules | `.claude/rules/` |
| Decision log | `agent-data/arch-decisions.md` |

### Roadmap / scope changes

| Update | File |
|--------|------|
| MVP 2 plan | `ROADMAP.md` |
| README pointer | `README.md` |
