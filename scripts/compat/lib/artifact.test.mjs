import { deflateRawSync } from 'node:zlib';
import { describe, expect, it } from 'vitest';
import { MAX_RESULT_BYTES, parseResultArtifact } from './artifact.mjs';
import { readZipEntry } from './zip.mjs';

const json = (value) => Buffer.from(JSON.stringify(value));
const good = { schemaVersion: 1, checks: { buildIos: 'passed', buildAndroid: 'failed', tests: 'passed' } };

// A one-entry zip archive, as a server may deliver a single artifact file.
function zipOf(name, content, method = 8) {
  const data = method === 8 ? deflateRawSync(content) : content;
  const nameBytes = Buffer.from(name);
  const local = Buffer.alloc(30);
  local.writeUInt32LE(0x04034b50, 0);
  local.writeUInt16LE(method, 8);
  local.writeUInt32LE(data.length, 18);
  local.writeUInt32LE(content.length, 22);
  local.writeUInt16LE(nameBytes.length, 26);
  const central = Buffer.alloc(46);
  central.writeUInt32LE(0x02014b50, 0);
  central.writeUInt16LE(method, 10);
  central.writeUInt32LE(data.length, 20);
  central.writeUInt32LE(content.length, 24);
  central.writeUInt16LE(nameBytes.length, 28);
  central.writeUInt32LE(0, 42);
  const centralOffset = local.length + nameBytes.length + data.length;
  const end = Buffer.alloc(22);
  end.writeUInt32LE(0x06054b50, 0);
  end.writeUInt16LE(1, 8);
  end.writeUInt16LE(1, 10);
  end.writeUInt32LE(central.length + nameBytes.length, 12);
  end.writeUInt32LE(centralOffset, 16);
  return Buffer.concat([local, nameBytes, data, central, nameBytes, end]);
}

describe('parseResultArtifact', () => {
  it('reads the three check outcomes', () => {
    expect(parseResultArtifact(json(good))).toEqual({ ok: true, checks: good.checks });
  });

  it('reads the same file delivered zipped, stored or deflated', () => {
    expect(parseResultArtifact(zipOf('compat-results/result.json', json(good)))).toEqual({ ok: true, checks: good.checks });
    expect(parseResultArtifact(zipOf('result.json', json(good), 0))).toEqual({ ok: true, checks: good.checks });
  });

  it('rejects anything but exactly the expected shape', () => {
    const cases = [
      { ...good, package: 'another-package' }, // the artifact may not say which cell it is
      { ...good, schemaVersion: 2 },
      { schemaVersion: 1, checks: { ...good.checks, extra: 'passed' } },
      { schemaVersion: 1, checks: { buildIos: 'passed', buildAndroid: 'passed' } },
      { schemaVersion: 1, checks: { ...good.checks, buildIos: 'yes' } },
      { schemaVersion: 1, checks: { ...good.checks, buildAndroid: 'none' } },
      [good],
      null,
    ];
    for (const value of cases) expect(parseResultArtifact(json(value)).ok, JSON.stringify(value)).toBe(false);
  });

  it('rejects oversized, non-JSON and non-UTF-8 content', () => {
    const padded = Buffer.from(JSON.stringify(good).replace('{', `{${' '.repeat(MAX_RESULT_BYTES)}`));
    expect(parseResultArtifact(padded)).toEqual({ ok: false, reason: `larger than ${MAX_RESULT_BYTES} bytes` });
    expect(parseResultArtifact(Buffer.from('status: passed')).ok).toBe(false);
    expect(parseResultArtifact(Buffer.from([0xff, 0xfe, 0x7b, 0x7d])).ok).toBe(false);
  });

  it('refuses a zip whose entry would inflate past the limit', () => {
    const bomb = zipOf('result.json', Buffer.alloc(MAX_RESULT_BYTES * 50, 0x20));
    const parsed = parseResultArtifact(bomb);
    expect(parsed.ok).toBe(false);
    expect(parsed.reason).toMatch(/larger than/);
  });

  it('refuses a zip without result.json', () => {
    expect(parseResultArtifact(zipOf('logs/tests.log', Buffer.from('x'))).reason).toMatch(/no matching file/);
  });
});

describe('readZipEntry', () => {
  it('rejects data that is not a zip archive', () => {
    expect(() => readZipEntry(Buffer.from('plain text, not a zip'), () => true, 100)).toThrow(/not a zip/);
  });
});
