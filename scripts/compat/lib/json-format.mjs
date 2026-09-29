// Formats compatibility data the way the files in compatibility-data/ are written by hand: two-space
// indentation, and any object two or more levels down whose values are all plain values on one line,
// e.g. `"tested": { "library": "2.1.3", "reactNative": "0.87.1" }`. Keeps diffs to the lines that
// changed.
const isPlain = (value) => value === null || typeof value !== 'object';

function format(value, depth) {
  if (isPlain(value)) return JSON.stringify(value);
  const indent = '  '.repeat(depth + 1);
  const closing = '  '.repeat(depth);

  if (Array.isArray(value)) {
    if (value.length === 0) return '[]';
    return `[\n${value.map((item) => indent + format(item, depth + 1)).join(',\n')}\n${closing}]`;
  }

  const entries = Object.entries(value);
  if (entries.length === 0) return '{}';
  if (depth > 1 && entries.every(([, v]) => isPlain(v))) {
    return `{ ${entries.map(([k, v]) => `${JSON.stringify(k)}: ${JSON.stringify(v)}`).join(', ')} }`;
  }
  return `{\n${entries.map(([k, v]) => `${indent}${JSON.stringify(k)}: ${format(v, depth + 1)}`).join(',\n')}\n${closing}}`;
}

export function formatJson(value) {
  return `${format(value, 0)}\n`;
}
