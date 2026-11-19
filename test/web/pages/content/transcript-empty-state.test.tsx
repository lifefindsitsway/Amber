import { describe, expect, it } from "vitest";
import { transcriptEmptyHint } from "../../../../src/web/pages/content/transcript-empty-state.tsx";

describe("transcriptEmptyHint", () => {
  it("asks to wait only while a processing task may still bring a transcript", () => {
    for (const status of ["queued", "running", "waiting"] as const) expect(transcriptEmptyHint(status)).toBe("emptyHintPending");
    // Finished, failed, cancelled, or imported from a content pack without any task: offer transcription and subtitle import.
    for (const status of ["succeeded", "failed", "cancelled", "none"] as const) expect(transcriptEmptyHint(status)).toBe("emptyHintIdle");
  });
});
