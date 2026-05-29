#!/usr/bin/env node
// forge-ledger-migrate — One-shot migration: split legacy global LEDGER.md into
// per-milestone fragment files under .gsd/ledger/.
//
// Library exports:
//   parseLedger(text)         → Array<entry>  // parse legacy LEDGER.md text into entries
//   migrate(cwd, opts)        → summary        // run migration, returns { status, written, skipped, would_write }
//
// CLI:
//   node forge-ledger-migrate.js [--cwd <dir>]          Run live migration
//   node forge-ledger-migrate.js --dry-run [--cwd <dir>] Dry run — print what would be written
//   node forge-ledger-migrate.js --help, -h              Show usage
//
// Exit codes:
//   0 — success (including no-ledger case)
//   2 — unknown arguments

'use strict';

const fs = require('fs');
const path = require('path');
const ledger = require('./forge-ledger');

// ── parseLedger ───────────────────────────────────────────────────────────────
// Splits legacy global LEDGER.md content into per-milestone entry objects.
// Handles headers of the form:
//   ## M### — <title>
//   ## M-<ts>-<slug> — <title>
// Each block runs from its header to the next ## M header or EOF.
// Returns Array<{ id, title, completed_at, slices, key_files, key_decisions, body }>
function parseLedger(text) {
  if (!text || !text.trim()) return [];

  const entries = [];

  // Split on lines that start with "## M" — each is a new milestone block
  // Use a lookahead-free approach: find all header positions then slice.
  const headerRegex = /^(##\s+(M\S+)\s+—\s+(.+))$/gm;
  const headers = [];
  let match;

  while ((match = headerRegex.exec(text)) !== null) {
    headers.push({
      fullLine: match[1],
      id: match[2],
      title: match[3].trim(),
      startIndex: match.index,
      headerEnd: match.index + match[0].length,
    });
  }

  if (headers.length === 0) return [];

  for (let i = 0; i < headers.length; i++) {
    const h = headers[i];
    const bodyStart = h.headerEnd;
    const bodyEnd = i + 1 < headers.length ? headers[i + 1].startIndex : text.length;
    const rawBody = text.slice(bodyStart, bodyEnd).trim();

    let slices = [];
    let key_files = [];
    let key_decisions = [];

    // Parse structured lines from the body
    // Format examples:
    //   **Slices:** S01 · S02 · S03
    //   **Key files:** path/a.js, path/b.js
    //   **Key decisions:** Decision A · Decision B
    for (const line of rawBody.split('\n')) {
      const slicesMatch = line.match(/^\*{0,2}Slices:\*{0,2}\s+(.+)$/i);
      if (slicesMatch) {
        slices = splitBulletOrComma(slicesMatch[1]);
        continue;
      }
      const filesMatch = line.match(/^\*{0,2}Key files?:\*{0,2}\s+(.+)$/i);
      if (filesMatch) {
        key_files = splitBulletOrComma(filesMatch[1]);
        continue;
      }
      const decisionsMatch = line.match(/^\*{0,2}Key decisions?:\*{0,2}\s+(.+)$/i);
      if (decisionsMatch) {
        key_decisions = splitBulletOrComma(decisionsMatch[1]);
        continue;
      }
    }

    entries.push({
      id: h.id,
      title: h.title,
      completed_at: null, // legacy LEDGER did not record this
      slices,
      key_files,
      key_decisions,
      body: rawBody,
    });
  }

  return entries;
}

// ── splitBulletOrComma ────────────────────────────────────────────────────────
// Splits a value string on ' · ' (middle dot) or ',' and trims each item.
function splitBulletOrComma(str) {
  if (!str) return [];
  // Prefer middle-dot separator; fall back to comma
  const sep = str.includes(' · ') ? ' · ' : ',';
  return str.split(sep).map(s => s.trim()).filter(Boolean);
}

// ── migrate ───────────────────────────────────────────────────────────────────
// Main migration function.
// opts: { dryRun: boolean, source: string }
//   source — override the default LEDGER.md path (opts.source wins over default)
// Returns: { status, written, skipped, would_write }
//   status: 'no-ledger' | 'done'
function migrate(cwd, opts) {
  opts = opts || {};
  const dryRun = Boolean(opts.dryRun);

  const ledgerPath = opts.source
    ? opts.source
    : path.join(cwd || process.cwd(), '.gsd', 'LEDGER.md');

  if (!fs.existsSync(ledgerPath)) {
    return { status: 'no-ledger', written: 0, skipped: 0, would_write: 0 };
  }

  let text;
  try {
    text = fs.readFileSync(ledgerPath, 'utf8');
  } catch (e) {
    process.stderr.write(`Warning: could not read LEDGER.md: ${e.message}\n`);
    return { status: 'no-ledger', written: 0, skipped: 0, would_write: 0 };
  }

  let entries;
  try {
    entries = parseLedger(text);
  } catch (e) {
    process.stderr.write(`Warning: failed to parse LEDGER.md: ${e.message}\n`);
    entries = [];
  }

  let written = 0;
  let skipped = 0;
  let would_write = 0;

  for (const entry of entries) {
    let existing = null;
    try {
      existing = ledger.readFragment(cwd, entry.id);
    } catch (e) {
      // readFragment throws on invalid id — warn and skip this entry
      process.stderr.write(`Warning: skipping entry "${entry.id}" — ${e.message}\n`);
      skipped++;
      continue;
    }

    if (existing !== null) {
      // Fragment already exists — idempotent skip
      skipped++;
      continue;
    }

    if (dryRun) {
      would_write++;
    } else {
      try {
        ledger.writeFragment(cwd, entry);
        written++;
      } catch (e) {
        process.stderr.write(`Warning: failed to write fragment for "${entry.id}": ${e.message}\n`);
        skipped++;
      }
    }
  }

  return { status: 'done', written, skipped, would_write };
}

// ── CLI ───────────────────────────────────────────────────────────────────────

function printUsage() {
  console.log(`Usage: node forge-ledger-migrate.js [options]

Options:
  --dry-run          Print what would be written without writing anything
  --cwd <dir>        Working directory (default: process.cwd())
  --source <path>    Read the LEDGER monolith from this path instead of .gsd/LEDGER.md
  --help, -h         Show this help and exit

Exit codes:
  0  Success (including when LEDGER.md is absent)
  2  Unknown or invalid arguments

Examples:
  node forge-ledger-migrate.js
  node forge-ledger-migrate.js --dry-run
  node forge-ledger-migrate.js --cwd /path/to/project
  node forge-ledger-migrate.js --dry-run --cwd /path/to/project
  node forge-ledger-migrate.js --source /path/to/LEDGER.md.bak`);
}

function cliMain(argv) {
  let cwd = process.cwd();
  let dryRun = false;
  let source = null;

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

  // Parse --source
  const sourceIdx = argv.indexOf('--source');
  if (sourceIdx !== -1) {
    const sourceVal = argv[sourceIdx + 1];
    if (!sourceVal || sourceVal.startsWith('-')) {
      process.stderr.write('--source requires a file path argument\n');
      process.exit(2);
    }
    source = sourceVal;
    argv = argv.filter((_, i) => i !== sourceIdx && i !== sourceIdx + 1);
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

  const summary = migrate(cwd, { dryRun, source });

  if (summary.status === 'no-ledger') {
    console.log(JSON.stringify({ status: 'no-ledger', message: 'nothing to migrate — .gsd/LEDGER.md not found', written: 0, skipped: 0, would_write: 0 }));
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
module.exports = { parseLedger, migrate };
