## Workflow

Changes always follow this order:

1. **Consult DOCS-MAP** — read `docs/DOCS-MAP.md` before any change to know which files need updating
2. **Design in SYSTEM-MAP** — if the change affects architecture, update `docs/SYSTEM-MAP.md` first
3. **Implement** — make code changes + update all impacted files from DOCS-MAP
4. **Self-check** — run `/self-check` to verify cross-references, docs, and consistency
5. **Commit** — use `/git-commit` for Conventional Commits
