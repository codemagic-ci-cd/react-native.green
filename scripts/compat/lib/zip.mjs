// Reads one small file out of a zip archive (for artifacts a server may deliver zipped). Refuses
// anything larger than `maxBytes` before inflating it, so a hostile archive cannot blow up memory.
import { inflateRawSync } from 'node:zlib';

const END_OF_CENTRAL_DIRECTORY = 0x06054b50;
const CENTRAL_ENTRY = 0x02014b50;
const LOCAL_HEADER = 0x04034b50;

export const isZip = (bytes) => bytes.length >= 4 && bytes.readUInt32LE(0) === LOCAL_HEADER;

/**
 * @param {Buffer} archive
 * @param {(name: string) => boolean} wanted  picks the entry by its path in the archive
 * @returns {Buffer} the entry's contents
 * @throws when the archive is malformed, has no such entry, or the entry is too large
 */
export function readZipEntry(archive, wanted, maxBytes) {
  // The end-of-central-directory record is at the end, before an optional comment of up to 64 KiB.
  let end = -1;
  for (let i = archive.length - 22; i >= Math.max(0, archive.length - 22 - 0xffff); i -= 1) {
    if (archive.readUInt32LE(i) === END_OF_CENTRAL_DIRECTORY) {
      end = i;
      break;
    }
  }
  if (end < 0) throw new Error('not a zip archive');

  const count = archive.readUInt16LE(end + 10);
  let offset = archive.readUInt32LE(end + 16);
  for (let entry = 0; entry < count; entry += 1) {
    if (offset + 46 > archive.length || archive.readUInt32LE(offset) !== CENTRAL_ENTRY) throw new Error('corrupt zip directory');
    const method = archive.readUInt16LE(offset + 10);
    const compressedSize = archive.readUInt32LE(offset + 20);
    const size = archive.readUInt32LE(offset + 24);
    const nameLength = archive.readUInt16LE(offset + 28);
    const extraLength = archive.readUInt16LE(offset + 30);
    const commentLength = archive.readUInt16LE(offset + 32);
    const localOffset = archive.readUInt32LE(offset + 42);
    const name = archive.toString('utf8', offset + 46, offset + 46 + nameLength);
    offset += 46 + nameLength + extraLength + commentLength;
    if (!wanted(name)) continue;

    if (size > maxBytes || compressedSize > maxBytes) throw new Error(`${name} is larger than ${maxBytes} bytes`);
    if (localOffset + 30 > archive.length || archive.readUInt32LE(localOffset) !== LOCAL_HEADER) throw new Error('corrupt zip entry');
    const dataStart = localOffset + 30 + archive.readUInt16LE(localOffset + 26) + archive.readUInt16LE(localOffset + 28);
    const data = archive.subarray(dataStart, dataStart + compressedSize);
    if (data.length !== compressedSize) throw new Error('truncated zip entry');
    if (method === 0) return Buffer.from(data);
    if (method === 8) return inflateRawSync(data, { maxOutputLength: maxBytes });
    throw new Error(`unsupported zip compression method ${method}`);
  }
  throw new Error('no matching file in the zip archive');
}
