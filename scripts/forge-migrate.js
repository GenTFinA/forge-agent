#!/usr/bin/env node
// forge-migrate — Consolidated migration orchestrator for Forge Agent fragment stores.
//
// Runs the three migrators (ledger, decisions, memory) in order. For each:
//   1. Renames the legacy monolith to <name>.bak (preserves existing .bak).
//   2. Invokes the migrator's migrate() export.
//   3. Verifies: renders via forge-projection and diffs against .bak content.
//   4. Writes .gsd/SCHEMA-VERSION on success.
//
// Library exports:
//   migrateAll(cwd, opts)  → summary object per store + schema_version_written
//
// CLI:
//   node forge-migrate.js [--cwd <dir>] [--dry-run]
//
// Exit codes:
//   0 — success
//   1 — migration error (partial state preserved; .bak files kept)
//   2 — bad arguments

'use strict';

const fs   = require('fs');
const path = require('path');

const ledgerMigrate    = require('./forge-ledger-migrate');
const decisionsMigrate = require('./forge-decisions-migrate');
const memoryMigrate    = require('./forge-memory-migrate');
const projection       = require('./forge-projection');
const { CURRENT_SCHEMA } = require('./forge-doctor');

// ── Store descriptors ─────────────────────────────────────────────────────────
// Each store: { name, monolithRel, bakRel, migrate, render }
const STORES = [
  {
    name:       'ledger',
    monolithRel: '.gsd/LEDGER.md',
    bakRel:      '.gsd/LEDGER.md.bak',
    migrate:    (cwd, opts) => ledgerMigrate.migrate(cwd, opts),
    render:     (cwd)       => projection.renderLedger(cwd),
  },
  {
    name:       'decisions',
    monolithRel: '.gsd/DECISIONS.md',
    bakRel:      '.gsd/DECISIONS.md.bak',
    migrate:    (cwd, opts) => decisionsMigrate.migrate(cwd, opts),
    render:     (cwd)       => projection.renderDecisions(cwd),
  },
  {
    name:       'memory',
    monolithRel: '.gsd/AUTO-MEMORY.md',
    bakRel:      '.gsd/AUTO-MEMORY.md.bak',
    migrate:    (cwd, opts) => memoryMigrate.migrate(cwd, opts),
    render:     (cwd)       => projection.renderMemory(cwd),
  },
];

// ── normalizeDecisions ────────────────────────────────────────────────────────
// Strip the leading `| # |` column from each table data row so that derived
// numbering differences don't cause spurious "differs" classification.
function stripDecisionNumbers(text) {
  return text
    .split('\n')
    .map(line => {
      // Match table rows that start with "| <number> |" and strip that column
      const m = line.match(/^\|\s*\d+\s*\|(.*)/);
      if (m) return '|' + m[1];
      return line;
    })
    .join('\n');
}

// ── compareContent ────────────────────────────────────────────────────────────
// Compares bak content vs rendered content.
// Returns 'identical' | 'differs (numbering only)' | 'differs' | 'no-bak'
function compareContent(bakContent, rendered, storeName) {
  if (bakContent === null) return 'no-bak';
  if (bakContent === rendered) return 'identical';

  // For decisions store, try ignoring the # column
  if (storeName === 'decisions') {
    const bakNorm      = stripDecisionNumbers(bakContent);
    const renderedNorm = stripDecisionNumbers(rendered);
    if (bakNorm === renderedNorm) return 'differs (numbering only)';
  }

  return 'differs';
}

// ── backupMonolith ────────────────────────────────────────────────────────────
// Renames monolith to .bak if monolith exists and .bak does not exist yet.
// Returns { action: 'renamed'|'bak-exists'|'no-source', bakContent: string|null }
function backupMonolith(cwd, store, dryRun) {
  const monolithPath = path.join(cwd, store.monolithRel);
  const bakPath      = path.join(cwd, store.bakRel);

  if (!fs.existsSync(monolithPath)) {
    return { action: 'no-source', bakContent: null };
  }

  if (fs.existsSync(bakPath)) {
    // .bak already exists — preserve it, read for verification
    const bakContent = fs.readFileSync(bakPath, 'utf8');
    return { action: 'bak-exists', bakContent };
  }

  // Read monolith content before rename (we need it for verification)
  const bakContent = fs.readFileSync(monolithPath, 'utf8');

  if (!dryRun) {
    fs.renameSync(monolithPath, bakPath);
  }

  return { action: dryRun ? 'would-rename' : 'renamed', bakContent };
}

// ── migrateStore ──────────────────────────────────────────────────────────────
// Runs backup + migration + verification for a single store.
// Returns store result object.
function migrateStore(cwd, store, opts) {
  const { dryRun = false } = opts;
  const result = {
    name:         store.name,
    bak:          null,    // 'renamed'|'bak-exists'|'no-source'|'would-rename'
    written:      0,
    skipped:      0,
    would_write:  0,
    warnings:     [],
    verification: null,   // 'identical'|'differs (numbering only)'|'differs'|'no-bak'|'skipped'
    error:        null,
  };

  // Step 1: backup
  let bakContent = null;
  try {
    const backup = backupMonolith(cwd, store, dryRun);
    result.bak   = backup.action;
    bakContent   = backup.bakContent;
  } catch (e) {
    result.error = `backup failed: ${e.message}`;
    return result;
  }

  // Step 2: migrate — pass bakPath as source when bakContent is available so the
  // migrator reads from the .bak file (original content) instead of the now-renamed path.
  let migrateResult;
  try {
    const migrateOpts = { dryRun };
    if (bakContent !== null) {
      migrateOpts.source = path.join(cwd, store.bakRel);
    }
    migrateResult = store.migrate(cwd, migrateOpts);
  } catch (e) {
    result.error = `migrate failed: ${e.message}`;
    return result;
  }

  result.written     = migrateResult.written     || 0;
  result.skipped     = migrateResult.skipped      || 0;
  result.would_write = migrateResult.would_write  || 0;
  result.warnings    = migrateResult.warnings     || [];

  // Step 3: verification (skip on dry-run — fragments weren't written)
  if (dryRun) {
    result.verification = 'skipped (dry-run)';
    return result;
  }

  // Only verify if we had a bak to compare against
  if (bakContent === null) {
    result.verification = 'no-bak';
    return result;
  }

  try {
    const rendered       = store.render(cwd);
    result.verification  = compareContent(bakContent, rendered, store.name);
  } catch (e) {
    result.verification = `error: ${e.message}`;
  }

  return result;
}

// ── writeSchemaVersion ────────────────────────────────────────────────────────
function writeSchemaVersion(cwd) {
  const dest = path.join(cwd, '.gsd', 'SCHEMA-VERSION');
  const dir  = path.dirname(dest);
  if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true });
  fs.writeFileSync(dest, CURRENT_SCHEMA + '\n', 'utf8');
  return CURRENT_SCHEMA;
}

// ── migrateAll ────────────────────────────────────────────────────────────────
// Orchestrates all three stores in order.
// Returns { ledger, decisions, memory, schema_version_written }
function migrateAll(cwd, opts = {}) {
  const { dryRun = false } = opts;

  const results = {};
  let anyError = false;

  for (const store of STORES) {
    const r = migrateStore(cwd, store, { dryRun });
    results[store.name] = r;
    if (r.error) {
      anyError = true;
      // Stop on first error to prevent cascading state corruption
      break;
    }
  }

  if (anyError) {
    results.schema_version_written = null;
    return results;
  }

  // Write SCHEMA-VERSION (skip on dry-run)
  let schemaWritten = null;
  if (!dryRun) {
    schemaWritten = writeSchemaVersion(cwd);
  } else {
    schemaWritten = `(dry-run, would write: ${CURRENT_SCHEMA})`;
  }

  results.schema_version_written = schemaWritten;
  return results;
}

// ── Module exports ────────────────────────────────────────────────────────────
module.exports = { migrateAll };

// ── CLI ───────────────────────────────────────────────────────────────────────
function printUsage() {
  console.log(`Usage: node forge-migrate.js [options]

Options:
  --cwd <dir>   Working directory (default: process.cwd())
  --dry-run     Preview only — no files written
  --help, -h    Show this help

Description:
  Orchestrates the three Forge fragment-store migrations in order:
    1. LEDGER.md        → .gsd/ledger/*.md
    2. DECISIONS.md     → .gsd/decisions/*.md
    3. AUTO-MEMORY.md   → .gsd/memory/*.md

  Each legacy monolith is renamed to <name>.bak before migration.
  Existing .bak files are preserved (never overwritten).
  After migration, renders via forge-projection and diffs against .bak.
  Writes .gsd/SCHEMA-VERSION on success.
  Idempotent: second run reports written:0 for each store.

Exit codes:
  0  Success
  1  Migration error (partial state; .bak files kept)
  2  Bad arguments`);
}

function cliMain(argv) {
  let cwd    = process.cwd();
  let dryRun = false;

  const cwdIdx = argv.indexOf('--cwd');
  if (cwdIdx !== -1) {
    cwd = argv[cwdIdx + 1];
    if (!cwd) {
      process.stderr.write('--cwd requires a directory argument\n');
      process.exit(2);
    }
    argv = argv.filter((_, i) => i !== cwdIdx && i !== cwdIdx + 1);
  }

  if (argv.includes('--dry-run')) dryRun = true;

  if (argv.includes('--help') || argv.includes('-h')) {
    printUsage();
    process.exit(0);
  }

  const unknowns = argv.filter(a => a.startsWith('--') && a !== '--dry-run');
  if (unknowns.length > 0) {
    process.stderr.write(`Unknown argument(s): ${unknowns.join(', ')}\n\n`);
    printUsage();
    process.exit(2);
  }

  let results;
  try {
    results = migrateAll(cwd, { dryRun });
  } catch (e) {
    process.stderr.write(`Migration failed: ${e.message}\n`);
    process.exit(1);
  }

  // Print summary
  console.log(JSON.stringify(results, null, 2));

  // Exit 1 if any store errored
  const hasError = STORES.some(s => results[s.name] && results[s.name].error);
  if (hasError) process.exit(1);
}

if (require.main === module) {
  try {
    cliMain(process.argv.slice(2));
  } catch (e) {
    process.stderr.write(`${e.message}\n`);
    process.exit(1);
  }
}
