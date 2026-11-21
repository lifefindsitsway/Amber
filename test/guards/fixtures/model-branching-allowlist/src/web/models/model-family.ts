import { NAMES } from "../ui/names.ts";
import type { Mark } from "../ui/names.ts";

export function family(name: string): Mark | undefined {
  return ["gpt", "claude"].includes(name) ? NAMES[0] : undefined;
}
