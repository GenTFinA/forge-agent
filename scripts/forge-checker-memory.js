#!/usr/bin/env node
// forge-checker-memory — Per-milestone CHECKER-MEMORY fragment store for Forge Agent
//
// Library exports:
//   CHECKER_MEMORY_DIR                     → string  // relative path '.gsd/checker-memory'
//   checkerMemoryDir(cwd)                  → string  // absolute path to checker-memory dir
//   fragmentPath(cwd, milestoneId)         → string  // absolute path to <milestone-id>.md
//   parseFragment(text)                    → object  // parse markdown with YAML frontmatter
//   writeFragment(cwd, fragment)           → { path, created }
//   readFragment(cwd, milestoneId)         → object | null
//   listFragments(cwd)                     → Array<{ milestoneId, path }>
//
// CLI:
//   node forge-checker-memory.js --list [--cwd <dir>]
//   node forge-checker-memory.js --read <milestone-id> [--cwd <dir>]
//   node forge-checker-memory.js --write [--cwd <dir>]   (reads JSON fragment from stdin)
//   node forge-checker-memory.js --validate <milestone-id> [--cwd <dir>]
//   node forge-checker-memory.js --help
//
// Exit codes:
//   0 — success
//   1 — runtime error (invalid id, parse error, etc.)
//   2 — unknown/missing arguments
//
// Design constraints (R4, R5):
//   R4: Partitioned by milestone-id ONLY. Task IDs and ask-session IDs are rejected.
//   R5: Events dedup on SHA1 of (kind, dimension, slice, ts) tuple.
//   Count/Last Seen are derived on projection — NOT persisted.

'use strict';

const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const { isValid, entityKind } = require('./forge-ids');

// ── Constants ─────────────────────────────────────────────────────────────────

const CHECKER_MEMORY_DIR = '.gsd/checker-memory';

// ── checkerMemoryDir ──────────────────────────────────────────────────────────
// Returns the absolute path to the checker-memory directory for a given cwd.
function checkerMemoryDir(cwd) {
  return path.join(cwd || process.cwd(), '.gsd', 'checker-memory');
}

// ── validateMilestoneId ───────────────────────────────────────────────────────
// Returns true if id is a valid milestone ID.
// CHECKER is milestone-partitioned only (R4) — task IDs and ask-session IDs
// are explicitly rejected with a descriptive error.
function validateMilestoneId(id) {
  if (!id) return false;
  if (!isValid(id)) return false;
  return entityKind(id) === 'milestone';
}

// ── fragmentPath ──────────────────────────────────────────────────────────────
// Returns absolute path to the fragment file for a milestone ID.
// Throws if the ID is not a valid milestone ID.
function fragmentPath(cwd, milestoneId) {
  if (!validateMilestoneId(milestoneId)) {
    const kind = isValid(milestoneId) ? entityKind(milestoneId) : 'unknown';
    if (kind === 'task') {
      throw new Error(
        `Invalid CHECKER-MEMORY key: "${milestoneId}" is a task ID. ` +
        'CHECKER-MEMORY is partitioned by milestone-id only (R4). ' +
        'Pass a milestone ID (M###, M-<ts>-<slug>).'
      );
    }
    if (milestoneId && /^ask-/i.test(milestoneId)) {
      throw new Error(
        `Invalid CHECKER-MEMORY key: "${milestoneId}" is an ask-session ID. ` +
        'CHECKER-MEMORY is partitioned by milestone-id only (R4). ' +
        'Pass a milestone ID (M###, M-<ts>-<slug>).'
      );
    }
    throw new Error(
      `Invalid CHECKER-MEMORY milestone ID: "${milestoneId}". ` +
      'Expected a milestone ID (M###, M-<ts>-<slug>).'
    );
  }
  return path.join(checkerMemoryDir(cwd), `${milestoneId}.md`);
}

// ── parseFragment ─────────────────────────────────────────────────────────────
// Parses a CHECKER-MEMORY fragment markdown file (YAML frontmatter + body).
// The `events:` key holds a block array of objects, each with keys:
//   { kind, dimension, severity, slice, ts, ...extras }
//   where kind ∈ {plan, verify}
// Count and last_seen are derived on projection — NOT stored in the fragment.
// Unknown frontmatter keys are passed through as-is.
function parseFragment(text) {
  const match = text.match(/^---\n([\s\S]*?)\n---\n?([\s\S]*)$/);
  if (!match) {
    return {
      milestone_id: null,
      events: [],
      body: text.trim(),
    };
  }

  const frontmatter = match[1];
  const body = match[2].trim();
  const result = {};

  const lines = frontmatter.split('\n');
  let currentKey = null;
  let currentArray = null;
  let inEventObject = false;
  let currentEvent = null;

  for (let i = 0; i < lines.length; i++) {
    const line = lines[i];

    // Detect start of an event object item: "  - kind: ..." or "- kind: ..."
    const eventItemStart = line.match(/^(\s*)-\s+([a-zA-Z_][a-zA-Z0-9_]*)\s*:\s*(.*)$/);
    if (eventItemStart && currentKey === 'events' && Array.isArray(result['events'])) {
      if (currentEvent !== null) {
        result['events'].push(currentEvent);
      }
      currentEvent = {};
      const key = eventItemStart[2];
      currentEvent[key] = eventItemStart[3].trim();
      inEventObject = true;
      currentArray = null;
      continue;
    }

    // Continuation of an event object: "    key: value"
    if (inEventObject && currentEvent !== null) {
      const objKv = line.match(/^\s{2,}([a-zA-Z_][a-zA-Z0-9_]*)\s*:\s*(.*)$/);
      if (objKv) {
        currentEvent[objKv[1]] = objKv[2].trim();
        continue;
      }
      // Unindented or non-kv line ends the event object
      if (currentEvent !== null) {
        result['events'].push(currentEvent);
        currentEvent = null;
        inEventObject = false;
      }
    }

    // Plain block array item: "  - value" or "- value" (non-events arrays)
    const arrayItem = line.match(/^\s*-\s+(.*)$/);
    if (arrayItem && currentArray !== null && currentKey !== 'events') {
      currentArray.push(arrayItem[1].trim());
      continue;
    }

    // Key-value pair
    const kv = line.match(/^([a-zA-Z_][a-zA-Z0-9_]*)\s*:\s*(.*)$/);
    if (kv) {
      const key = kv[1];
      const rawVal = kv[2].trim();

      if (key === 'events') {
        result['events'] = [];
        currentKey = 'events';
        currentArray = null;
        currentEvent = null;
        inEventObject = false;
        continue;
      }

      // Inline array: [a, b, c] or []
      if (rawVal.startsWith('[')) {
        const inner = rawVal.replace(/^\[|\]$/g, '').trim();
        result[key] = inner === '' ? [] : inner.split(',').map(s => s.trim()).filter(Boolean);
        currentKey = key;
        currentArray = null;
        inEventObject = false;
      } else if (rawVal === '') {
        // Block array starts next
        result[key] = [];
        currentKey = key;
        currentArray = result[key];
        inEventObject = false;
      } else {
        result[key] = rawVal;
        currentKey = key;
        currentArray = null;
        inEventObject = false;
      }
      continue;
    }

    // Unrecognized line — flush pending event object and reset context
    if (currentEvent !== null) {
      result['events'].push(currentEvent);
      currentEvent = null;
    }
    inEventObject = false;
    currentArray = null;
  }

  // Flush trailing event object
  if (currentEvent !== null) {
    result['events'].push(currentEvent);
  }

  // Ensure events is always an array
  if (!Array.isArray(result['events'])) {
    result['events'] = [];
  }

  result.milestone_id = result.milestone_id || null;
  result.body = body;

  return result;
}

// ── eventHash ─────────────────────────────────────────────────────────────────
// Stable SHA1 hash for an event's dedup tuple: (kind, dimension, slice, ts).
// R5: Events are deduped on this tuple — NOT on the full object.
function eventHash(e) {
  const raw = [
    e.kind || '',
    e.dimension || '',
    e.slice || '',
    e.ts || '',
  ].join('\x00');
  return crypto.createHash('sha1').update(raw).digest('hex');
}

// ── EVENT_KEYS ────────────────────────────────────────────────────────────────
// Canonical key order for event serialization (R5, Step 5 in plan).
// Alpha-sorted extras follow after the canonical prefix.
const EVENT_KEYS = ['kind', 'dimension', 'severity', 'slice', 'ts'];

// ── mergeEvents ───────────────────────────────────────────────────────────────
// Merges two arrays of event objects.
// New entries are added; entries whose (kind, dimension, slice, ts) tuple
// already exists are skipped (R5 dedup).
// Result is sorted by ts ASC, then by SHA1 of tuple for stability.
function mergeEvents(existing, incoming) {
  const seen = new Set(existing.map(eventHash));
  const merged = [...existing];

  for (const e of incoming) {
    const h = eventHash(e);
    if (!seen.has(h)) {
      seen.add(h);
      merged.push(e);
    }
  }

  // Sort: ts ASC, then by SHA1(tuple) for determinism
  merged.sort((a, b) => {
    const ta = String(a.ts || '');
    const tb = String(b.ts || '');
    if (ta < tb) return -1;
    if (ta > tb) return 1;
    return eventHash(a).localeCompare(eventHash(b));
  });

  return merged;
}

// ── serializeFrontmatter ──────────────────────────────────────────────────────
// Serializes a fragment object to YAML frontmatter string.
// Keys are emitted in alphabetical order for diff stability.
// `events` array uses block-of-objects form.
// Simple arrays use block form. Scalars use plain form.
function serializeFrontmatter(fragment) {
  const skip = new Set(['body']);
  const keys = Object.keys(fragment).filter(k => !skip.has(k)).sort();

  const lines = [];
  for (const key of keys) {
    const val = fragment[key];

    if (key === 'events') {
      // Block array of objects
      if (!Array.isArray(val) || val.length === 0) {
        lines.push('events: []');
      } else {
        lines.push('events:');
        for (const e of val) {
          // Canonical keys first (EVENT_KEYS), then extras alpha-sorted
          const allKeys = [
            ...EVENT_KEYS.filter(k => k in e),
            ...Object.keys(e).filter(k => !EVENT_KEYS.includes(k)).sort(),
          ];
          let first = true;
          for (const ek of allKeys) {
            const prefix = first ? '  - ' : '    ';
            lines.push(`${prefix}${ek}: ${e[ek] !== undefined && e[ek] !== null ? e[ek] : ''}`);
            first = false;
          }
        }
      }
      continue;
    }

    if (Array.isArray(val)) {
      if (val.length === 0) {
        lines.push(`${key}: []`);
      } else {
        lines.push(`${key}:`);
        for (const item of val) {
          lines.push(`  - ${item}`);
        }
      }
    } else if (val === null || val === undefined) {
      lines.push(`${key}: `);
    } else {
      lines.push(`${key}: ${val}`);
    }
  }
  return lines.join('\n');
}

// ── writeFragment ─────────────────────────────────────────────────────────────
// Writes a CHECKER-MEMORY fragment to disk.
// fragment shape: { milestoneId, events: [{kind, dimension, severity, slice, ts, ...}, ...] }
// Merges with existing fragment if present (dedup on SHA1 of (kind, dimension, slice, ts)).
// Byte-compares before writing — no-op if content is identical (byte-idempotent, R5).
// Returns { path: string, created: boolean }
// created: false if content is identical after merge (idempotent).
function writeFragment(cwd, fragment) {
  if (!fragment || !fragment.milestoneId) {
    throw new Error('fragment.milestoneId is required');
  }

  const fpath = fragmentPath(cwd, fragment.milestoneId); // throws if invalid id
  const dir = path.dirname(fpath);

  // mkdir -p
  if (!fs.existsSync(dir)) {
    fs.mkdirSync(dir, { recursive: true });
  }

  // Normalize: store as milestone_id in frontmatter, milestoneId in JS object
  const incomingEvents = Array.isArray(fragment.events) ? fragment.events : [];

  // Merge with existing if present
  let base;
  if (fs.existsSync(fpath)) {
    const existing = parseFragment(fs.readFileSync(fpath, 'utf8'));
    const existingEvents = Array.isArray(existing.events) ? existing.events : [];
    const mergedEvents = mergeEvents(existingEvents, incomingEvents);
    // Merge: incoming scalar fields override existing; events merged
    base = {
      ...existing,
      milestone_id: fragment.milestoneId,
      events: mergedEvents,
    };
    // Preserve body if not provided in incoming
    if (fragment.body !== undefined) {
      base.body = fragment.body;
    }
  } else {
    // New fragment: sort events for stable ordering
    const events = mergeEvents([], incomingEvents);
    base = {
      milestone_id: fragment.milestoneId,
      events,
      body: fragment.body || '',
    };
  }

  // Serialize
  const frontmatter = serializeFrontmatter(base);
  const body = base.body ? `\n${base.body}` : '';
  const content = `---\n${frontmatter}\n---\n${body}`;

  // Idempotent byte-compare (R5)
  if (fs.existsSync(fpath)) {
    const existingContent = fs.readFileSync(fpath, 'utf8');
    if (existingContent === content) {
      return { path: fpath, created: false };
    }
  }

  fs.writeFileSync(fpath, content, 'utf8');
  return { path: fpath, created: true };
}

// ── readFragment ──────────────────────────────────────────────────────────────
// Reads and parses a CHECKER-MEMORY fragment. Returns null if the file does not exist.
function readFragment(cwd, milestoneId) {
  let fpath;
  try {
    fpath = fragmentPath(cwd, milestoneId);
  } catch (e) {
    throw e; // propagate invalid id error
  }

  if (!fs.existsSync(fpath)) return null;
  const text = fs.readFileSync(fpath, 'utf8');
  return parseFragment(text);
}

// ── listFragments ─────────────────────────────────────────────────────────────
// Lists all fragment files in the checker-memory directory.
// Returns Array<{ milestoneId, path }> sorted by milestoneId ascending.
// Returns [] if the directory does not exist.
function listFragments(cwd) {
  const dir = checkerMemoryDir(cwd);
  if (!fs.existsSync(dir)) return [];

  const files = fs.readdirSync(dir);
  const fragments = files
    .filter(f => f.endsWith('.md'))
    .map(f => ({
      milestoneId: f.slice(0, -3), // strip .md
      path: path.join(dir, f),
    }))
    .sort((a, b) => a.milestoneId.localeCompare(b.milestoneId));

  return fragments;
}

// ── projectStats ──────────────────────────────────────────────────────────────
// Derives count and last_seen for each (dimension, kind) pair from events.
// Count/Last Seen are NOT persisted — derived on projection (R4).
// Returns Array<{ dimension, kind, count, last_seen, severity }>
function projectStats(events) {
  const map = new Map();
  for (const e of events) {
    const key = `${e.kind || ''}:${e.dimension || ''}`;
    if (!map.has(key)) {
      map.set(key, {
        dimension: e.dimension || '',
        kind: e.kind || '',
        severity: e.severity || '',
        count: 0,
        last_seen: '',
      });
    }
    const entry = map.get(key);
    entry.count += 1;
    if ((e.ts || '') > entry.last_seen) {
      entry.last_seen = e.ts || '';
      // Keep severity from most recent event
      entry.severity = e.severity || entry.severity;
    }
  }
  return Array.from(map.values()).sort((a, b) => {
    if (a.dimension < b.dimension) return -1;
    if (a.dimension > b.dimension) return 1;
    return a.kind.localeCompare(b.kind);
  });
}

// ── Module exports ────────────────────────────────────────────────────────────
module.exports = {
  CHECKER_MEMORY_DIR,
  checkerMemoryDir,
  fragmentPath,
  parseFragment,
  writeFragment,
  readFragment,
  listFragments,
  projectStats,
};

// ── cliMain ───────────────────────────────────────────────────────────────────
function printUsage() {
  console.log(`Usage: node forge-checker-memory.js <command> [options]

Commands:
  --list [--cwd <dir>]                     List all checker-memory fragments (JSON array)
  --read <milestone-id> [--cwd <dir>]      Read and print a fragment (JSON), null if missing
  --write [--cwd <dir>]                    Write/merge fragment from stdin (JSON fragment)
  --validate <milestone-id> [--cwd <dir>]  Validate ID and check if fragment exists
  --help, -h                               Show this help

Milestone ID forms accepted:
  M###, M-<ts>-<slug>            Milestone IDs only

CHECKER-MEMORY is partitioned by milestone-id ONLY (R4).
Task IDs (TASK-###, T-<ts>-<slug>) and ask-session IDs are rejected.

Event schema:
  { kind: "plan"|"verify", dimension: string, severity: string, slice: string, ts: string }
  Dedup key: SHA1(kind + dimension + slice + ts)  — R5

Options:
  --cwd <dir>   Working directory (default: process.cwd())

Exit codes:
  0  Success
  1  Runtime error (invalid id, parse error, I/O failure)
  2  Unknown or missing arguments`);
}

function cliMain(argv) {
  // Parse --cwd
  let cwd = process.cwd();
  const cwdIdx = argv.indexOf('--cwd');
  if (cwdIdx !== -1) {
    cwd = argv[cwdIdx + 1];
    if (!cwd) {
      process.stderr.write('--cwd requires a directory argument\n');
      process.exit(2);
    }
    argv = argv.filter((_, i) => i !== cwdIdx && i !== cwdIdx + 1);
  }

  const cmd = argv[0];

  if (!cmd || cmd === '--help' || cmd === '-h') {
    printUsage();
    process.exit(0);
  }

  if (cmd === '--list') {
    const result = listFragments(cwd);
    // Return milestoneId (not unitId) for CHECKER convention
    console.log(JSON.stringify(result));
    process.exit(0);
  }

  if (cmd === '--read') {
    const id = argv[1];
    if (!id) {
      process.stderr.write('--read requires a milestone ID\n');
      process.exit(2);
    }
    try {
      const fragment = readFragment(cwd, id);
      console.log(JSON.stringify(fragment));
      process.exit(0);
    } catch (e) {
      process.stderr.write(`Error: ${e.message}\n`);
      process.exit(1);
    }
  }

  if (cmd === '--write') {
    // Read JSON fragment from stdin
    let raw = '';
    process.stdin.setEncoding('utf8');
    process.stdin.on('data', chunk => { raw += chunk; });
    process.stdin.on('end', () => {
      let fragment;
      try {
        fragment = JSON.parse(raw);
      } catch (e) {
        process.stderr.write(`JSON parse error: ${e.message}\n`);
        process.exit(1);
      }
      try {
        const result = writeFragment(cwd, fragment);
        console.log(JSON.stringify(result));
        process.exit(0);
      } catch (e) {
        process.stderr.write(`Error: ${e.message}\n`);
        process.exit(1);
      }
    });
    return; // async — do not fall through
  }

  if (cmd === '--validate') {
    const id = argv[1];
    if (!id) {
      process.stderr.write('--validate requires a milestone ID\n');
      process.exit(2);
    }
    const valid = validateMilestoneId(id);
    if (!valid) {
      const kind = isValid(id) ? entityKind(id) : 'unknown';
      process.stderr.write(
        `Invalid: "${id}" is not a milestone ID (detected kind: ${kind}). ` +
        'CHECKER-MEMORY accepts milestone IDs only (R4).\n'
      );
      process.exit(1);
    }
    let fpath;
    try {
      fpath = fragmentPath(cwd, id);
    } catch (e) {
      process.stderr.write(`Error: ${e.message}\n`);
      process.exit(1);
    }
    const exists = fs.existsSync(fpath);
    console.log(JSON.stringify({ id, valid: true, exists, path: fpath }));
    process.exit(0);
  }

  process.stderr.write(`Unknown command: "${cmd}"\nRun --help for usage.\n`);
  process.exit(2);
}

// Only run CLI when executed directly (not when required as a module)
if (require.main === module) {
  cliMain(process.argv.slice(2));
}
