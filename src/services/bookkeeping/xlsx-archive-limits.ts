/**
 * XLSX (ZIP) を展開する前の容量検査。圧縮後サイズだけでは ZIP bomb を防げないため、
 * central directory に記録された各 entry の展開後サイズも合計する。
 *
 * @implements SPEC-HOUSEHOLD-BOOKKEEPING-004 (spec/feature/household-bookkeeping.md)
 */

export const MAX_XLSX_BYTES = 8 * 1024 * 1024;
export const MAX_XLSX_UNCOMPRESSED_BYTES = 64 * 1024 * 1024;
export const MAX_XLSX_ENTRIES = 2_000;

const CENTRAL_FILE_HEADER = 0x02014b50;
const END_OF_CENTRAL_DIRECTORY = 0x06054b50;
const MAX_EOCD_SEARCH = 65_557;

export function assertSafeXlsxArchive(buf: Buffer): void {
  if (buf.length === 0 || buf.length > MAX_XLSX_BYTES) throw new Error("workbook size limit exceeded");

  const eocd = findEndOfCentralDirectory(buf);
  if (eocd < 0) throw new Error("invalid xlsx archive");
  if (buf.readUInt16LE(eocd + 4) !== 0 || buf.readUInt16LE(eocd + 6) !== 0) {
    throw new Error("multi-disk workbooks are not supported");
  }
  const entries = buf.readUInt16LE(eocd + 10);
  if (buf.readUInt16LE(eocd + 8) !== entries) throw new Error("invalid xlsx entry count");
  const directorySize = buf.readUInt32LE(eocd + 12);
  const directoryOffset = buf.readUInt32LE(eocd + 16);
  if (entries === 0xffff || directorySize === 0xffffffff || directoryOffset === 0xffffffff) {
    throw new Error("ZIP64 workbooks are not supported");
  }
  if (entries > MAX_XLSX_ENTRIES || directoryOffset + directorySize > eocd) {
    throw new Error("invalid or oversized xlsx archive");
  }

  let offset = directoryOffset;
  let uncompressedTotal = 0;
  for (let i = 0; i < entries; i++) {
    if (offset + 46 > eocd || buf.readUInt32LE(offset) !== CENTRAL_FILE_HEADER) {
      throw new Error("invalid xlsx central directory");
    }
    uncompressedTotal += buf.readUInt32LE(offset + 24);
    if (uncompressedTotal > MAX_XLSX_UNCOMPRESSED_BYTES) {
      throw new Error("workbook expanded size limit exceeded");
    }
    const nameLength = buf.readUInt16LE(offset + 28);
    const extraLength = buf.readUInt16LE(offset + 30);
    const commentLength = buf.readUInt16LE(offset + 32);
    offset += 46 + nameLength + extraLength + commentLength;
  }
  if (offset !== directoryOffset + directorySize) throw new Error("invalid xlsx central directory size");
}

function findEndOfCentralDirectory(buf: Buffer): number {
  const min = Math.max(0, buf.length - MAX_EOCD_SEARCH);
  for (let offset = buf.length - 22; offset >= min; offset--) {
    if (buf.readUInt32LE(offset) === END_OF_CENTRAL_DIRECTORY
      && offset + 22 + buf.readUInt16LE(offset + 20) === buf.length) return offset;
  }
  return -1;
}
