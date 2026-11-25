import { useEffect, useRef } from "react";
import { SAVE_NOTICE_DISMISS_MS } from "../shared/defaults.ts";

/**
 * Dismisses a transient notice after `ms` (by default `SAVE_NOTICE_DISMISS_MS`, the wait of a
 * "saved to …" notice). `key` names the notice on screen — `undefined` while there is none — so a
 * new notice restarts the wait and removing it early (or unmounting) cancels it. The latest
 * `onDismiss` is called.
 */
export function useAutoDismiss(key: unknown, onDismiss: () => void, ms: number = SAVE_NOTICE_DISMISS_MS): void {
  const latest = useRef(onDismiss);
  latest.current = onDismiss;
  useEffect(() => {
    if (key === undefined) return undefined;
    const timer = setTimeout(() => latest.current(), ms);
    return () => clearTimeout(timer);
  }, [key, ms]);
}
