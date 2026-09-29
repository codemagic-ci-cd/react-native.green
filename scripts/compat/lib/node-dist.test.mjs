import { createHash } from 'node:crypto';
import { describe, expect, it } from 'vitest';
import { archiveName, checksumOf, matchesSetting, pickRelease, platformOf, verifyArchive } from './node-dist.mjs';

describe('matchesSetting', () => {
  it('matches on as many parts as the setting gives', () => {
    expect(matchesSetting('v24.9.0', '24')).toBe(true);
    expect(matchesSetting('v24.9.0', '24.9')).toBe(true);
    expect(matchesSetting('v24.9.0', '24.9.0')).toBe(true);
    expect(matchesSetting('v24.9.0', '24.1')).toBe(false);
    expect(matchesSetting('v22.14.0', '24')).toBe(false);
    expect(matchesSetting('v2.4.0', '24')).toBe(false);
  });
});

describe('pickRelease', () => {
  const index = [
    { version: 'v25.0.0', files: ['osx-arm64-tar', 'linux-x64'] },
    { version: 'v24.10.0', files: ['linux-x64'] },
    { version: 'v24.9.1', files: ['osx-arm64-tar', 'linux-x64'] },
    { version: 'v24.9.0', files: ['osx-arm64-tar', 'linux-x64'] },
    { version: 'v22.20.0', files: ['osx-arm64-tar', 'linux-x64'] },
  ];

  it('takes the newest matching release that has an archive for the machine', () => {
    expect(pickRelease(index, '24', 'darwin-arm64')).toBe('v24.9.1');
    expect(pickRelease(index, '24', 'linux-x64')).toBe('v24.10.0');
    expect(pickRelease(index, '24.9.0', 'darwin-arm64')).toBe('v24.9.0');
    expect(pickRelease(index, '23', 'darwin-arm64')).toBeNull();
  });

  it('names archives the way nodejs.org does', () => {
    expect(archiveName('v24.9.1', 'darwin-arm64')).toBe('node-v24.9.1-darwin-arm64.tar.gz');
    expect(platformOf('darwin', 'arm64')).toBe('darwin-arm64');
    expect(platformOf('linux', 'x64')).toBe('linux-x64');
    expect(() => platformOf('win32', 'x64')).toThrow(/no Node download/);
  });
});

describe('verifyArchive', () => {
  const bytes = Buffer.from('an archive');
  const sum = createHash('sha256').update(bytes).digest('hex');
  const shasums = `${'0'.repeat(64)}  node-v24.9.1-linux-x64.tar.gz\n${sum}  node-v24.9.1-darwin-arm64.tar.gz\n`;

  it('accepts the archive SHASUMS256.txt lists', () => {
    expect(checksumOf(shasums, 'node-v24.9.1-darwin-arm64.tar.gz')).toBe(sum);
    expect(() => verifyArchive(bytes, shasums, 'node-v24.9.1-darwin-arm64.tar.gz')).not.toThrow();
  });

  it('refuses a changed archive and one that is not listed', () => {
    expect(() => verifyArchive(Buffer.from('another archive'), shasums, 'node-v24.9.1-darwin-arm64.tar.gz')).toThrow(/does not match/);
    expect(() => verifyArchive(bytes, shasums, 'node-v24.9.1-linux-x64.tar.gz')).toThrow(/does not match/);
    expect(() => verifyArchive(bytes, shasums, 'node-v24.9.1-darwin-x64.tar.gz')).toThrow(/does not list/);
  });
});
