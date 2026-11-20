import { CONTEXT_WINDOW_SUGGESTIONS, parseTokenCount as parsePositiveTokenCount } from "../../models/context-window.ts";

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

/** The suggestions for a context window input, bound by `list={id}`. */
export function ContextWindowSuggestions({ id }: { id: string }) {
  return (
    <datalist id={id}>
      {CONTEXT_WINDOW_SUGGESTIONS.map((suggestion) => (
        <option key={suggestion.tokens} value={suggestion.tokens} label={suggestion.label} />
      ))}
    </datalist>
  );
}
