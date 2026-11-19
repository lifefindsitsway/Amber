export interface MediaProbe {
  durationMs: number;
  hasAudio: boolean;
  mimeType: string;
  /** `sha256:<hex>` of the whole file. */
  fingerprint: string;
}

/**
 * Local files and server uploads converge on the same Content + MediaAsset pipeline
 * through this port. It works on paths and writes only files: MediaAsset
 * rows and WorkUnits are the pipeline's business.
 */
export interface LocalMediaIngest {
  /**
   * Magic bytes + ffprobe: duration, audio track, container, content fingerprint. Shared
   * by the upload check before commit and by the `media` stage. A container outside the
   * whitelist fails with `media_unsupported_type`; a missing audio track is reported, not
   * raised, because it is fatal only when the Task needs audio.
   */
  probe(path: string, signal: AbortSignal): Promise<MediaProbe>;
  /**
   * Writes mono 16 kHz FLAC to `output.path`; no audio track fails with
   * `media_no_audio`. With `durationMs` (the input's known duration) `onProgress` gets
   * the share written so far in [0, 1], and 1 once the file is complete; without it only
   * the final 1 is reported.
   */
  extractAudio(
    input: { path: string },
    output: { path: string },
    signal: AbortSignal,
    options?: { durationMs?: number; onProgress?: (progress: number) => void },
  ): Promise<{ sizeBytes: number; durationMs: number }>;
  /**
   * An audio cache: the audio of `input` re-encoded as MP3 (libmp3lame,
   * constant `bitrateKbps`) to `output.path`. Reports progress in [0, 1] against the
   * input's probed duration; aborting kills ffmpeg. No audio track fails with
   * `media_no_audio`.
   */
  transcodeAudio(
    input: { path: string },
    output: { path: string },
    options: { bitrateKbps: number },
    onProgress: (progress: number) => void,
    signal: AbortSignal,
  ): Promise<{ sizeBytes: number; durationMs?: number }>;
  /**
   * A per-chunk clip for audio-assisted proofreading: `[startMs, endMs)` of
   * `input`, written to `output.path` as `mimeType` (`audio/wav` = mono 16 kHz PCM, or
   * `audio/mpeg`). `input` is only ever the file of the Task's own `extracted_audio`
   * MediaAsset, resolved by the pipeline through the FileStore; no path from a request or
   * user reaches here. An unsupported `mimeType` fails with `llm_capability`; any failure
   * downgrades only that chunk to text.
   */
  clipAudio(
    input: { path: string },
    output: { path: string },
    range: { startMs: number; endMs: number },
    mimeType: string,
    signal: AbortSignal,
  ): Promise<{ sizeBytes: number }>;
  /**
   * One frame of `input` at `atMs` (clamped by the caller to the media's length) written to
   * `output.path` as WebP at `quality`, scaled so its longer edge is at most `maxLongEdge`.
   * Both paths are files in a job directory the caller owns and removes; nothing goes through
   * a pipe. An empty output (a time past the last frame) fails with
   * `invalid_request.figure_frame` (`past_end`), a file without a picture with `no_video`.
   * Aborting or `FIGURE_PROCESS_TIMEOUT_MS` kills the process tree.
   */
  captureFrame(
    input: { path: string; atMs: number },
    output: { path: string },
    options: { maxLongEdge: number; quality: number },
    signal: AbortSignal,
  ): Promise<{ width: number; height: number; bytes: number }>;
  /**
   * Re-encodes an uploaded or pasted image (`input.path`, already checked to be PNG, JPEG or
   * WebP by its signature and within `FIGURE_PIXELS_MAX` by its header) to a WebP at
   * `output.path`: decoded strictly (any damage fails with `invalid_request.figure_image`
   * `corrupt`), first frame only, turned upright by its orientation, every metadata dropped,
   * scaled to `maxLongEdge`, transparency kept. Paths as for `captureFrame`; same timeout.
   */
  normalizeImage(
    input: { path: string },
    output: { path: string },
    options: { maxLongEdge: number; quality: number },
    signal: AbortSignal,
  ): Promise<{ width: number; height: number; bytes: number }>;
}
