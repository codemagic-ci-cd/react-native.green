// Reads one file out of an uncompressed tar archive (npm tarballs, after gunzip). Handles the ustar
// name prefix and pax/GNU long names, which is all npm tarballs use.
const BLOCK = 512;

const text = (buffer, start, length) => {
  const end = buffer.indexOf(0, start);
  return buffer.toString('utf8', start, end === -1 || end > start + length ? start + length : end);
};

/** @returns {Buffer | null} the contents of `path`, or null when the archive has no such file */
export function readTarFile(archive, path) {
  let offset = 0;
  let longName = null;
  while (offset + BLOCK <= archive.length) {
    const header = archive.subarray(offset, offset + BLOCK);
    if (header.every((byte) => byte === 0)) return null; // end of archive

    const size = parseInt(text(header, 124, 12).trim() || '0', 8);
    const type = String.fromCharCode(header[156] || 48);
    const prefix = text(header, 345, 155);
    const name = longName ?? (prefix ? `${prefix}/${text(header, 0, 100)}` : text(header, 0, 100));
    const body = archive.subarray(offset + BLOCK, offset + BLOCK + size);
    offset += BLOCK + Math.ceil(size / BLOCK) * BLOCK;
    longName = null;

    if (type === 'L') {
      longName = body.toString('utf8').replace(/\0.*$/s, '');
    } else if (type === 'x') {
      const pathRecord = /\d+ path=([^\n]*)\n/.exec(body.toString('utf8'));
      if (pathRecord) longName = pathRecord[1];
    } else if ((type === '0' || type === '\0') && name === path) {
      return Buffer.from(body);
    }
  }
  return null;
}
