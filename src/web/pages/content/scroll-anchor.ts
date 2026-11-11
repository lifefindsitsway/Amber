/** Rows of a list that can anchor the scroll position carry their key in this attribute. */
export const ROW_KEY_ATTRIBUTE = "data-row-key";

/** The first visible row of a scrolled list and where it sat: its key and its top edge's distance below the viewport top (negative when partly scrolled off). */
export interface ScrollAnchor {
  key: string;
  offset: number;
}

/** Passes of the correction in `restoreAnchor`; each re-reads the layout, so a row whose size settles late is still caught. */
const RESTORE_PASSES = 3;
/** Pixels of drift below which a row counts as back in place. */
export const TOLERANCE_PX = 0.5;

/** Rows in document order, without querying by key (keys may hold any character). */
function rowsOf(container: HTMLElement): HTMLElement[] {
  return Array.from(container.querySelectorAll<HTMLElement>(`[${ROW_KEY_ATTRIBUTE}]`));
}

/**
 * The first row whose bottom edge is below the container's top, with the distance of its top
 * edge from there. Works on any list whose rows carry `data-row-key`, windowed or not: only
 * mounted rows can be anchors, and the first visible one always is.
 */
export function captureAnchor(container: HTMLElement): ScrollAnchor | undefined {
  const top = container.getBoundingClientRect().top;
  for (const row of rowsOf(container)) {
    const rect = row.getBoundingClientRect();
    // A row that takes no space (hidden) cannot hold a position.
    if (rect.height === 0 && rect.width === 0) continue;
    if (rect.bottom > top) {
      const key = row.getAttribute(ROW_KEY_ATTRIBUTE);
      return key === null ? undefined : { key, offset: rect.top - top };
    }
  }
  return undefined;
}

/**
 * Scrolls the container so the anchor's row sits at the same distance from the viewport top
 * as when it was captured, after the rows' sizes changed (a font size or line height change).
 * Returns whether the row exists. The correction repeats a few times because laying out the
 * rows around the target can move it again.
 */
export function restoreAnchor(container: HTMLElement, anchor: ScrollAnchor): boolean {
  let found = false;
  for (let pass = 0; pass < RESTORE_PASSES; pass += 1) {
    const row = rowsOf(container).find((candidate) => candidate.getAttribute(ROW_KEY_ATTRIBUTE) === anchor.key);
    if (row === undefined) return found;
    found = true;
    const drift = row.getBoundingClientRect().top - container.getBoundingClientRect().top - anchor.offset;
    if (Math.abs(drift) < TOLERANCE_PX) break;
    container.scrollTop += drift;
  }
  return found;
}
