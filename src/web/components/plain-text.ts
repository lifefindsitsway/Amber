import type { WebSourceDto } from "../../shared/dto/chat.ts";
import { formatDuration } from "../format.ts";

const MARKER = /\[\[(seg|unresolved|web):([^\]\s]+)\]\]/g;

/**
 * Rich text (summary, chat answer) as plain text for the clipboard: `[[seg:…]]` citations
 * become their `[m:ss]` timestamps and `[[web:…]]` citations their `[n]` source number;
 * unresolved citations and citations without a known time or source are dropped rather
 * than leaking marker syntax.
 */
export function plainText(
  body: string,
  timeOf: (segmentId: string) => number | undefined,
  webIndexOf: (sourceId: string) => number | undefined = () => undefined,
): string {
  return body.replace(MARKER, (_, kind: string, value: string) => {
    if (kind === "web") {
      const index = webIndexOf(value);
      return index === undefined ? "" : `[${index}]`;
    }
    if (kind !== "seg") return "";
    const time = timeOf(value);
    return time === undefined ? "" : `[${formatDuration(time)}]`;
  });
}

/** The answer's own sources it actually cites, by their number. */
export function citedWebSources(body: string, sources: readonly WebSourceDto[]): WebSourceDto[] {
  const cited = new Set<string>();
  for (const match of body.matchAll(MARKER)) {
    if (match[1] === "web") cited.add(match[2] as string);
  }
  return sources.filter((source) => cited.has(source.id)).sort((a, b) => a.index - b.index);
}

/**
 * A chat answer for the clipboard: plain text as above, then, when it cites web pages, a
 * list of those sources under `heading` so the `[n]` numbers still lead somewhere.
 */
export function answerPlainText(
  body: string,
  timeOf: (segmentId: string) => number | undefined,
  sources: readonly WebSourceDto[],
  heading: string,
): string {
  const indexOf = new Map(sources.map((source) => [source.id, source.index]));
  const text = plainText(body, timeOf, (sourceId) => indexOf.get(sourceId));
  const cited = citedWebSources(body, sources);
  if (cited.length === 0) return text;
  const list = cited.map((source) => `[${source.index}] ${source.title} ${source.url}`.replace(/\s+$/u, ""));
  return `${text}\n\n${heading}\n${list.join("\n")}`;
}
