import { useCallback, useMemo, useRef } from "react";
import {
  READER_TYPOGRAPHY_DEFAULTS,
  readerTypographyKey,
  readerTypographySchema,
  type ReaderTypography,
} from "../../../shared/reader-typography.ts";
import { useMe } from "../../api/queries.ts";
import { useStoredValue } from "../../use-stored-value.ts";

export { READER_TYPOGRAPHY_DEFAULTS, readerTypographyKey, readerTypographySchema, type ReaderTypography };

/** Writes made before the current user is known have no key to go to and are dropped. */
const NO_USER_KEY = "amber.reader.typography.";

/**
 * Parses a stored value field by field, so one damaged or outdated field (say a font size
 * from an older range) falls back to its default without resetting the readable others.
 */
export function parseReaderTypography(raw: string | undefined): ReaderTypography {
  if (raw === undefined) return { ...READER_TYPOGRAPHY_DEFAULTS };
  let stored: unknown;
  try {
    stored = JSON.parse(raw);
  } catch {
    return { ...READER_TYPOGRAPHY_DEFAULTS };
  }
  if (typeof stored !== "object" || stored === null || Array.isArray(stored)) return { ...READER_TYPOGRAPHY_DEFAULTS };
  const fields = stored as Record<string, unknown>;
  const { fontSize, lineHeight, showSpeakers } = readerTypographySchema.shape;
  const fontSizeResult = fontSize.safeParse(fields.fontSize);
  const lineHeightResult = lineHeight.safeParse(fields.lineHeight);
  const showSpeakersResult = showSpeakers.safeParse(fields.showSpeakers);
  return {
    version: 1,
    fontSize: fontSizeResult.success ? fontSizeResult.data : READER_TYPOGRAPHY_DEFAULTS.fontSize,
    lineHeight: lineHeightResult.success ? lineHeightResult.data : READER_TYPOGRAPHY_DEFAULTS.lineHeight,
    showSpeakers: showSpeakersResult.success ? showSpeakersResult.data : READER_TYPOGRAPHY_DEFAULTS.showSpeakers,
  };
}

/**
 * The current user's reading typography: `[value, set(partial), reset()]`. The value is
 * always complete (defaults fill whatever is missing or invalid); `set` merges a partial
 * change into it and stores the whole record; `reset` removes the stored record.
 */
export function useReaderTypography(): [ReaderTypography, (change: Partial<Omit<ReaderTypography, "version">>) => void, () => void] {
  const userId = useMe().data?.userId;
  const [raw, setRaw] = useStoredValue(userId === undefined ? NO_USER_KEY : readerTypographyKey(userId));
  const value = useMemo(() => (userId === undefined ? { ...READER_TYPOGRAPHY_DEFAULTS } : parseReaderTypography(raw)), [raw, userId]);
  // Changes merge against the latest value, not the one of the last render, so two changes
  // made before React re-renders (a slider and a toggle in one handler) both apply.
  const latest = useRef(value);
  latest.current = value;
  const set = useCallback(
    (change: Partial<Omit<ReaderTypography, "version">>) => {
      if (userId === undefined) return;
      const next = readerTypographySchema.safeParse({ ...latest.current, ...change });
      if (!next.success) return;
      latest.current = next.data;
      setRaw(JSON.stringify(next.data));
    },
    [setRaw, userId],
  );
  const reset = useCallback(() => {
    if (userId !== undefined) setRaw(undefined);
  }, [setRaw, userId]);
  return [value, set, reset];
}
