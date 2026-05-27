#!/usr/bin/env node
// forge-migrate-b1.smoke.js — Self-contained B1 smoke test for forge-migrate end-to-end.
//
// Builds a synthetic .gsd/ fixture in os.tmpdir(), runs forge-migrate LIVE (no --dry-run),
// and asserts the four B1 success criteria from SCOPE.md:
//   1. Exit code 0
//   2. ≥1 fragment file in each of .gsd/{ledger,decisions,memory}/
//   3. .bak files exist and are byte-identical to original content
//   4. forge-projection --render ledger output equals LEDGER.md.bak
//
// Exit 0 on success (tmpdir cleaned). Exit 1 on failure (tmpdir preserved).

'use strict';

const fs           = require('fs');
const path         = require('path');
const os           = require('os');
const { spawnSync } = require('child_process');

// ── Repo root (scripts/smoke/ → scripts/ → repo root) ───────────────────────
const REPO_ROOT = path.resolve(__dirname, '..', '..');

// ── Fixture content ───────────────────────────────────────────────────────────

// LEDGER.md — one valid ## M... — <title> block that parseLedger detects
const LEDGER_CONTENT =
  '## M-20260101000000-smoke — Smoke milestone\n' +
  '\n' +
  '**Slices:** S01\n' +
  '\n' +
  '**Key files:** scripts/forge-migrate.js\n' +
  '\n' +
  '**Key decisions:** D12\n';

// DECISIONS.md — global format header + separator + one data row
// detectFormat looks for 'scope' AND 'choice' in the first pipe-row
const DECISIONS_CONTENT =
  '# Forge Decisions Log\n' +
  '\n' +
  '| # | When | Scope | Decision | Choice | Rationale | Revisable? |\n' +
  '|---|------|-------|----------|--------|-----------|------------|\n' +
  '| 1 | 2026-01-01 | M-20260101000000-smoke | Use fragment store | Yes | Scalability | No |\n';

// AUTO-MEMORY.md — one entry matching parseAutoMemory bullet regex
const MEMORY_CONTENT =
  '# Forge Auto-Memory\n' +
  '\n' +
  '- [MEM001] (convention) confidence:0.90 hits:3 — Smoke test memory entry\n' +
  '  source: task/T01 | updated: 2026-01-01\n';

// ── Helpers ───────────────────────────────────────────────────────────────────

function fail(msg, tempdir) {
  process.stderr.write(`FAIL: ${msg}\n`);
  if (tempdir) {
    process.stderr.write(`Tempdir preserved for debugging: ${tempdir}\n`);
  }
  process.exit(1);
}

function assertFragmentCount(store, tempdir, label) {
  const dir = path.join(tempdir, '.gsd', store);
  if (!fs.existsSync(dir)) {
    fail(`Fragment dir missing: ${dir}`, tempdir);
  }
  const files = fs.readdirSync(dir).filter(f => f.endsWith('.md'));
  if (files.length < 1) {
    fail(`Assertion 2 failed: no .md fragments in .gsd/${store}/ (label: ${label})`, tempdir);
  }
  return files;
}

// ── Main ───────────────────────────────────────────────────────────────────────

(function main() {
  // Create temp dir
  const tempdir = fs.mkdtempSync(path.join(os.tmpdir(), 'forge-migrate-b1-'));
  const gsdDir  = path.join(tempdir, '.gsd');
  fs.mkdirSync(gsdDir, { recursive: true });

  // Write fixtures & snapshot content for later comparison
  const ledgerPath    = path.join(gsdDir, 'LEDGER.md');
  const decisionsPath = path.join(gsdDir, 'DECISIONS.md');
  const memoryPath    = path.join(gsdDir, 'AUTO-MEMORY.md');

  fs.writeFileSync(ledgerPath,    LEDGER_CONTENT,    'utf8');
  fs.writeFileSync(decisionsPath, DECISIONS_CONTENT, 'utf8');
  fs.writeFileSync(memoryPath,    MEMORY_CONTENT,    'utf8');

  // Snapshot for byte-comparison
  const snapLedger    = LEDGER_CONTENT;
  const snapDecisions = DECISIONS_CONTENT;
  const snapMemory    = MEMORY_CONTENT;

  console.log(`Tempdir: ${tempdir}`);
  console.log('Running: node scripts/forge-migrate.js --cwd <tempdir>');

  // ── Assertion 1: forge-migrate exits 0 ───────────────────────────────────────
  const migrateResult = spawnSync(
    'node',
    [path.join(REPO_ROOT, 'scripts', 'forge-migrate.js'), '--cwd', tempdir],
    { cwd: REPO_ROOT, encoding: 'utf8' }
  );

  console.log('--- forge-migrate stdout ---');
  if (migrateResult.stdout) process.stdout.write(migrateResult.stdout);
  if (migrateResult.stderr) {
    console.log('--- forge-migrate stderr ---');
    process.stderr.write(migrateResult.stderr);
  }
  console.log(`--- exit code: ${migrateResult.status} ---`);

  if (migrateResult.status !== 0) {
    fail(`Assertion 1 failed: forge-migrate exited with code ${migrateResult.status}`, tempdir);
  }
  console.log('OK assertion 1: forge-migrate exit code 0');

  // ── Assertion 2: ≥1 fragment in each store dir ───────────────────────────────
  const ledgerFiles    = assertFragmentCount('ledger',    tempdir, 'ledger');
  const decisionsFiles = assertFragmentCount('decisions', tempdir, 'decisions');
  const memoryFiles    = assertFragmentCount('memory',    tempdir, 'memory');

  console.log(`OK assertion 2: fragments — ledger:${ledgerFiles.length} decisions:${decisionsFiles.length} memory:${memoryFiles.length}`);

  // ── Assertion 3: .bak files exist and are byte-identical to originals ────────
  const bakLedger    = path.join(gsdDir, 'LEDGER.md.bak');
  const bakDecisions = path.join(gsdDir, 'DECISIONS.md.bak');
  const bakMemory    = path.join(gsdDir, 'AUTO-MEMORY.md.bak');

  if (!fs.existsSync(bakLedger))    fail(`Assertion 3 failed: LEDGER.md.bak missing`,    tempdir);
  if (!fs.existsSync(bakDecisions)) fail(`Assertion 3 failed: DECISIONS.md.bak missing`, tempdir);
  if (!fs.existsSync(bakMemory))    fail(`Assertion 3 failed: AUTO-MEMORY.md.bak missing`, tempdir);

  const bakLedgerContent    = fs.readFileSync(bakLedger,    'utf8');
  const bakDecisionsContent = fs.readFileSync(bakDecisions, 'utf8');
  const bakMemoryContent    = fs.readFileSync(bakMemory,    'utf8');

  if (bakLedgerContent !== snapLedger) {
    fail(`Assertion 3 failed: LEDGER.md.bak content differs from original`, tempdir);
  }
  if (bakDecisionsContent !== snapDecisions) {
    fail(`Assertion 3 failed: DECISIONS.md.bak content differs from original`, tempdir);
  }
  if (bakMemoryContent !== snapMemory) {
    fail(`Assertion 3 failed: AUTO-MEMORY.md.bak content differs from original`, tempdir);
  }
  console.log('OK assertion 3: all .bak files exist and are byte-identical to originals');

  // ── Assertion 4: forge-projection --render ledger equals LEDGER.md.bak ───────
  const projResult = spawnSync(
    'node',
    [path.join(REPO_ROOT, 'scripts', 'forge-projection.js'), '--render', 'ledger', '--cwd', tempdir],
    { cwd: REPO_ROOT, encoding: 'utf8' }
  );

  if (projResult.status !== 0) {
    fail(`Assertion 4 failed: forge-projection exited with code ${projResult.status}\n${projResult.stderr}`, tempdir);
  }

  const projectedLedger = projResult.stdout;

  // The plan says "byte-equal" for ledger. Compare projection vs .bak.
  // Note: projection re-renders from fragments so it may add header/footer.
  // We compare projection vs .bak; if they differ, log the diff for debugging.
  if (projectedLedger !== bakLedgerContent) {
    console.log('--- projection output ---');
    process.stdout.write(projectedLedger);
    console.log('--- bak content ---');
    process.stdout.write(bakLedgerContent);
    fail(`Assertion 4 failed: projection output does not byte-equal LEDGER.md.bak`, tempdir);
  }
  console.log('OK assertion 4: forge-projection --render ledger byte-equals LEDGER.md.bak');

  // ── All assertions passed ─────────────────────────────────────────────────────
  console.log('\nOK: B1 smoke passed (4/4 assertions)');

  // Cleanup
  fs.rmSync(tempdir, { recursive: true, force: true });
  process.exit(0);
})();
