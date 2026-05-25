#!/usr/bin/env node
// forge-decisions-migrate — One-shot migration: split legacy global DECISIONS.md (and any
// per-milestone M###-DECISIONS.md files) into per-unit fragments under .gsd/decisions/.
//
// Library exports:
//   parseDecisions(text, opts?)   → Array<row>  // parse DECISIONS table text into row objects
//   migrate(cwd, opts)            → summary      // run migration, returns { status, written, skipped, would_write, warnings }
//
// CLI:
//   node forge-decisions-migrate.js [--cwd <dir>]           Run live migration
//   node forge-decisions-migrate.js --dry-run [--cwd <dir>]  Dry run — print what would be written
//   node forge-decisions-migrate.js --help, -h               Show usage
//
// Exit codes:
//   0 — success (including no-decisions case)
//   2 — unknown arguments

'use strict';

const fs = require('fs');
const path = require('path');
const decisions = require('./forge-decisions');

// ── SENTINEL ──────────────────────────────────────────────────────────────────
// Rows whose scope cannot be resolved to a known ID are bucketed here.
const ORPHAN_BUCKET = 'legacy-orphan';

// ── detectFormat ──────────────────────────────────────────────────────────────
// Returns 'global' | 'multi-run' | 'unknown' based on the header row.
// Global format:    | # | When | Scope | Decision | Choice | Rationale | Revisable? |
// Multi-run format: | ID | Decision | Rationale | Date |
function detectFormat(text) {
  const lines = text.split('\n');
  for (const line of lines) {
    const trimmed = line.trim();
    if (!trimmed.startsWith('|')) continue;
    const lower = trimmed.toLowerCase();
    // Global format has Scope and Choice columns
    if (lower.includes('scope') && lower.includes('choice')) return 'global';
    // Multi-run format has ID, Decision, Rationale, Date (no Scope/Choice)
    if (lower.includes('| id |') || lower.match(/\|\s*id\s*\|/)) return 'multi-run';
    break; // only check first pipe-row
  }
  return 'unknown';
}

// ── splitRow ──────────────────────────────────────────────────────────────────
// Splits a markdown table row by '|', trims cells, drops first/last empty.
function splitRow(line) {
  return line
    .split('|')
    .slice(1, -1)
    .map(c => c.trim());
}

// ── isSeparatorRow ────────────────────────────────────────────────────────────
// Returns true if the row is a markdown table separator (e.g. |---|---|).
function isSeparatorRow(line) {
  return /^\|[\s\-|:]+\|$/.test(line.trim());
}

// ── parseDecisions ────────────────────────────────────────────────────────────
// Parses DECISIONS table text into an array of row objects.
// opts.scopeOverride — override scope for all rows (used for multi-run per-milestone files)
// opts.format       — 'global' | 'multi-run' | auto-detect
//
// Global row shape:     { when, scope, decision, choice, rationale, revisable }
// Multi-run row shape:  { when, scope, decision, choice: null, rationale, revisable: null }
//   (scope comes from opts.scopeOverride or is ORPHAN_BUCKET)
//
// Returns Array<row>; per-row parse failures push to warnings[] and continue.
function parseDecisions(text, opts) {
  opts = opts || {};
  const warnings = [];
  const rows = [];

  if (!text || !text.trim()) return { rows, warnings };

  const format = opts.format || detectFormat(text);

  const lines = text.split('\n');
  let headerParsed = false;
  let headerCols = []; // lower-cased column names from the header row

  for (let i = 0; i < lines.length; i++) {
    const line = lines[i];
    if (!line.trim().startsWith('|')) continue;
    if (isSeparatorRow(line)) continue;

    const cells = splitRow(line);
    if (cells.length === 0) continue;

    // First pipe-row is the header
    if (!headerParsed) {
      headerCols = cells.map(c => c.toLowerCase().replace(/[^a-z0-9]/g, ''));
      headerParsed = true;
      continue;
    }

    try {
      if (format === 'global') {
        // Column order: # | When | Scope | Decision | Choice | Rationale | Revisable?
        const getCell = (names) => {
          for (const name of names) {
            const idx = headerCols.indexOf(name.toLowerCase().replace(/[^a-z0-9]/g, ''));
            if (idx !== -1 && idx < cells.length) return cells[idx] || '';
          }
          return '';
        };

        const scope = getCell(['scope']) || ORPHAN_BUCKET;
        const when = getCell(['when']);
        const decision = getCell(['decision']);
        const choice = getCell(['choice']);
        const rationale = getCell(['rationale']);
        const revisable = getCell(['revisable', 'revisable?']);

        rows.push({ when, scope, decision, choice, rationale, revisable });

      } else if (format === 'multi-run') {
        // Column order: ID | Decision | Rationale | Date
        const idxDecision = headerCols.findIndex(c => c === 'decision');
        const idxRationale = headerCols.findIndex(c => c === 'rationale');
        const idxDate = headerCols.findIndex(c => c === 'date');

        const decision = idxDecision !== -1 ? (cells[idxDecision] || '') : '';
        const rationale = idxRationale !== -1 ? (cells[idxRationale] || '') : '';
        const when = idxDate !== -1 ? (cells[idxDate] || '') : '';
        const scope = opts.scopeOverride || ORPHAN_BUCKET;

        rows.push({ when, scope, decision, choice: null, rationale, revisable: null });

      } else {
        // Unknown format — treat each non-header row as opaque and orphan it
        warnings.push(`Row ${i + 1}: unknown table format, orphaning row`);
        rows.push({
          when: '',
          scope: ORPHAN_BUCKET,
          decision: cells.join(' | '),
          choice: null,
          rationale: '',
          revisable: null,
        });
      }
    } catch (e) {
      warnings.push(`Row ${i + 1}: parse error — ${e.message}`);
    }
  }

  return { rows, warnings };
}

// ── resolveScope ──────────────────────────────────────────────────────────────
// Maps a raw scope string to the canonical bucket ID for the decisions fragment.
// Returns the canonical ID string, or ORPHAN_BUCKET if unparseable.
function resolveScope(scope) {
  if (!scope || !scope.trim()) return ORPHAN_BUCKET;

  const s = scope.trim();

  // Already a valid unit ID (milestone or task) — use as-is
  try {
    const { isValid } = require('./forge-ids');
    if (isValid(s)) return s;
  } catch (e) {
    // forge-ids not available — fall through to manual detection
  }

  // Legacy M### format (e.g., M001, M042)
  if (/^M\d+$/i.test(s)) return s;

  // Legacy TASK-### format
  if (/^TASK-\d+$/i.test(s)) return s;

  // Timestamp-prefixed forms that aren't caught by isValid
  if (/^M-\d{14}-[a-z0-9-]+$/i.test(s)) return s;
  if (/^T-\d{14}-[a-z0-9-]+$/i.test(s)) return s;

  // forge-ask session IDs
  if (/^ask-[A-Za-z0-9._-]+$/.test(s)) return s;

  return ORPHAN_BUCKET;
}

// ── inferScopeFromPath ────────────────────────────────────────────────────────
// Infers the milestone ID from a per-milestone DECISIONS file path.
// E.g., .gsd/milestones/M001/M001-DECISIONS.md → 'M001'
//       .gsd/milestones/M-20260101120000-foo/M-20260101120000-foo-DECISIONS.md → 'M-20260101120000-foo'
function inferScopeFromPath(filePath) {
  const basename = path.basename(filePath);
  // Match M###-DECISIONS.md or M-<ts>-<slug>-DECISIONS.md
  const m = basename.match(/^(M(?:-\d{14}-[a-z0-9-]+|\d+))-DECISIONS\.md$/i);
  if (m) return m[1];
  // Fallback: parent dir name
  const parentDir = path.basename(path.dirname(filePath));
  return parentDir || ORPHAN_BUCKET;
}

// ── groupByScope ──────────────────────────────────────────────────────────────
// Groups parsed rows into a Map<bucketId → row[]>.
function groupByScope(rows) {
  const groups = new Map();
  for (const row of rows) {
    const bucketId = resolveScope(row.scope);
    if (!groups.has(bucketId)) groups.set(bucketId, []);
    groups.get(bucketId).push(row);
  }
  return groups;
}

// ── migrate ───────────────────────────────────────────────────────────────────
// Main migration function.
// opts: { dryRun: boolean }
// Returns: { status, written, skipped, would_write, warnings }
//   status: 'no-decisions' | 'done' | 'idempotent'
function migrate(cwd, opts) {
  opts = opts || {};
  const dryRun = Boolean(opts.dryRun);
  const effectiveCwd = cwd || process.cwd();

  const allRows = [];
  const allWarnings = [];
  let anySourceFound = false;

  // ── Read global .gsd/DECISIONS.md ──────────────────────────────────────────
  const globalPath = path.join(effectiveCwd, '.gsd', 'DECISIONS.md');
  if (fs.existsSync(globalPath)) {
    anySourceFound = true;
    let text;
    try {
      text = fs.readFileSync(globalPath, 'utf8');
    } catch (e) {
      allWarnings.push(`Could not read ${globalPath}: ${e.message}`);
    }
    if (text) {
      const { rows, warnings } = parseDecisions(text);
      allRows.push(...rows);
      allWarnings.push(...warnings);
    }
  }

  // ── Glob per-milestone *-DECISIONS.md files ────────────────────────────────
  const milestonesDir = path.join(effectiveCwd, '.gsd', 'milestones');
  if (fs.existsSync(milestonesDir)) {
    let milestoneDirs;
    try {
      milestoneDirs = fs.readdirSync(milestonesDir);
    } catch (e) {
      allWarnings.push(`Could not list milestones dir: ${e.message}`);
      milestoneDirs = [];
    }

    for (const milestoneId of milestoneDirs) {
      const milestoneDir = path.join(milestonesDir, milestoneId);
      let files;
      try {
        files = fs.readdirSync(milestoneDir);
      } catch (e) {
        continue; // skip unreadable dirs
      }

      for (const file of files) {
        if (!file.endsWith('-DECISIONS.md')) continue;
        const filePath = path.join(milestoneDir, file);
        anySourceFound = true;
        let text;
        try {
          text = fs.readFileSync(filePath, 'utf8');
        } catch (e) {
          allWarnings.push(`Could not read ${filePath}: ${e.message}`);
          continue;
        }

        const scopeOverride = inferScopeFromPath(filePath);
        const { rows, warnings } = parseDecisions(text, { format: 'multi-run', scopeOverride });
        allRows.push(...rows);
        allWarnings.push(...warnings.map(w => `[${file}] ${w}`));
      }
    }
  }

  if (!anySourceFound) {
    return { status: 'no-decisions', written: 0, skipped: 0, would_write: 0, warnings: allWarnings };
  }

  if (allRows.length === 0) {
    return { status: 'no-decisions', written: 0, skipped: 0, would_write: 0, warnings: allWarnings };
  }

  // ── Group rows by resolved scope bucket ────────────────────────────────────
  const groups = groupByScope(allRows);

  let written = 0;
  let skipped = 0;
  let would_write = 0;

  for (const [bucketId, rows] of groups) {
    // Build fragment payload — strip the numbering/ID columns; store clean rows
    const cleanRows = rows.map(r => {
      const entry = {};
      if (r.when !== undefined && r.when !== null) entry.when = r.when;
      if (r.scope !== undefined && r.scope !== null) entry.scope = r.scope;
      if (r.decision !== undefined && r.decision !== null) entry.decision = r.decision;
      if (r.choice !== undefined && r.choice !== null) entry.choice = r.choice;
      if (r.rationale !== undefined && r.rationale !== null) entry.rationale = r.rationale;
      if (r.revisable !== undefined && r.revisable !== null) entry.revisable = r.revisable;
      return entry;
    });

    const fragment = { unit_id: bucketId, decisions: cleanRows };

    // For orphan bucket, writeFragment would fail validation — use direct file write
    if (bucketId === ORPHAN_BUCKET) {
      const orphanPath = path.join(effectiveCwd, '.gsd', 'decisions', `${ORPHAN_BUCKET}.md`);
      if (dryRun) {
        would_write++;
        process.stdout.write(`[dry-run] would write ${rows.length} rows → ${orphanPath}\n`);
        continue;
      }

      // Check idempotent — orphan file already exists with same rows?
      if (fs.existsSync(orphanPath)) {
        skipped++;
        continue;
      }

      try {
        const dir = path.dirname(orphanPath);
        if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true });

        // Serialize as simple markdown table for operator review
        let content = `# Legacy Orphan Decisions\n\n`;
        content += `<!-- Rows whose Scope could not be resolved to a known unit ID. -->\n`;
        content += `<!-- Rebucket manually by moving rows to the appropriate fragment file. -->\n\n`;
        content += `| When | Scope (raw) | Decision | Choice | Rationale | Revisable? |\n`;
        content += `|------|-------------|----------|--------|-----------|------------|\n`;
        for (const r of cleanRows) {
          content += `| ${r.when || ''} | ${r.scope || ''} | ${r.decision || ''} | ${r.choice || ''} | ${r.rationale || ''} | ${r.revisable || ''} |\n`;
        }
        fs.writeFileSync(orphanPath, content, 'utf8');
        written++;
      } catch (e) {
        allWarnings.push(`Failed to write orphan bucket: ${e.message}`);
        skipped++;
      }
      continue;
    }

    // Normal unit ID — use writeFragment (idempotent, dedup-aware)
    if (dryRun) {
      // Peek: does the fragment already exist?
      let existing = null;
      try {
        existing = decisions.readFragment(effectiveCwd, bucketId);
      } catch (e) {
        // Invalid ID that slipped through resolveScope — warn and orphan
        allWarnings.push(`Bucket ID "${bucketId}" is not a valid unit ID: ${e.message}`);
        would_write++; // Would have written to orphan
        process.stdout.write(`[dry-run] INVALID ID "${bucketId}" — ${rows.length} rows would go to orphan\n`);
        continue;
      }
      would_write++;
      const action = existing === null ? 'create' : 'merge';
      process.stdout.write(`[dry-run] would ${action} fragment for "${bucketId}" with ${rows.length} rows\n`);
      continue;
    }

    try {
      const result = decisions.writeFragment(effectiveCwd, fragment);
      if (result.created) {
        written++;
      } else {
        skipped++; // identical content — idempotent skip
      }
    } catch (e) {
      allWarnings.push(`Failed to write fragment for "${bucketId}": ${e.message}`);
      skipped++;
    }
  }

  // Determine status
  const status = written === 0 && would_write === 0 ? 'idempotent' : 'done';

  return { status, written, skipped, would_write, warnings: allWarnings };
}

// ── CLI ───────────────────────────────────────────────────────────────────────

function printUsage() {
  console.log(`Usage: node forge-decisions-migrate.js [options]

Options:
  --dry-run          Print what would be written without writing anything
  --cwd <dir>        Working directory (default: process.cwd())
  --help, -h         Show this help and exit

Exit codes:
  0  Success (including when no DECISIONS sources are found)
  2  Unknown or invalid arguments

Examples:
  node forge-decisions-migrate.js
  node forge-decisions-migrate.js --dry-run
  node forge-decisions-migrate.js --cwd /path/to/project
  node forge-decisions-migrate.js --dry-run --cwd /path/to/project`);
}

function cliMain(argv) {
  let cwd = process.cwd();
  let dryRun = false;

  // Parse --cwd
  const cwdIdx = argv.indexOf('--cwd');
  if (cwdIdx !== -1) {
    const cwdVal = argv[cwdIdx + 1];
    if (!cwdVal || cwdVal.startsWith('-')) {
      process.stderr.write('--cwd requires a directory argument\n');
      process.exit(2);
    }
    cwd = cwdVal;
    argv = argv.filter((_, i) => i !== cwdIdx && i !== cwdIdx + 1);
  }

  for (const arg of argv) {
    if (arg === '--help' || arg === '-h') {
      printUsage();
      process.exit(0);
    } else if (arg === '--dry-run') {
      dryRun = true;
    } else {
      process.stderr.write(`Unknown argument: ${arg}\n\n`);
      printUsage();
      process.exit(2);
    }
  }

  const summary = migrate(cwd, { dryRun });

  if (summary.status === 'no-decisions') {
    console.log(JSON.stringify({
      status: 'no-decisions',
      message: 'nothing to migrate — no DECISIONS sources found',
      written: 0,
      skipped: 0,
      would_write: 0,
      warnings: summary.warnings,
    }));
  } else {
    console.log(JSON.stringify(summary));
  }

  process.exit(0);
}

// ── Guarded CLI invocation ────────────────────────────────────────────────────
if (require.main === module) {
  try {
    cliMain(process.argv.slice(2));
  } catch (e) {
    process.stderr.write(`${e.message}\n`);
    process.exit(1);
  }
}

// ── Module exports ────────────────────────────────────────────────────────────
module.exports = { parseDecisions, migrate, ORPHAN_BUCKET };
