import { useCallback, useEffect, useRef } from "react";

/**
 * Hands the focus to the entry's action once a notice in front of it is saved away: the notice
 * unmounts with the field that had the focus, which would otherwise drop it on the page body.
 * The action may still be disabled when the save answers (the provider list is read again
 * first), so the focus waits until `blocked` turns false. Returns the notice's `onSaved`.
 */
export function useFocusAfterSave(blocked: boolean, target: () => HTMLElement | null | undefined): () => void {
  const armed = useRef(false);
  const latest = useRef({ blocked, target });
  latest.current = { blocked, target };
  useEffect(() => {
    if (blocked || !armed.current) return;
    armed.current = false;
    latest.current.target()?.focus();
  }, [blocked]);
  return useCallback(() => {
    if (latest.current.blocked) armed.current = true;
    else latest.current.target()?.focus();
  }, []);
}
