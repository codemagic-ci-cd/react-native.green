// The result artifact of a compatibility-check build: compat-results/result.json, holding only the
// three check outcomes. It comes from a build that ran the library's own code, so it is read as
// untrusted input: small, plain JSON, exactly this shape, nothing else accepted.
//
//   { "schemaVersion": 1, "checks": { "buildIos": "passed", "buildAndroid": "failed", "tests": "passed" } }
import { isZip, readZipEntry } from './zip.mjs';

export const RESULT_SCHEMA_VERSION = 1;
export const RESULT_FILE = 'result.json';
export const MAX_RESULT_BYTES = 4096;

const OUTCOMES = { buildIos: ['passed', 'failed'], buildAndroid: ['passed', 'failed'], tests: ['passed', 'failed', 'none'] };

const exactKeys = (value, keys) =>
  value !== null && typeof value === 'object' && !Array.isArray(value) &&
  Object.keys(value).length === keys.length && keys.every((key) => Object.hasOwn(value, key));

/**
 * @param {Buffer} bytes  the downloaded artifact, as-is or zipped
 * @returns {{ ok: true, checks: { buildIos: string, buildAndroid: string, tests: string } } | { ok: false, reason: string }}
 */
export function parseResultArtifact(bytes) {
  if (bytes.length > MAX_RESULT_BYTES && !isZip(bytes)) return { ok: false, reason: `larger than ${MAX_RESULT_BYTES} bytes` };
  let content = bytes;
  if (isZip(bytes)) {
    if (bytes.length > MAX_RESULT_BYTES * 2) return { ok: false, reason: `zip larger than ${MAX_RESULT_BYTES * 2} bytes` };
    try {
      content = readZipEntry(bytes, (name) => name === RESULT_FILE || name.endsWith(`/${RESULT_FILE}`), MAX_RESULT_BYTES);
    } catch (error) {
      return { ok: false, reason: `zip: ${error.message}` };
    }
  }

  let value;
  try {
    value = JSON.parse(new TextDecoder('utf-8', { fatal: true }).decode(content));
  } catch {
    return { ok: false, reason: 'not UTF-8 JSON' };
  }
  if (!exactKeys(value, ['schemaVersion', 'checks']) || value.schemaVersion !== RESULT_SCHEMA_VERSION) {
    return { ok: false, reason: 'not the expected shape { schemaVersion: 1, checks }' };
  }
  if (!exactKeys(value.checks, Object.keys(OUTCOMES))) return { ok: false, reason: 'checks must hold exactly buildIos, buildAndroid and tests' };
  for (const [name, allowed] of Object.entries(OUTCOMES)) {
    if (!allowed.includes(value.checks[name])) return { ok: false, reason: `checks.${name} must be one of ${allowed.join(', ')}` };
  }
  return { ok: true, checks: { buildIos: value.checks.buildIos, buildAndroid: value.checks.buildAndroid, tests: value.checks.tests } };
}
