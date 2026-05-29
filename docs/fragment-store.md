# Fragment Store + Projection

Reference documentation for the Forge Agent fragment-store architecture introduced in M001.

---

## Overview

The classic `.gsd/` layout keeps three mutable monoliths (`LEDGER.md`, `DECISIONS.md`,
`AUTO-MEMORY.md`) as single files that every concurrent writer must touch. Under multi-branch
or multi-developer workflows these files diverge and merge-conflict constantly.

The **fragment-store** solves this with a read/write split:

- **Writers** append a small per-unit fragment (one file per milestone / session / task).
- **Readers** never open fragments directly — they call `forge-projection.js` which
  reconstructs the full monolith on the fly.
- **Monoliths** live on disk as a `.gitignore`-d (or `svn:ignore`-d) projection cache,
  regenerated when stale. They are never committed.

The result is conflict-free by construction: each fragment is owned by exactly one unit of
work and therefore by exactly one developer/branch.

---

## Store Layout

```
.gsd/
├── ledger/              # one fragment per completed milestone
│   └── <milestone-id>.md
├── decisions/           # one fragment per milestone, slice, or ask-session
│   └── <id>.md
├── memory/              # one fragment per milestone or task where learning occurred
│   └── <id>.md
├── checker-memory/      # plan-checker learning entries (S04)
│   └── <id>.md
│
│   ── PROJECTION CACHE (gitignored / svn:ignored) ──
├── LEDGER.md            ← rendered by forge-projection --write-all
├── DECISIONS.md         ← rendered by forge-projection --write-all
└── AUTO-MEMORY.md       ← rendered by forge-projection --write-all
```

Fragment directories are created **lazily** on first write — `/forge-init` does not pre-create
them. The ignore rules that hide the projection cache files are written during `forge-init` by
`scripts/forge-ignore.js --apply`.

---

## Fragment Schema

Every fragment file carries a YAML frontmatter block followed by a markdown body:

```markdown
---
schema_version: 1
type: ledger | decisions | memory | checker-memory
id: <unit-id>            # milestone ID (M-<ts>-<slug> or M###) or ask-<session-id>
written_at: <ISO-8601>
# type-specific fields follow:
#   ledger:    title, slices_done, key_files, key_decisions
#   decisions: milestone, slice (optional)
#   memory:    category, confidence, hits, last_hit, decay_half_life_ms
---

<body — markdown prose>
```

The `schema_version` field enables `forge-doctor --check schema` to detect fragments written
by older or future versions and alert before incompatibilities cause silent data loss.

A `.gsd/SCHEMA-VERSION` file records the current schema version (integer) for the whole
working copy. `forge-doctor` and `forge-migrate.js` read this to decide whether migration is
needed.

---

## Layer-by-Layer Reference

### Layer 1 — Ignore rules (S01)

`scripts/forge-ignore.js --apply` detects the VCS (Git or SVN) and writes the appropriate
ignore entries for the three projection-cache paths:

- **Git:** appends to `.gsd/.gitignore`
- **SVN:** sets `svn:ignore` on `.gsd/`

This step runs automatically inside `/forge-init` (both Case A — existing project and
Case B — new project). Re-running is idempotent.

### Layer 2 — Fragment writers (S02)

Three modules, one per store, all following the same API contract:

| Module | CLI flag | Store dir |
|--------|----------|-----------|
| `scripts/forge-ledger.js` | `--write \| --read \| --list \| --validate` | `.gsd/ledger/` |
| `scripts/forge-decisions.js` | same flags | `.gsd/decisions/` |
| `scripts/forge-memory.js` | same flags | `.gsd/memory/` |

Each module exports: `writeFragment(cwd, entry)`, `readFragment(cwd, id)`,
`listFragments(cwd)`, `parseFragment(text)`. The `forge-completer` and `forge-memory` agents
call these functions when closing a milestone or extracting a memory.

Migration helpers for existing monoliths:
- `scripts/forge-ledger-migrate.js`
- `scripts/forge-decisions-migrate.js`
- `scripts/forge-memory-migrate.js`

### Layer 3 — Projection engine (S03)

`scripts/forge-projection.js` is the read-side of the paradigm.

**Library exports:**

```js
renderLedger(cwd)      // → string  LEDGER.md reconstructed from ledger/*.md
renderDecisions(cwd)   // → string  DECISIONS.md with derived # numbering
renderMemory(cwd)      // → string  AUTO-MEMORY.md with decay computed on-read
isStale(cwd)           // → { ledger:bool, decisions:bool, memory:bool }
writeAll(cwd)          // → { written:[string], skipped:[string] }
```

**CLI:**

```bash
node scripts/forge-projection.js --render ledger|decisions|memory [--cwd <dir>]
node scripts/forge-projection.js --stale  [--cwd <dir>]
node scripts/forge-projection.js --write-all [--cwd <dir>]
```

Staleness is determined by comparing the `mtime` of the projection cache file against the
newest fragment in its store directory. `isStale()` is cheap (stat-only); it is called by
agents that need to read a monolith — they call `writeAll()` first when stale.

Memory decay is computed **on-read**: confidence is adjusted by a 30-day half-life without
mutating the fragment. The cap of 50 active memories is enforced during projection, not during
write.

### Layer 4 — Migration + verification (S04)

`/forge-update` runs `scripts/forge-migrate.js` which:

1. Reads `.gsd/SCHEMA-VERSION` (or defaults to version `0` for pre-M001 working copies).
2. For each store below the target schema version, calls the matching migrate script to
   explode the monolith into per-unit fragments.
3. Keeps the original monolith as `<name>.bak` (e.g. `LEDGER.md.bak`).
4. Runs a verification step: renders the new projection and diffs it against the backup
   (modulo line-number prefixes). A mismatch is reported but does not abort — the `.bak` file
   is preserved so nothing is lost.
5. Writes the new `.gsd/SCHEMA-VERSION`.

Migration is **idempotent** — re-running it on an already-migrated working copy is a no-op
(fragments already exist; monolith backup is preserved unchanged).

### Layer 5 — Doctor checks (S05)

`forge-doctor` validates the fragment-store health:

```bash
/forge-doctor --check schema
/forge-doctor --check projection-versioned
```

- `--check schema` — verifies every fragment's `schema_version` matches the working copy
  SCHEMA-VERSION. Fragments written by a future version emit a warning; fragments below the
  current version are flagged for migration.
- `--check projection-versioned` — verifies the projection cache exists and is fresh (not
  stale). If stale, suggests running `node scripts/forge-projection.js --write-all`.

---

## Projection Cache — .bak Guarantee

The migration step always preserves `LEDGER.md.bak`, `DECISIONS.md.bak`, and
`AUTO-MEMORY.md.bak` alongside the migrated fragments. These backups are kept indefinitely
(also gitignored) and serve as the ground truth for verifying migration correctness.

To manually verify a projection matches its backup:

```bash
node scripts/forge-projection.js --render ledger --cwd /your/project > /tmp/ledger-new.md
diff /your/project/.gsd/LEDGER.md.bak /tmp/ledger-new.md
```

A clean diff confirms the migration was lossless.

---

## Related Files

- [`scripts/forge-projection.js`](../scripts/forge-projection.js) — projection engine
- [`scripts/forge-ledger.js`](../scripts/forge-ledger.js) — ledger fragment writer
- [`scripts/forge-decisions.js`](../scripts/forge-decisions.js) — decisions fragment writer
- [`scripts/forge-memory.js`](../scripts/forge-memory.js) — memory fragment writer
- [`scripts/forge-ignore.js`](../scripts/forge-ignore.js) — VCS ignore rules (Layer 1)
- [`scripts/forge-migrate.js`](../scripts/forge-migrate.js) — migration orchestrator
- [`scripts/forge-doctor.js`](../scripts/forge-doctor.js) — health checks
