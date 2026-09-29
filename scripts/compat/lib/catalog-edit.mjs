// Changes one `versions` array in the text of green-packages.toml, leaving every comment and all
// layout as written. watch-releases uses this instead of re-serialising the TOML, which would lose
// the comments.
//
// Every edit is checked by parsing the text before and after: the only difference may be that one
// array, and it must equal the requested versions. Anything else throws, so a wrong edit can never be
// pushed.
import { parse as parseToml } from 'smol-toml';
import { lineOf } from './semver.mjs';

/**
 * Classifies every character of a TOML text as code ("c"), inside a string ("s") or a comment ("#"),
 * so key and header searches never match text in a comment or a string value.
 */
function classify(text) {
  const kind = new Array(text.length);
  let state = 'code';
  for (let i = 0; i < text.length; i += 1) {
    const c = text[i];
    const next3 = text.slice(i, i + 3);
    if (state === 'code') {
      if (next3 === '"""' || next3 === "'''") {
        state = next3 === '"""' ? 'mlbasic' : 'mlliteral';
        kind[i] = kind[i + 1] = kind[i + 2] = 's';
        i += 2;
        continue;
      }
      if (c === '"') state = 'basic';
      else if (c === "'") state = 'literal';
      else if (c === '#') state = 'comment';
      kind[i] = state === 'code' ? 'c' : state === 'comment' ? '#' : 's';
      continue;
    }
    if (state === 'comment') {
      if (c === '\n') {
        state = 'code';
        kind[i] = 'c';
      } else kind[i] = '#';
      continue;
    }
    kind[i] = 's';
    if (state === 'basic') {
      if (c === '\\') {
        kind[i + 1] = 's';
        i += 1;
      } else if (c === '"' || c === '\n') state = 'code';
    } else if (state === 'literal') {
      if (c === "'" || c === '\n') state = 'code';
    } else if (state === 'mlbasic') {
      if (c === '\\') {
        kind[i + 1] = 's';
        i += 1;
      } else if (next3 === '"""') {
        kind[i + 1] = kind[i + 2] = 's';
        i += 2;
        state = 'code';
      }
    } else if (state === 'mlliteral' && next3 === "'''") {
      kind[i + 1] = kind[i + 2] = 's';
      i += 2;
      state = 'code';
    }
  }
  return kind;
}

/** Line records: { start, end, first } where `first` is the index of the first non-blank character. */
function linesOf(text) {
  const lines = [];
  let start = 0;
  while (start <= text.length) {
    let end = text.indexOf('\n', start);
    if (end === -1) end = text.length;
    let first = start;
    while (first < end && (text[first] === ' ' || text[first] === '\t')) first += 1;
    lines.push({ start, end, first });
    if (end === text.length) break;
    start = end + 1;
  }
  return lines;
}

/** Finds the `versions = [` key that belongs to `target`, returning the array's [open, close] indexes. */
function locateArray(text, kind, target) {
  const lines = linesOf(text);
  let section = null; // 'react-native' | { package: number } | 'other'
  let packageIndex = -1;
  const packages = []; // per [[package]] block: { name, versionsLine }
  let reactNativeVersions = null;

  for (const line of lines) {
    if (line.first >= line.end || kind[line.first] !== 'c') continue;
    const head = text.slice(line.first, line.end);
    if (text[line.first] === '[') {
      const header = head.slice(0, head.search(/\](?!\])|$/) + 1).replace(/\s+/g, '');
      if (header.startsWith('[[package]]')) {
        packageIndex += 1;
        packages.push({ name: undefined, versionsLine: null });
        section = { package: packageIndex, own: true };
      } else if (header === '[react-native]') {
        section = 'react-native';
      } else if (header.startsWith('[package.') && typeof section === 'object' && section !== null) {
        section = { package: section.package, own: false }; // a sub-table: no longer the entry's own keys
      } else {
        section = 'other';
      }
      continue;
    }
    const key = /^([A-Za-z0-9_-]+)\s*=/.exec(head)?.[1];
    if (!key) continue;
    if (section === 'react-native' && key === 'versions') reactNativeVersions = line;
    if (typeof section === 'object' && section?.own) {
      const entry = packages[section.package];
      if (key === 'versions') entry.versionsLine = line;
      if (key === 'name') {
        try {
          entry.name = parseToml(text.slice(line.first, line.end).replace(/#.*$/, '')).name;
        } catch {
          entry.name = undefined;
        }
      }
    }
  }

  let keyLine;
  if (target === 'react-native') {
    keyLine = reactNativeVersions;
    if (!keyLine) throw new Error('green-packages.toml has no versions key in [react-native]');
  } else {
    const matches = packages.filter((p) => p.name === target);
    if (matches.length === 0) throw new Error(`green-packages.toml has no [[package]] named "${target}"`);
    if (matches.length > 1) throw new Error(`green-packages.toml lists "${target}" more than once`);
    keyLine = matches[0].versionsLine;
    if (!keyLine) throw new Error(`the [[package]] "${target}" has no versions key of its own`);
  }

  let open = text.indexOf('=', keyLine.first) + 1;
  while (open < text.length && !(text[open] === '[' && kind[open] === 'c')) {
    if (kind[open] === 'c' && !/\s/.test(text[open])) throw new Error(`versions for "${target}" is not an array`);
    open += 1;
  }
  let depth = 0;
  for (let i = open; i < text.length; i += 1) {
    if (kind[i] !== 'c') continue;
    if (text[i] === '[') depth += 1;
    if (text[i] === ']') {
      depth -= 1;
      if (depth === 0) return { open, close: i, keyIndent: text.slice(keyLine.start, keyLine.first) };
    }
  }
  throw new Error(`the versions array of "${target}" is not closed`);
}

/** Rewrites an array spread over several lines: one value per line, comments kept next to their value. */
function rewriteMultiline(text, kind, { open, close, keyIndent }, versions) {
  // Walk the lines inside the array, collecting values with their leading and trailing comments.
  const items = []; // { value, leading: string[], trailing: string | null }
  let pending = [];
  let indent = null;
  const inner = linesOf(text.slice(open + 1, close)).map((l) => ({ start: l.start + open + 1, end: l.end + open + 1, first: l.first + open + 1 }));
  for (const line of inner) {
    const values = [];
    let comment = null;
    let i = line.first;
    while (i < line.end) {
      if (kind[i] === '#') {
        comment = text.slice(i, line.end).trimEnd();
        break;
      }
      if (kind[i] === 's') {
        let j = i;
        while (j < line.end && kind[j] === 's') j += 1;
        values.push(parseToml(`v = ${text.slice(i, j)}`).v);
        i = j;
        continue;
      }
      i += 1;
    }
    if (values.length > 0) {
      if (indent === null) indent = text.slice(line.start, line.first);
      values.forEach((value, k) => items.push({ value, leading: k === 0 ? pending : [], trailing: k === values.length - 1 ? comment : null }));
      pending = [];
    } else if (comment !== null) {
      pending.push(text.slice(line.start, line.end).trimEnd());
    }
  }
  indent ??= `${keyIndent}  `;

  // A new value takes the comments of the old value on the same minor line; comments whose value is
  // gone are kept at the end, and so are comments after the last value.
  const byLine = new Map(items.map((item) => [lineOf(item.value), item]));
  const used = new Set();
  const out = [];
  for (const version of versions) {
    const old = byLine.get(lineOf(version));
    if (old) used.add(old);
    out.push(...(old?.leading ?? []));
    out.push(`${indent}${JSON.stringify(version)},${old?.trailing ? ` ${old.trailing}` : ''}`);
  }
  for (const item of items) {
    if (used.has(item)) continue;
    out.push(...item.leading);
    if (item.trailing) out.push(`${indent}${item.trailing}`);
  }
  out.push(...pending);
  return `[\n${out.join('\n')}\n${keyIndent}]`;
}

/**
 * @param {string} text  the whole of green-packages.toml
 * @param {string} target  "react-native", or a package name
 * @param {string[]} versions  the new array, in the order to write
 * @returns {string} the new text
 */
export function setVersions(text, target, versions) {
  const kind = classify(text);
  const located = locateArray(text, kind, target);
  const original = text.slice(located.open, located.close + 1);
  const replacement = original.includes('\n')
    ? rewriteMultiline(text, kind, located, versions)
    : `[${/^\[\s/.test(original) ? ' ' : ''}${versions.map((v) => JSON.stringify(v)).join(', ')}${/\s\]$/.test(original) ? ' ' : ''}]`;
  const next = text.slice(0, located.open) + replacement + text.slice(located.close + 1);
  verifyEdit(text, next, target, versions);
  return next;
}

/** Throws unless `next` differs from `text` in exactly the target's versions, which equal `versions`. */
export function verifyEdit(text, next, target, versions) {
  const before = parseToml(text);
  const after = parseToml(next);
  const pick = (doc) => (target === 'react-native' ? doc['react-native'] : doc.package?.find((p) => p.name === target));
  const beforeTable = pick(before);
  const afterTable = pick(after);
  if (!beforeTable || !afterTable) throw new Error(`edit check: "${target}" is missing after the edit`);
  if (JSON.stringify(afterTable.versions) !== JSON.stringify(versions)) {
    throw new Error(`edit check: the new versions of "${target}" are ${JSON.stringify(afterTable.versions)}, not ${JSON.stringify(versions)}`);
  }
  afterTable.versions = beforeTable.versions;
  if (JSON.stringify(after) !== JSON.stringify(before)) throw new Error(`edit check: editing "${target}" changed something else`);
}
