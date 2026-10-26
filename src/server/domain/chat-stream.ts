import type { Citation } from "./artifact.ts";
import type { AliasTable } from "./citations.ts";
import type { WebSource } from "./web-search.ts";

/** Opening and closing lines of the control section the chat system prompts ask for. */
const CONTROL_START = "<<<suggestions>>>";
const CONTROL_END = "<<<end>>>";
/** Suggestions kept from the control section (the prompts ask for two or three). */
const SUGGESTIONS_MAX = 3;

/**
 * A sentence (`s`) or web (`w`) alias in the forms `citations.ts` accepts: `[[s12]]`, or
 * `[s12]]` / `[[s12]` with one bracket missing.
 */
const ALIAS_AT_START = /^(?:\[\[([sw])(\d+)\]\]?|\[([sw])(\d+)\]\])/;
/**
 * A possibly unfinished alias marker at the end of the buffer: `[`, `[[`, `[s`, `[[s`,
 * `[s12`, `[[s12`, `[s12]`, `[[s12]`, and the same with `w`. The last two wait for a
 * possible closing `]`.
 */
const ALIAS_PREFIX = /^\[\[?(?:[sw](?:\d*(?:\])?)?)?$/;

/** What the client receives while an answer streams. */
export type ChatAnswerEvent = { type: "answer.delta"; delta: string } | { type: "citation"; citation: Citation; startMs: number };

/** The stored outcome of a streamed answer. */
export interface ChatAnswer {
  /** Canonical markers only; trailing whitespace trimmed. */
  text: string;
  /** Distinct cited sentences in order of first appearance. */
  citations: Citation[];
  /** Absent when the control section was missing or unreadable. */
  suggestions?: string[];
}

/**
 * Turns the model's raw deltas into what the client may see: an `[[s<n>]]` alias split
 * across deltas is held until it closes, then becomes the canonical `[[seg:<id>]]` (or the
 * visible `[[unresolved:s<n>]]` when the request never showed that alias; chat does not
 * repair). A `[[w<n>]]` alias becomes `[[web:<id>]]` of this answer's n-th source, or
 * `[[unresolved:w<n>]]` past them; a `[[web:<id>]]` the model wrote itself is passed on as
 * it is, and only resolves where that id is one of the answer's own sources. The control section never streams: anything that may begin it is held, and once
 * it begins the rest of the output is kept back and parsed at the end. Trailing whitespace
 * is held too, so the answer never ends with the blank line before the control section.
 */
export class ChatStreamAssembler {
  private readonly table: AliasTable;
  private readonly startMsOf: (segmentId: string) => number;
  private readonly webSources: readonly WebSource[];
  private pending = "";
  private heldSpace = "";
  private control: string | undefined;
  private text = "";
  private readonly citations: Citation[] = [];
  private readonly cited = new Set<string>();

  /** `webSources`: this answer's sources, whose `[[w<index>]]` aliases become `[[web:<id>]]`. */
  constructor(table: AliasTable, startMsOf: (segmentId: string) => number, webSources: readonly WebSource[] = []) {
    this.table = table;
    this.startMsOf = startMsOf;
    this.webSources = webSources;
  }

  push(delta: string): ChatAnswerEvent[] {
    if (this.control !== undefined) {
      this.control += delta;
      return [];
    }
    this.pending += delta;
    return this.drain(false);
  }

  /** Flushes what is held and parses the control section; the stream is over. */
  finish(): { events: ChatAnswerEvent[]; answer: ChatAnswer } {
    const events = this.control === undefined ? this.drain(true) : [];
    const suggestions = this.control === undefined ? undefined : parseSuggestions(this.control);
    return {
      events,
      answer: {
        text: this.text.trimEnd(),
        citations: this.citations.map((citation) => ({ ...citation })),
        ...(suggestions === undefined ? {} : { suggestions }),
      },
    };
  }

  /** The canonical text emitted so far, for an answer that ends early. */
  partial(): ChatAnswer {
    return { text: this.text.trimEnd(), citations: this.citations.map((citation) => ({ ...citation })) };
  }

  private drain(final: boolean): ChatAnswerEvent[] {
    // Citation events go first so the client knows a sentence before its marker arrives.
    const events: ChatAnswerEvent[] = [];
    let out = "";
    for (;;) {
      const special = this.pending.search(/[[<]/);
      if (special === -1) {
        out += this.pending;
        this.pending = "";
        break;
      }
      out += this.pending.slice(0, special);
      this.pending = this.pending.slice(special);
      if (this.pending.startsWith("<")) {
        if (this.pending.startsWith(CONTROL_START)) {
          this.control = this.pending.slice(CONTROL_START.length);
          this.pending = "";
          break;
        }
        if (!final && CONTROL_START.startsWith(this.pending)) {
          break;
        }
        out += "<";
        this.pending = this.pending.slice(1);
        continue;
      }
      // Held first: `[[s12]` alone could still become `[[s12]]` with the next delta.
      if (!final && ALIAS_PREFIX.test(this.pending)) {
        break;
      }
      const alias = ALIAS_AT_START.exec(this.pending);
      if (alias !== null) {
        const kind = (alias[1] ?? alias[3]) as string;
        const digits = (alias[2] ?? alias[4]) as string;
        out += kind === "w" ? this.resolveWeb(digits) : this.resolve(digits, events);
        this.pending = this.pending.slice(alias[0].length);
        continue;
      }
      out += "[";
      this.pending = this.pending.slice(1);
    }
    let text = this.heldSpace + out;
    this.heldSpace = "";
    if (final && this.control === undefined) {
      text = text.trimEnd();
    } else {
      // Held until more text follows; dropped if the answer ends here.
      const trailing = /\s+$/.exec(text);
      if (trailing !== null) {
        this.heldSpace = trailing[0];
        text = text.slice(0, trailing.index);
      }
    }
    if (text !== "") {
      this.text += text;
      events.push({ type: "answer.delta", delta: text });
    }
    return events;
  }

  /** The stored form of one web alias; the sources reach the client with the search result, not as events. */
  private resolveWeb(digits: string): string {
    const source = /^[1-9]\d*$/.test(digits) ? this.webSources[Number(digits) - 1] : undefined;
    return source === undefined ? `[[unresolved:w${digits}]]` : `[[web:${source.id}]]`;
  }

  /** The canonical form of one alias; a newly cited sentence also yields a `citation` event. */
  private resolve(digits: string, events: ChatAnswerEvent[]): string {
    const entry = /^[1-9]\d*$/.test(digits) ? this.table.get(Number(digits)) : undefined;
    if (entry === undefined) {
      return `[[unresolved:s${digits}]]`;
    }
    const { citation } = entry;
    if (!this.cited.has(citation.segmentId)) {
      this.cited.add(citation.segmentId);
      this.citations.push({ ...citation });
      events.push({ type: "citation", citation: { ...citation }, startMs: this.startMsOf(citation.segmentId) });
    }
    return `[[seg:${citation.segmentId}]]`;
  }
}

/** The `- ` lines of the control section up to `<<<end>>>`; undefined when unreadable. */
function parseSuggestions(control: string): string[] | undefined {
  const end = control.indexOf(CONTROL_END);
  if (end === -1) {
    return undefined;
  }
  const items = control
    .slice(0, end)
    .split(/\r?\n/)
    .map((line) => line.trim())
    .filter((line) => line.startsWith("- "))
    .map((line) => line.slice(2).trim())
    .filter((line) => line !== "")
    .slice(0, SUGGESTIONS_MAX);
  return items.length === 0 ? undefined : items;
}
