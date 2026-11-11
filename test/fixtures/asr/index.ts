import { readFileSync } from "node:fs";
import { join } from "node:path";
import { normalizeTermKey, type TerminologyEntry } from "../../../src/server/domain/terminology.ts";

/**
 * ASR fixtures. The `elevenlabs-*.json` answers are synthetic: they follow the documented
 * response structure of the ElevenLabs speech-to-text API
 * (https://elevenlabs.io/docs/api-reference/speech-to-text/convert, read 2026-10-01) —
 * `language_code`, `text`, and `words[]` of `word` / `spacing` tokens timed in seconds —
 * with invented timing. Each file says so in its `_fixture` field.
 * - `elevenlabs-en.json`: English; full stops, an abbreviation before a lowercase word, a
 *   run-on sentence over the word limit with one comma, and a long pause.
 * - `elevenlabs-mixed.json`: Chinese with English terms (spacing tokens around Latin words).
 * - `elevenlabs-zh-synthetic.json`: a Chinese word stream; one sentence over the character
 *   limit with a comma, one with neither punctuation nor a pause before the next, a long pause.
 * - `elevenlabs-diarized.json`: English with `speaker_id` on the words: two speakers, one word
 *   without a label inside a run of one speaker, and an interjection of the other that overlaps.
 * - `elevenlabs-zh-recorded.json`: a real answer, redacted; see its `_fixture`
 *   field for source and licence. Its Chinese tokens carry the punctuation that ends a word
 *   at the start of the next token.
 */
export function asrResponse(name: "en" | "mixed" | "zh-synthetic" | "zh-recorded" | "diarized"): string {
  return readFileSync(join(import.meta.dirname, `elevenlabs-${name}.json`), "utf8");
}

const entry = (ordinal: number, term: string): TerminologyEntry => ({
  id: `term-${ordinal}`,
  ordinal,
  term,
  normalizedKey: normalizeTermKey(term),
});

/**
 * Terms the platform's own ASR got wrong on the first use case:
 * 「生成式软件工程」 heard as 「深成市软件工程」, 「Claude Opus 4.5」 as "cloud open 4.5",
 * 「搜索代码」 as 「解索代码」, 「-I」 as 「杠I」.
 */
export const KNOWN_MISHEARD_TERMS: readonly TerminologyEntry[] = [
  entry(1, "生成式软件工程"),
  entry(2, "Claude Opus 4.5"),
  entry(3, "搜索代码"),
  entry(4, "-I"),
];
