import { describe, expect, it } from "vitest";
import { chatContextDtoSchema, chatContextUsedDtoSchema } from "../../../src/shared/dto/chat.ts";

describe("chat context DTOs", () => {
  it("flags a left-out summary the same way before asking and on what an answer used", () => {
    expect(chatContextDtoSchema.parse({ mode: "full", summaryOmitted: true })).toEqual({ mode: "full", summaryOmitted: true });
    expect(chatContextUsedDtoSchema.parse({ mode: "full", summaryOmitted: true })).toEqual({ mode: "full", summaryOmitted: true });
    for (const value of ["speakers_changed", false]) {
      expect(chatContextDtoSchema.safeParse({ mode: "full", summaryOmitted: value }).success).toBe(false);
      expect(chatContextUsedDtoSchema.safeParse({ mode: "full", summaryOmitted: value }).success).toBe(false);
    }
    expect(chatContextDtoSchema.parse({ mode: "retrieval", estimatedTokens: 3_000 })).toEqual({ mode: "retrieval", estimatedTokens: 3_000 });
    // Absent means kept; an explicit undefined is not a value the response carries.
    expect(chatContextDtoSchema.safeParse({ mode: "full", summaryOmitted: undefined }).success).toBe(false);
  });
});
