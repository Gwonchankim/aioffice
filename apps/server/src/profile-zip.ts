/**
 * Dependency-free, store-only (uncompressed) ZIP writer and reader used to
 * package agent-profile export/import bundles. All operations are pure
 * `Buffer` math; nothing touches the filesystem. The reader is deliberately
 * strict: every entry that does not match the exact shape produced by
 * `writeStoreZip` is rejected with an explicit reason.
 */

const LOCAL_FILE_HEADER_SIGNATURE = 0x04034b50;
const CENTRAL_DIRECTORY_SIGNATURE = 0x02014b50;
const END_OF_CENTRAL_DIRECTORY_SIGNATURE = 0x06054b50;
const ZIP64_END_OF_CENTRAL_DIRECTORY_SIGNATURE = 0x06064b50;
const ZIP64_END_OF_CENTRAL_DIRECTORY_LOCATOR_SIGNATURE = 0x07064b50;

const UTF8_FLAG = 0x0800;
const DATA_DESCRIPTOR_FLAG = 0x0008;
const STORE_METHOD = 0;
const VERSION_NEEDED = 20;
const VERSION_MADE_BY = 20;
const ZIP64_MARKER = 0xffffffff;

/** Regular file, rw-r--r-- (0o100644), placed in the high 16 bits per the Unix external-attributes convention. */
const UNIX_REGULAR_FILE_EXTERNAL_ATTRIBUTES = (0o100644 << 16) >>> 0;
const S_IFMT = 0xf000;
const S_IFLNK = 0xa000;

const MAX_ENTRY_NAME_LENGTH = 256;
const MAX_ENTRY_UNCOMPRESSED_SIZE = 5 * 1024 * 1024;
const MAX_TOTAL_UNCOMPRESSED_SIZE = 50 * 1024 * 1024;

export interface ZipEntryInput {
  readonly name: string;
  readonly data: Buffer;
}

export interface ZipEntryOutput {
  readonly name: string;
  readonly data: Buffer;
}

export class ZipValidationError extends Error {
  public constructor(message: string) {
    super(message);
    this.name = 'ZipValidationError';
  }
}

const crc32Table = buildCrc32Table();

function buildCrc32Table(): Uint32Array {
  const table = new Uint32Array(256);
  for (let index = 0; index < 256; index += 1) {
    let value = index;
    for (let bit = 0; bit < 8; bit += 1) {
      value = value & 1 ? (value >>> 1) ^ 0xedb88320 : value >>> 1;
    }
    table[index] = value >>> 0;
  }
  return table;
}

function crc32(data: Buffer): number {
  let crc = 0xffffffff;
  for (let index = 0; index < data.length; index += 1) {
    crc = crc32Table[(crc ^ data[index]!) & 0xff]! ^ (crc >>> 8);
  }
  return (crc ^ 0xffffffff) >>> 0;
}

function assertValidEntryName(name: string): void {
  const nameBytes = Buffer.byteLength(name, 'utf8');
  if (nameBytes === 0 || nameBytes > MAX_ENTRY_NAME_LENGTH) {
    throw new ZipValidationError(
      `Entry name "${name}" must be between 1 and ${MAX_ENTRY_NAME_LENGTH} UTF-8 bytes.`,
    );
  }
  if (name.includes('\u0000')) {
    throw new ZipValidationError(`Entry name "${name}" contains a NUL byte.`);
  }
  if (name.includes('\\')) {
    throw new ZipValidationError(`Entry name "${name}" contains a backslash.`);
  }
  if (name.includes(':')) {
    throw new ZipValidationError(`Entry name "${name}" contains a colon.`);
  }
  if (name.startsWith('/')) {
    throw new ZipValidationError(`Entry name "${name}" is an absolute or leading-slash path.`);
  }
  if (/^[A-Za-z]:/.test(name)) {
    throw new ZipValidationError(`Entry name "${name}" is an absolute drive path.`);
  }
  if (name.split('/').some((segment) => segment === '..')) {
    throw new ZipValidationError(`Entry name "${name}" contains a ".." path segment.`);
  }
}

/**
 * Writes a minimal, spec-compliant store-only ZIP archive: local file
 * headers immediately followed by their data, then a central directory, then
 * a single-disk end-of-central-directory record. No compression, no data
 * descriptors, no ZIP64 extensions.
 */
export function writeStoreZip(entries: readonly ZipEntryInput[]): Buffer {
  const seenLowerCaseNames = new Set<string>();
  for (const entry of entries) {
    assertValidEntryName(entry.name);
    const lowerCaseName = entry.name.toLowerCase();
    if (seenLowerCaseNames.has(lowerCaseName)) {
      throw new ZipValidationError(`Duplicate entry name (case-insensitive): "${entry.name}".`);
    }
    seenLowerCaseNames.add(lowerCaseName);
    if (entry.data.length > MAX_ENTRY_UNCOMPRESSED_SIZE) {
      throw new ZipValidationError(`Entry "${entry.name}" exceeds the 5MB per-entry limit.`);
    }
  }

  const localChunks: Buffer[] = [];
  const centralChunks: Buffer[] = [];
  let offset = 0;
  let totalUncompressedSize = 0;

  for (const entry of entries) {
    const nameBuffer = Buffer.from(entry.name, 'utf8');
    const crc = crc32(entry.data);
    totalUncompressedSize += entry.data.length;

    const localHeader = Buffer.alloc(30);
    localHeader.writeUInt32LE(LOCAL_FILE_HEADER_SIGNATURE, 0);
    localHeader.writeUInt16LE(VERSION_NEEDED, 4);
    localHeader.writeUInt16LE(UTF8_FLAG, 6);
    localHeader.writeUInt16LE(STORE_METHOD, 8);
    localHeader.writeUInt16LE(0, 10); // last mod file time
    localHeader.writeUInt16LE(0, 12); // last mod file date
    localHeader.writeUInt32LE(crc, 14);
    localHeader.writeUInt32LE(entry.data.length, 18); // compressed size == uncompressed (store)
    localHeader.writeUInt32LE(entry.data.length, 22);
    localHeader.writeUInt16LE(nameBuffer.length, 26);
    localHeader.writeUInt16LE(0, 28); // extra field length

    localChunks.push(localHeader, nameBuffer, entry.data);

    const centralHeader = Buffer.alloc(46);
    centralHeader.writeUInt32LE(CENTRAL_DIRECTORY_SIGNATURE, 0);
    centralHeader.writeUInt16LE(VERSION_MADE_BY, 4);
    centralHeader.writeUInt16LE(VERSION_NEEDED, 6);
    centralHeader.writeUInt16LE(UTF8_FLAG, 8);
    centralHeader.writeUInt16LE(STORE_METHOD, 10);
    centralHeader.writeUInt16LE(0, 12);
    centralHeader.writeUInt16LE(0, 14);
    centralHeader.writeUInt32LE(crc, 16);
    centralHeader.writeUInt32LE(entry.data.length, 20);
    centralHeader.writeUInt32LE(entry.data.length, 24);
    centralHeader.writeUInt16LE(nameBuffer.length, 28);
    centralHeader.writeUInt16LE(0, 30); // extra field length
    centralHeader.writeUInt16LE(0, 32); // comment length
    centralHeader.writeUInt16LE(0, 34); // disk number start
    centralHeader.writeUInt16LE(0, 36); // internal attributes
    centralHeader.writeUInt32LE(UNIX_REGULAR_FILE_EXTERNAL_ATTRIBUTES, 38);
    centralHeader.writeUInt32LE(offset, 42);

    centralChunks.push(centralHeader, nameBuffer);

    offset += localHeader.length + nameBuffer.length + entry.data.length;
  }

  if (totalUncompressedSize > MAX_TOTAL_UNCOMPRESSED_SIZE) {
    throw new ZipValidationError('Archive contents exceed the 50MB total size limit.');
  }

  const centralDirectory = Buffer.concat(centralChunks);
  const centralDirectoryOffset = offset;

  const eocd = Buffer.alloc(22);
  eocd.writeUInt32LE(END_OF_CENTRAL_DIRECTORY_SIGNATURE, 0);
  eocd.writeUInt16LE(0, 4);
  eocd.writeUInt16LE(0, 6);
  eocd.writeUInt16LE(entries.length, 8);
  eocd.writeUInt16LE(entries.length, 10);
  eocd.writeUInt32LE(centralDirectory.length, 12);
  eocd.writeUInt32LE(centralDirectoryOffset, 16);
  eocd.writeUInt16LE(0, 20); // comment length

  return Buffer.concat([...localChunks, centralDirectory, eocd]);
}

interface CentralDirectoryEntry {
  readonly name: string;
  readonly generalPurposeFlag: number;
  readonly method: number;
  readonly crc32: number;
  readonly compressedSize: number;
  readonly uncompressedSize: number;
  readonly externalAttributes: number;
  readonly localHeaderOffset: number;
}

function findEndOfCentralDirectory(buffer: Buffer): number {
  const minimumLength = 22;
  if (buffer.length < minimumLength) {
    throw new ZipValidationError(
      'Archive is too small to contain an end-of-central-directory record.',
    );
  }
  const maxCommentLength = Math.min(0xffff, buffer.length - minimumLength);
  for (let commentLength = 0; commentLength <= maxCommentLength; commentLength += 1) {
    const offset = buffer.length - minimumLength - commentLength;
    if (buffer.readUInt32LE(offset) === END_OF_CENTRAL_DIRECTORY_SIGNATURE) {
      const declaredCommentLength = buffer.readUInt16LE(offset + 20);
      if (declaredCommentLength === commentLength) {
        return offset;
      }
    }
  }
  throw new ZipValidationError('Archive end-of-central-directory record was not found.');
}

function assertNoZip64Markers(buffer: Buffer): void {
  if (buffer.length < 4) {
    return;
  }
  for (let offset = 0; offset <= buffer.length - 4; offset += 1) {
    const signature = buffer.readUInt32LE(offset);
    if (
      signature === ZIP64_END_OF_CENTRAL_DIRECTORY_SIGNATURE ||
      signature === ZIP64_END_OF_CENTRAL_DIRECTORY_LOCATOR_SIGNATURE
    ) {
      throw new ZipValidationError('Archive declares an unsupported ZIP64 record.');
    }
  }
}

/**
 * Reads and exhaustively validates a store-only ZIP archive. Every rejection
 * reason is explicit: unsupported compression, data descriptors, ZIP64
 * markers/sentinels, oversized entries or archive, declared/actual size or
 * CRC mismatches, unsafe entry names, case-insensitive duplicate names, and
 * symlink external attributes.
 */
export function readStoreZip(buffer: Buffer): readonly ZipEntryOutput[] {
  assertNoZip64Markers(buffer);

  const eocdOffset = findEndOfCentralDirectory(buffer);
  const diskNumber = buffer.readUInt16LE(eocdOffset + 4);
  const centralDirectoryStartDisk = buffer.readUInt16LE(eocdOffset + 6);
  const entriesOnThisDisk = buffer.readUInt16LE(eocdOffset + 8);
  const totalEntries = buffer.readUInt16LE(eocdOffset + 10);
  const centralDirectorySize = buffer.readUInt32LE(eocdOffset + 12);
  const centralDirectoryOffset = buffer.readUInt32LE(eocdOffset + 16);

  if (diskNumber !== 0 || centralDirectoryStartDisk !== 0 || entriesOnThisDisk !== totalEntries) {
    throw new ZipValidationError('Archive declares an unsupported multi-disk layout.');
  }
  if (centralDirectorySize === ZIP64_MARKER || centralDirectoryOffset === ZIP64_MARKER) {
    throw new ZipValidationError('Archive declares an unsupported ZIP64 sentinel value.');
  }
  if (centralDirectoryOffset + centralDirectorySize > eocdOffset) {
    throw new ZipValidationError('Archive central directory extends past the declared end.');
  }

  const centralEntries: CentralDirectoryEntry[] = [];
  let cursor = centralDirectoryOffset;
  for (let index = 0; index < totalEntries; index += 1) {
    if (cursor + 46 > buffer.length) {
      throw new ZipValidationError('Archive central directory record is truncated.');
    }
    if (buffer.readUInt32LE(cursor) !== CENTRAL_DIRECTORY_SIGNATURE) {
      throw new ZipValidationError('Archive central directory record has an invalid signature.');
    }
    const generalPurposeFlag = buffer.readUInt16LE(cursor + 8);
    const method = buffer.readUInt16LE(cursor + 10);
    const crcValue = buffer.readUInt32LE(cursor + 16);
    const compressedSize = buffer.readUInt32LE(cursor + 20);
    const uncompressedSize = buffer.readUInt32LE(cursor + 24);
    const nameLength = buffer.readUInt16LE(cursor + 28);
    const extraLength = buffer.readUInt16LE(cursor + 30);
    const commentLength = buffer.readUInt16LE(cursor + 32);
    const externalAttributes = buffer.readUInt32LE(cursor + 38);
    const localHeaderOffset = buffer.readUInt32LE(cursor + 42);

    if (
      compressedSize === ZIP64_MARKER ||
      uncompressedSize === ZIP64_MARKER ||
      localHeaderOffset === ZIP64_MARKER
    ) {
      throw new ZipValidationError('Archive entry declares an unsupported ZIP64 sentinel value.');
    }

    const nameStart = cursor + 46;
    if (nameStart + nameLength > buffer.length) {
      throw new ZipValidationError('Archive central directory entry name is truncated.');
    }
    const name = buffer.subarray(nameStart, nameStart + nameLength).toString('utf8');

    centralEntries.push({
      name,
      generalPurposeFlag,
      method,
      crc32: crcValue,
      compressedSize,
      uncompressedSize,
      externalAttributes,
      localHeaderOffset,
    });

    cursor = nameStart + nameLength + extraLength + commentLength;
  }

  const seenLowerCaseNames = new Set<string>();
  let totalUncompressedSize = 0;
  const results: ZipEntryOutput[] = [];

  for (const entry of centralEntries) {
    assertValidEntryName(entry.name);

    if (entry.method !== STORE_METHOD) {
      throw new ZipValidationError(`Entry "${entry.name}" uses an unsupported compression method.`);
    }
    if ((entry.generalPurposeFlag & DATA_DESCRIPTOR_FLAG) !== 0) {
      throw new ZipValidationError(`Entry "${entry.name}" uses an unsupported data descriptor.`);
    }
    if (entry.compressedSize !== entry.uncompressedSize) {
      throw new ZipValidationError(
        `Entry "${entry.name}" declares mismatched compressed/uncompressed sizes for a stored entry.`,
      );
    }
    if (entry.uncompressedSize > MAX_ENTRY_UNCOMPRESSED_SIZE) {
      throw new ZipValidationError(`Entry "${entry.name}" exceeds the 5MB per-entry limit.`);
    }
    if ((entry.externalAttributes >>> 16) & S_IFMT) {
      const fileType = (entry.externalAttributes >>> 16) & S_IFMT;
      if (fileType === S_IFLNK) {
        throw new ZipValidationError(`Entry "${entry.name}" is a symlink, which is not permitted.`);
      }
    }

    const lowerCaseName = entry.name.toLowerCase();
    if (seenLowerCaseNames.has(lowerCaseName)) {
      throw new ZipValidationError(`Duplicate entry name (case-insensitive): "${entry.name}".`);
    }
    seenLowerCaseNames.add(lowerCaseName);

    if (entry.localHeaderOffset + 30 > buffer.length) {
      throw new ZipValidationError(`Entry "${entry.name}" local header is truncated.`);
    }
    if (buffer.readUInt32LE(entry.localHeaderOffset) !== LOCAL_FILE_HEADER_SIGNATURE) {
      throw new ZipValidationError(`Entry "${entry.name}" local header has an invalid signature.`);
    }
    const localFlag = buffer.readUInt16LE(entry.localHeaderOffset + 6);
    const localMethod = buffer.readUInt16LE(entry.localHeaderOffset + 8);
    const localCrc = buffer.readUInt32LE(entry.localHeaderOffset + 14);
    const localCompressedSize = buffer.readUInt32LE(entry.localHeaderOffset + 18);
    const localUncompressedSize = buffer.readUInt32LE(entry.localHeaderOffset + 22);
    const localNameLength = buffer.readUInt16LE(entry.localHeaderOffset + 26);
    const localExtraLength = buffer.readUInt16LE(entry.localHeaderOffset + 28);

    if ((localFlag & DATA_DESCRIPTOR_FLAG) !== 0) {
      throw new ZipValidationError(
        `Entry "${entry.name}" local header uses an unsupported data descriptor.`,
      );
    }
    if (localMethod !== STORE_METHOD) {
      throw new ZipValidationError(
        `Entry "${entry.name}" local header uses an unsupported compression method.`,
      );
    }

    const nameStart = entry.localHeaderOffset + 30;
    if (nameStart + localNameLength > buffer.length) {
      throw new ZipValidationError(`Entry "${entry.name}" local header name is truncated.`);
    }
    const localName = buffer.subarray(nameStart, nameStart + localNameLength).toString('utf8');
    if (localName !== entry.name) {
      throw new ZipValidationError(
        `Entry "${entry.name}" local header name does not match the central directory.`,
      );
    }
    if (
      localCompressedSize !== entry.compressedSize ||
      localUncompressedSize !== entry.uncompressedSize ||
      localCrc !== entry.crc32
    ) {
      throw new ZipValidationError(
        `Entry "${entry.name}" declared size or CRC does not match between the local and central headers.`,
      );
    }

    const dataStart = nameStart + localNameLength + localExtraLength;
    const dataEnd = dataStart + entry.uncompressedSize;
    if (dataEnd > buffer.length) {
      throw new ZipValidationError(`Entry "${entry.name}" data is truncated.`);
    }
    const data = Buffer.from(buffer.subarray(dataStart, dataEnd));
    if (data.length !== entry.uncompressedSize) {
      throw new ZipValidationError(
        `Entry "${entry.name}" declared size does not match the actual data length.`,
      );
    }

    const actualCrc = crc32(data);
    if (actualCrc !== entry.crc32) {
      throw new ZipValidationError(`Entry "${entry.name}" CRC-32 does not match the actual data.`);
    }

    totalUncompressedSize += data.length;
    if (totalUncompressedSize > MAX_TOTAL_UNCOMPRESSED_SIZE) {
      throw new ZipValidationError('Archive contents exceed the 50MB total size limit.');
    }

    results.push({ name: entry.name, data });
  }

  return results;
}
