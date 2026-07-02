---
name: self-check
description: >
  Project-specific self-check. Verifies DOCS-MAP compliance, SYSTEM-MAP integrity,
  agent-data freshness, quality gates, and documentation consistency.
  Українською: перевірка проєкту, self-check, аудит.
disable-model-invocation: false
user-invocable: true
---

## Purpose

Run a project-specific audit after any change.
Report PASS/FAIL per check. Fix issues found.

## Checks

### 1. DOCS-MAP compliance

Read `docs/DOCS-MAP.md`. Based on what was changed in this session:
- Verify every file listed in the relevant "Change → Impact" section was updated
- If any impacted file was missed — report and fix

### 2. SYSTEM-MAP integrity

If `docs/SYSTEM-MAP.md` exists:
- Verify the Mermaid diagram reflects the current architecture
- Verify the Components table matches actual project structure
- If architecture changed during this session — verify SYSTEM-MAP was updated FIRST

### 3. agent-data/ freshness

**progress.md**:
- Does Active task reflect current work? If stale — invoke `/progress`

**troubleshooting.md**:
- Were bugs fixed this session? If yes and not logged — invoke `/troubleshooting`

**arch-decisions.md**:
- Were architectural decisions made? If yes and not logged — append entry

### 4. Quality gates

Read `.claude/CLAUDE.md` Quality gates section. If defined:
- Suggest running test command
- Suggest running lint command
- Report which gates are configured vs which were verified

### 5. Documentation consistency

- Verify README.md reflects current state (if it exists)
- Verify no stale file paths in docs
- Verify `.claude/CLAUDE.md` Key paths section matches actual structure

### 6. Tiered verification (claims + consistency)

Three-tier approach: deep where it matters, cheap everywhere else.

**Step 1 — Derive verification tokens from the session's changes:**
- What was added, removed, or renamed? Extract key terms.
- What counts changed? Extract old and new values.
- What features were affected? Extract feature names and synonyms.

**Step 2 — Tier 1: Full-read changed files (zero extra cost):**
- For every file modified in this session, verify semantic accuracy of ALL claims:
  counts, feature descriptions, behavior statements, model/tool descriptions.

**Step 3 — Tier 2: Full-read DOCS-MAP related files (bounded cost):**
- Consult `docs/DOCS-MAP.md`: find the "Change → Impact" section matching the change type.
- Full-read each listed file, even if not modified.
- Verify: counts match, lists complete, parallel trees match actual structure.

**Step 4 — Tier 3: Grep verification tokens across ALL docs (cheap):**
- Grep the tokens from Step 1 across all project .md files.
- Review each match in context (surrounding 3-5 lines).
- Catches stale terminology in files nobody expected to be affected.

### 7. Uncommitted changes

Run `git status --short` — report count of uncommitted files.

## Output format

```
## Self-Check Report

| # | Check | Result |
|---|-------|--------|
| 1 | DOCS-MAP compliance | PASS/FAIL |
| 2 | SYSTEM-MAP integrity | PASS/FAIL |
| 3 | agent-data/ freshness | PASS/FAIL |
| 4 | Quality gates | PASS/FAIL/SKIPPED |
| 5 | Documentation | PASS/FAIL |
| 6 | Tiered verification | PASS/FAIL |
| 7 | Uncommitted | N files |

Issues found: <list or "none">
Fixes applied: <list or "none">
```
