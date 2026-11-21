import type { VendorMarkId } from "../ui/vendor-icon.tsx";

/**
 * Which vendor's mark to show beside a model name. This is a display guess from the name only:
 * a relay or proxy may serve any model under any name, so the result never decides a request,
 * a capability, a price, a filter or a default; it only picks an icon drawn next to the written
 * name. It is the one place allowed to look at model names, and only the mark component reads it.
 */
const FAMILIES: ReadonlyArray<readonly [VendorMarkId, readonly string[]]> = [
  ["openai", ["gpt", "chatgpt", "o1", "o2", "o3", "o4", "o5", "o6", "o7", "o8", "o9"]],
  ["claude", ["claude"]],
  ["gemini", ["gemini", "gemma"]],
  ["deepseek", ["deepseek"]],
  ["qwen", ["qwen", "qwq", "qvq"]],
  ["glm", ["glm", "chatglm"]],
  ["kimi", ["kimi", "moonshot"]],
  ["grok", ["grok"]],
];

/** After a prefix: the end of the name, a digit or a separator, so "gptx" or "claudette" do not match. */
const BOUNDARY = /^(?:$|[0-9._:-])/u;

/**
 * The vendor a model name points at, from its last path segment ("openai/gpt-5" → "gpt-5"),
 * case-insensitively; `undefined` when no known prefix starts it.
 */
export function modelFamily(modelId: string): VendorMarkId | undefined {
  const name = modelId.slice(modelId.lastIndexOf("/") + 1).trim().toLowerCase();
  for (const [mark, prefixes] of FAMILIES) {
    if (prefixes.some((prefix) => name.startsWith(prefix) && BOUNDARY.test(name.slice(prefix.length)))) {
      return mark;
    }
  }
  return undefined;
}
