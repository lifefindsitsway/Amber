import { CITATION_INVALID_RATIO_MAX, CITATION_REPAIR_CANDIDATES } from "../../shared/defaults.ts";
import type { SegmentId } from "../../shared/ids.ts";
import type { Citation } from "./artifact.ts";
import type { TranscriptSegment } from "./transcript.ts";

/**
 * The citation envelope. During a model call sentences are named by short
 * aliases `[[s<n>]]`; the table below is scoped to one Task and maps each alias to the
 * sentence it stands for. After the call, valid aliases become the canonical
 * `[[seg:<segmentId>]]` marker and invalid ones the visible `[[unresolved:<alias>]]`,
 * never silently dropped.
 */

/** One sentence a model may cite: alias `n` (1-based), its citation and its text. */
export interface AliasEntry {
  alias: number;
  citation: Citation;
  text: string;
}

export class AliasTable {
  readonly entries: readonly AliasEntry[];
  private readonly bySegment: ReadonlyMap<string, number>;

  /** `entries[i].alias` must be `i + 1`. */
  constructor(entries: readonly AliasEntry[]) {
    entries.forEach((entry, index) => {
      if (entry.alias !== index + 1) {
        throw new TypeError("aliases must be numbered 1..n in order");
      }
    });
    this.entries = entries;
    this.bySegment = new Map(entries.map((entry) => [entry.citation.segmentId as string, entry.alias]));
  }

  get(alias: number): AliasEntry | undefined {
    return this.entries[alias - 1];
  }

  aliasOf(segmentId: string): number | undefined {
    return this.bySegment.get(segmentId);
  }

  /** The `[[s<n>]] text` line a prompt shows for an alias; the text is kept on one line. */
  line(alias: number): string {
    const entry = this.get(alias);
    if (entry === undefined) {
      throw new RangeError(`alias s${alias} is not in the table`);
    }
    return `[[s${alias}]] ${oneLine(entry.text)}`;
  }

  /** Stable material for input digests: which segment each alias names. */
  fingerprint(): string {
    return this.entries.map((entry) => `${entry.alias}:${entry.citation.transcriptRevisionId}:${entry.citation.segmentId}`).join(",");
  }
}

/** A single video's table: every sentence of the revision in `ordinal` order is `s1..sN`. */
export function transcriptAliasTable(revisionId: string, segments: readonly TranscriptSegment[]): AliasTable {
  return new AliasTable(
    [...segments]
      .sort((a, b) => a.ordinal - b.ordinal)
      .map((segment, index) => ({ alias: index + 1, citation: { transcriptRevisionId: revisionId, segmentId: segment.id }, text: segment.text })),
  );
}

const CANONICAL = /\[\[seg:([^\]\s]+)\]\]/g;

/**
 * The segment ids named by the canonical `[[seg:<segmentId>]]` markers of a stored body, in
 * order of appearance with repeats. Only whole markers count: an id that merely occurs in
 * the text, or inside an `[[unresolved:…]]` marker, is not a reference.
 */
export function markedSegmentIds(body: string): string[] {
  return [...body.matchAll(CANONICAL)].map((match) => match[1] as string);
}

/**
 * A collection's table: the canonical markers of the members' summaries, in
 * member order and first appearance, are renumbered `s1..sN` across lectures; a sentence
 * cited twice keeps one alias. Returns each body rewritten with aliases. A marker whose
 * sentence cannot be found becomes `[[unresolved:seg:<id>]]` rather than vanishing.
 */
export function collectionAliasTable(
  bodies: readonly string[],
  sentenceOf: (segmentId: string) => { transcriptRevisionId: string; text: string } | undefined,
): { table: AliasTable; bodies: string[] } {
  const entries: AliasEntry[] = [];
  const known = new Map<string, number>();
  const rewritten = bodies.map((body) =>
    body.replace(CANONICAL, (_marker, segmentId: string) => {
      let alias = known.get(segmentId);
      if (alias === undefined) {
        const sentence = sentenceOf(segmentId);
        if (sentence === undefined) {
          return `[[unresolved:seg:${segmentId}]]`;
        }
        alias = entries.length + 1;
        entries.push({ alias, citation: { transcriptRevisionId: sentence.transcriptRevisionId, segmentId: segmentId as SegmentId }, text: sentence.text });
        known.set(segmentId, alias);
      }
      return `[[s${alias}]]`;
    }),
  );
  return { table: new AliasTable(entries), bodies: rewritten };
}

/**
 * An alias marker as models write it: `[[s<n>]]`, or with one bracket missing on one side
 * (`[s<n>]]`, `[[s<n>]`), which some models drop in runs of citations. A
 * marker with one bracket on each side, `[s<n>]`, is not an alias and is left as text.
 * `[[seg:…]]` and `[[unresolved:s<n>]]` never match: `s` must directly follow the bracket
 * and be followed by digits.
 */
const ALIAS = /\[\[s(\d+)\]\]?|\[s(\d+)\]\]/g;

/** The digits of an `ALIAS` match, whichever of its two forms matched. */
function aliasDigits(first: string | undefined, second: string | undefined): string {
  return (first ?? second) as string;
}

/** Whether a text contains the alias `s<n>` in any form `ALIAS` accepts. */
function mentionsAlias(text: string, alias: string): boolean {
  for (const match of text.matchAll(ALIAS)) {
    if (aliasName(aliasDigits(match[1], match[2])) === alias) {
      return true;
    }
  }
  return false;
}

function aliasName(digits: string): string {
  return `s${digits}`;
}

function isValid(digits: string, table: AliasTable): boolean {
  return /^[1-9]\d*$/.test(digits) && table.get(Number(digits)) !== undefined;
}

/**
 * Alias occurrences in one model output. Only `[[s<n>]]` markers count: an
 * `[[unresolved:…]]` marker carried over from an earlier output is not a new invalid alias.
 */
export interface CitationCheck {
  total: number;
  invalid: number;
  /** Distinct invalid aliases (`s999`), in order of first appearance. */
  invalidAliases: string[];
  /** `invalid / total`; 0 when the output cites nothing. */
  ratio: number;
}

export function checkCitations(text: string, table: AliasTable): CitationCheck {
  let total = 0;
  let invalid = 0;
  const invalidAliases: string[] = [];
  for (const match of text.matchAll(ALIAS)) {
    const digits = aliasDigits(match[1], match[2]);
    total += 1;
    if (!isValid(digits, table)) {
      invalid += 1;
      const name = aliasName(digits);
      if (!invalidAliases.includes(name)) {
        invalidAliases.push(name);
      }
    }
  }
  return { total, invalid, invalidAliases, ratio: total === 0 ? 0 : invalid / total };
}

/** One citation repair is due when the invalid ratio exceeds `CITATION_INVALID_RATIO_MAX`. */
export function needsRepair(check: CitationCheck): boolean {
  return check.ratio > CITATION_INVALID_RATIO_MAX;
}

/**
 * Candidate sentences for each invalid alias: the output paragraphs
 * containing it are compared with every sentence of the table by character-trigram
 * similarity, and the best `CITATION_REPAIR_CANDIDATES` are kept. Deterministic: ties go
 * to the lower alias.
 */
export function repairCandidates(text: string, invalidAliases: readonly string[], table: AliasTable): Map<string, AliasEntry[]> {
  const paragraphs = text.split(/\n\s*\n/);
  const sentenceGrams = table.entries.map((entry) => trigrams(entry.text));
  const result = new Map<string, AliasEntry[]>();
  for (const alias of invalidAliases) {
    const context = paragraphs.filter((paragraph) => mentionsAlias(paragraph, alias)).join("\n");
    const grams = trigrams(context.replace(ALIAS, " ").replace(/\[\[unresolved:[^\]]*\]\]/g, " "));
    const ranked = table.entries
      .map((entry, index) => ({ entry, score: dice(grams, sentenceGrams[index] as Set<string>) }))
      .sort((a, b) => b.score - a.score || a.entry.alias - b.entry.alias)
      .slice(0, CITATION_REPAIR_CANDIDATES)
      .map(({ entry }) => entry);
    result.set(alias, ranked);
  }
  return result;
}

/** The `{{candidates}}` section of the `citation.repair` prompt: each invalid alias followed by its candidate lines. */
export function renderCandidates(candidates: ReadonlyMap<string, readonly AliasEntry[]>, table: AliasTable): string {
  return [...candidates]
    .map(([alias, entries]) => [`${alias}：`, ...entries.map((entry) => table.line(entry.alias))].join("\n"))
    .join("\n\n");
}

/**
 * The answer to the `citation.repair` prompt: a JSON object from invalid alias to replacement alias or
 * null. Only invalid aliases that were asked about and replacements that exist in the
 * table are kept; anything unreadable repairs nothing.
 */
export function parseRepair(text: string, invalidAliases: readonly string[], table: AliasTable): Record<string, string> {
  const start = text.indexOf("{");
  const end = text.lastIndexOf("}");
  if (start === -1 || end < start) {
    return {};
  }
  let parsed: unknown;
  try {
    parsed = JSON.parse(text.slice(start, end + 1));
  } catch {
    return {};
  }
  if (parsed === null || typeof parsed !== "object" || Array.isArray(parsed)) {
    return {};
  }
  const mapping: Record<string, string> = {};
  for (const [key, value] of Object.entries(parsed as Record<string, unknown>)) {
    const from = key.trim().replace(/^\[\[|\]\]$/g, "");
    if (!invalidAliases.includes(from) || typeof value !== "string") {
      continue;
    }
    const match = /^(?:\[\[)?s(\d+)(?:\]\])?$/.exec(value.trim());
    if (match !== null && isValid(match[1] as string, table)) {
      mapping[from] = aliasName(match[1] as string);
    }
  }
  return mapping;
}

/** Rewrites each repaired alias to its replacement; other markers are left as they are. */
export function applyRepair(text: string, mapping: Readonly<Record<string, string>>): string {
  return text.replace(ALIAS, (marker, first?: string, second?: string) => {
    const replacement = mapping[aliasName(aliasDigits(first, second))];
    return replacement === undefined ? marker : `[[${replacement}]]`;
  });
}

/**
 * Text that feeds a later call (a carry, or partials into the final): valid aliases stay,
 * invalid ones become `[[unresolved:<alias>]]` so they are neither re-cited nor counted again.
 */
export function markUnresolved(text: string, table: AliasTable): string {
  return text.replace(ALIAS, (_marker, first?: string, second?: string) => {
    const digits = aliasDigits(first, second);
    return isValid(digits, table) ? `[[s${digits}]]` : `[[unresolved:${aliasName(digits)}]]`;
  });
}

/**
 * The stored form: valid aliases become canonical `[[seg:<segmentId>]]` markers and the
 * de-duplicated `citations` index in order of first appearance; invalid ones become
 * `[[unresolved:<alias>]]` and stay out of `citations`.
 */
export function finalizeCitations(text: string, table: AliasTable): { body: string; citations: Citation[] } {
  const citations: Citation[] = [];
  const seen = new Set<string>();
  const body = text.replace(ALIAS, (_marker, first?: string, second?: string) => {
    const digits = aliasDigits(first, second);
    if (!isValid(digits, table)) {
      return `[[unresolved:${aliasName(digits)}]]`;
    }
    const { citation } = table.get(Number(digits)) as AliasEntry;
    if (!seen.has(citation.segmentId)) {
      seen.add(citation.segmentId);
      citations.push({ ...citation });
    }
    return `[[seg:${citation.segmentId}]]`;
  });
  return { body, citations };
}

function oneLine(text: string): string {
  return text.replace(/\r\n|\r|\n/g, " ");
}

function trigrams(text: string): Set<string> {
  const normalized = text.toLowerCase().replace(/\s+/g, " ").trim();
  const chars = [...normalized];
  const grams = new Set<string>();
  if (chars.length === 0) {
    return grams;
  }
  if (chars.length < 3) {
    grams.add(chars.join(""));
    return grams;
  }
  for (let i = 0; i + 3 <= chars.length; i += 1) {
    grams.add(chars.slice(i, i + 3).join(""));
  }
  return grams;
}

/** Dice coefficient of two trigram sets. */
function dice(a: ReadonlySet<string>, b: ReadonlySet<string>): number {
  if (a.size === 0 || b.size === 0) {
    return 0;
  }
  let shared = 0;
  for (const gram of a) {
    if (b.has(gram)) {
      shared += 1;
    }
  }
  return (2 * shared) / (a.size + b.size);
}
