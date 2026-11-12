/**
 * Line breaking of styled subtitle text, done before the renderer sees it. libass's `ass`
 * filter wraps only at spaces, so a long Chinese line runs off the picture; its Unicode
 * wrapping mode moves a glyph across the break when it rebalances lines, leaving closing
 * punctuation at the start of a line. Breaking here with the bundled font's advances keeps
 * every line inside the wrap width, balanced like the player's `text-wrap: balance`.
 */

/** Advance widths of the font the lines are drawn in, in em; `undefined` for a character the font lacks. */
export interface GlyphAdvances {
  advanceEm(codePoint: number): number | undefined;
}

/** Characters the font lacks are drawn by a fallback font; a full em never underestimates them. */
const MISSING_ADVANCE_EM = 1;

/** Steps of the search for the narrowest width that keeps the fewest lines: far below a pixel for any subtitle. */
const BALANCE_STEPS = 24;

const graphemes = new Intl.Segmenter(undefined, { granularity: "grapheme" });

/** Scripts written without spaces, and full-width forms: a line may break before or after any of them. */
const CJK =
  /^[\u2E80-\u303F\u3040-\u30FF\u3100-\u31FF\u3200-\u33FF\u3400-\u4DBF\u4E00-\u9FFF\uA960-\uA97F\uAC00-\uD7AF\uF900-\uFAFF\uFE30-\uFE4F\uFF00-\uFFEF\u{20000}-\u{3FFFF}]/u;
/** Closing punctuation, small kana and iteration marks: never the first character of a line. */
const NO_START = new Set([
  ..."，。、；：！？）」』】〉》〕］｝〙〗〟’”…‥・ー々〻ゝゞヽヾ〜～％",
  ..."ぁぃぅぇぉっゃゅょゎゕゖァィゥェォッャュョヮヵヶ",
  ...",.;:!?)]}%",
]);
/** Opening punctuation: never the last character of a line. */
const NO_END = new Set([..."（「『【〈《〔［｛〘〖〝‘“", ..."([{"]);
const SPACE = /^[ \t\u3000]$/u;
const LETTER = /^\p{L}/u;

interface Piece {
  text: string;
  /** Width without the trailing spaces, which disappear at the end of a line. */
  width: number;
  /** Width including the trailing spaces, which count when the next piece follows on the same line. */
  fullWidth: number;
}

/** May a line break between graphemes `a` and `b`, with `before` the grapheme preceding `a`? */
function breakBetween(before: string | undefined, a: string, b: string): boolean {
  if (SPACE.test(b) || NO_START.has(b)) return false;
  if (SPACE.test(a)) return true;
  if (NO_END.has(a)) return false;
  if (CJK.test(a) || CJK.test(b)) return true;
  return a === "-" && before !== undefined && LETTER.test(before) && LETTER.test(b);
}

/**
 * The lines of one subtitle line drawn at `emPx` pixels per em, each no wider than
 * `maxWidth`: a line that fits is returned unchanged; otherwise it takes the fewest lines
 * possible, then the narrowest width that still needs no more, so the lines come out even.
 * Breaks fall after spaces (which are dropped), around CJK characters and after a hyphen
 * between letters, never before closing or after opening punctuation; a run with no break
 * that is wider than `maxWidth` on its own is cut between graphemes.
 */
export function breakSubtitleLine(text: string, maxWidth: number, emPx: number, glyphs: GlyphAdvances): string[] {
  const units = [...graphemes.segment(text)].map(({ segment }) => segment);
  const widthOf = (unit: string): number => {
    let em = 0;
    for (const char of unit) {
      em += glyphs.advanceEm(char.codePointAt(0) as number) ?? MISSING_ADVANCE_EM;
    }
    return em * emPx;
  };
  const pieces = cutOversized(piecesOf(units, widthOf), maxWidth, widthOf);
  const total = pieces.reduce((sum, piece, index) => sum + (index === pieces.length - 1 ? piece.width : piece.fullWidth), 0);
  if (total <= maxWidth) {
    return [text];
  }
  const fewest = layout(pieces, maxWidth).length;
  let lo = Math.max(...pieces.map((piece) => piece.width), total / fewest);
  let hi = maxWidth;
  if (layout(pieces, lo).length <= fewest) {
    hi = lo;
  } else {
    for (let step = 0; step < BALANCE_STEPS; step += 1) {
      const mid = (lo + hi) / 2;
      if (layout(pieces, mid).length <= fewest) hi = mid;
      else lo = mid;
    }
  }
  return layout(pieces, hi).map((line) => line.map((piece) => piece.text).join("").replace(/[ \t\u3000]+$/u, ""));
}

/** The text cut at every break opportunity, each piece carrying its trailing spaces. */
function piecesOf(units: readonly string[], widthOf: (unit: string) => number): Piece[] {
  const pieces: Piece[] = [];
  let current: Piece = { text: "", width: 0, fullWidth: 0 };
  units.forEach((unit, index) => {
    if (index > 0 && breakBetween(units[index - 2], units[index - 1] as string, unit)) {
      pieces.push(current);
      current = { text: "", width: 0, fullWidth: 0 };
    }
    const width = widthOf(unit);
    current.text += unit;
    current.fullWidth += width;
    if (!SPACE.test(unit)) current.width = current.fullWidth;
  });
  pieces.push(current);
  return pieces;
}

/** Pieces wider than `maxWidth` on their own, cut between graphemes so each part fits. */
function cutOversized(pieces: readonly Piece[], maxWidth: number, widthOf: (unit: string) => number): Piece[] {
  return pieces.flatMap((piece) => {
    if (piece.width <= maxWidth) return [piece];
    const parts: Piece[] = [];
    let current: Piece = { text: "", width: 0, fullWidth: 0 };
    for (const { segment } of graphemes.segment(piece.text)) {
      const width = widthOf(segment);
      const space = SPACE.test(segment);
      if (!space && current.text !== "" && current.fullWidth + width > maxWidth) {
        parts.push(current);
        current = { text: "", width: 0, fullWidth: 0 };
      }
      current.text += segment;
      current.fullWidth += width;
      if (!space) current.width = current.fullWidth;
    }
    parts.push(current);
    return parts;
  });
}

/** Greedy filling: each line takes pieces while their width, without the last one's trailing spaces, fits. */
function layout(pieces: readonly Piece[], width: number): Piece[][] {
  const lines: Piece[][] = [];
  let line: Piece[] = [];
  let used = 0;
  for (const piece of pieces) {
    if (line.length > 0 && used + piece.width > width) {
      lines.push(line);
      line = [];
      used = 0;
    }
    line.push(piece);
    used += piece.fullWidth;
  }
  lines.push(line);
  return lines;
}
