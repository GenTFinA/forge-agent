/**
 * forge-yaml-safe.js — Shared YAML-safe scalar serializer/parser
 *
 * Provides lossless round-trip serialization for arbitrary string values into
 * YAML scalar form, using plain scalars when safe and block-scalar `|` form
 * when the value contains characters that would be ambiguous in YAML.
 *
 * Zero external dependencies — Node.js built-ins only.
 *
 * Exports:
 *   needsBlockScalar(value)              → boolean
 *   serializeScalar(value, indent = 0)   → string  (may be multi-line if block)
 *   parseScalar(lines, startIdx, baseIndent = 0) → { value: string, nextIndex: number }
 *
 * CLI:
 *   node scripts/forge-yaml-safe.js --smoke   → runs inline assertions, prints PASS/FAIL
 */

'use strict';

// ---------------------------------------------------------------------------
// Constants
// ---------------------------------------------------------------------------

/** Characters that are ambiguous as the first character of a plain YAML scalar. */
const UNSAFE_FIRST_CHARS = new Set(['[', '{', ':', "'", '"', '>', '|', '&', '*', '!', '%', '#', '?', '-', '@', '`']);

/** YAML boolean/null keywords that must be quoted to avoid type coercion. */
const YAML_KEYWORDS = new Set(['true', 'false', 'null', '~', 'yes', 'no', 'on', 'off']);

/** Regex for integers and floats that YAML would parse as numbers. */
const NUMERIC_RE = /^-?\d+(\.\d+)?([eE][+-]?\d+)?$/;

// ---------------------------------------------------------------------------
// needsBlockScalar(value)
// ---------------------------------------------------------------------------

/**
 * Returns true when `value` cannot be safely emitted as a plain YAML scalar
 * and must be wrapped in block-scalar `|` form.
 *
 * @param {string} value
 * @returns {boolean}
 */
function needsBlockScalar(value) {
  if (typeof value !== 'string') {
    value = String(value);
  }

  // Multi-line content → block scalar required
  if (value.includes('\n')) return true;

  // Leading or trailing whitespace → would be silently trimmed by plain parser
  if (value !== value.trim()) return true;

  // Empty string is handled separately in serializeScalar (returns '')
  if (value.length === 0) return false;

  // First character is ambiguous in plain scalar context
  const firstChar = value[0];
  if (UNSAFE_FIRST_CHARS.has(firstChar)) return true;

  // YAML boolean/null keywords → must quote to preserve string type
  if (YAML_KEYWORDS.has(value.toLowerCase())) return true;

  // Numeric-looking values → would be parsed as numbers
  if (NUMERIC_RE.test(value)) return true;

  // `: ` sequence anywhere → key: value ambiguity
  if (value.includes(': ')) return true;

  // Value ends with `:` → key indicator ambiguity
  if (value.endsWith(':')) return true;

  // `#` after a space → inline comment start
  if (value.includes(' #')) return true;

  return false;
}

// ---------------------------------------------------------------------------
// serializeScalar(value, indent = 0)
// ---------------------------------------------------------------------------

/**
 * Serializes `value` to a YAML scalar string.
 *
 * - Plain scalar (returned as-is) when needsBlockScalar returns false.
 * - Block-scalar `|` form when needsBlockScalar returns true.
 *   The returned string begins with `|` followed by newline-separated content
 *   lines indented by (indent + 2) spaces. The caller uses this as:
 *     `${key}: ${serializeScalar(value, currentIndent)}`
 *   which produces:
 *     `key: |`
 *     `  line1`
 *     `  line2`
 *
 * - null/undefined → returns `''` (caller decides how to emit empty).
 * - Empty string → returns `''`.
 *
 * @param {string|null|undefined} value
 * @param {number} [indent=0]  Current indentation level of the containing key
 * @returns {string}
 */
function serializeScalar(value, indent) {
  if (indent === undefined) indent = 0;

  if (value === null || value === undefined) return '';

  const str = String(value);

  if (str.length === 0) return "''";

  if (!needsBlockScalar(str)) return str;

  // Block scalar form: `|` indicator, then indented lines
  const lineIndent = ' '.repeat(indent + 2);
  const lines = str.split('\n');
  const indentedLines = lines.map(function(line) {
    return lineIndent + line;
  });
  return '|\n' + indentedLines.join('\n');
}

// ---------------------------------------------------------------------------
// parseScalar(lines, startIdx, baseIndent = 0)
// ---------------------------------------------------------------------------

/**
 * Parses a scalar value starting at `lines[startIdx]`.
 *
 * The caller has already stripped the `key: ` prefix, leaving either:
 *   - A plain value (e.g. `"hello"`, `42`, empty)
 *   - A block-scalar indicator `|` (optionally followed by whitespace)
 *
 * For block scalars, subsequent lines indented more than `baseIndent` are
 * consumed and joined with `\n` after stripping the `baseIndent + 2` space
 * prefix.
 *
 * @param {string[]} lines        Array of all lines being parsed
 * @param {number}   startIdx     Index of the value portion of the current line
 * @param {number}   [baseIndent=0]  Indentation of the containing block
 * @returns {{ value: string, nextIndex: number }}
 */
function parseScalar(lines, startIdx, baseIndent) {
  if (baseIndent === undefined) baseIndent = 0;

  const raw = (lines[startIdx] || '').trim();

  // Block scalar indicator
  if (/^\|\s*$/.test(raw)) {
    const contentIndent = baseIndent + 2;
    const contentLines = [];
    let i = startIdx + 1;

    while (i < lines.length) {
      const line = lines[i];
      // A line belongs to the block if it is empty or indented enough
      if (line.trim() === '') {
        contentLines.push('');
        i++;
        continue;
      }
      // Count leading spaces
      const leadingSpaces = line.length - line.trimStart().length;
      if (leadingSpaces >= contentIndent) {
        contentLines.push(line.slice(contentIndent));
        i++;
      } else {
        break;
      }
    }

    // Strip trailing empty lines added by the `|` emitter (YAML `|` default chomping keeps one trailing newline)
    // We want to recover the exact original string, so strip all trailing empties
    while (contentLines.length > 0 && contentLines[contentLines.length - 1] === '') {
      contentLines.pop();
    }

    return { value: contentLines.join('\n'), nextIndex: i };
  }

  // Quoted scalar — strip delimiters and unescape
  if (raw.length >= 2) {
    if ((raw[0] === '"' && raw[raw.length - 1] === '"') ||
        (raw[0] === "'" && raw[raw.length - 1] === "'")) {
      const delimiter = raw[0];
      let inner = raw.slice(1, -1);
      if (delimiter === '"') {
        inner = inner
          .replace(/\\n/g, '\n')
          .replace(/\\\\/g, '\\')
          .replace(/\\"/g, '"');
      }
      return { value: inner, nextIndex: startIdx + 1 };
    }
  }

  // Plain scalar
  return { value: raw, nextIndex: startIdx + 1 };
}

// ---------------------------------------------------------------------------
// Exports
// ---------------------------------------------------------------------------

module.exports = { needsBlockScalar, serializeScalar, parseScalar };

// ---------------------------------------------------------------------------
// Inline smoke tests (CLI: node scripts/forge-yaml-safe.js --smoke)
// ---------------------------------------------------------------------------

if (require.main === module && process.argv[2] === '--smoke') {
  let allPassed = true;

  function assert(label, actual, expected) {
    if (actual === expected) {
      console.log('PASS: ' + label);
    } else {
      console.log('FAIL: ' + label + ' expected=' + JSON.stringify(expected) + ' got=' + JSON.stringify(actual));
      allPassed = false;
    }
  }

  // Helper: full round-trip via serializeScalar + parseScalar
  function roundTrip(value) {
    const serialized = serializeScalar(value, 0);
    // Split into lines; first line is the scalar value (or `|`)
    const lines = serialized.split('\n');
    const result = parseScalar(lines, 0, 0);
    return result.value;
  }

  // needsBlockScalar basic cases
  assert('needsBlockScalar(simple) === false', needsBlockScalar('hello'), false);
  assert('needsBlockScalar(multiline) === true', needsBlockScalar('a\nb'), true);
  assert('needsBlockScalar([bracket) === true', needsBlockScalar('[abc'), true);
  assert('needsBlockScalar({brace) === true', needsBlockScalar('{brace'), true);
  assert('needsBlockScalar(:colon-start) === true', needsBlockScalar(':colon-start'), true);
  assert('needsBlockScalar(trailing-space) === true', needsBlockScalar('trailing '), true);
  assert('needsBlockScalar(true) === true', needsBlockScalar('true'), true);
  assert('needsBlockScalar(42) === true', needsBlockScalar('42'), true);
  assert('needsBlockScalar(has: colon) === true', needsBlockScalar('has: colon'), true);

  // Round-trip tests
  assert('round-trip: simple', roundTrip('simple'), 'simple');
  assert('round-trip: line1\\nline2', roundTrip('line1\nline2'), 'line1\nline2');
  assert('round-trip: line1\\nline2\\nline3', roundTrip('line1\nline2\nline3'), 'line1\nline2\nline3');
  assert('round-trip: [bracket', roundTrip('[not-an-array'), '[not-an-array');
  assert('round-trip: {brace', roundTrip('{brace}'), '{brace}');
  assert('round-trip: :colon-start', roundTrip(':colon-start'), ':colon-start');
  assert('round-trip: trailing space', roundTrip('trailing '), 'trailing ');
  assert('round-trip: true', roundTrip('true'), 'true');
  assert('round-trip: 42', roundTrip('42'), '42');
  assert('round-trip: has: colon', roundTrip('has: colon'), 'has: colon');
  assert('round-trip: leading space', roundTrip(' leading'), ' leading');
  assert('round-trip: #comment-char', roundTrip('#comment'), '#comment');

  // Serialized form checks
  const multiLineSerialized = serializeScalar('line1\nline2', 0);
  assert('block scalar starts with |', multiLineSerialized.startsWith('|'), true);
  assert('block scalar contains line1', multiLineSerialized.includes('  line1'), true);
  assert('block scalar contains line2', multiLineSerialized.includes('  line2'), true);

  // Empty string
  const emptyResult = parseScalar(["''"], 0, 0);
  assert('empty string round-trip', emptyResult.value, '');

  if (!allPassed) {
    process.exit(1);
  }
  process.exit(0);
}
