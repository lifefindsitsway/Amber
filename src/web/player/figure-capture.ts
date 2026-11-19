import { useSyncExternalStore } from "react";
import type { MediaAssetDto } from "../../shared/dto/content.ts";

/**
 * A frame interval long enough for any video worth capturing (10 fps and up). Used only when
 * the browser does not say which frame is on screen: a capture time this close to the end of
 * the file would ask for a frame past the last one, which the server cannot capture.
 */
const FALLBACK_FRAME_MS = 100;
/**
 * The frame on screen is trusted only when it starts at most this long before the playback
 * position: after a seek the position moves at once while the new frame comes a moment later,
 * and a slide video may show one frame for a second.
 */
const FRAME_TRUST_MS = 1000;

/**
 * The media time to capture, in whole milliseconds. What the user sees is the frame on screen,
 * so its own start time is taken when the browser reports it (`frameMs`) and it belongs to the
 * current position; otherwise the playback position. Either is kept before the last frame: at
 * the very end of the file (playback stopped there) there is no frame at or after the
 * position, and the server would answer that there is nothing to capture.
 */
export function captureTimeMs(input: { currentMs: number; durationMs: number | undefined; frameMs: number | undefined }): number {
  const current = Number.isFinite(input.currentMs) ? Math.max(0, input.currentMs) : 0;
  const frame = input.frameMs;
  // The position may run a little ahead of the frame on screen during playback, or (rarely) behind it.
  const onScreen = frame !== undefined && Number.isFinite(frame) && frame >= 0 && frame - current <= FALLBACK_FRAME_MS && current - frame <= FRAME_TRUST_MS;
  let at = onScreen ? frame : current;
  const duration = input.durationMs;
  if (duration !== undefined && Number.isFinite(duration) && duration > 0) {
    // A frame on screen is a real frame, so it starts before the end; a position is only a guess.
    at = Math.min(at, onScreen ? duration - 1 : duration - FALLBACK_FRAME_MS);
  }
  return Math.max(0, Math.floor(at));
}

/**
 * The Content's files a frame can be captured from: an original file or a platform cache that
 * is a video, available now. Audio files, extracted audio and missing files are not.
 */
export function capturableAssetIds(media: readonly MediaAssetDto[]): string[] {
  return media
    .filter((asset) => (asset.kind === "external_local" || asset.kind === "managed_upload" || asset.kind === "platform_cache") && asset.availability === "available" && asset.mimeType.startsWith("video/"))
    .map((asset) => asset.id);
}

/**
 * The picture the content page could capture now. `video`: the local player shows one of the
 * Content's video files the server can read; `request` gives the file and time of the frame on
 * screen, `capture` captures it from the player. `audio`: the player plays a file without a
 * picture. No source: nothing to capture from (no local player, an online one, or the reading
 * view cannot take figures).
 */
export type FrameSource =
  | { kind: "video"; contentId: string; request: () => { assetId: string; atMs: number }; capture: () => void }
  | { kind: "audio"; contentId: string };

/**
 * The one frame source of this window, set by the player while it shows one and read by the
 * reading view's insert menu (the two sit in different columns, with no common parent but the
 * page). Only one content page is open per window.
 */
class FrameSourceStore {
  private current: FrameSource | undefined;
  private readonly listeners = new Set<() => void>();

  readonly subscribe = (listener: () => void): (() => void) => {
    this.listeners.add(listener);
    return () => this.listeners.delete(listener);
  };

  readonly snapshot = (): FrameSource | undefined => this.current;

  /** Sets the source; returns the function that clears it again unless another one replaced it. */
  set(source: FrameSource): () => void {
    this.current = source;
    this.emit();
    return () => {
      if (this.current !== source) return;
      this.current = undefined;
      this.emit();
    };
  }

  private emit(): void {
    for (const listener of this.listeners) listener();
  }
}

export const frameSources = new FrameSourceStore();

/** The frame source of `contentId`, or `undefined` when there is none. */
export function useFrameSource(contentId: string): FrameSource | undefined {
  const source = useSyncExternalStore(frameSources.subscribe, frameSources.snapshot);
  return source?.contentId === contentId ? source : undefined;
}

/** The file and time of the frame `video` shows now. */
export function frameRequest(video: HTMLVideoElement, assetId: string, frameMs: number | undefined): { assetId: string; atMs: number } {
  const duration = video.duration;
  return {
    assetId,
    atMs: captureTimeMs({ currentMs: video.currentTime * 1000, durationMs: Number.isFinite(duration) && duration > 0 ? duration * 1000 : undefined, frameMs }),
  };
}

/**
 * Follows which frame of `video` is on screen (its start time, in ms), through
 * `requestVideoFrameCallback` where the browser has it. Frames are reported only while new
 * ones are presented, so a paused video costs nothing.
 */
export function trackPresentedFrame(video: HTMLVideoElement): { frameMs: () => number | undefined; stop: () => void } {
  if (typeof video.requestVideoFrameCallback !== "function") return { frameMs: () => undefined, stop: () => undefined };
  let frameMs: number | undefined;
  let handle = 0;
  const onFrame = (_now: number, metadata: VideoFrameCallbackMetadata): void => {
    frameMs = metadata.mediaTime * 1000;
    handle = video.requestVideoFrameCallback(onFrame);
  };
  handle = video.requestVideoFrameCallback(onFrame);
  // Another file in the same element starts over.
  const onEmptied = (): void => {
    frameMs = undefined;
  };
  video.addEventListener("emptied", onEmptied);
  return {
    frameMs: () => frameMs,
    stop: () => {
      video.cancelVideoFrameCallback(handle);
      video.removeEventListener("emptied", onEmptied);
    },
  };
}
