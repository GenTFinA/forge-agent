#!/usr/bin/env node
// forge-s1-skills.smoke.js — S1 grep gate + fragment-store sanity for rewired skills.
//
// Validates SCOPE.md criterion S1: the three rewired SKILL.md files (forge-discuss,
// forge-new-milestone, forge-task) contain NO direct Edit|Write calls to
// DECISIONS.md, LEDGER.md, or AUTO-MEMORY.md.
//
// Known-good exception: forge-task/SKILL.md line 252 contains DECISIONS.md inside
// a worker dispatch template (prose description, not an actual Edit/Write call).
// That line is filtered out as an accepted residual.
//
// Also validates sanity: each rewired SKILL.md mentions `forge-decisions.js --write`
// or `forge-ledger.js --write` at least once (confirms rewire is present).
//
// Steps:
//   1. Grep gate — scan the three SKILL.md files for Edit|Write + DECISIONS|LEDGER|AUTO-MEMORY.
//      Filter the known-good residual. Assert 0 hits remain.
//   2. Live fragment-write smoke — pipe a decisions payload to forge-decisions.js --write
//      in a tmpdir, then ls the .gsd/decisions/ dir to confirm file created.
//   3. Round-trip read — node scripts/forge-decisions.js --read <id> --cwd <tmpdir>.
//   4. Sanity check — verify each SKILL.md mentions the expected CLI call.
//   5. Exit 0 (all pass) or 1 (one or more failures).
//
// Exit 0 on success. Exit 1 on failure (tmpdir preserved for inspection).

'use strict';

const fs            = require('fs');
const path          = require('path');
const os            = require('os');
const { spawnSync } = require('child_process');

// ── Repo root (scripts/smoke/ → scripts/ → repo root) ───────────────────────
const REPO_ROOT = path.resolve(__dirname, '..', '..');

// ── Helpers ───────────────────────────────────────────────────────────────────

let failures = 0;

function pass(msg) { console.log(`  PASS  ${msg}`); }
function fail(msg) { console.error(`  FAIL  ${msg}`); failures++; }

function runNode(args, opts = {}) {
  return spawnSync(process.execPath, args, {
    cwd: REPO_ROOT,
    encoding: 'utf8',
    input: opts.input,
    timeout: 15000,
  });
}

// ── SKILL paths ───────────────────────────────────────────────────────────────

const SKILLS = [
  'skills/forge-discuss/SKILL.md',
  'skills/forge-new-milestone/SKILL.md',
  'skills/forge-task/SKILL.md',
];

// Known-good residual: forge-task/SKILL.md line 252 — DECISIONS.md appears inside
// a prose description of the worker dispatch template, not an actual Edit/Write call.
// This line is stable and expected; filter it before asserting 0 hits.
const KNOWN_RESIDUAL = {
  file: 'skills/forge-task/SKILL.md',
  // Unique substring that identifies this specific line:
  marker: 'Append significant decisions to .gsd/DECISIONS.md using **Edit only**',
};

// ── Gate 1: S1 grep gate ──────────────────────────────────────────────────────

console.log('\n## Gate 1 — S1 Grep Gate\n');
console.log('Pattern: lines matching /Edit|Write/ AND /DECISIONS\\.md|LEDGER\\.md|AUTO-MEMORY\\.md/i');
console.log('Files scanned:');
SKILLS.forEach(s => console.log('  ' + s));
console.log();

const EDIT_WRITE_RE   = /Edit|Write/;
const SENSITIVE_RE    = /DECISIONS\.md|LEDGER\.md|AUTO-MEMORY\.md/i;

let grepHits = [];

for (const skillRelPath of SKILLS) {
  const fullPath = path.join(REPO_ROOT, skillRelPath);
  let content;
  try {
    content = fs.readFileSync(fullPath, 'utf8');
  } catch (e) {
    fail(`Cannot read ${skillRelPath}: ${e.message}`);
    continue;
  }
  const lines = content.split('\n');
  lines.forEach((line, idx) => {
    if (EDIT_WRITE_RE.test(line) && SENSITIVE_RE.test(line)) {
      grepHits.push({ file: skillRelPath, lineNum: idx + 1, line: line.trim() });
    }
  });
}

// Filter known-good residual
const filteredHits = grepHits.filter(h => {
  return !(h.file === KNOWN_RESIDUAL.file && h.line.includes(KNOWN_RESIDUAL.marker));
});

if (grepHits.length > 0) {
  console.log(`Raw hits before filter: ${grepHits.length}`);
  grepHits.forEach(h => console.log(`  [${h.file}:${h.lineNum}] ${h.line.slice(0, 120)}`));
  if (filteredHits.length === 0) {
    console.log(`Known-good residual filtered: ${grepHits.length - filteredHits.length} line(s) accepted.`);
  }
} else {
  console.log('Raw hits: 0');
}

if (filteredHits.length === 0) {
  pass(`S1 grep gate — 0 unexpected hits (${grepHits.length} raw, ${grepHits.length - filteredHits.length} filtered as known-good)`);
} else {
  fail(`S1 grep gate — ${filteredHits.length} unexpected hit(s) remain after filtering:`);
  filteredHits.forEach(h => console.error(`    [${h.file}:${h.lineNum}] ${h.line.slice(0, 120)}`));
}

// ── Gate 2: Sanity — each SKILL.md mentions the expected CLI call ─────────────

console.log('\n## Gate 2 — Sanity: CLI call present in each SKILL.md\n');

const DECISIONS_CLI_RE = /forge-decisions\.js.*--write/;
const LEDGER_CLI_RE    = /forge-ledger\.js.*--write/;

for (const skillRelPath of SKILLS) {
  const fullPath = path.join(REPO_ROOT, skillRelPath);
  let content;
  try {
    content = fs.readFileSync(fullPath, 'utf8');
  } catch (e) {
    // already failed above
    continue;
  }
  const hasDecisions = DECISIONS_CLI_RE.test(content);
  const hasLedger    = LEDGER_CLI_RE.test(content);
  if (hasDecisions || hasLedger) {
    const which = hasDecisions ? 'forge-decisions.js --write' : 'forge-ledger.js --write';
    pass(`${skillRelPath} mentions \`${which}\``);
  } else {
    fail(`${skillRelPath} does NOT mention forge-decisions.js --write OR forge-ledger.js --write`);
  }
}

// ── Gate 3: Live fragment-write smoke ─────────────────────────────────────────

console.log('\n## Gate 3 — Live Fragment Write (forge-decisions.js)\n');

const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'forge-s04-smoke-'));
const unitId = 'M-20260527000000-smoke';

console.log(`Tmpdir: ${tmpDir}`);
console.log(`Unit ID: ${unitId}`);

const payload = JSON.stringify({
  unit_id: unitId,
  decisions: [
    {
      when: '2026-05-27',
      scope: 'milestone',
      decision: 'smoke',
      choice: 'works',
      rationale: 'S04 S1 smoke run',
      revisable: 'yes',
    },
  ],
});

const writeResult = runNode(
  [path.join(REPO_ROOT, 'scripts', 'forge-decisions.js'), '--write', '--cwd', tmpDir],
  { input: payload }
);

console.log(`Command: node scripts/forge-decisions.js --write --cwd <tmpdir>`);
console.log(`stdin:   ${payload}`);
console.log(`stdout:  ${writeResult.stdout.trim()}`);
if (writeResult.stderr) console.log(`stderr:  ${writeResult.stderr.trim()}`);
console.log(`exit:    ${writeResult.status}`);

let writeJson;
try {
  writeJson = JSON.parse(writeResult.stdout.trim());
} catch (e) {
  writeJson = null;
}

if (writeResult.status === 0 && writeJson && writeJson.created === true) {
  pass(`forge-decisions.js --write → created: true`);
} else {
  fail(`forge-decisions.js --write failed or returned unexpected output`);
}

// Verify file on disk
const decisionsDir = path.join(tmpDir, '.gsd', 'decisions');
let listedFiles = [];
try {
  listedFiles = fs.readdirSync(decisionsDir);
} catch (e) {
  fail(`Cannot read ${decisionsDir}: ${e.message}`);
}

console.log(`\nls ${decisionsDir}:\n  ${listedFiles.join('\n  ') || '(empty)'}`);

if (listedFiles.includes(`${unitId}.md`)) {
  pass(`Fragment file ${unitId}.md present in .gsd/decisions/`);
} else {
  fail(`Fragment file ${unitId}.md NOT found in .gsd/decisions/; got: ${listedFiles.join(', ')}`);
}

// Round-trip read
const readResult = runNode(
  [path.join(REPO_ROOT, 'scripts', 'forge-decisions.js'), '--read', unitId, '--cwd', tmpDir]
);

console.log(`\nCommand: node scripts/forge-decisions.js --read ${unitId} --cwd <tmpdir>`);
console.log(`stdout:  ${readResult.stdout.trim()}`);
if (readResult.stderr) console.log(`stderr:  ${readResult.stderr.trim()}`);
console.log(`exit:    ${readResult.status}`);

let readJson;
try {
  readJson = JSON.parse(readResult.stdout.trim());
} catch (e) {
  readJson = null;
}

if (readResult.status === 0 && readJson && readJson.unit_id === unitId) {
  pass(`Round-trip --read confirmed unit_id: ${unitId}`);
} else {
  fail(`Round-trip --read failed or unit_id mismatch`);
}

// ── Summary ───────────────────────────────────────────────────────────────────

console.log('\n## Result\n');

if (failures === 0) {
  console.log('PASS — all S1 gates satisfied.');
  console.log('  - S1 grep gate: 0 unexpected Edit|Write hits on DECISIONS.md/LEDGER.md/AUTO-MEMORY.md');
  console.log('  - Sanity: each rewired SKILL.md carries the expected fragment-store CLI call');
  console.log('  - Live fragment write + round-trip read: OK');
  process.exit(0);
} else {
  console.error(`FAIL — ${failures} gate(s) failed. See output above.`);
  process.exit(1);
}
