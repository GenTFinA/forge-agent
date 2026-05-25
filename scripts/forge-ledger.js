#!/usr/bin/env node
// forge-ledger — Per-milestone LEDGER fragment store for Forge Agent
//
// Library exports:
//   LEDGER_DIR                          → string  // relative path '.gsd/ledger'
//   ledgerDir(cwd)                      → string  // absolute path to ledger dir
//   fragmentPath(cwd, milestoneId)      → string  // absolute path to <id>.md
//   parseFragment(text)                 → object  // parse markdown with YAML frontmatter
//   writeFragment(cwd, entry)           → { path, created }
//   readFragment(cwd, milestoneId)      → object | null
//   listFragments(cwd)                  → Array<{ id, path }>
//
// CLI:
//   node forge-ledger.js --list [--cwd <dir>]
//   node forge-ledger.js --read <id> [--cwd <dir>]
//   node forge-ledger.js --write [--cwd <dir>]   (reads JSON entry from stdin)
//   node forge-ledger.js --validate <id> [--cwd <dir>]
//   node forge-ledger.js --help
//
// Exit codes:
//   0 — success
//   1 — runtime error (invalid id, parse error, etc.)
//   2 — unknown/missing arguments

'use strict';

const fs = require('fs');
const path = require('path');
const { isValid, entityKind } = require('./forge-ids');

// ── Constants ─────────────────────────────────────────────────────────────────

const LEDGER_DIR = '.gsd/ledger';

// ── ledgerDir ─────────────────────────────────────────────────────────────────
// Returns the absolute path to the ledger directory for a given cwd.
function ledgerDir(cwd) {
  return path.join(cwd || process.cwd(), '.gsd', 'ledger');
}

// ── fragmentPath ──────────────────────────────────────────────────────────────
// Returns absolute path to the fragment file for a milestone ID.
// Throws if the ID is invalid or not a milestone.
function fragmentPath(cwd, milestoneId) {
  if (!isValid(milestoneId)) {
    throw new Error(`Invalid milestone ID: ${milestoneId}`);
  }
  if (entityKind(milestoneId) !== 'milestone') {
    throw new Error(`ID is not a milestone: ${milestoneId} (kind: ${entityKind(milestoneId)})`);
  }
  return path.join(ledgerDir(cwd), `${milestoneId}.md`);
}

// ── parseFragment ─────────────────────────────────────────────────────────────
// Parses a LEDGER fragment markdown file (YAML frontmatter + body).
// Accepts both inline [a, b] and block "- a\n- b" array forms.
// Unknown frontmatter keys are passed through as-is.
// Returns { id, title, completed_at, slices, key_files, key_decisions, body, ...rest }
function parseFragment(text) {
  const match = text.match(/^---\n([\s\S]*?)\n---\n?([\s\S]*)$/);
  if (!match) {
    // No frontmatter — return minimal object with raw body
    return { id: null, title: null, completed_at: null, slices: [], key_files: [], key_decisions: [], body: text.trim() };
  }

  const frontmatter = match[1];
  const body = match[2].trim();
  const result = {};

  // Parse frontmatter line by line
  const lines = frontmatter.split('\n');
  let currentKey = null;
  let currentArray = null;

  for (const line of lines) {
    // Block array item "  - value" or "- value"
    const arrayItem = line.match(/^\s*-\s+(.*)$/);
    if (arrayItem && currentArray !== null) {
      currentArray.push(arrayItem[1].trim());
      continue;
    }

    // Key-value pair
    const kv = line.match(/^([a-zA-Z_][a-zA-Z0-9_]*)\s*:\s*(.*)$/);
    if (kv) {
      const key = kv[1];
      const rawVal = kv[2].trim();

      // Inline array: [a, b, c] or []
      if (rawVal.startsWith('[')) {
        const inner = rawVal.replace(/^\[|\]$/g, '').trim();
        result[key] = inner === '' ? [] : inner.split(',').map(s => s.trim()).filter(Boolean);
        currentKey = key;
        currentArray = null; // inline — no continuation
      } else if (rawVal === '') {
        // Block array starts next
        result[key] = [];
        currentKey = key;
        currentArray = result[key];
      } else {
        result[key] = rawVal;
        currentKey = key;
        currentArray = null;
      }
      continue;
    }

    // Unrecognized line — reset context
    currentArray = null;
  }

  // Normalize expected array fields
  const arrayFields = ['slices', 'key_files', 'key_decisions'];
  for (const f of arrayFields) {
    if (!Array.isArray(result[f])) {
      result[f] = result[f] != null ? [String(result[f])] : [];
    }
  }

  // Normalize scalar fields
  result.id = result.id || null;
  result.title = result.title || null;
  result.completed_at = result.completed_at || null;
  result.body = body;

  return result;
}

// ── serializeFrontmatter ──────────────────────────────────────────────────────
// Serializes an entry object to YAML frontmatter string.
// Keys are emitted in alphabetical order for diff stability.
// Arrays use block form for readability.
function serializeFrontmatter(entry) {
  const skip = new Set(['body']);
  const keys = Object.keys(entry).filter(k => !skip.has(k)).sort();

  const lines = [];
  for (const key of keys) {
    const val = entry[key];
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
// Writes a LEDGER fragment to disk.
// Validates entry.id before writing.
// Returns { path: string, created: boolean }
// created: false if file existed and content is identical (idempotent).
function writeFragment(cwd, entry) {
  if (!entry || !entry.id) {
    throw new Error('entry.id is required');
  }

  const fpath = fragmentPath(cwd, entry.id); // throws if invalid id
  const dir = path.dirname(fpath);

  // mkdir -p
  if (!fs.existsSync(dir)) {
    fs.mkdirSync(dir, { recursive: true });
  }

  // Serialize
  const frontmatter = serializeFrontmatter(entry);
  const body = entry.body ? `\n${entry.body}` : '';
  const content = `---\n${frontmatter}\n---\n${body}`;

  // Idempotent check
  if (fs.existsSync(fpath)) {
    const existing = fs.readFileSync(fpath, 'utf8');
    if (existing === content) {
      return { path: fpath, created: false };
    }
  }

  fs.writeFileSync(fpath, content, 'utf8');
  return { path: fpath, created: true };
}

// ── readFragment ──────────────────────────────────────────────────────────────
// Reads and parses a LEDGER fragment. Returns null if the file does not exist.
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
// Lists all fragment files in the ledger directory.
// Returns Array<{ id, path }> sorted by id ascending.
// Returns [] if the directory does not exist.
function listFragments(cwd) {
  const dir = ledgerDir(cwd);
  if (!fs.existsSync(dir)) return [];

  const files = fs.readdirSync(dir);
  const fragments = files
    .filter(f => f.endsWith('.md'))
    .map(f => ({
      id: f.slice(0, -3), // strip .md
      path: path.join(dir, f),
    }))
    .sort((a, b) => a.id.localeCompare(b.id));

  return fragments;
}

// ── cliMain ───────────────────────────────────────────────────────────────────
function printUsage() {
  console.log(`Usage: node forge-ledger.js <command> [options]

Commands:
  --list [--cwd <dir>]          List all ledger fragments (JSON array)
  --read <id> [--cwd <dir>]     Read and print a fragment (JSON), null if missing
  --write [--cwd <dir>]         Write fragment from stdin (JSON entry)
  --validate <id> [--cwd <dir>] Validate ID and check if fragment exists
  --help, -h                    Show this help

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
      process.stderr.write('--read requires a milestone ID\n');
      process.exit(2);
    }
    const fragment = readFragment(cwd, id);
    console.log(JSON.stringify(fragment));
    process.exit(0);
  }

  if (cmd === '--write') {
    // Read JSON entry from stdin
    let raw = '';
    process.stdin.setEncoding('utf8');
    process.stdin.on('data', chunk => { raw += chunk; });
    process.stdin.on('end', () => {
      let entry;
      try {
        entry = JSON.parse(raw);
      } catch (e) {
        process.stderr.write(`Failed to parse JSON from stdin: ${e.message}\n`);
        process.exit(1);
      }
      const result = writeFragment(cwd, entry);
      console.log(JSON.stringify(result));
      process.exit(0);
    });
    return; // async — do not fall through
  }

  if (cmd === '--validate') {
    const id = argv[1];
    if (!id) {
      process.stderr.write('--validate requires a milestone ID\n');
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
      valid: isValid(id),
      kind: entityKind(id),
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

// ── Module exports ────────────────────────────────────────────────────────────
module.exports = {
  LEDGER_DIR,
  ledgerDir,
  fragmentPath,
  writeFragment,
  readFragment,
  listFragments,
  parseFragment,
};
