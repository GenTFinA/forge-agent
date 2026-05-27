#!/usr/bin/env node
// forge-b2-runtime.smoke.js — B2+S2 runtime smoke for fragment visibility + merger purge.
//
// Validates SCOPE.md criterion B2: a memory written via the fragment API is visible
// in the next selective injection WITHOUT any human running --write-all.
// Also validates S2: mergeMilestone does NOT touch AUTO-MEMORY.md.
//
// Steps:
//   1. Build minimal .gsd/ in os.tmpdir()
//   2. Write a marker fragment via `node scripts/forge-memory.js --write` (stdin JSON)
//   3. Verify --list returns the fragment
//   4. Verify --read <unit-id> returns the marker fact
//   5. Run mergeMilestone and confirm result.merged.memories === 0 and AUTO-MEMORY.md untouched
//   6. Run three slice grep gates
//   7. Exit 0 (all pass) or 1 (failure with details)
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

function pass(msg) { console.log(`  PASS  ${msg}`); }
function fail(msg) { console.error(`  FAIL  ${msg}`); }

function runNode(args, opts) {
  return spawnSync(process.execPath, args, {
    cwd: REPO_ROOT,
    encoding: 'utf8',
    input: opts && opts.input,
    timeout: 15000,
  });
}

// ── Marker ID — must be a valid milestone timestamp ID ────────────────────────
// Format: M-<YYYYMMDDHHMMSS>-<slug>  (14-digit UTC timestamp)
function makeMarkerId() {
  const now = new Date();
  const ts = [
    now.getUTCFullYear(),
    String(now.getUTCMonth() + 1).padStart(2, '0'),
    String(now.getUTCDate()).padStart(2, '0'),
    String(now.getUTCHours()).padStart(2, '0'),
    String(now.getUTCMinutes()).padStart(2, '0'),
    String(now.getUTCSeconds()).padStart(2, '0'),
  ].join('');
  return `M-${ts}-s02smoke`;
}

// ── Main ──────────────────────────────────────────────────────────────────────

async function main() {
  let failures = 0;
  const tmpBase = fs.mkdtempSync(path.join(os.tmpdir(), 'forge-b2-smoke-'));
  console.log(`\nSmoke workspace: ${tmpBase}\n`);

  // ── Step 1: minimal .gsd/ structure ─────────────────────────────────────────
  fs.mkdirSync(path.join(tmpBase, '.gsd', 'memory'), { recursive: true });
  console.log('[1] Workspace prepared.');

  // ── Step 2: write marker fragment ────────────────────────────────────────────
  const MARKER_ID   = makeMarkerId();
  const MARKER_FACT = `S02 smoke marker — fragment visibility test (${MARKER_ID})`;

  // Facts must be objects with mem_id to survive writeFragment's mergeFacts dedup.
  // Plain strings are silently dropped by the fragment store API.
  const fragmentJson = JSON.stringify({
    unit_id:    MARKER_ID,
    category:   'convention',
    facts:      [{
      mem_id:     `${MARKER_ID}-f1`,
      category:   'convention',
      text:       MARKER_FACT,
      created_at: new Date().toISOString(),
      source_unit: MARKER_ID,
    }],
    confidence: 0.9,
    hits:       1,
  });

  console.log(`[2] Writing marker fragment: ${MARKER_ID}`);
  const writeResult = runNode(
    ['scripts/forge-memory.js', '--write', '--cwd', tmpBase],
    { input: fragmentJson }
  );
  if (writeResult.status !== 0) {
    fail(`--write exited ${writeResult.status}: ${writeResult.stderr.trim()}`);
    failures++;
  } else {
    pass(`--write OK → ${writeResult.stdout.trim()}`);
  }

  // ── Step 3: --list ────────────────────────────────────────────────────────────
  console.log('\n[3] --list');
  const listResult = runNode(['scripts/forge-memory.js', '--list', '--cwd', tmpBase]);
  if (listResult.status !== 0) {
    fail(`--list exited ${listResult.status}: ${listResult.stderr.trim()}`);
    failures++;
  } else {
    let listParsed;
    try { listParsed = JSON.parse(listResult.stdout); } catch (e) {
      fail(`--list output is not JSON: ${listResult.stdout.trim()}`);
      failures++;
      listParsed = [];
    }
    const found = Array.isArray(listParsed) && listParsed.some(e => e.unitId === MARKER_ID);
    if (!found) {
      fail(`--list did not return fragment ${MARKER_ID}. Got: ${JSON.stringify(listParsed)}`);
      failures++;
    } else {
      pass(`--list returned fragment ${MARKER_ID}`);
    }
    console.log('     stdout:', listResult.stdout.trim());
  }

  // ── Step 4: --read ────────────────────────────────────────────────────────────
  console.log('\n[4] --read');
  const readResult = runNode(['scripts/forge-memory.js', '--read', MARKER_ID, '--cwd', tmpBase]);
  if (readResult.status !== 0) {
    fail(`--read exited ${readResult.status}: ${readResult.stderr.trim()}`);
    failures++;
  } else {
    let readParsed;
    try { readParsed = JSON.parse(readResult.stdout); } catch (e) {
      fail(`--read output is not JSON: ${readResult.stdout.trim()}`);
      failures++;
      readParsed = null;
    }
    if (readParsed === null) {
      fail(`--read returned null for ${MARKER_ID}`);
      failures++;
    } else {
      const factTexts = (readParsed.facts || []).map(f => (typeof f === 'string' ? f : f.text || ''));
      const hasMarker = factTexts.some(t => t.includes('S02 smoke marker'));
      if (!hasMarker) {
        fail(`--read did not contain marker fact. facts: ${JSON.stringify(factTexts)}`);
        failures++;
      } else {
        pass(`--read returned marker fact: "${factTexts.find(t => t.includes('S02 smoke marker'))}"`);
      }
    }
    console.log('     stdout:', readResult.stdout.trim());
  }

  // ── Step 5: mergeMilestone — AUTO-MEMORY.md must be untouched ────────────────
  console.log('\n[5] mergeMilestone — AUTO-MEMORY.md untouched proof');
  const autoMemPath = path.join(tmpBase, '.gsd', 'AUTO-MEMORY.md');
  const autoMemExisted = fs.existsSync(autoMemPath);
  const mtimeBefore = autoMemExisted ? fs.statSync(autoMemPath).mtimeMs : null;

  const mergerCode = `
const m = require('./scripts/forge-merger.js');
m.mergeMilestone(process.cwd(), ${JSON.stringify(MARKER_ID)}, { cwd: ${JSON.stringify(tmpBase)} })
  .then(r => { console.log(JSON.stringify(r, null, 2)); process.exit(0); })
  .catch(e => { process.stderr.write(e.message + '\\n'); process.exit(1); });
`;
  const mergeResult = runNode(['-e', mergerCode]);
  if (mergeResult.status !== 0) {
    fail(`mergeMilestone error: ${mergeResult.stderr.trim()}`);
    failures++;
  } else {
    let mergeOut;
    try { mergeOut = JSON.parse(mergeResult.stdout); } catch (e) {
      fail(`mergeMilestone output not JSON: ${mergeResult.stdout.trim()}`);
      failures++;
      mergeOut = null;
    }
    if (mergeOut) {
      const memoriesCount = mergeOut.merged && mergeOut.merged.memories;
      if (memoriesCount !== 0 && memoriesCount !== undefined) {
        fail(`result.merged.memories should be 0 but got: ${memoriesCount}`);
        failures++;
      } else {
        pass(`result.merged.memories === ${memoriesCount === undefined ? '(absent/0)' : memoriesCount}`);
      }
      console.log('     merger result:', JSON.stringify(mergeOut));
    }

    const autoMemExistsAfter = fs.existsSync(autoMemPath);
    const mtimeAfter = autoMemExistsAfter ? fs.statSync(autoMemPath).mtimeMs : null;

    if (!autoMemExisted && !autoMemExistsAfter) {
      pass('AUTO-MEMORY.md did not exist before or after — merger did not create it');
    } else if (autoMemExisted && mtimeBefore === mtimeAfter) {
      pass(`AUTO-MEMORY.md mtime unchanged: ${mtimeBefore}`);
    } else if (!autoMemExisted && autoMemExistsAfter) {
      fail('AUTO-MEMORY.md was CREATED by merger — should not happen (T03 purge failed)');
      failures++;
    } else {
      fail(`AUTO-MEMORY.md mtime changed: before=${mtimeBefore} after=${mtimeAfter}`);
      failures++;
    }
  }

  // ── Step 6: three slice grep gates ───────────────────────────────────────────
  console.log('\n[6] Slice grep gates');

  // Gate A: forge-auto/SKILL.md — use Node fs to avoid cross-platform grep flag differences
  const autoSkillText = fs.readFileSync(path.join(REPO_ROOT, 'skills', 'forge-auto', 'SKILL.md'), 'utf8');
  const gateARe = /forge-projection|--write-all|forge-memory.*--list/gi;
  const countA = (autoSkillText.match(gateARe) || []).length;
  if (countA >= 1) {
    pass(`forge-auto/SKILL.md grep gate: ${countA} match(es) (forge-projection|--write-all|forge-memory.*--list)`);
  } else {
    fail('forge-auto/SKILL.md grep gate: 0 matches — expected ≥1 for forge-projection|--write-all|forge-memory.*--list');
    failures++;
  }

  // Gate B: forge-next/SKILL.md
  const nextSkillText = fs.readFileSync(path.join(REPO_ROOT, 'skills', 'forge-next', 'SKILL.md'), 'utf8');
  const gateBRe = /forge-projection|--write-all|forge-memory.*--list/gi;
  const countB = (nextSkillText.match(gateBRe) || []).length;
  if (countB >= 1) {
    pass(`forge-next/SKILL.md grep gate: ${countB} match(es) (forge-projection|--write-all|forge-memory.*--list)`);
  } else {
    fail('forge-next/SKILL.md grep gate: 0 matches — expected ≥1 for forge-projection|--write-all|forge-memory.*--list');
    failures++;
  }

  // Gate C: forge-merger.js tasks array does NOT contain auto-memory
  const mergerText = fs.readFileSync(path.join(REPO_ROOT, 'scripts', 'forge-merger.js'), 'utf8');
  const tasksMatch = mergerText.match(/const tasks\s*=\s*\[([\s\S]*?)^  \];/m);
  let mergerGatePassed = false;
  if (tasksMatch) {
    const tasksBody = tasksMatch[1];
    mergerGatePassed = !/auto-memory|AUTO-MEMORY/i.test(tasksBody) ||
      // allow if only in comment lines
      tasksBody.split('\n').every(line => {
        if (/auto-memory|AUTO-MEMORY/i.test(line)) return /^\s*\/\//.test(line);
        return true;
      });
  } else {
    // fallback: check that any AUTO-MEMORY reference in mergeMilestone function is comment-only
    const fnMatch = mergerText.match(/async function mergeMilestone[\s\S]*?\n\}/);
    if (fnMatch) {
      mergerGatePassed = fnMatch[0].split('\n').every(line => {
        if (/AUTO-MEMORY|auto-memory/i.test(line)) return /^\s*\/\//.test(line);
        return true;
      });
    }
  }
  if (mergerGatePassed) {
    pass('forge-merger.js: auto-memory absent from mergeMilestone tasks array (only in comments)');
  } else {
    fail('forge-merger.js: auto-memory found in mergeMilestone tasks array — T03 purge incomplete');
    failures++;
  }

  // ── Cleanup marker fragment ───────────────────────────────────────────────────
  const markerFile = path.join(tmpBase, '.gsd', 'memory', `${MARKER_ID}.md`);
  if (fs.existsSync(markerFile)) fs.unlinkSync(markerFile);

  // ── Summary ───────────────────────────────────────────────────────────────────
  console.log('\n' + '─'.repeat(60));
  if (failures === 0) {
    console.log('VERDICT: PASS — all B2+S2 gates passed');
    // Clean up tmpdir on success
    fs.rmSync(tmpBase, { recursive: true, force: true });
    process.exit(0);
  } else {
    console.error(`VERDICT: FAIL — ${failures} gate(s) failed. Workspace preserved: ${tmpBase}`);
    process.exit(1);
  }
}

main().catch(e => {
  console.error('Smoke script threw:', e.message);
  process.exit(1);
});
