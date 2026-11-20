import { readFileSync } from "node:fs";
import { join } from "node:path";

/**
 * OpenAI Responses fixtures, all synthetic and following the documented wire format
 * (developers.openai.com/api/reference/resources/responses and docs.x.ai Responses
 * reference, read 2026-11-20); ids are placeholders.
 * - `equivalent.sse`: the stream answering `EQUIVALENT_REQUEST` in OpenAI's shape, with
 *   `event:` lines and a reasoning item before the message; normalizes exactly to
 *   `EQUIVALENT_GOLDEN`. Usage arrives in `response.completed`, where output includes reasoning.
 * - `xai.sse`: xAI's shape: `data:` lines only, a reasoning summary delta, usage whose
 *   `output_tokens` leaves reasoning out (32 + 9 + 110 = 151, the documented example) plus
 *   cost fields, and a trailing `data: [DONE]`.
 * - `nonstream.json`: a whole Response with a reasoning item and two `output_text` parts.
 * - `errors.json`: error answers by name, `{ status, body }`.
 */
export function responsesStream(name: "equivalent" | "xai"): string {
  return readFileSync(join(import.meta.dirname, `${name}.sse`), "utf8");
}

export function responsesBody(): string {
  return readFileSync(join(import.meta.dirname, "nonstream.json"), "utf8");
}

export interface ErrorAnswer {
  status: number;
  body: string;
}

export function responsesError(name: string): ErrorAnswer {
  const all = JSON.parse(readFileSync(join(import.meta.dirname, "errors.json"), "utf8")) as Record<string, { status: number; body: unknown }>;
  const answer = all[name];
  if (answer === undefined || name.startsWith("_") || name === "sanitized") {
    throw new Error(`no Responses error fixture ${name}`);
  }
  return { status: answer.status, body: JSON.stringify(answer.body) };
}
