import { DANMAKU_ITEMS_MAX, DANMAKU_TEXT_MAX_CHARS } from "../../shared/defaults.ts";
import type { DanmakuItem } from "../../shared/dto/danmaku.ts";

/** Tabs, line and paragraph breaks: a danmaku is one line, so each run of them becomes a space. */
const BREAKS = /[\t\n\r\v\f\u0085\u2028\u2029]+/gu;

/**
 * What a danmaku must not carry: control characters, lone surrogates, and format characters
 * (bidi overrides and isolates, zero-width spaces, BOM, soft hyphen, tag characters) that
 * can reorder or hide text — except U+200D, which joins emoji sequences and is harmless
 * alone. Also the blank "letters" (Hangul fillers, the blank braille pattern, the combining
 * grapheme joiner, Khmer inherent vowels, Mongolian variation selectors) that render as
 * nothing and are used to send invisible or blank-looking text.
 */
const INVISIBLE = /(?!\u200D)[\p{Cc}\p{Cs}\p{Cf}\u034F\u115F\u1160\u17B4\u17B5\u180B-\u180F\u2800\u3164\uFFA0]/gu;

/** Runs of whitespace of any script; a danmaku keeps at most one space between words. */
const SPACES = /\s+/gu;

const graphemes = new Intl.Segmenter(undefined, { granularity: "grapheme" });

/**
 * A platform danmaku text as Amber keeps it: plain text on one line with control, format and
 * blank characters removed, spaces collapsed and trimmed, and at most `DANMAKU_TEXT_MAX_CHARS`
 * UTF-16 units (the unit the API schema counts) without splitting a character or an emoji
 * sequence. Markup inside it stays literal text: it is never interpreted. `undefined` when
 * nothing visible is left.
 */
export function cleanDanmakuText(raw: string, maxChars = DANMAKU_TEXT_MAX_CHARS): string | undefined {
  let text = raw.replace(BREAKS, " ").replace(INVISIBLE, "").replace(SPACES, " ").trim();
  if (text.length > maxChars) {
    let kept = "";
    for (const { segment } of graphemes.segment(text)) {
      if (kept.length + segment.length > maxChars) {
        break;
      }
      kept += segment;
    }
    text = kept.trimEnd();
  }
  return text === "" ? undefined : text;
}

/**
 * The items in time order (ties keep their order of arrival), at most `max` of them. When
 * there are more, whole weight classes are dropped from the lowest up: the weight is the
 * platform's own judgement of which danmaku to show when a stretch is crowded, and the
 * player thins by it too. Within the weight class that straddles the limit, the kept items
 * are spread evenly over time, so no part of the video loses that class altogether while
 * another keeps all of it.
 */
export function capDanmakuItems(items: readonly DanmakuItem[], max = DANMAKU_ITEMS_MAX): { items: DanmakuItem[]; truncated: boolean } {
  // Indices in time order, arrival order breaking ties (the sort is stable).
  const order = items.map((_, index) => index).sort((a, b) => (items[a] as DanmakuItem).timeMs - (items[b] as DanmakuItem).timeMs);
  if (items.length <= max) {
    return { items: order.map((index) => items[index] as DanmakuItem), truncated: false };
  }
  const classes = new Map<number, number[]>();
  for (const index of order) {
    const weight = (items[index] as DanmakuItem).weight;
    const members = classes.get(weight);
    if (members === undefined) {
      classes.set(weight, [index]);
    } else {
      members.push(index);
    }
  }
  const kept = new Set<number>();
  for (const weight of [...classes.keys()].sort((a, b) => b - a)) {
    const members = classes.get(weight) as number[];
    const room = max - kept.size;
    if (members.length <= room) {
      for (const index of members) kept.add(index);
      continue;
    }
    // Members are in time order; a step of n / room ≥ 1 picks distinct ones across the whole span.
    for (let pick = 0; pick < room; pick++) {
      kept.add(members[Math.floor(((pick + 0.5) * members.length) / room)] as number);
    }
    break;
  }
  return { items: order.filter((index) => kept.has(index)).map((index) => items[index] as DanmakuItem), truncated: true };
}
