import type { ReactNode } from "react";
import { vi } from "vitest";
import type { SpeakerDto } from "../../../src/shared/dto/speaker.ts";
import type { TranscriptSegmentDto } from "../../../src/shared/dto/transcript.ts";
import { ContentPageProvider } from "../../../src/web/pages/content/content-context.tsx";
import { DraftEditor } from "../../../src/web/pages/content/draft-editor.tsx";
import { contentDetail, revision, segment } from "./content-data.ts";
import { mockApi, renderApp, type RecordedCall } from "./render.tsx";
import { stubResizeObserver } from "./speaker-fetch.ts";

export const NOT_FOUND = { status: 404, body: { error: { class: "not_found", code: "not_found", retryDisposition: "never", userMessage: "" } } };

export const SPEAKER_A: SpeakerDto = { id: "spk-a", ordinal: 1, name: "陈明", colorIndex: 0, used: true };
export const SPEAKER_B: SpeakerDto = { id: "spk-b", ordinal: 2, name: "林雪", colorIndex: 1, used: true };
/** Named by nobody and used by nothing. */
export const SPEAKER_C: SpeakerDto = { id: "spk-c", ordinal: 3, colorIndex: 2, used: false };

/** Six sentences: A A B B B A, one second apart each four seconds long. */
export function talk(): TranscriptSegmentDto[] {
  const who = ["spk-a", "spk-a", "spk-b", "spk-b", "spk-b", "spk-a"];
  return who.map((speakerId, index) => segment(`t${index + 1}`, index, index * 4_000, index * 4_000 + 4_000, `第${index + 1}句内容。`, { speakerId }));
}

/** Answers a PUT with the body it was sent, at `version`. */
export const echoPut = (version: number) => (call: RecordedCall) => ({ body: { id: "d1", contentId: "c1", ...(call.body as object), version, updatedAt: 1 } });

export const puts = (calls: RecordedCall[]) =>
  calls.filter((call) => call.method === "PUT" && call.path.endsWith("/transcript/draft")).map((call) => call.body as { expectedVersion: number | null; segments: Array<Record<string, unknown>> });

export const commitBodies = (calls: RecordedCall[]) => calls.filter((call) => call.path.endsWith("/draft/commit")).map((call) => call.body);

/** Routes of a Content whose base revision `r1` has the given sentences, with no draft yet. */
export function editorRoutes(base: readonly TranscriptSegmentDto[] = talk(), speakers: readonly SpeakerDto[] = [SPEAKER_A, SPEAKER_B, SPEAKER_C]) {
  return {
    "GET /api/contents/c1/transcript/draft": NOT_FOUND,
    "GET /api/transcript/revisions/r1/segments": { body: { revision: revision("r1"), items: base } },
    "GET /api/contents/c1/speakers": { body: { items: speakers } },
    "PUT /api/contents/c1/transcript/draft": echoPut(1),
    "POST /api/contents/c1/transcript/draft/commit": { status: 201, body: revision("m1", { kind: "manual", parentRevisionId: "r1" }) },
  };
}

export function renderSpeakerEditor(options: { onClose?: () => void; applySpeakersFrom?: string; wrap?: (children: ReactNode) => ReactNode } = {}) {
  stubResizeObserver();
  Element.prototype.scrollIntoView ??= () => undefined;
  const onClose = options.onClose ?? vi.fn();
  const state = { content: contentDetail(), primaryRevisionId: "r1", selection: undefined, select: vi.fn(), openTab: vi.fn(), highlightThreshold: 80, setHighlightThreshold: vi.fn(), openSubtitleEditor: vi.fn() };
  const editor = <DraftEditor base={revision("r1")} primaryRevisionId="r1" onClose={onClose} {...(options.applySpeakersFrom === undefined ? {} : { applySpeakersFrom: options.applySpeakersFrom })} />;
  renderApp(<ContentPageProvider value={state}>{options.wrap === undefined ? editor : options.wrap(editor)}</ContentPageProvider>);
  return onClose;
}

export { mockApi };
