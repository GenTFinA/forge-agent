---
name: forge-sweep
description: "Prune know-how files (AUTO-MEMORY, DECISIONS, milestones, sessions) per team policy. Default = dry-run preview. Use --apply to execute."
disable-model-invocation: true
allowed-tools: Read, Write, Bash, Glob, AskUserQuestion
---

## O que fazer

$ARGUMENTS

---

Prune ephemeral GSD artifacts and tighten durable know-how files (AUTO-MEMORY, DECISIONS) at the end of a task or milestone. Goal: keep shared `.gsd/` files lean and long-lived; avoid SVN/Git merge conflicts.

Milestone and task directories are **trimmed in place** (preserving only the `*-SUMMARY.md` file) rather than removed entirely — the directory's continued presence in version control signals to the team that the milestone/task existed and was completed, avoiding the "where did M### go?" confusion when one teammate runs `/forge-sweep` and another pulls the result.

## Args

Parse `$ARGUMENTS`:
- (empty) → **dry-run** (preview only, no writes)
- `--apply` → execute the sweep (asks confirmation via AskUserQuestion before any destructive action)
- `--force` → combined with `--apply`, skips confirmation prompt
- `--scope task` → only drops sessions and prunes AUTO-MEMORY/DECISIONS; leaves milestone dirs fully intact (no trim)
- `--scope milestone` (default) → full sweep including trimming milestone dirs whose `LEDGER.md` entry exists (keeps only their SUMMARY)
- `--keep-low-confidence` → bypass the confidence/hits filter on AUTO-MEMORY (rare; use only when you know low-hit memories will graduate soon)

## Bootstrap guard

Run in parallel:
```bash
ls CLAUDE.md 2>/dev/null && echo "ok" || echo "missing"
ls .gsd/STATE.md 2>/dev/null && echo "ok" || echo "missing"
ls .gsd/LEDGER.md 2>/dev/null && echo "ok" || echo "missing"
```

If any missing → tell user "Project not initialized — run /forge-init first" and stop.

---

## Sweep Policy (single source of truth)

### AUTO-MEMORY entries

Keep when **all** apply:
- `confidence >= 0.90`
- `hits >= 2`
- description does NOT mention specific line numbers (`line N`, `lines N-M`) — those are codified in code, re-discoverable via blame
- description does NOT name a single file path as the only context — single-file gotchas have low reuse value

Otherwise → drop. Surface as **flag for human review** when confidence/hits pass but the description mentions a line number or single file (could still be valuable).

### DECISIONS rows

Keep when the row describes a **cross-cutting architectural invariant**:
- Extension point / config plug pattern (e.g., "use the per-X override mechanism")
- Server-vs-client boundary, sync-vs-async boundary, or similar invariant
- `Revisable: Não` is a strong signal (but not the only one)

Drop when the row describes:
- A concrete UX behavior already implemented (button text, exact column list, persistence rules)
- A specific bugfix call site (line N, file X)
- A list of values (column names, dictionary keys) that's already in the source

Surface as **flag for review** when ambiguous.

### Milestone directories (`.gsd/milestones/M*/`)

**Trim in place** (do NOT remove the directory) when:
- `M###-SUMMARY.md` exists inside it (milestone is closed)
- AND a corresponding entry exists in `.gsd/LEDGER.md` (matched by milestone ID in heading)

Trim = delete every file inside the directory EXCEPT `M###-SUMMARY.md`. Slice plans, task plans, research notes, CONTEXT, plan-checks, `continue.md`, and any other intermediate artifacts are removed. The directory itself and the SUMMARY remain so the team still sees the milestone existed.

Skip + warn if either condition is missing — don't lose history without a LEDGER trail.

### Task directories (`.gsd/tasks/TASK-###/`)

**Trim in place** (do NOT remove the directory) when:
- `TASK-###-SUMMARY.md` exists inside it (task is done)
- AND a corresponding entry exists in `.gsd/LEDGER.md` (matched by `## TASK-###` heading)

Trim = delete every file inside the directory EXCEPT `TASK-###-SUMMARY.md`. The directory itself and the SUMMARY remain for the same team-visibility reason as milestones.

Skip + warn if either condition is missing — don't lose history without a LEDGER trail.

### Session files (`.gsd/sessions/ask-*.md`)

Drop when frontmatter has `status: closed`. Keep `status: open` sessions untouched. Surface as flag if status is missing or unparseable.

### Files NOT touched by this sweep

`PROJECT.md`, `REQUIREMENTS.md`, `KNOWLEDGE.md`, `CODING-STANDARDS.md`, `CLAUDE.md`, `LEDGER.md`, `STATE.md`, `claude-agent-prefs.md`, `prefs.local.md`, `.claude/settings.json`, `.gsd/forge/` (telemetry).

---

## Steps

### 1. Inventory

In parallel:
- `ls -d .gsd/milestones/M*/ 2>/dev/null`
- `ls -d .gsd/tasks/TASK-*/ 2>/dev/null`
- `ls .gsd/sessions/ 2>/dev/null`
- Read `.gsd/AUTO-MEMORY.md`
- Read `.gsd/DECISIONS.md`
- Read `.gsd/LEDGER.md`

For each milestone dir found, check whether `M###-SUMMARY.md` exists inside AND whether `LEDGER.md` contains a heading line matching `^## M###` (case-sensitive).

For each task dir found, check whether `TASK-###-SUMMARY.md` exists inside AND whether `LEDGER.md` contains a heading line matching `^## TASK-###` (case-sensitive).

For each session file, parse frontmatter to extract `status:`.

### 2. Classify

Walk each AUTO-MEMORY entry. The format is:
```
- [MEMxxx] (category) confidence:0.NN hits:N — text...
```

Extract `confidence`, `hits`, and the `text` portion. Apply the filter (see Sweep Policy).

Walk each DECISIONS table row (lines starting with `|` after the header separator). Apply the filter using the `Scope`, `Decision`, and `Revisable?` columns. Architectural invariants are typically `Não` revisable AND have a `Scope` containing words like "architecture", "extensibility", "boundary", "invariant" — but use judgment: a row whose `Decision` describes "where X plugs in" or "X is server-side" qualifies even without those keywords.

When in doubt: classify as **flag for review** rather than auto-drop.

### 3. Print preview

Always print the preview, regardless of mode:

```
## /forge-sweep preview {dry-run | apply}

### AUTO-MEMORY
  Keep:    N entries
  Drop:    N entries  (each listed with [MEMxxx] one-liner)
  Review:  N entries  (each listed with WHY flagged: "mentions line 1115" / "single file scope")

### DECISIONS
  Keep:    N rows
  Drop:    N rows  (each: # | Scope | Decision one-liner)
  Review:  N rows  (each: WHY flagged)

### Milestone dirs
  Trim:    M001, M002, ...   (keep only M###-SUMMARY.md; drop intermediates)
  Keep:    M00X (active — untouched)
  Skip:    M00Y (no SUMMARY) | M00Z (missing LEDGER entry)

### Task dirs
  Trim:    TASK-001, TASK-002, ...   (keep only TASK-###-SUMMARY.md; drop intermediates)
  Keep:    TASK-NNN (no SUMMARY yet — untouched)
  Skip:    TASK-NNN (missing LEDGER entry)

### Session files
  Drop:    ask-YYYY-MM-DD-HHMM.md (status: closed)
  Keep:    ask-YYYY-MM-DD-HHMM.md (status: open)
  Skip:    ask-... (status missing)
```

### 4. If dry-run → stop here

Print: "Dry-run complete. To apply: /forge-sweep --apply"

### 5. If --apply (and not --force) → confirm

Use AskUserQuestion with a single yes/no:
- Question: "Apply the sweep above? Drops N memories + N decisions + N sessions; trims N milestone dirs + N task dirs (keeping only their SUMMARY). Cannot be undone except via version control."
- Options: ["Apply now", "Cancel"]

If user picks Cancel → stop, no writes.

### 6. Execute (when --force OR confirmed)

Order matters — do these in sequence:

**a) AUTO-MEMORY rewrite**
Build the new file content:
- Keep the `<!-- gsd-auto-memory ... -->` header lines, but update the comment to add `| pruned: YYYY-MM-DD — kept K/N (criteria: confidence>=0.90 AND hits>=2 AND cross-cutting)`
- Re-emit each kept entry verbatim
- Group by category (`## Gotcha`, `## Convention`, `## Architecture`) preserving original ordering within each group
Write back via Write tool.

**b) DECISIONS rewrite**
Build new content:
- Preserve the title and explanatory comment block; append a new comment line: `<!-- YYYY-MM-DD: Pruned K/N rows. Kept only cross-cutting architectural invariants. -->`
- Re-emit the table header and the kept rows verbatim (preserve original `#` numbering — do NOT renumber)
Write back via Write tool.

**c) Milestone dirs**
For each dir in the "Trim" list:
- Double-check LEDGER has a matching heading (defensive)
- Remove every file inside `.gsd/milestones/M###/` EXCEPT `M###-SUMMARY.md`. Portable command (works on Linux/macOS/Git Bash):
  `find .gsd/milestones/M###/ -mindepth 1 -not -name 'M###-SUMMARY.md' -delete`
  PowerShell equivalent:
  `Get-ChildItem '.gsd/milestones/M###/' -Recurse -Force | Where-Object { $_.Name -ne 'M###-SUMMARY.md' } | Sort-Object FullName -Descending | Remove-Item -Force -Recurse`
- Do NOT remove the directory itself, and do NOT remove `M###-SUMMARY.md`.

**d) Task dirs**
For each dir in the "Trim" list:
- Double-check LEDGER has a matching heading (defensive)
- Remove every file inside `.gsd/tasks/TASK-###/` EXCEPT `TASK-###-SUMMARY.md`. Use the same find/PowerShell pattern as above with the task-specific paths and filename.
- Do NOT remove the directory itself, and do NOT remove `TASK-###-SUMMARY.md`.

**e) Session files**
For each file in the "Drop" list:
- `rm -f .gsd/sessions/<file>`

**f) Telemetry log**
Append to `.gsd/forge/events.jsonl`:
```json
{"ts":"<ISO8601>","event":"sweep","scope":"<scope>","dropped":{"memories":N,"decisions":N,"sessions":N},"trimmed":{"milestones":N,"tasks":N},"flagged":{"memories":N,"decisions":N}}
```

### 7. Final report

```
✓ Sweep applied

  AUTO-MEMORY:    K/N kept   (M dropped, R flagged for review next time)
  DECISIONS:      K/N kept
  Milestone dirs: M trimmed (only SUMMARY kept), K untouched (active)
  Task dirs:      M trimmed (only SUMMARY kept), K untouched (no SUMMARY yet)
  Sessions:       M dropped, K kept (open)

Files now lean. Commit to version control when ready.

Flagged entries (re-evaluate before next sweep):
  - [MEMxxx] reason
  - DECISIONS row N — reason
```

---

## Notes for the team

- **Run after `complete-milestone`** — that's when LEDGER gets the milestone entry, making the milestone dir safe to trim down to its SUMMARY.
- **For ad-hoc tasks (`/forge-task`)** — task dirs are trimmed automatically when SUMMARY + LEDGER entry exist, same rules as milestones.
- **Why trim instead of delete** — the empty-ish milestone/task directory (with just the SUMMARY inside) stays visible in version control so teammates pulling the sweep see the milestone existed. This avoids the confusion of "where did M### go?" when one dev sweeps and another pulls.
- **Flagged entries don't auto-drop** — re-evaluate them in the next sweep. If they still don't earn promotion (hits stay low, scope still narrow), drop manually next time.
- **Re-renumbering is forbidden** — DECISIONS rows keep their original `#` even after prune (auditability).
- **Never edit `STATE.md`** — this command does not touch state.
- **Never run during an active milestone phase** — only after `complete-milestone` or between tickets.
