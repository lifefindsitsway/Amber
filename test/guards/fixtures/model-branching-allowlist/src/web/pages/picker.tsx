import { family } from "../models/model-family.ts";

export const pick = (id: string) => family(id) ?? "claude-fallback";
