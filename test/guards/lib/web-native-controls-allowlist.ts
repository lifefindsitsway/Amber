import type { WebNativeControlCounts } from "./web-native-controls.ts";

/**
 * Files of `src/web` that still hold native controls or hand-tinted notices, with how many of
 * each. The counts are exact: a file that migrates some of them lowers its counts, a file that
 * migrates all of them drops its entry, and new code may not add to them.
 */
export interface WebNativeControlsAllowlistEntry {
  /** Repository-relative path with forward slashes. */
  file: string;
  counts: WebNativeControlCounts;
  reason: string;
}

export const WEB_NATIVE_CONTROLS_ALLOWLIST: readonly WebNativeControlsAllowlistEntry[] = [];
