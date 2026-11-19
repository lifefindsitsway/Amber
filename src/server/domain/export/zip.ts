import { crc32 } from "node:zlib";

/**
 * A minimal zip writer for exports that bundle a document with its images: classic zip
 * (no zip64), every entry stored without compression, UTF-8 names flagged as such. The
 * images are already compressed and the document is small, so deflate would buy little and
 * stored entries keep the writer to Node's built-in `crc32`.
 *
 * Classic zip records sizes, offsets and the entry count in 32 and 16 bits, and the all-ones
 * values mean "look in the zip64 record", so the largest usable values are one less. An
 * archive that would pass them is refused before its first byte (`checkZip`), or, for an
 * entry source that only reveals its sizes as it goes, before the entry that would pass them;
 * a refused or failed archive never gets its central directory, so no reader takes it for a
 * whole one.
 */

/** Largest entry count classic zip can record (0xffff means zip64). */
export const ZIP_MAX_ENTRIES = 0xfffe;
/** Largest size or offset classic zip can record (0xffffffff means zip64). */
export const ZIP_MAX_OFFSET = 0xfffffffe;
/** Longest entry name in bytes. */
const ZIP_MAX_NAME_BYTES = 0xffff;

export interface ZipEntry {
  /** Path inside the archive with `/` separators, relative, without `.` or `..` segments. */
  name: string;
  data: Uint8Array;
}

/** Bounds an archive must stay within; the format's own by default, smaller ones in tests. */
export interface ZipLimits {
  entries: number;
  /** Largest offset of any record, which bounds every entry size too. */
  offset: number;
}

const FORMAT_LIMITS: ZipLimits = { entries: ZIP_MAX_ENTRIES, offset: ZIP_MAX_OFFSET };

export type ZipLimitReason = "entries" | "size" | "name";

/** The archive would not fit classic zip, or an entry name is unusable. Nothing has been written for it. */
export class ZipLimitError extends Error {
  readonly reason: ZipLimitReason;

  constructor(reason: ZipLimitReason, message: string) {
    super(message);
    this.name = "ZipLimitError";
    this.reason = reason;
  }
}

const LOCAL_HEADER_BYTES = 30;
const CENTRAL_HEADER_BYTES = 46;
const END_RECORD_BYTES = 22;
/** Version 2.0: the lowest that knows directories and stored entries. */
const VERSION = 20;
/**
 * "Version made by": Unix (3) in the high byte. Some unzip builds (Debian's) recode the names of
 * entries made on MS-DOS (0) through the locale's code page even when they are flagged UTF-8,
 * which garbles Chinese titles; Windows Explorer and 7-Zip go by the UTF-8 flag either way.
 */
const MADE_BY = (3 << 8) | VERSION;
/** Unix external attributes of a regular file readable by all (`0100644`), in the high 16 bits. */
const FILE_ATTRIBUTES = 0o100644 * 0x10000;
/** General purpose flag bit 11: the name is UTF-8. */
const UTF8_FLAG = 0x0800;
const STORED = 0;

function nameBytes(name: string): Buffer {
  const segments = name.split("/");
  if (
    name === "" ||
    name.startsWith("/") ||
    name.includes("\\") ||
    /[\u0000-\u001f\u007f]/u.test(name) ||
    segments.some((segment) => segment === "" || segment === "." || segment === "..")
  ) {
    throw new ZipLimitError("name", `unusable zip entry name: ${JSON.stringify(name)}`);
  }
  const bytes = Buffer.from(name, "utf8");
  if (bytes.length > ZIP_MAX_NAME_BYTES) {
    throw new ZipLimitError("name", "zip entry name too long");
  }
  return bytes;
}

/**
 * The archive's size in bytes for entries of these names and sizes, or `ZipLimitError` when
 * it would not fit: too many entries, an offset past the limit, or a bad or repeated name.
 * Run it before the first byte of a response so a refusal can still be an ordinary error.
 */
export function checkZip(entries: ReadonlyArray<{ name: string; size: number }>, limits: ZipLimits = FORMAT_LIMITS): number {
  if (entries.length > limits.entries) {
    throw new ZipLimitError("entries", `a zip holds at most ${limits.entries} entries`);
  }
  const seen = new Set<string>();
  let offset = 0;
  let central = 0;
  for (const entry of entries) {
    const name = nameBytes(entry.name);
    if (seen.has(entry.name)) {
      throw new ZipLimitError("name", `repeated zip entry name: ${JSON.stringify(entry.name)}`);
    }
    seen.add(entry.name);
    if (offset > limits.offset) {
      throw new ZipLimitError("size", "zip archive too large");
    }
    offset += LOCAL_HEADER_BYTES + name.length + entry.size;
    central += CENTRAL_HEADER_BYTES + name.length;
  }
  // The central directory starts where the last entry ends and is itself bounded.
  if (offset > limits.offset || central > limits.offset) {
    throw new ZipLimitError("size", "zip archive too large");
  }
  return offset + central + END_RECORD_BYTES;
}

/** MS-DOS date and time of `epochMs` in the process's time zone, as zip tools show them; 1980 at the earliest. */
function dosDateTime(epochMs: number): { date: number; time: number } {
  const at = new Date(epochMs);
  if (at.getFullYear() < 1980) {
    return { date: (1 << 5) | 1, time: 0 };
  }
  const year = Math.min(at.getFullYear(), 2107) - 1980;
  return {
    date: (year << 9) | ((at.getMonth() + 1) << 5) | at.getDate(),
    time: (at.getHours() << 11) | (at.getMinutes() << 5) | Math.floor(at.getSeconds() / 2),
  };
}

interface Written {
  name: Buffer;
  crc: number;
  size: number;
  offset: number;
}

/**
 * The archive's bytes, entry by entry, then the central directory. `entries` may be an
 * array, checked whole before the first byte, or an async source that produces entries as
 * the archive is read; then each is checked as it arrives, and an entry that would pass the
 * limits, or a source that fails, ends the stream with that error and without a central
 * directory.
 */
export async function* zipStream(
  entries: Iterable<ZipEntry> | AsyncIterable<ZipEntry>,
  options: { modifiedAt: number; limits?: ZipLimits },
): AsyncGenerator<Uint8Array> {
  const limits = options.limits ?? FORMAT_LIMITS;
  if (Array.isArray(entries)) {
    checkZip(
      (entries as readonly ZipEntry[]).map((entry) => ({ name: entry.name, size: entry.data.length })),
      limits,
    );
  }
  const { date, time } = dosDateTime(options.modifiedAt);
  const written: Written[] = [];
  const seen = new Set<string>();
  let offset = 0;
  for await (const entry of entries) {
    const name = nameBytes(entry.name);
    if (seen.has(entry.name)) {
      throw new ZipLimitError("name", `repeated zip entry name: ${JSON.stringify(entry.name)}`);
    }
    if (written.length + 1 > limits.entries) {
      throw new ZipLimitError("entries", `a zip holds at most ${limits.entries} entries`);
    }
    if (offset > limits.offset || offset + LOCAL_HEADER_BYTES + name.length + entry.data.length > limits.offset) {
      throw new ZipLimitError("size", "zip archive too large");
    }
    seen.add(entry.name);
    const crc = crc32(entry.data);
    const header = Buffer.alloc(LOCAL_HEADER_BYTES);
    header.writeUInt32LE(0x04034b50, 0);
    header.writeUInt16LE(VERSION, 4);
    header.writeUInt16LE(UTF8_FLAG, 6);
    header.writeUInt16LE(STORED, 8);
    header.writeUInt16LE(time, 10);
    header.writeUInt16LE(date, 12);
    header.writeUInt32LE(crc, 14);
    header.writeUInt32LE(entry.data.length, 18);
    header.writeUInt32LE(entry.data.length, 22);
    header.writeUInt16LE(name.length, 26);
    header.writeUInt16LE(0, 28);
    written.push({ name, crc, size: entry.data.length, offset });
    offset += LOCAL_HEADER_BYTES + name.length + entry.data.length;
    yield Buffer.concat([header, name]);
    if (entry.data.length > 0) {
      yield entry.data;
    }
  }
  const centralStart = offset;
  const records: Buffer[] = [];
  for (const entry of written) {
    const record = Buffer.alloc(CENTRAL_HEADER_BYTES);
    record.writeUInt32LE(0x02014b50, 0);
    record.writeUInt16LE(MADE_BY, 4);
    record.writeUInt16LE(VERSION, 6);
    record.writeUInt16LE(UTF8_FLAG, 8);
    record.writeUInt16LE(STORED, 10);
    record.writeUInt16LE(time, 12);
    record.writeUInt16LE(date, 14);
    record.writeUInt32LE(entry.crc, 16);
    record.writeUInt32LE(entry.size, 20);
    record.writeUInt32LE(entry.size, 24);
    record.writeUInt16LE(entry.name.length, 28);
    // Extra field, comment, disk number and internal attributes: none.
    record.writeUInt32LE(FILE_ATTRIBUTES, 38);
    record.writeUInt32LE(entry.offset, 42);
    records.push(record, entry.name);
  }
  const central = Buffer.concat(records);
  if (centralStart > limits.offset || central.length > limits.offset) {
    throw new ZipLimitError("size", "zip archive too large");
  }
  const end = Buffer.alloc(END_RECORD_BYTES);
  end.writeUInt32LE(0x06054b50, 0);
  end.writeUInt16LE(written.length, 8);
  end.writeUInt16LE(written.length, 10);
  end.writeUInt32LE(central.length, 12);
  end.writeUInt32LE(centralStart, 16);
  yield Buffer.concat([central, end]);
}
