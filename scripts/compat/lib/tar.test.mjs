import { describe, expect, it } from 'vitest';
import { readTarFile } from './tar.mjs';

// Builds a minimal ustar archive in memory, the way npm pack writes one.
function tarEntry(name, content, type = '0') {
  const body = Buffer.from(content);
  const header = Buffer.alloc(512);
  header.write(name.slice(0, 100), 0);
  header.write('0000644\0', 100);
  header.write(`${body.length.toString(8).padStart(11, '0')}\0`, 124);
  header.write(type, 156);
  header.write('ustar\0', 257);
  const padding = Buffer.alloc((512 - (body.length % 512)) % 512);
  return Buffer.concat([header, body, padding]);
}

describe('readTarFile', () => {
  const archive = Buffer.concat([
    tarEntry('package/package.json', '{"name":"expo"}'),
    tarEntry('package/bundledNativeModules.json', '{"react-native":"0.86.3"}'),
    Buffer.alloc(1024),
  ]);

  it('finds a file by its full path', () => {
    expect(readTarFile(archive, 'package/bundledNativeModules.json')?.toString()).toBe('{"react-native":"0.86.3"}');
  });

  it('returns null for a missing file', () => {
    expect(readTarFile(archive, 'package/missing.json')).toBeNull();
  });

  it('follows GNU long names', () => {
    const long = `package/${'deep/'.repeat(25)}template/package.json`;
    const withLongName = Buffer.concat([tarEntry('././@LongLink', long, 'L'), tarEntry(long.slice(0, 99), '{"ok":true}'), Buffer.alloc(1024)]);
    expect(readTarFile(withLongName, long)?.toString()).toBe('{"ok":true}');
  });
});
