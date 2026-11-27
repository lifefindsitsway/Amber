/**
 * Just enough ISO BMFF (MP4) reading to learn a remote video's picture size and codec from
 * its header, fetching byte ranges instead of the whole file. Only box headers are walked and
 * only `moov` is read in full; sizes are bounded by the caller.
 */

/** The first video track of a file: its display size and the four-character code of its sample entry. */
export interface Mp4VideoTrack {
  width: number;
  height: number;
  /** `avc1` / `avc3` for H.264, `hvc1` / `hev1` for H.265, and so on. */
  codec: string;
}

/** Reads `length` bytes from `start` (fewer at the end of the file) and reports the file's total length. */
export type Mp4RangeReader = (start: number, length: number) => Promise<{ bytes: Uint8Array; totalBytes: number }>;

export interface Mp4ProbeLimits {
  /** Bytes asked for per read while walking the top-level boxes. */
  chunkBytes: number;
  /** A larger `moov` is not read. */
  moovMaxBytes: number;
  /** Reads at most, the `moov` read included. */
  maxReads: number;
}

interface Box {
  type: string;
  /** Payload start and end within the buffer. */
  start: number;
  end: number;
}

/** The complete child boxes of `buffer[start, end)`; a box that runs past `end` ends the walk. */
function childBoxes(buffer: Buffer, start: number, end: number): Box[] {
  const boxes: Box[] = [];
  let position = start;
  while (position + 8 <= end) {
    let size = buffer.readUInt32BE(position);
    let header = 8;
    if (size === 1) {
      if (position + 16 > end) {
        break;
      }
      size = Number(buffer.readBigUInt64BE(position + 8));
      header = 16;
    } else if (size === 0) {
      size = end - position;
    }
    if (size < header || position + size > end) {
      break;
    }
    boxes.push({ type: buffer.toString("latin1", position + 4, position + 8), start: position + header, end: position + size });
    position += size;
  }
  return boxes;
}

function child(buffer: Buffer, parent: Box, type: string): Box | undefined {
  return childBoxes(buffer, parent.start, parent.end).find((box) => box.type === type);
}

/** Width and height of a `tkhd`, in whole pixels, swapped when its matrix turns the picture a quarter. */
function trackHeaderSize(buffer: Buffer, tkhd: Box): { width: number; height: number } | undefined {
  const version = buffer[tkhd.start];
  // Version 1 widens the creation and modification times and the duration to 64 bits.
  const matrix = tkhd.start + (version === 1 ? 52 : 40);
  const size = matrix + 36;
  if (size + 8 > tkhd.end) {
    return undefined;
  }
  const width = Math.round(buffer.readUInt32BE(size) / 0x10000);
  const height = Math.round(buffer.readUInt32BE(size + 4) / 0x10000);
  const a = buffer.readInt32BE(matrix);
  const d = buffer.readInt32BE(matrix + 16);
  return a === 0 && d === 0 ? { width: height, height: width } : { width, height };
}

/** The first video track of a `moov` payload, `undefined` when it has none that can be read. */
export function videoTrackOfMoov(moov: Uint8Array): Mp4VideoTrack | undefined {
  const buffer = Buffer.from(moov.buffer, moov.byteOffset, moov.byteLength);
  for (const trak of childBoxes(buffer, 0, buffer.length).filter((box) => box.type === "trak")) {
    const mdia = child(buffer, trak, "mdia");
    const hdlr = mdia === undefined ? undefined : child(buffer, mdia, "hdlr");
    if (hdlr === undefined || hdlr.start + 12 > hdlr.end || buffer.toString("latin1", hdlr.start + 8, hdlr.start + 12) !== "vide") {
      continue;
    }
    const minf = mdia === undefined ? undefined : child(buffer, mdia, "minf");
    const stbl = minf === undefined ? undefined : child(buffer, minf, "stbl");
    const stsd = stbl === undefined ? undefined : child(buffer, stbl, "stsd");
    // Full box header, entry count, then the first sample entry's size and type.
    if (stsd === undefined || stsd.start + 16 > stsd.end) {
      continue;
    }
    const entry = stsd.start + 8;
    const codec = buffer.toString("latin1", entry + 4, entry + 8);
    const tkhd = child(buffer, trak, "tkhd");
    let size = tkhd === undefined ? undefined : trackHeaderSize(buffer, tkhd);
    if ((size === undefined || size.width === 0 || size.height === 0) && entry + 36 <= stsd.end) {
      // A visual sample entry stores the coded size after 24 bytes of reserved and predefined fields.
      size = { width: buffer.readUInt16BE(entry + 32), height: buffer.readUInt16BE(entry + 34) };
    }
    if (size === undefined || size.width === 0 || size.height === 0) {
      continue;
    }
    return { ...size, codec };
  }
  return undefined;
}

/**
 * The first video track and total length of a remote MP4, read through `read`: the top-level
 * boxes are walked chunk by chunk (skipping `mdat` and anything else by its declared size)
 * until `moov`, which is then read whole. `undefined` when the file is not an MP4 that can be
 * read this way within `limits`.
 */
export async function probeMp4(read: Mp4RangeReader, limits: Mp4ProbeLimits): Promise<{ track: Mp4VideoTrack; totalBytes: number } | undefined> {
  let offset = 0;
  let reads = 0;
  while (reads < limits.maxReads) {
    const chunk = await read(offset, limits.chunkBytes);
    reads++;
    const buffer = Buffer.from(chunk.bytes.buffer, chunk.bytes.byteOffset, chunk.bytes.byteLength);
    const total = chunk.totalBytes;
    let position = 0;
    while (position + 8 <= buffer.length) {
      let size = buffer.readUInt32BE(position);
      let header = 8;
      if (size === 1) {
        if (position + 16 > buffer.length) {
          break;
        }
        size = Number(buffer.readBigUInt64BE(position + 8));
        header = 16;
      } else if (size === 0) {
        size = total - (offset + position);
      }
      if (size < header) {
        return undefined;
      }
      if (buffer.toString("latin1", position + 4, position + 8) === "moov") {
        if (size > limits.moovMaxBytes) {
          return undefined;
        }
        let moov: Uint8Array;
        if (position + size <= buffer.length) {
          moov = buffer.subarray(position + header, position + size);
        } else {
          if (reads >= limits.maxReads) {
            return undefined;
          }
          const whole = await read(offset + position, size);
          reads++;
          if (whole.bytes.byteLength < size) {
            return undefined;
          }
          moov = whole.bytes.subarray(header, size);
        }
        const track = videoTrackOfMoov(moov);
        return track === undefined ? undefined : { track, totalBytes: total };
      }
      position += size;
    }
    if (position === 0 || offset + position >= total) {
      return undefined;
    }
    offset += position;
  }
  return undefined;
}
