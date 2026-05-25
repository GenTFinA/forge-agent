#!/usr/bin/env node
// forge-memory — Per-unit AUTO-MEMORY fragment store for Forge Agent
//
// Library exports:
//   MEMORY_DIR                          → string  // relative path '.gsd/memory'
//   memoryDir(cwd)                      → string  // absolute path to memory dir
//   fragmentPath(cwd, unitId)           → string  // absolute path to <unit-id>.md
//   parseFragment(text)                 → object  // parse markdown with YAML frontmatter
//   writeFragment(cwd, fragment)        → { path, created }
//   readFragment(cwd, unitId)           → object | null
//   listFragments(cwd)                  → Array<{ unitId, path }>
//
// CLI:
//   node forge-memory.js --list [--cwd <dir>]
//   node forge-memory.js --read <unit-id> [--cwd <dir>]
//   node forge-memory.js --write [--cwd <dir>]   (reads JSON fragment from stdin)
//   node forge-memory.js --validate <unit-id> [--cwd <dir>]
//   node forge-memory.js --help
//
// Exit codes:
//   0 — success
//   1 — runtime error (invalid id, parse error, etc.)
//   2 — unknown/missing arguments

'use strict';

const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const { isValid, entityKind } = require('./forge-ids');

// ── Constants ─────────────────────────────────────────────────────────────────

const MEMORY_DIR = '.gsd/memory';

// Pattern for forge-ask session IDs: ask-<session-id>
const ASK_ID_RE = /^ask-[A-Za-z0-9._-]+$/;

// ── memoryDir ─────────────────────────────────────────────────────────────────
// Returns the absolute path to the memory directory for a given cwd.
function memoryDir(cwd) {
  return path.join(cwd || process.cwd(), '.gsd', 'memory');
}

// ── validateUnitId ────────────────────────────────────────────────────────────
// Returns true if id is a valid unit ID for a MEMORY fragment.
// Accepts three shapes:
//   1. Milestone IDs (via forge-ids.isValid + entityKind === 'milestone')
//   2. Task IDs     (via forge-ids.isValid + entityKind === 'task')
//   3. ask-<session-id> literals (^ask-[A-Za-z0-9._-]+$)
function validateUnitId(id) {
  if (!id) return false;
  // Shape 3: forge-ask session
  if (ASK_ID_RE.test(id)) return true;
  // Shapes 1 & 2: delegate to forge-ids
  if (!isValid(id)) return false;
  const kind = entityKind(id);
  return kind === 'milestone' || kind === 'task';
}

// ── fragmentPath ──────────────────────────────────────────────────────────────
// Returns absolute path to the fragment file for a unit ID.
// Throws if the ID is not a valid memory unit ID.
function fragmentPath(cwd, unitId) {
  if (!validateUnitId(unitId)) {
    throw new Error(
      `Invalid memory unit ID: "${unitId}". ` +
      'Expected a milestone ID (M###, M-<ts>-<slug>), ' +
      'task ID (TASK-###, T-<ts>-<slug>), or ask-<session-id>.'
    );
  }
  return path.join(memoryDir(cwd), `${unitId}.md`);
}

// ── parseFragment ─────────────────────────────────────────────────────────────
// Parses a MEMORY fragment markdown file (YAML frontmatter + body).
// The `facts:` key holds a block array of objects, each with keys:
//   { mem_id, category, text, created_at, source_unit }
// The `stats:` key holds a block array of stat event objects, each with keys:
//   { kind, mem_id, ts, ...payload }
// Decay is computed on-projection — NOT manufactured as events here.
// Unknown frontmatter keys are passed through as-is.
// Accepts both inline ([...]) and block (- item) array forms.
function parseFragment(text) {
  const match = text.match(/^---\n([\s\S]*?)\n---\n?([\s\S]*)$/);
  if (!match) {
    return {
      unit_id: null,
      facts: [],
      stats: [],
      body: text.trim(),
    };
  }

  const frontmatter = match[1];
  const body = match[2].trim();
  const result = {};

  const OBJECT_ARRAY_KEYS = new Set(['facts', 'stats']);

  const lines = frontmatter.split('\n');
  let currentKey = null;
  let currentArray = null;
  let inObjectArray = false;
  let currentObject = null;

  for (let i = 0; i < lines.length; i++) {
    const line = lines[i];

    // Detect start of an object array item: "  - key: value" or "- key: value"
    const objectItemStart = line.match(/^(\s*)-\s+([a-zA-Z_][a-zA-Z0-9_]*)\s*:\s*(.*)$/);
    if (objectItemStart && currentKey && OBJECT_ARRAY_KEYS.has(currentKey) && Array.isArray(result[currentKey])) {
      // Save previous object
      if (currentObject !== null) {
        result[currentKey].push(currentObject);
      }
      currentObject = {};
      const key = objectItemStart[2];
      currentObject[key] = objectItemStart[3].trim();
      inObjectArray = true;
      currentArray = null;
      continue;
    }

    // Continuation of an object item: "    key: value"
    if (inObjectArray && currentObject !== null) {
      const objKv = line.match(/^\s{2,}([a-zA-Z_][a-zA-Z0-9_]*)\s*:\s*(.*)$/);
      if (objKv) {
        currentObject[objKv[1]] = objKv[2].trim();
        continue;
      }
      // Unindented or non-kv line ends the current object
      if (currentObject !== null) {
        result[currentKey].push(currentObject);
        currentObject = null;
        inObjectArray = false;
      }
    }

    // Plain block array item: "  - value" or "- value" (non-object arrays)
    const arrayItem = line.match(/^\s*-\s+(.*)$/);
    if (arrayItem && currentArray !== null && currentKey && !OBJECT_ARRAY_KEYS.has(currentKey)) {
      currentArray.push(arrayItem[1].trim());
      continue;
    }

    // Key-value pair
    const kv = line.match(/^([a-zA-Z_][a-zA-Z0-9_]*)\s*:\s*(.*)$/);
    if (kv) {
      const key = kv[1];
      const rawVal = kv[2].trim();

      if (OBJECT_ARRAY_KEYS.has(key)) {
        result[key] = [];
        currentKey = key;
        currentArray = null;
        currentObject = null;
        inObjectArray = false;
        continue;
      }

      // Inline array: [a, b, c] or []
      if (rawVal.startsWith('[')) {
        const inner = rawVal.replace(/^\[|\]$/g, '').trim();
        result[key] = inner === '' ? [] : inner.split(',').map(s => s.trim()).filter(Boolean);
        currentKey = key;
        currentArray = null;
        inObjectArray = false;
      } else if (rawVal === '') {
        // Block array starts next
        result[key] = [];
        currentKey = key;
        currentArray = result[key];
        inObjectArray = false;
      } else {
        result[key] = rawVal;
        currentKey = key;
        currentArray = null;
        inObjectArray = false;
      }
      continue;
    }

    // Unrecognized line — flush pending object and reset context
    if (currentObject !== null) {
      result[currentKey].push(currentObject);
      currentObject = null;
    }
    inObjectArray = false;
    currentArray = null;
  }

  // Flush trailing object
  if (currentObject !== null) {
    result[currentKey].push(currentObject);
  }

  // Ensure facts and stats are always arrays
  if (!Array.isArray(result['facts'])) result['facts'] = [];
  if (!Array.isArray(result['stats'])) result['stats'] = [];

  result.unit_id = result.unit_id || null;
  result.body = body;

  return result;
}

// ── factHash ──────────────────────────────────────────────────────────────────
// Stable hash for a fact's mem_id — primary dedup key.
// Same mem_id is always the same fact: re-writing is a no-op.
function factHash(f) {
  return String(f.mem_id || '');
}

// ── statHash ─────────────────────────────────────────────────────────────────
// Stable SHA1 hash for a stat event's (kind, mem_id, ts) dedup tuple.
function statHash(s) {
  const raw = [s.kind || '', s.mem_id || '', s.ts || ''].join('\x00');
  return crypto.createHash('sha1').update(raw).digest('hex');
}

// ── mergeFacts ────────────────────────────────────────────────────────────────
// Merges two arrays of fact objects.
// Dedup by mem_id — existing fact fields are NEVER mutated.
// New facts are appended; result sorted by created_at ASC then mem_id for stability.
function mergeFacts(existing, incoming) {
  const seen = new Set(existing.map(factHash));
  const merged = [...existing];

  for (const f of incoming) {
    const h = factHash(f);
    if (h && !seen.has(h)) {
      seen.add(h);
      merged.push(f);
    }
  }

  merged.sort((a, b) => {
    const ca = String(a.created_at || '');
    const cb = String(b.created_at || '');
    if (ca < cb) return -1;
    if (ca > cb) return 1;
    return String(a.mem_id || '').localeCompare(String(b.mem_id || ''));
  });

  return merged;
}

// ── mergeStats ────────────────────────────────────────────────────────────────
// Merges two arrays of stat event objects.
// Dedup by SHA1(kind, mem_id, ts) — re-writing the same event is a no-op.
// Result sorted by ts ASC then by hash for stability.
function mergeStats(existing, incoming) {
  const seen = new Set(existing.map(statHash));
  const merged = [...existing];

  for (const s of incoming) {
    const h = statHash(s);
    if (!seen.has(h)) {
      seen.add(h);
      merged.push(s);
    }
  }

  merged.sort((a, b) => {
    const ta = String(a.ts || '');
    const tb = String(b.ts || '');
    if (ta < tb) return -1;
    if (ta > tb) return 1;
    return statHash(a).localeCompare(statHash(b));
  });

  return merged;
}

// ── serializeFrontmatter ──────────────────────────────────────────────────────
// Serializes a fragment object to YAML frontmatter string.
// Keys are emitted in alphabetical order for diff stability.
// `facts` and `stats` use block-of-objects form.
// Simple arrays use block form. Scalars use plain form.
function serializeFrontmatter(fragment) {
  const skip = new Set(['body']);
  const keys = Object.keys(fragment).filter(k => !skip.has(k)).sort();

  const FACT_KEYS = ['mem_id', 'category', 'text', 'created_at', 'source_unit'];
  const STAT_KEYS = ['kind', 'mem_id', 'ts'];

  const lines = [];
  for (const key of keys) {
    const val = fragment[key];

    if (key === 'facts') {
      if (!Array.isArray(val) || val.length === 0) {
        lines.push('facts: []');
      } else {
        lines.push('facts:');
        for (const f of val) {
          // Canonical keys first, then extras alphabetically
          const allKeys = [
            ...FACT_KEYS.filter(k => k in f),
            ...Object.keys(f).filter(k => !FACT_KEYS.includes(k)).sort(),
          ];
          let first = true;
          for (const fk of allKeys) {
            const prefix = first ? '  - ' : '    ';
            lines.push(`${prefix}${fk}: ${f[fk] !== undefined && f[fk] !== null ? f[fk] : ''}`);
            first = false;
          }
        }
      }
      continue;
    }

    if (key === 'stats') {
      if (!Array.isArray(val) || val.length === 0) {
        lines.push('stats: []');
      } else {
        lines.push('stats:');
        for (const s of val) {
          // Canonical keys first (kind, mem_id, ts), then extras alphabetically
          const extraKeys = Object.keys(s).filter(k => !STAT_KEYS.includes(k)).sort();
          const allKeys = [
            ...STAT_KEYS.filter(k => k in s),
            ...extraKeys,
          ];
          let first = true;
          for (const sk of allKeys) {
            const prefix = first ? '  - ' : '    ';
            lines.push(`${prefix}${sk}: ${s[sk] !== undefined && s[sk] !== null ? s[sk] : ''}`);
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
// Writes a MEMORY fragment to disk.
// fragment shape: { unit_id, facts?: [...], stats?: [...], ...rest }
// Merges with existing fragment if present.
//   - facts: dedup by mem_id; existing fact fields NEVER mutated (append-only).
//   - stats: dedup by SHA1(kind, mem_id, ts); append-only.
// Byte-compares after merge — skips write if content is identical (idempotent).
// Returns { path: string, created: boolean }
// created: false if content is identical after merge.
function writeFragment(cwd, fragment) {
  if (!fragment || !fragment.unit_id) {
    throw new Error('fragment.unit_id is required');
  }

  const fpath = fragmentPath(cwd, fragment.unit_id); // throws if invalid id
  const dir = path.dirname(fpath);

  // mkdir -p
  if (!fs.existsSync(dir)) {
    fs.mkdirSync(dir, { recursive: true });
  }

  // Merge with existing if present
  let base;
  if (fs.existsSync(fpath)) {
    const existing = parseFragment(fs.readFileSync(fpath, 'utf8'));
    const existingFacts = Array.isArray(existing.facts) ? existing.facts : [];
    const incomingFacts = Array.isArray(fragment.facts) ? fragment.facts : [];
    const existingStats = Array.isArray(existing.stats) ? existing.stats : [];
    const incomingStats = Array.isArray(fragment.stats) ? fragment.stats : [];
    const mergedFacts = mergeFacts(existingFacts, incomingFacts);
    const mergedStats = mergeStats(existingStats, incomingStats);
    // Incoming scalar fields override existing; facts/stats merged
    base = { ...existing, ...fragment, facts: mergedFacts, stats: mergedStats };
  } else {
    // New fragment: sort for stable ordering
    const facts = Array.isArray(fragment.facts) ? mergeFacts([], fragment.facts) : [];
    const stats = Array.isArray(fragment.stats) ? mergeStats([], fragment.stats) : [];
    base = { ...fragment, facts, stats };
  }

  // Serialize
  const frontmatter = serializeFrontmatter(base);
  const body = base.body ? `\n${base.body}` : '';
  const content = `---\n${frontmatter}\n---\n${body}`;

  // Idempotent check
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
// Reads and parses a MEMORY fragment. Returns null if the file does not exist.
function readFragment(cwd, unitId) {
  let fpath;
  try {
    fpath = fragmentPath(cwd, unitId);
  } catch (e) {
    throw e; // propagate invalid id error
  }

  if (!fs.existsSync(fpath)) return null;
  const text = fs.readFileSync(fpath, 'utf8');
  return parseFragment(text);
}

// ── listFragments ─────────────────────────────────────────────────────────────
// Lists all fragment files in the memory directory.
// Returns Array<{ unitId, path }> sorted by unitId ascending.
// Returns [] if the directory does not exist.
function listFragments(cwd) {
  const dir = memoryDir(cwd);
  if (!fs.existsSync(dir)) return [];

  const files = fs.readdirSync(dir);
  const fragments = files
    .filter(f => f.endsWith('.md'))
    .map(f => ({
      unitId: f.slice(0, -3), // strip .md
      path: path.join(dir, f),
    }))
    .sort((a, b) => a.unitId.localeCompare(b.unitId));

  return fragments;
}

// ── Module exports ────────────────────────────────────────────────────────────
module.exports = {
  MEMORY_DIR,
  memoryDir,
  fragmentPath,
  parseFragment,
  writeFragment,
  readFragment,
  listFragments,
};

// ── cliMain ───────────────────────────────────────────────────────────────────
function printUsage() {
  console.log(`Usage: node forge-memory.js <command> [options]

Commands:
  --list [--cwd <dir>]                    List all memory fragments (JSON array)
  --read <unit-id> [--cwd <dir>]          Read and print a fragment (JSON), null if missing
  --write [--cwd <dir>]                   Write/merge fragment from stdin (JSON fragment)
  --validate <unit-id> [--cwd <dir>]      Validate ID and check if fragment exists
  --help, -h                              Show this help

Unit ID forms accepted:
  M###, M-<ts>-<slug>            Milestone IDs
  TASK-###, T-<ts>-<slug>        Task IDs
  ask-<session-id>               forge-ask session IDs

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
    console.log(JSON.stringify(result));
    process.exit(0);
  }

  if (cmd === '--read') {
    const id = argv[1];
    if (!id) {
      process.stderr.write('--read requires a unit ID\n');
      process.exit(2);
    }
    const fragment = readFragment(cwd, id);
    console.log(JSON.stringify(fragment));
    process.exit(0);
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
        process.stderr.write(`Failed to parse JSON from stdin: ${e.message}\n`);
        process.exit(1);
      }
      let result;
      try {
        result = writeFragment(cwd, fragment);
      } catch (e) {
        process.stderr.write(`${e.message}\n`);
        process.exit(1);
      }
      console.log(JSON.stringify(result));
      process.exit(0);
    });
    return; // async — do not fall through
  }

  if (cmd === '--validate') {
    const id = argv[1];
    if (!id) {
      process.stderr.write('--validate requires a unit ID\n');
      process.exit(2);
    }
    let exists = false;
    let existsError = null;
    try {
      const fpath = fragmentPath(cwd, id);
      exists = fs.existsSync(fpath);
    } catch (e) {
      existsError = e.message;
    }
    const result = {
      id,
      valid: validateUnitId(id),
      exists: existsError ? false : exists,
    };
    if (existsError) result.error = existsError;
    console.log(JSON.stringify(result));
    process.exit(0);
  }

  // Unknown command
  process.stderr.write(`Unknown argument: ${cmd}\n\n`);
  printUsage();
  process.exit(2);
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
