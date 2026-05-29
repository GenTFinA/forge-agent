#!/usr/bin/env node
'use strict';

// Smoke test for SCOPE B3: checker fragment store + projection + grep gates.
// Usage: node tests/forge-b3-checker.smoke.js
// Exits 0 on all pass, 1 on any failure.

const fs = require('fs');
const os = require('os');
const path = require('path');
const { execSync } = require('child_process');

const REPO_ROOT = path.resolve(__dirname, '..');

// ── helpers ───────────────────────────────────────────────────────────────────

const results = [];

function assert(name, pass, detail) {
  const label = pass ? 'PASS' : 'FAIL';
  console.log(`  [${label}] ${name}${detail ? ' — ' + detail : ''}`);
  results.push({ name, pass });
}

function runGrepCount(args, opts) {
  try {
    const out = execSync(`grep ${args}`, Object.assign({ encoding: 'utf8' }, opts));
    return parseInt(out.trim(), 10) || 0;
  } catch (e) {
    // grep exits 1 when no matches found; stdout still has the count for -c
    if (e.stdout !== undefined) {
      const n = parseInt((e.stdout || '').trim(), 10);
      return isNaN(n) ? 0 : n;
    }
    return 0;
  }
}

// ── main ──────────────────────────────────────────────────────────────────────

const milestoneId = 'M-20260527000000-smoke';
const fragment = {
  milestoneId,
  events: [
    {
      kind: 'verify',
      dimension: 'completeness',
      severity: 'warn',
      slice: 'S03',
      ts: '2026-05-27T10:00:00Z',
    },
  ],
};

const tempdir = fs.mkdtempSync(path.join(os.tmpdir(), 'forge-b3-smoke-'));
fs.mkdirSync(path.join(tempdir, '.gsd', 'checker-memory'), { recursive: true });

console.log('forge-b3-checker smoke');
console.log('');
console.log('Part 1: write checker fragment via forge-checker-memory.js --write');

try {
  // Step 1: write fragment
  const writeCmd = `node ${path.join(REPO_ROOT, 'scripts', 'forge-checker-memory.js')} --write --cwd ${tempdir}`;
  try {
    execSync(writeCmd, {
      input: JSON.stringify(fragment),
      stdio: ['pipe', 'pipe', 'inherit'],
    });
    assert('forge-checker-memory --write exits 0', true);
  } catch (e) {
    assert('forge-checker-memory --write exits 0', false, String(e.message).slice(0, 120));
  }

  // Verify file was created
  const fragFile = path.join(tempdir, '.gsd', 'checker-memory', `${milestoneId}.md`);
  assert('fragment file created', fs.existsSync(fragFile));

  console.log('');
  console.log('Part 2: render projection via forge-projection.js --render checker');

  // Step 2: render projection
  let projOut = '';
  try {
    const renderCmd = `node ${path.join(REPO_ROOT, 'scripts', 'forge-projection.js')} --render checker --cwd ${tempdir}`;
    projOut = execSync(renderCmd, { encoding: 'utf8' });
    assert('forge-projection --render checker exits 0', true);
  } catch (e) {
    assert('forge-projection --render checker exits 0', false, String(e.message).slice(0, 120));
    projOut = '';
  }

  assert('projection output non-empty', projOut.length > 0);
  assert('projection contains ## Verification Patterns', projOut.includes('## Verification Patterns'));
  assert('projection contains "completeness"', projOut.includes('completeness'));

  console.log('');
  console.log('Part 3: B3 grep gates against real repo');

  // Gate 1: grep -ci checker scripts/forge-projection.js ≥ 3
  const count1 = runGrepCount('-ci checker scripts/forge-projection.js', { cwd: REPO_ROOT, encoding: 'utf8' });
  assert(
    'grep -ci checker scripts/forge-projection.js ≥ 3',
    count1 >= 3,
    `got ${count1}`
  );

  // Gate 2: grep -c "CHECKER-MEMORY.md" shared/forge-dispatch.md == 0
  const count2 = runGrepCount('-c "CHECKER-MEMORY.md" shared/forge-dispatch.md', { cwd: REPO_ROOT, encoding: 'utf8' });
  assert(
    'grep -c "CHECKER-MEMORY.md" shared/forge-dispatch.md == 0',
    count2 === 0,
    `got ${count2}`
  );

  // Gate 3: forge-projection.js --render checker appears in shared/forge-dispatch.md ≥ 2 times.
  // Note: the dispatch file uses shell-quoted paths ("$FORGE_SCRIPTS_DIR/forge-projection.js" --render checker),
  // so we match the looser but equivalent substring "projection.js.*--render checker" via -E regex.
  const count3 = runGrepCount('-cE "projection\\.js.*--render checker" shared/forge-dispatch.md', { cwd: REPO_ROOT, encoding: 'utf8' });
  assert(
    'forge-projection.js --render checker in shared/forge-dispatch.md ≥ 2',
    count3 >= 2,
    `got ${count3}`
  );

} finally {
  fs.rmSync(tempdir, { recursive: true, force: true });
}

// ── summary ───────────────────────────────────────────────────────────────────

console.log('');
const passed = results.filter(r => r.pass).length;
const total = results.length;
const allPass = results.every(r => r.pass);
console.log(`Result: ${passed}/${total} assertions passed`);
if (!allPass) {
  const failed = results.filter(r => !r.pass).map(r => r.name);
  console.log(`Failed: ${failed.join(', ')}`);
}
process.exit(allPass ? 0 : 1);
