import { useCallback, useState } from "react";

/**
 * Values whose write to localStorage failed (private mode, storage disabled): they last for
 * the page session instead of being lost at the next mount.
 */
const sessionOnly = new Map<string, string | undefined>();

function readStored(key: string): string | undefined {
  try {
    return localStorage.getItem(key) ?? undefined;
  } catch {
    return sessionOnly.get(key);
  }
}

function writeStored(key: string, value: string | undefined): void {
  try {
    if (value === undefined) localStorage.removeItem(key);
    else localStorage.setItem(key, value);
    sessionOnly.delete(key);
  } catch {
    sessionOnly.set(key, value);
  }
}

/**
 * A local UI preference under `key`, read again whenever the key changes (a route that keeps
 * the component mounted for another collection or Content); `undefined` writes remove it.
 */
export function useStoredValue(key: string): [string | undefined, (value: string | undefined) => void] {
  const [state, setState] = useState(() => ({ key, value: readStored(key) }));
  let current = state;
  if (state.key !== key) {
    current = { key, value: readStored(key) };
    setState(current);
  }
  const set = useCallback(
    (value: string | undefined) => {
      writeStored(key, value);
      setState({ key, value });
    },
    [key],
  );
  return [current.value, set];
}
