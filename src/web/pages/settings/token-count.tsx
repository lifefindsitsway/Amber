import { parseTokenCount as parsePositiveTokenCount } from "../../models/context-window.ts";

/**
 * A token count as typed in the model table: `undefined` for blank (the limit stays unset),
 * `NaN` for anything that is not a positive whole number of tokens. Same reading as every
 * other context window input ("128000", "128,000", "128K", "1.5M").
 */
export function parseTokenCount(text: string): number | undefined {
  if (text.trim() === "") {
    return undefined;
  }
  return parsePositiveTokenCount(text) ?? Number.NaN;
}
