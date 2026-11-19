/**
 * The tar subset content packs use, written and read here rather than by npm `tar`: every
 * entry is one POSIX ustar header block for a regular file followed by its data, padded to
 * the block size, and the archive ends with two zero blocks. Reading never extracts
 * anything; it only parses headers, so an entry of any other type (links, directories, pax
 * or GNU extension headers) can be named and refused instead of being interpreted. Sizes too
 * large for the octal field use the GNU base-256 form, which GNU tar, bsdtar and 7-Zip read.
 */

export const TAR_BLOCK = 512;
/** The end-of-archive marker: two zero blocks. */
export const TAR_END_BYTES = TAR_BLOCK * 2;

const NAME_BYTES = 100;
const OCTAL_SIZE_MAX = 0o77777777777;
const encoder = new TextEncoder();
const decoder = new TextDecoder("utf-8", { fatal: true });

/** Bytes of padding after `size` bytes of data. */
export function tarPadding(size: number): number {
  const rest = size % TAR_BLOCK;
  return rest === 0 ? 0 : TAR_BLOCK - rest;
}

/** Bytes an entry of `size` data bytes occupies, header included. */
export function tarEntryBytes(size: number): number {
  return TAR_BLOCK + size + tarPadding(size);
}

function writeOctal(block: Uint8Array, offset: number, length: number, value: number): void {
  const text = value.toString(8).padStart(length - 1, "0");
  block.set(encoder.encode(text), offset);
  block[offset + length - 1] = 0;
}

/** Big-endian base-256 with the high bit of the first byte set (GNU). */
function writeBase256(block: Uint8Array, offset: number, length: number, value: number): void {
  let rest = BigInt(value);
  for (let index = length - 1; index > 0; index -= 1) {
    block[offset + index] = Number(rest & 0xffn);
    rest >>= 8n;
  }
  block[offset] = 0x80;
}

/** One ustar header block for a regular file `name` of `size` bytes. */
export function tarHeader(name: string, size: number, mtimeMs: number): Uint8Array {
  const nameBytes = encoder.encode(name);
  if (nameBytes.length > NAME_BYTES || nameBytes.includes(0)) {
    throw new RangeError("tar entry name does not fit the ustar name field");
  }
  if (!Number.isSafeInteger(size) || size < 0) {
    throw new RangeError("tar entry size is not a byte count");
  }
  const block = new Uint8Array(TAR_BLOCK);
  block.set(nameBytes, 0);
  writeOctal(block, 100, 8, 0o644);
  writeOctal(block, 108, 8, 0);
  writeOctal(block, 116, 8, 0);
  if (size > OCTAL_SIZE_MAX) {
    writeBase256(block, 124, 12, size);
  } else {
    writeOctal(block, 124, 12, size);
  }
  writeOctal(block, 136, 12, Math.max(0, Math.floor(mtimeMs / 1000)));
  block[156] = 0x30; // "0": regular file
  block.set(encoder.encode("ustar\u000000"), 257);
  writeOctal(block, 329, 8, 0);
  writeOctal(block, 337, 8, 0);
  block.fill(0x20, 148, 156);
  let sum = 0;
  for (const byte of block) sum += byte;
  writeOctal(block, 148, 7, sum);
  block[155] = 0x20;
  return block;
}

/** What a header block declares, or why it cannot be accepted. */
export type TarHeaderRead =
  | { kind: "end" }
  | { kind: "file"; name: string; size: number }
  | { kind: "refused"; reason: "link" | "directory" | "type" | "header" | "name"; name?: string };

function isZero(bytes: Uint8Array): boolean {
  for (const byte of bytes) {
    if (byte !== 0) return false;
  }
  return true;
}

function readNumber(field: Uint8Array): number | undefined {
  if ((field[0] ?? 0) & 0x80) {
    // A negative base-256 value (0xff lead) is never a size.
    if (field[0] !== 0x80) return undefined;
    let value = 0n;
    for (let index = 1; index < field.length; index += 1) {
      value = (value << 8n) | BigInt(field[index] ?? 0);
    }
    return value > BigInt(Number.MAX_SAFE_INTEGER) ? undefined : Number(value);
  }
  let text = "";
  for (const byte of field) {
    if (byte === 0 || byte === 0x20) {
      if (text !== "") break;
      continue;
    }
    if (byte < 0x30 || byte > 0x37) return undefined;
    text += String.fromCharCode(byte);
  }
  return text === "" ? 0 : Number.parseInt(text, 8);
}

function readText(field: Uint8Array): string | undefined {
  const end = field.indexOf(0);
  try {
    return decoder.decode(end < 0 ? field : field.subarray(0, end));
  } catch {
    return undefined;
  }
}

/**
 * Parses one header block. A zero block is the end marker. Only a ustar regular file with a
 * valid checksum, an empty prefix and an empty link name is a `file`.
 */
export function readTarHeader(block: Uint8Array): TarHeaderRead {
  if (block.length !== TAR_BLOCK) {
    return { kind: "refused", reason: "header" };
  }
  if (isZero(block)) {
    return { kind: "end" };
  }
  let sum = 0;
  for (let index = 0; index < TAR_BLOCK; index += 1) {
    sum += index >= 148 && index < 156 ? 0x20 : (block[index] as number);
  }
  const stored = readNumber(block.subarray(148, 156));
  const magic = readText(block.subarray(257, 263));
  const version = String.fromCharCode(block[263] as number, block[264] as number);
  if (stored !== sum || magic !== "ustar" || version !== "00") {
    return { kind: "refused", reason: "header" };
  }
  const name = readText(block.subarray(0, NAME_BYTES));
  const type = block[156];
  if (type === 0x31 || type === 0x32) {
    return { kind: "refused", reason: "link", ...(name === undefined ? {} : { name }) };
  }
  if (type === 0x35) {
    return { kind: "refused", reason: "directory", ...(name === undefined ? {} : { name }) };
  }
  if (type !== 0x30 && type !== 0) {
    return { kind: "refused", reason: "type", ...(name === undefined ? {} : { name }) };
  }
  if (name === undefined || name === "" || !isZero(block.subarray(345, 500)) || !isZero(block.subarray(157, 257))) {
    return { kind: "refused", reason: "name", ...(name === undefined ? {} : { name }) };
  }
  const size = readNumber(block.subarray(124, 136));
  if (size === undefined) {
    return { kind: "refused", reason: "header", name };
  }
  return { kind: "file", name, size };
}
