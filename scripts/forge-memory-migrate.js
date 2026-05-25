#!/usr/bin/env node
// forge-memory-migrate — One-shot migration: split legacy .gsd/AUTO-MEMORY.md and
// .gsd/CHECKER-MEMORY.md monoliths into per-unit fragments + seed stat events.
//
// Library exports:
//   parseAutoMemory(text)         → { entries, warnings }
//   parseCheckerMemory(text)      → { rows, warnings }
//   migrate(cwd, opts)            → summary
//
// CLI:
//   node forge-memory-migrate.js [options]
//
// Options:
//   --dry-run          Print what would be written without writing anything
//   --cwd <dir>        Working directory (default: process.cwd())
//   --skip-memory      Skip AUTO-MEMORY.md migration
//   --skip-checker     Skip CHECKER-MEMORY.md migration
//   --verify           After writes, attempt best-effort projection verify (advisory only)
//   --help, -h         Show this help and exit
//
// Exit codes:
//   0 — success (including no-sources case)
//   2 — unknown or invalid arguments

'use strict';

const fs = require('fs');
const path = require('path');
const memory = require('./forge-memory');
const checkerMemory = require('./forge-checker-memory');

// ── SENTINEL ──────────────────────────────────────────────────────────────────
// Entries whose source cannot be resolved to a valid unit-id go here.
const ORPHAN_BUCKET = 'legacy-orphan';

// ── Entry regex ───────────────────────────────────────────────────────────────
// Matches:
//   - [MEMxxx] (category) confidence:0.NN hits:N — text
//     source: <type>/<id> | updated: YYYY-MM-DD
//
// The entry may span multiple lines (text can contain hyphens, etc.).
// We parse line-by-line: bullet line + source line pairs.

// ── parseAutoMemory ───────────────────────────────────────────────────────────
// Parses .gsd/AUTO-MEMORY.md text into an array of entry objects.
// Returns { entries: Array<entry>, warnings: Array<string> }
// entry shape: { mem_id, category, confidence, hits, text, source, updated }
function parseAutoMemory(text) {
  const warnings = [];
  const entries = [];

  if (!text || !text.trim()) return { entries, warnings };

  const lines = text.split('\n');
  let i = 0;

  while (i < lines.length) {
    const line = lines[i];

    // Match bullet: - [MEM###] (category) confidence:0.NN hits:N — text
    const bulletMatch = line.match(
      /^- \[([A-Z]+\d+)\] \(([^)]+)\) confidence:([\d.]+) hits:(\d+) — (.+)$/
    );

    if (!bulletMatch) {
      i++;
      continue;
    }

    const mem_id = bulletMatch[1];
    const category = bulletMatch[2];
    const confidence = parseFloat(bulletMatch[3]);
    const hits = parseInt(bulletMatch[4], 10);
    let textLines = [bulletMatch[5].trim()];

    // Collect continuation lines until we hit "source:" line or a new bullet or section
    let j = i + 1;
    let sourceLine = null;

    while (j < lines.length) {
      const next = lines[j];
      // Source line: "  source: <...> | updated: YYYY-MM-DD"
      if (next.match(/^\s+source:\s+/)) {
        sourceLine = next.trim();
        j++;
        break;
      }
      // New bullet or heading — stop
      if (next.match(/^- \[/) || next.match(/^#{1,6}\s/)) {
        break;
      }
      // Blank line or indented continuation
      if (next.trim() !== '') {
        textLines.push(next.trim());
      }
      j++;
    }

    i = j;

    if (!sourceLine) {
      warnings.push(`[${mem_id}] No source line found — orphaning`);
      entries.push({ mem_id, category, confidence, hits, text: textLines.join(' '), source: null, updated: null });
      continue;
    }

    // Parse source line: "source: execute-task/T01 | updated: 2026-05-25"
    const sourceMatch = sourceLine.match(/source:\s*([^\|]+)\|?\s*(?:updated:\s*(.+))?$/);
    if (!sourceMatch) {
      warnings.push(`[${mem_id}] Could not parse source line: "${sourceLine}" — orphaning`);
      entries.push({ mem_id, category, confidence, hits, text: textLines.join(' '), source: null, updated: null });
      continue;
    }

    const source = sourceMatch[1].trim();
    const updated = sourceMatch[2] ? sourceMatch[2].trim() : null;

    entries.push({ mem_id, category, confidence, hits, text: textLines.join(' '), source, updated });
  }

  return { entries, warnings };
}

// ── resolveMemoryUnitId ───────────────────────────────────────────────────────
// Maps a memory entry's source string to a valid memory unit-id.
// Source forms:
//   execute-task/T01        → resolve T01 to its owning milestone via filesystem scan
//   complete-slice/S##      → resolve to owning milestone similarly
//   T-<ts>-<slug>           → use as-is (loose task)
//   M-<ts>-<slug> or M###  → use as-is (milestone)
// Unresolvable → ORPHAN_BUCKET
function resolveMemoryUnitId(source, cwd) {
  if (!source) return ORPHAN_BUCKET;

  const s = source.trim();

  // Timestamp-prefixed loose task — use as-is
  if (/^T-\d{14}-[a-z0-9-]+$/i.test(s)) return s;

  // Timestamp-prefixed milestone — use as-is
  if (/^M-\d{14}-[a-z0-9-]+$/i.test(s)) return s;

  // Legacy milestone M### — use as-is
  if (/^M\d+$/i.test(s)) return s;

  // Structured source: <unit_type>/<id>
  const slashIdx = s.indexOf('/');
  if (slashIdx !== -1) {
    const unitType = s.slice(0, slashIdx).trim();
    const unitId = s.slice(slashIdx + 1).trim();

    // Timestamp-prefixed task from structured source
    if (/^T-\d{14}-[a-z0-9-]+$/i.test(unitId)) return unitId;
    // Timestamp-prefixed milestone from structured source
    if (/^M-\d{14}-[a-z0-9-]+$/i.test(unitId)) return unitId;

    // Legacy T## / S## — need to resolve via filesystem
    if (/^T\d+$/i.test(unitId) || /^S\d+$/i.test(unitId)) {
      const resolved = resolveViaFilesystem(unitId, unitType, cwd);
      if (resolved) return resolved;
      return ORPHAN_BUCKET;
    }

    // Legacy M### from structured source
    if (/^M\d+$/i.test(unitId)) return unitId;
  }

  return ORPHAN_BUCKET;
}

// ── resolveViaFilesystem ──────────────────────────────────────────────────────
// Scans .gsd/milestones/ to find the milestone that owns a given T## or S##.
// Returns milestone-id string or null if not found / ambiguous.
function resolveViaFilesystem(id, unitType, cwd) {
  const milestonesDir = path.join(cwd, '.gsd', 'milestones');
  if (!fs.existsSync(milestonesDir)) return null;

  let dirs;
  try {
    dirs = fs.readdirSync(milestonesDir);
  } catch (e) {
    return null;
  }

  const matches = [];

  for (const milestoneId of dirs) {
    const milestoneDir = path.join(milestonesDir, milestoneId);
    let stat;
    try {
      stat = fs.statSync(milestoneDir);
    } catch (e) {
      continue;
    }
    if (!stat.isDirectory()) continue;

    const slicesDir = path.join(milestoneDir, 'slices');
    if (!fs.existsSync(slicesDir)) continue;

    // For T## ids — look in all tasks dirs
    if (/^T\d+$/i.test(id)) {
      let sliceDirs;
      try {
        sliceDirs = fs.readdirSync(slicesDir);
      } catch (e) {
        continue;
      }
      for (const sliceId of sliceDirs) {
        const tasksDir = path.join(slicesDir, sliceId, 'tasks', id);
        if (fs.existsSync(tasksDir)) {
          matches.push(milestoneId);
          break;
        }
      }
    }

    // For S## ids — look in slices dir
    if (/^S\d+$/i.test(id)) {
      const sliceDir = path.join(slicesDir, id);
      if (fs.existsSync(sliceDir)) {
        matches.push(milestoneId);
      }
    }
  }

  if (matches.length === 1) return matches[0];
  return null; // absent or ambiguous
}

// ── parseCheckerMemory ────────────────────────────────────────────────────────
// Parses .gsd/CHECKER-MEMORY.md tables.
// Returns { rows: Array<row>, warnings: Array<string> }
// row shape: { dimension, severity, slice, count, lastSeenTs, table }
// table: 'plan' | 'verify'
function parseCheckerMemory(text) {
  const warnings = [];
  const rows = [];

  if (!text || !text.trim()) return { rows, warnings };

  const lines = text.split('\n');
  let currentTable = null; // 'plan' | 'verify'
  let headerParsed = false;
  let headerCols = [];

  for (let i = 0; i < lines.length; i++) {
    const line = lines[i].trim();

    // Detect table section
    if (line.match(/Plan Quality Patterns/i)) {
      currentTable = 'plan';
      headerParsed = false;
      headerCols = [];
      continue;
    }
    if (line.match(/Verification Patterns/i)) {
      currentTable = 'verify';
      headerParsed = false;
      headerCols = [];
      continue;
    }

    if (!currentTable) continue;
    if (!line.startsWith('|')) continue;

    // Separator row
    if (/^\|[\s\-|:]+\|$/.test(line)) continue;

    const cells = line.split('|').slice(1, -1).map(c => c.trim());
    if (cells.length === 0) continue;

    // Header row
    if (!headerParsed) {
      headerCols = cells.map(c => c.toLowerCase().replace(/[^a-z0-9]/g, ''));
      headerParsed = true;
      continue;
    }

    // Data row
    const getCell = (names) => {
      for (const name of names) {
        const idx = headerCols.indexOf(name.toLowerCase().replace(/[^a-z0-9]/g, ''));
        if (idx !== -1 && idx < cells.length) return cells[idx] || '';
      }
      return '';
    };

    try {
      const dimension = getCell(['dimension', 'pattern', 'check']);
      const severity = getCell(['severity', 'level']);
      const slice = getCell(['slice', 'slices', 'context']);
      const countStr = getCell(['count', 'hits', 'occurrences']);
      const lastSeen = getCell(['lastseen', 'last', 'date', 'updated']);

      const count = parseInt(countStr, 10) || 1;

      // Extract milestone-id from lastSeen field (e.g., "M001 2026-05-20" or "M001")
      let lastSeenTs = null;
      let milestoneId = null;
      if (lastSeen) {
        const mMatch = lastSeen.match(/(M(?:-\d{14}-[a-z0-9-]+|\d+))/i);
        if (mMatch) milestoneId = mMatch[1];
        const dateMatch = lastSeen.match(/(\d{4}-\d{2}-\d{2})/);
        if (dateMatch) lastSeenTs = dateMatch[1];
      }

      if (!dimension) {
        warnings.push(`Row ${i + 1}: no dimension found — skipping`);
        continue;
      }

      rows.push({ dimension, severity, slice, count, lastSeenTs, milestoneId, table: currentTable });
    } catch (e) {
      warnings.push(`Row ${i + 1}: parse error — ${e.message}`);
    }
  }

  return { rows, warnings };
}

// ── writeBak ──────────────────────────────────────────────────────────────────
// Copies src → src.bak if .bak does not already exist.
function writeBak(srcPath) {
  const bakPath = srcPath + '.bak';
  if (!fs.existsSync(bakPath)) {
    fs.copyFileSync(srcPath, bakPath);
    return true;
  }
  return false; // already existed
}

// ── writeOrphanBucket ─────────────────────────────────────────────────────────
// Writes the legacy-orphan.md memory fragment for entries with no resolvable unit-id.
function writeOrphanBucket(cwd, orphanEntries, dryRun) {
  const orphanPath = path.join(cwd, '.gsd', 'memory', `${ORPHAN_BUCKET}.md`);

  if (dryRun) {
    process.stdout.write(`[dry-run] would write ${orphanEntries.length} orphan entries → ${orphanPath}\n`);
    return { written: 0, would_write: 1 };
  }

  if (fs.existsSync(orphanPath)) {
    return { written: 0, skipped: 1 };
  }

  const dir = path.dirname(orphanPath);
  if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true });

  let content = `# Legacy Orphan Memory Entries\n\n`;
  content += `<!-- Entries whose source could not be resolved to a valid unit-id. -->\n`;
  content += `<!-- Rebucket manually by moving entries to the appropriate fragment file. -->\n\n`;

  for (const e of orphanEntries) {
    content += `## [${e.mem_id}] ${e.category}\n\n`;
    content += `- confidence: ${e.confidence}\n`;
    content += `- hits: ${e.hits}\n`;
    content += `- text: ${e.text}\n`;
    content += `- source: ${e.source || '(unparseable)'}\n`;
    if (e.updated) content += `- updated: ${e.updated}\n`;
    content += '\n';
  }

  fs.writeFileSync(orphanPath, content, 'utf8');
  return { written: 1, skipped: 0 };
}

// ── migrate ───────────────────────────────────────────────────────────────────
// Main migration function.
// opts: { dryRun, skipMemory, skipChecker, verify }
// Returns: { status, memory: {...}, checker: {...}, warnings }
function migrate(cwd, opts) {
  opts = opts || {};
  const dryRun = Boolean(opts.dryRun);
  const skipMemory = Boolean(opts.skipMemory);
  const skipChecker = Boolean(opts.skipChecker);
  const effectiveCwd = cwd || process.cwd();

  const allWarnings = [];
  const result = {
    status: 'done',
    memory: { written: 0, skipped: 0, would_write: 0, orphans: 0 },
    checker: { written: 0, skipped: 0, would_write: 0, status: 'skipped' },
  };

  // ── AUTO-MEMORY migration ──────────────────────────────────────────────────
  if (!skipMemory) {
    const autoMemoryPath = path.join(effectiveCwd, '.gsd', 'AUTO-MEMORY.md');

    if (!fs.existsSync(autoMemoryPath)) {
      allWarnings.push('AUTO-MEMORY.md not found; skipping memory migration');
      result.memory.status = 'not-found';
    } else {
      const text = fs.readFileSync(autoMemoryPath, 'utf8');
      const { entries, warnings } = parseAutoMemory(text);
      allWarnings.push(...warnings.map(w => `[auto-memory] ${w}`));

      // Group entries by resolved unit-id
      const groups = new Map(); // unitId → entries[]
      const orphanEntries = [];

      for (const entry of entries) {
        const unitId = resolveMemoryUnitId(entry.source, effectiveCwd);
        if (unitId === ORPHAN_BUCKET) {
          orphanEntries.push(entry);
        } else {
          if (!groups.has(unitId)) groups.set(unitId, []);
          groups.get(unitId).push(entry);
        }
      }

      // Write per-unit fragments
      for (const [unitId, unitEntries] of groups) {
        const facts = unitEntries.map(e => ({
          mem_id: e.mem_id,
          category: e.category,
          text: e.text,
          created_at: e.updated || new Date().toISOString().slice(0, 10),
          source_unit: e.source || unitId,
        }));

        const stats = unitEntries.map(e => ({
          kind: 'seed',
          mem_id: e.mem_id,
          ts: e.updated ? `${e.updated}T00:00:00Z` : new Date().toISOString(),
          hits: e.hits,
          confidence: e.confidence,
        }));

        if (dryRun) {
          process.stdout.write(`[dry-run] would write ${unitEntries.length} facts → .gsd/memory/${unitId}.md\n`);
          result.memory.would_write++;
          continue;
        }

        try {
          const writeResult = memory.writeFragment(effectiveCwd, { unit_id: unitId, facts, stats });
          if (writeResult.created) {
            result.memory.written++;
          } else {
            result.memory.skipped++;
          }
        } catch (e) {
          allWarnings.push(`Failed to write memory fragment for "${unitId}": ${e.message}`);
          result.memory.skipped++;
        }
      }

      // Handle orphans
      if (orphanEntries.length > 0) {
        result.memory.orphans = orphanEntries.length;
        if (dryRun) {
          process.stdout.write(`[dry-run] would write ${orphanEntries.length} orphan entries → .gsd/memory/legacy-orphan.md\n`);
          result.memory.would_write++;
        } else {
          const orphanResult = writeOrphanBucket(effectiveCwd, orphanEntries, false);
          result.memory.written += orphanResult.written || 0;
          result.memory.skipped += orphanResult.skipped || 0;
        }
      }

      // Preserve .bak
      if (!dryRun && entries.length > 0) {
        try {
          writeBak(autoMemoryPath);
        } catch (e) {
          allWarnings.push(`Could not write AUTO-MEMORY.md.bak: ${e.message}`);
        }
      }

      result.memory.status = 'done';
    }
  } else {
    result.memory.status = 'skipped';
  }

  // ── CHECKER-MEMORY migration ───────────────────────────────────────────────
  if (!skipChecker) {
    const checkerMemoryPath = path.join(effectiveCwd, '.gsd', 'CHECKER-MEMORY.md');

    if (!fs.existsSync(checkerMemoryPath)) {
      process.stdout.write('checker monolith absent; skip\n');
      result.checker.status = 'not-found';
    } else {
      const text = fs.readFileSync(checkerMemoryPath, 'utf8');
      const { rows, warnings } = parseCheckerMemory(text);
      allWarnings.push(...warnings.map(w => `[checker-memory] ${w}`));

      // Group rows by milestone-id
      const groups = new Map(); // milestoneId → rows[]
      const orphanRows = [];

      for (const row of rows) {
        const milestoneId = row.milestoneId;
        if (!milestoneId) {
          orphanRows.push(row);
          allWarnings.push(`Checker row "${row.dimension}" has no resolvable milestone-id — orphaning`);
          continue;
        }
        if (!groups.has(milestoneId)) groups.set(milestoneId, []);
        groups.get(milestoneId).push(row);
      }

      // Emit one seed event per row into the appropriate milestone fragment
      for (const [milestoneId, milestoneRows] of groups) {
        const events = milestoneRows.map(row => ({
          kind: row.table === 'plan' ? 'plan' : 'verify',
          dimension: row.dimension,
          severity: row.severity || 'warn',
          slice: row.slice || '',
          ts: row.lastSeenTs ? `${row.lastSeenTs}T00:00:00Z` : new Date().toISOString(),
          count: row.count,
        }));

        if (dryRun) {
          process.stdout.write(`[dry-run] would write ${milestoneRows.length} checker events → .gsd/checker-memory/${milestoneId}.md\n`);
          result.checker.would_write++;
          continue;
        }

        try {
          const writeResult = checkerMemory.writeFragment(effectiveCwd, { milestoneId, events });
          if (writeResult.created) {
            result.checker.written++;
          } else {
            result.checker.skipped++;
          }
        } catch (e) {
          allWarnings.push(`Failed to write checker fragment for "${milestoneId}": ${e.message}`);
          result.checker.skipped++;
        }
      }

      // Preserve .bak
      if (!dryRun && rows.length > 0) {
        try {
          writeBak(checkerMemoryPath);
        } catch (e) {
          allWarnings.push(`Could not write CHECKER-MEMORY.md.bak: ${e.message}`);
        }
      }

      result.checker.status = 'done';
    }
  } else {
    result.checker.status = 'skipped';
  }

  // ── Best-effort verify (advisory only) ────────────────────────────────────
  // NOTE: The real projection engine ships in S05. This is a structural sanity
  // check only — compares fragment count vs expected entries. Log diff, never fail.
  if (opts.verify && !dryRun) {
    try {
      const fragments = memory.listFragments(effectiveCwd);
      const expectedCount = result.memory.written + result.memory.skipped;
      if (fragments.length !== expectedCount) {
        allWarnings.push(
          `[verify] Advisory: fragment count ${fragments.length} ≠ expected ${expectedCount}. ` +
          'This is best-effort — the full projection engine ships in S05.'
        );
      } else {
        process.stdout.write(`[verify] Fragment count matches (${fragments.length} files). Advisory pass.\n`);
      }
    } catch (e) {
      allWarnings.push(`[verify] Could not run advisory check: ${e.message}`);
    }
  }

  if (allWarnings.length > 0) {
    result.warnings = allWarnings;
  }

  return result;
}

// ── CLI ───────────────────────────────────────────────────────────────────────

function printUsage() {
  console.log(`Usage: node forge-memory-migrate.js [options]

Options:
  --dry-run          Print what would be written without writing anything
  --cwd <dir>        Working directory (default: process.cwd())
  --skip-memory      Skip AUTO-MEMORY.md migration
  --skip-checker     Skip CHECKER-MEMORY.md migration
  --verify           After writes, run advisory byte-compare verify (best-effort; S05 is canonical)
  --help, -h         Show this help and exit

Exit codes:
  0  Success (including when no memory sources are found)
  2  Unknown or invalid arguments

Examples:
  node forge-memory-migrate.js
  node forge-memory-migrate.js --dry-run
  node forge-memory-migrate.js --cwd /path/to/project
  node forge-memory-migrate.js --dry-run --cwd /path/to/project
  node forge-memory-migrate.js --skip-checker
  node forge-memory-migrate.js --skip-memory`);
}

function cliMain(argv) {
  let cwd = process.cwd();
  let dryRun = false;
  let skipMemory = false;
  let skipChecker = false;
  let verify = false;

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
    } else if (arg === '--skip-memory') {
      skipMemory = true;
    } else if (arg === '--skip-checker') {
      skipChecker = true;
    } else if (arg === '--verify') {
      verify = true;
    } else {
      process.stderr.write(`Unknown argument: ${arg}\n\n`);
      printUsage();
      process.exit(2);
    }
  }

  const summary = migrate(cwd, { dryRun, skipMemory, skipChecker, verify });

  const output = {
    status: dryRun ? 'would_run' : summary.status,
    memory: dryRun
      ? { would_write: summary.memory.would_write, orphans: summary.memory.orphans }
      : { written: summary.memory.written, skipped: summary.memory.skipped, orphans: summary.memory.orphans },
    checker: summary.checker.status === 'skipped' || summary.checker.status === 'not-found'
      ? { status: summary.checker.status }
      : dryRun
        ? { would_write: summary.checker.would_write }
        : { written: summary.checker.written, skipped: summary.checker.skipped },
  };

  if (summary.warnings && summary.warnings.length > 0) {
    output.warnings = summary.warnings;
  }

  console.log(JSON.stringify(output, null, 2));
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
module.exports = { parseAutoMemory, parseCheckerMemory, migrate, ORPHAN_BUCKET };
