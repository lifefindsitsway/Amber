import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { monotonicFactory } from "ulid";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { openDatabase } from "../../src/server/adapters/sqlite/database.ts";
import { canonicalJson } from "../../src/server/domain/canonical-json.ts";
import { UNKNOWN_CAPABILITY_FLAGS } from "../../src/server/domain/provider-profile.ts";
import { TaskEventBus } from "../../src/server/pipeline/events.ts";
import { transact } from "../../src/server/pipeline/publish.ts";
import { createTask } from "../../src/server/pipeline/task-state.ts";
import type { SegmentId } from "../../src/shared/ids.ts";
import { composeServerStack, type ComposedStack, type StackRequest } from "../fixtures/server/composed-stack.ts";
import { MODEL_SNAPSHOT } from "../fixtures/pipeline/summary-data.ts";
import { lectureTranscripts } from "../fixtures/transcripts/lecture.ts";

/**
 * User B holds every resource id of user A and walks every route the server
 * mode registers. The matrix below is keyed by the registered routes and is fail-closed:
 * a route without an entry, or an entry without a route, fails. Owned resources answer
 * 404 exactly like unknown ids, administration answers 403, and afterwards A's data is
 * byte-for-byte what it was. No request leaves the machine: providers are written to the
 * database directly, and the self-scoped calls that could reach out are not sent.
 */

const newId = monotonicFactory();
/** Text only A's data contains. */
const MARK = "alicemarkzq";

interface AliceIds {
  userId: string;
  contentId: string;
  asrRevisionId: string;
  correctedRevisionId: string;
  segmentId: string;
  correctedSegmentId: string;
  noteId: string;
  summaryArtifactId: string;
  summaryRevisionId: string;
  chapterRevisionId: string;
  collectionId: string;
  collectionItemId: string;
  taskId: string;
  workUnitId: string;
  assetId: string;
  assetFile: string;
  providerId: string;
  asrProfileId: string;
  otherModelsId: string;
  templateId: string;
  bobCollectionId: string;
  threadId: string;
  chatAnswerId: string;
}

type Entry =
  | { kind: "owned"; requests: (ids: AliceIds) => StackRequest[] }
  | { kind: "admin" }
  | { kind: "public"; reason: string }
  | { kind: "self"; reason: string; requests?: (ids: AliceIds) => StackRequest[] };

const modelRef = (ids: AliceIds) => ({ providerProfileId: ids.providerId, modelId: "model-a" });
const owned = (requests: Entry & { kind: "owned" } extends infer E ? (E extends { requests: infer R } ? R : never) : never): Entry => ({ kind: "owned", requests });
const get = (url: string): StackRequest => ({ method: "GET", url });

const MATRIX: Record<string, Entry> = {
  "GET /api/health": { kind: "public", reason: "liveness only, no user data" },
  "GET /api/version": { kind: "public", reason: "version and run mode only" },
  "POST /api/auth/login": { kind: "public", reason: "the login itself" },
  "GET /api/setup": { kind: "public", reason: "only tells whether the instance is initialized" },
  "POST /api/setup": { kind: "public", reason: "token-protected; an initialized instance answers 409" },
  "GET /api/auth/me": { kind: "self", reason: "the caller's own principal", requests: () => [get("/api/auth/me")] },
  "POST /api/auth/logout": { kind: "self", reason: "ends the caller's own session (sent with a throwaway session)" },
  "POST /api/auth/change-password": {
    kind: "self",
    reason: "the caller's own credential",
    requests: () => [{ method: "POST", url: "/api/auth/change-password", payload: { currentPassword: "not-the-password", newPassword: "whatever-placeholder" } }],
  },
  "GET /api/tasks": {
    kind: "self",
    reason: "lists the caller's Tasks; a filter naming A's Content finds nothing",
    requests: (ids) => [get("/api/tasks"), get(`/api/tasks?contentId=${ids.contentId}`), get(`/api/tasks?collectionId=${ids.collectionId}`)],
  },
  "GET /api/tasks/events": { kind: "self", reason: "an open stream of the caller's own events (per-user filtering is covered by the SSE tests)" },
  "GET /api/tasks/:id": owned((ids) => [get(`/api/tasks/${ids.taskId}`)]),
  "POST /api/tasks/:id/cancel": owned((ids) => [{ method: "POST", url: `/api/tasks/${ids.taskId}/cancel` }]),
  "POST /api/tasks/:id/retry-stage": owned((ids) => [{ method: "POST", url: `/api/tasks/${ids.taskId}/retry-stage`, payload: { stage: "media" } }]),
  "POST /api/tasks/:id/work-units/:wid/confirm-resend": owned((ids) => [{ method: "POST", url: `/api/tasks/${ids.taskId}/work-units/${ids.workUnitId}/confirm-resend` }]),
  "GET /api/instance-settings": { kind: "admin" },
  "PATCH /api/instance-settings": { kind: "admin" },
  "GET /api/fonts/subtitle": { kind: "self", reason: "the bundled subtitle font, the same file for every user; no user data" },
  "GET /api/settings": { kind: "self", reason: "the caller's own preferences", requests: () => [get("/api/settings")] },
  "PATCH /api/settings": {
    kind: "self",
    reason: "the caller's own preferences; A's ASR model is refused as a default",
    requests: (ids) => [
      { method: "PATCH", url: "/api/settings", payload: { theme: "dark" } },
      { method: "PATCH", url: "/api/settings", payload: { defaultAsrModelRef: { asrProfileId: ids.asrProfileId, modelId: "qwen-audio-3.1-asr-flash-filetrans" } } },
    ],
  },
  "POST /api/contents/import": {
    kind: "self",
    reason: "creates the caller's own Contents; an unsupported URL is refused before anything goes online",
    requests: () => [{ method: "POST", url: "/api/contents/import", payload: { items: [{ url: "https://example.invalid/watch?v=1" }] } }],
  },
  "POST /api/contents/inspect": {
    kind: "self",
    reason: "inspects a URL for the caller; an unsupported URL is refused before anything goes online",
    requests: () => [{ method: "POST", url: "/api/contents/inspect", payload: { url: "https://example.invalid/watch?v=1" } }],
  },
  "GET /api/contents": {
    kind: "self",
    reason: "lists the caller's Contents; filters naming A's resources find nothing",
    requests: (ids) => [get("/api/contents"), get("/api/contents?uncollected=1"), get(`/api/contents?collectionId=${ids.collectionId}`)],
  },
  "POST /api/contents/upload": { kind: "self", reason: "creates the caller's own Content (multipart only; quota and isolation covered by the upload tests)" },
  "GET /api/contents/:id": owned((ids) => [get(`/api/contents/${ids.contentId}`)]),
  "PATCH /api/contents/:id": owned((ids) => [
    { method: "PATCH", url: `/api/contents/${ids.contentId}`, payload: { title: "taken" } },
    { method: "PATCH", url: `/api/contents/${ids.contentId}`, payload: { pinned: true } },
  ]),
  "DELETE /api/contents/:id": owned((ids) => [{ method: "DELETE", url: `/api/contents/${ids.contentId}` }]),
  "POST /api/contents/:id/subtitle-import": owned((ids) => [
    { method: "POST", url: `/api/contents/${ids.contentId}/subtitle-import`, payload: { text: "1\n00:00:00,000 --> 00:00:01,000\nx\n", format: "srt", language: "en" } },
  ]),
  "GET /api/contents/:id/transcript/revisions": owned((ids) => [get(`/api/contents/${ids.contentId}/transcript/revisions`)]),
  "PUT /api/contents/:id/primary-transcript": owned((ids) => [
    { method: "PUT", url: `/api/contents/${ids.contentId}/primary-transcript`, payload: { revisionId: ids.correctedRevisionId } },
  ]),
  "POST /api/contents/:id/transcript/retranscribe": owned((ids) => [
    { method: "POST", url: `/api/contents/${ids.contentId}/transcript/retranscribe`, payload: {} },
    { method: "POST", url: `/api/contents/${ids.contentId}/transcript/retranscribe`, payload: { asrModelRef: { asrProfileId: ids.asrProfileId, modelId: "qwen-audio-3.1-asr-flash-filetrans" } } },
  ]),
  "GET /api/transcript/revisions/:rid/segments": owned((ids) => [get(`/api/transcript/revisions/${ids.asrRevisionId}/segments`)]),
  "GET /api/contents/:id/transcript/draft": owned((ids) => [get(`/api/contents/${ids.contentId}/transcript/draft`)]),
  "PUT /api/contents/:id/transcript/draft": owned((ids) => [
    { method: "PUT", url: `/api/contents/${ids.contentId}/transcript/draft`, payload: { baseRevisionId: ids.asrRevisionId, segments: [] } },
  ]),
  "DELETE /api/contents/:id/transcript/draft": owned((ids) => [{ method: "DELETE", url: `/api/contents/${ids.contentId}/transcript/draft` }]),
  "PUT /api/transcript/revisions/:rid/archived": owned((ids) => [
    { method: "PUT", url: `/api/transcript/revisions/${ids.asrRevisionId}/archived`, payload: { archived: true } },
  ]),
  "DELETE /api/transcript/revisions/:rid": owned((ids) => [
    { method: "DELETE", url: `/api/transcript/revisions/${ids.correctedRevisionId}?withDescendants=true` },
  ]),
  "POST /api/contents/:id/transcript/draft/commit": owned((ids) => [
    { method: "POST", url: `/api/contents/${ids.contentId}/transcript/draft/commit`, payload: { expectedPrimaryRevisionId: ids.asrRevisionId } },
  ]),
  "GET /api/transcript/segments/:sid/map": owned((ids) => [get(`/api/transcript/segments/${ids.segmentId}/map?targetRevision=${ids.correctedRevisionId}`)]),
  "POST /api/contents/:id/transcript/proofread": owned((ids) => [{ method: "POST", url: `/api/contents/${ids.contentId}/transcript/proofread`, payload: { modelRef: modelRef(ids) } }]),
  "GET /api/contents/:id/chapters": owned((ids) => [get(`/api/contents/${ids.contentId}/chapters`)]),
  "PUT /api/contents/:id/chapters/current": owned((ids) => [
    { method: "PUT", url: `/api/contents/${ids.contentId}/chapters/current`, payload: { revisionId: ids.chapterRevisionId } },
  ]),
  "POST /api/contents/:id/chapters/regenerate": owned((ids) => [{ method: "POST", url: `/api/contents/${ids.contentId}/chapters/regenerate`, payload: { modelRef: modelRef(ids) } }]),
  "GET /api/contents/:id/highlights": owned((ids) => [get(`/api/contents/${ids.contentId}/highlights`)]),
  "POST /api/contents/:id/highlights/recompute": owned((ids) => [{ method: "POST", url: `/api/contents/${ids.contentId}/highlights/recompute`, payload: { modelRef: modelRef(ids) } }]),
  "GET /api/contents/:id/translations": owned((ids) => [get(`/api/contents/${ids.contentId}/translations`)]),
  "POST /api/contents/:id/translations": owned((ids) => [
    { method: "POST", url: `/api/contents/${ids.contentId}/translations`, payload: { targetLanguages: ["en"], modelRef: modelRef(ids) } },
  ]),
  "POST /api/contents/:id/export": owned((ids) => [
    { method: "POST", url: `/api/contents/${ids.contentId}/export`, payload: { format: "srt", revisionId: ids.asrRevisionId } },
    { method: "POST", url: `/api/contents/${ids.contentId}/export`, payload: { format: "markdown", sections: { transcript: { revisionId: ids.asrRevisionId } }, backlinks: false } },
  ]),
  "POST /api/collections/:id/export": owned((ids) => [{ method: "POST", url: `/api/collections/${ids.collectionId}/export`, payload: { backlinks: false } }]),
  "GET /api/summary-templates": { kind: "self", reason: "builtin templates and the caller's own", requests: () => [get("/api/summary-templates")] },
  "POST /api/summary-templates": {
    kind: "self",
    reason: "creates the caller's own template",
    requests: () => [{ method: "POST", url: "/api/summary-templates", payload: { name: "bob template", prompt: "bob prompt" } }],
  },
  "PATCH /api/summary-templates/:id": owned((ids) => [{ method: "PATCH", url: `/api/summary-templates/${ids.templateId}`, payload: { prompt: "changed" } }]),
  "DELETE /api/summary-templates/:id": owned((ids) => [{ method: "DELETE", url: `/api/summary-templates/${ids.templateId}` }]),
  "GET /api/summary-templates/:id/versions": owned((ids) => [get(`/api/summary-templates/${ids.templateId}/versions`)]),
  "GET /api/contents/:id/summaries": owned((ids) => [get(`/api/contents/${ids.contentId}/summaries`)]),
  "POST /api/contents/:id/summaries": owned((ids) => [
    { method: "POST", url: `/api/contents/${ids.contentId}/summaries`, payload: { templateId: "summary.core", modelRef: modelRef(ids) } },
    // B's own Content with A's template must not reach it either.
    { method: "POST", url: `/api/contents/${ids.contentId}/summaries`, payload: { templateId: ids.templateId, modelRef: modelRef(ids) } },
  ]),
  "GET /api/summaries/:aid/revisions": owned((ids) => [get(`/api/summaries/${ids.summaryArtifactId}/revisions`)]),
  "PUT /api/summaries/:aid/current": owned((ids) => [{ method: "PUT", url: `/api/summaries/${ids.summaryArtifactId}/current`, payload: { revisionId: ids.summaryRevisionId } }]),
  "GET /api/collections": { kind: "self", reason: "lists the caller's collections", requests: () => [get("/api/collections")] },
  "POST /api/collections": { kind: "self", reason: "creates the caller's own collection", requests: () => [{ method: "POST", url: "/api/collections", payload: { name: "bob collection 2" } }] },
  "GET /api/collections/:id": owned((ids) => [get(`/api/collections/${ids.collectionId}`)]),
  "PATCH /api/collections/:id": owned((ids) => [{ method: "PATCH", url: `/api/collections/${ids.collectionId}`, payload: { name: "taken" } }]),
  "DELETE /api/collections/:id": owned((ids) => [{ method: "DELETE", url: `/api/collections/${ids.collectionId}` }]),
  "POST /api/collections/:id/items": owned((ids) => [
    { method: "POST", url: `/api/collections/${ids.collectionId}/items`, payload: { contentId: ids.contentId } },
    // A's Content into B's own collection.
    { method: "POST", url: `/api/collections/${ids.bobCollectionId}/items`, payload: { contentId: ids.contentId } },
  ]),
  "PUT /api/collections/:id/items/order": owned((ids) => [{ method: "PUT", url: `/api/collections/${ids.collectionId}/items/order`, payload: { itemIds: [ids.collectionItemId] } }]),
  "DELETE /api/collections/:id/items/:iid": owned((ids) => [
    { method: "DELETE", url: `/api/collections/${ids.collectionId}/items/${ids.collectionItemId}` },
    { method: "DELETE", url: `/api/collections/${ids.bobCollectionId}/items/${ids.collectionItemId}` },
  ]),
  "POST /api/collections/:id/summary": owned((ids) => [{ method: "POST", url: `/api/collections/${ids.collectionId}/summary`, payload: { modelRef: modelRef(ids) } }]),
  "GET /api/collections/:id/summary": owned((ids) => [get(`/api/collections/${ids.collectionId}/summary`)]),
  "GET /api/search": owned((ids) => [get(`/api/search?q=${MARK}&scope=${ids.collectionId}`)]),
  "GET /api/contents/:id/chat": owned((ids) => [get(`/api/contents/${ids.contentId}/chat`)]),
  "POST /api/contents/:id/chat/messages": owned((ids) => [
    { method: "POST", url: `/api/contents/${ids.contentId}/chat/messages`, payload: { text: "hi", modelRef: modelRef(ids) } },
  ]),
  "GET /api/contents/:id/chat/threads": owned((ids) => [get(`/api/contents/${ids.contentId}/chat/threads`)]),
  "POST /api/contents/:id/chat/threads": owned((ids) => [{ method: "POST", url: `/api/contents/${ids.contentId}/chat/threads` }]),
  "PATCH /api/contents/:id/chat/threads/:tid": owned((ids) => [{ method: "PATCH", url: `/api/contents/${ids.contentId}/chat/threads/${ids.threadId}`, payload: { pinned: true } }]),
  "DELETE /api/contents/:id/chat/threads/:tid": owned((ids) => [{ method: "DELETE", url: `/api/contents/${ids.contentId}/chat/threads/${ids.threadId}` }]),
  "POST /api/contents/:id/chat/messages/:mid/retry": owned((ids) => [
    { method: "POST", url: `/api/contents/${ids.contentId}/chat/messages/${ids.chatAnswerId}/retry`, headers: { "idempotency-key": "bob-retry-1" }, payload: {} },
  ]),
  "POST /api/contents/:id/chat/turns/delete": owned((ids) => [{ method: "POST", url: `/api/contents/${ids.contentId}/chat/turns/delete`, payload: { messageIds: [ids.chatAnswerId] } }]),
  "DELETE /api/contents/:id/chat": owned((ids) => [{ method: "DELETE", url: `/api/contents/${ids.contentId}/chat` }]),
  "GET /api/contents/:id/notes": owned((ids) => [
    get(`/api/contents/${ids.contentId}/notes`),
    get(`/api/contents/${ids.contentId}/notes?revision=${ids.asrRevisionId}`),
  ]),
  "POST /api/contents/:id/notes": owned((ids) => [
    {
      method: "POST",
      url: `/api/contents/${ids.contentId}/notes`,
      headers: { "idempotency-key": "bob-note-1" },
      payload: {
        transcriptRevisionId: ids.correctedRevisionId, startSegmentId: ids.correctedSegmentId, startOffset: 0,
        endSegmentId: ids.correctedSegmentId, endOffset: 2, mark: "underline", color: "blue", comment: "taken",
      },
    },
  ]),
  "PATCH /api/notes/:id": owned((ids) => [
    { method: "PATCH", url: `/api/notes/${ids.noteId}`, payload: { color: "green" } },
    { method: "PATCH", url: `/api/notes/${ids.noteId}`, payload: { comment: null } },
  ]),
  "DELETE /api/notes/:id": owned((ids) => [{ method: "DELETE", url: `/api/notes/${ids.noteId}` }]),
  "GET /api/notes/groups": { kind: "self", reason: "groups the caller's own notes; none of A's", requests: () => [get("/api/notes/groups")] },
  "GET /api/trash": { kind: "self", reason: "lists the caller's own trash", requests: () => [get("/api/trash")] },
  "DELETE /api/trash": { kind: "self", reason: "empties the caller's own trash", requests: () => [{ method: "DELETE", url: "/api/trash" }] },
  "POST /api/trash/:id/restore": owned((ids) => [{ method: "POST", url: `/api/trash/${ids.contentId}/restore` }]),
  "DELETE /api/trash/:id": owned((ids) => [{ method: "DELETE", url: `/api/trash/${ids.contentId}` }]),
  "GET /api/asr-profiles": { kind: "self", reason: "lists the caller's ASR profiles", requests: () => [get("/api/asr-profiles")] },
  "POST /api/asr-profiles": {
    kind: "self",
    reason: "creates the caller's own ASR profile at a preset endpoint, which needs no lookup",
    requests: () => [{ method: "POST", url: "/api/asr-profiles", payload: { name: "bob", provider: "dashscope" } }],
  },
  "PATCH /api/asr-profiles/:id": owned((ids) => [
    { method: "PATCH", url: `/api/asr-profiles/${ids.asrProfileId}`, payload: { name: "taken" } },
    { method: "PATCH", url: `/api/asr-profiles/${ids.asrProfileId}`, payload: { models: [{ modelId: "fun-asr" }] } },
  ]),
  "PUT /api/asr-profiles/order": {
    kind: "self",
    reason: "orders the caller's own ASR profiles; naming A's profile is refused as an incomplete list",
    requests: (ids) => [{ method: "PUT", url: "/api/asr-profiles/order", payload: { profileIds: [ids.asrProfileId] } }],
  },
  "DELETE /api/asr-profiles/:id": owned((ids) => [{ method: "DELETE", url: `/api/asr-profiles/${ids.asrProfileId}` }]),
  "PUT /api/asr-profiles/:id/credential": owned((ids) => [{ method: "PUT", url: `/api/asr-profiles/${ids.asrProfileId}/credential`, payload: { value: "<placeholder>" } }]),
  "POST /api/asr-profiles/:id/probe": owned((ids) => [{ method: "POST", url: `/api/asr-profiles/${ids.asrProfileId}/probe` }]),
  "POST /api/asr-profiles/:id/test": owned((ids) => [{ method: "POST", url: `/api/asr-profiles/${ids.asrProfileId}/test`, payload: { modelId: "qwen-audio-3.1-asr-flash-filetrans" } }]),
  "PUT /api/asr-profiles/:id/model-pricing": owned((ids) => [
    { method: "PUT", url: `/api/asr-profiles/${ids.asrProfileId}/model-pricing`, payload: { modelId: "qwen-audio-3.1-asr-flash-filetrans", pricing: null } },
  ]),
  "GET /api/other-models": { kind: "self", reason: "lists the caller's own register", requests: () => [get("/api/other-models")] },
  "POST /api/other-models": {
    kind: "self",
    reason: "creates the caller's own register entry",
    requests: () => [{ method: "POST", url: "/api/other-models", payload: { name: "bob", models: [{ modelId: "tts-1", kind: "tts" }] } }],
  },
  "PUT /api/other-models/order": {
    kind: "self",
    reason: "orders the caller's own register; naming A's entry is refused as an incomplete list",
    requests: (ids) => [{ method: "PUT", url: "/api/other-models/order", payload: { profileIds: [ids.otherModelsId] } }],
  },
  "PATCH /api/other-models/:id": owned((ids) => [{ method: "PATCH", url: `/api/other-models/${ids.otherModelsId}`, payload: { name: "taken", note: null } }]),
  "DELETE /api/other-models/:id": owned((ids) => [{ method: "DELETE", url: `/api/other-models/${ids.otherModelsId}` }]),
  "PUT /api/other-models/:id/model-pricing": owned((ids) => [
    { method: "PUT", url: `/api/other-models/${ids.otherModelsId}/model-pricing`, payload: { modelId: "image-1", pricing: { currency: "USD", items: [{ unit: "per_image", amount: "0.04" }] } } },
  ]),
  "GET /api/providers": { kind: "self", reason: "lists the caller's profiles", requests: () => [get("/api/providers")] },
  "POST /api/providers": { kind: "self", reason: "creates the caller's own profile (not sent: saving resolves the baseURL host)" },
  "PUT /api/providers/order": {
    kind: "self",
    reason: "orders the caller's own profiles; naming A's profile is refused as an incomplete list",
    requests: (ids) => [{ method: "PUT", url: "/api/providers/order", payload: { profileIds: [ids.providerId] } }],
  },
  "PATCH /api/providers/:id": owned((ids) => [{ method: "PATCH", url: `/api/providers/${ids.providerId}`, payload: { name: "taken" } }]),
  "DELETE /api/providers/:id": owned((ids) => [{ method: "DELETE", url: `/api/providers/${ids.providerId}` }]),
  "PUT /api/providers/:id/credential": owned((ids) => [{ method: "PUT", url: `/api/providers/${ids.providerId}/credential`, payload: { value: "<placeholder>" } }]),
  "POST /api/providers/:id/probe": owned((ids) => [{ method: "POST", url: `/api/providers/${ids.providerId}/probe`, payload: { modelId: "model-a" } }]),
  "PUT /api/providers/:id/model-pricing": owned((ids) => [
    { method: "PUT", url: `/api/providers/${ids.providerId}/model-pricing`, payload: { modelId: "model-a", pricing: { currency: "CNY", items: [{ unit: "per_request", amount: "1" }] } } },
  ]),
  "PUT /api/providers/:id/models/:mid/override": owned((ids) => [
    { method: "PUT", url: `/api/providers/${ids.providerId}/models/model-a/override`, payload: { flags: { stream: "supported" } } },
  ]),
  "GET /api/terminology": owned((ids) => [get(`/api/terminology?scope=content:${ids.contentId}`), get(`/api/terminology?scope=collection:${ids.collectionId}`)]),
  "PUT /api/terminology": owned((ids) => [
    { method: "PUT", url: `/api/terminology?scope=content:${ids.contentId}`, payload: { entries: [{ term: "x" }] } },
    { method: "PUT", url: `/api/terminology?scope=collection:${ids.collectionId}`, payload: { entries: [{ term: "x" }] } },
  ]),
  "GET /api/web-search": { kind: "self", reason: "the caller's own search service", requests: () => [get("/api/web-search")] },
  "PUT /api/web-search": {
    kind: "self",
    reason: "chooses the caller's own search service",
    requests: () => [{ method: "PUT", url: "/api/web-search", payload: { service: "tavily" } }],
  },
  "PUT /api/web-search/credential": {
    kind: "self",
    reason: "the caller's own search key",
    requests: () => [{ method: "PUT", url: "/api/web-search/credential", payload: { value: "<placeholder>" } }],
  },
  "DELETE /api/web-search": { kind: "self", reason: "removes the caller's own search service", requests: () => [{ method: "DELETE", url: "/api/web-search" }] },
  "POST /api/web-search/test": { kind: "self", reason: "a search with the caller's own key (not sent: it would go online)" },
  "GET /api/usage": { kind: "self", reason: "the caller's own usage", requests: () => [get("/api/usage")] },
  "GET /api/storage": { kind: "self", reason: "the caller's own stored bytes and limit", requests: () => [get("/api/storage")] },
  "GET /api/platform-accounts": { kind: "self", reason: "the caller's own accounts", requests: () => [get("/api/platform-accounts")] },
  "PUT /api/platform-accounts/:platform/cookies": { kind: "self", reason: "the caller's own account of a platform (not sent: it stores a credential)" },
  "POST /api/platform-accounts/:platform/check": { kind: "self", reason: "checks the caller's own account upstream (not sent: it would go online)" },
  "DELETE /api/platform-accounts/:platform": { kind: "self", reason: "the caller's own account of a platform", requests: () => [{ method: "DELETE", url: "/api/platform-accounts/bilibili" }] },
  "POST /api/platform-accounts/bilibili/qr": { kind: "self", reason: "starts the caller's own QR login (not sent: it would go online)" },
  "GET /api/platform-accounts/bilibili/qr/:attemptId": {
    kind: "self",
    reason: "attempts are kept per caller; another user's attempt id is unknown (route test covers it)",
    requests: () => [get("/api/platform-accounts/bilibili/qr/01UNKNOWNATTEMPT0000000000")],
  },
  "GET /api/media/:assetId": owned((ids) => [{ method: "GET", url: `/api/media/${ids.assetId}`, headers: { range: "bytes=0-9" } }, get(`/api/media/${ids.assetId}`)]),
  "HEAD /api/media/:assetId": owned((ids) => [{ method: "HEAD", url: `/api/media/${ids.assetId}` }]),
  "DELETE /api/media/:assetId": owned((ids) => [{ method: "DELETE", url: `/api/media/${ids.assetId}` }]),
  "POST /api/admin/credentials/reset": { kind: "admin" },
  "GET /api/admin/users": { kind: "admin" },
  "POST /api/admin/users": { kind: "admin" },
  "PATCH /api/admin/users/:id": { kind: "admin" },
  "POST /api/admin/users/:id/reset-password": { kind: "admin" },
  "DELETE /api/admin/users/:id": { kind: "admin" },
  "GET /api/admin/storage": { kind: "admin" },
  "GET /api/admin/network-allowlist": { kind: "admin" },
  "PUT /api/admin/network-allowlist": { kind: "admin" },
};

/** Administration requests aimed at A: a refusal must come before anything is read or changed. */
function adminRequests(key: string, ids: AliceIds): StackRequest[] {
  const [method, path] = key.split(" ") as [StackRequest["method"], string];
  const url = path.replace(":id", ids.userId);
  const payloads: Record<string, unknown> = {
    "PATCH /api/instance-settings": { concurrencyPipeline: 3 },
    "POST /api/admin/users": { username: "mallory", password: "placeholder-password", role: "admin" },
    "PATCH /api/admin/users/:id": { status: "suspended" },
    "POST /api/admin/users/:id/reset-password": { newPassword: "placeholder-password" },
    "PUT /api/admin/network-allowlist": { origins: ["http://10.0.0.5"] },
  };
  return [{ method, url, ...(key in payloads ? { payload: payloads[key] } : {}) }];
}

let stack: ComposedStack;
let ids: AliceIds;
let bobCookie: string;

function seedAlice(userId: string, bobId: string): AliceIds {
  const repository = stack.composition.repository;
  const contentId = newId();
  const transcripts = lectureTranscripts(contentId);
  const now = Date.now();
  const summaryRevisionId = newId();
  const chapterRevisionId = newId();
  const collectionId = newId();
  const collectionItemId = newId();
  const providerId = newId();
  const asrProfileId = newId();
  const otherModelsId = newId();
  const templateId = newId();
  const assetId = newId();
  const bobCollectionId = newId();
  const noteId = newId();
  const threadId = newId();
  const chatAnswerId = newId();
  const storageRef = `assets/${userId}/${contentId}/${assetId}`;
  const assetFile = join(stack.dataDir, storageRef);
  mkdirSync(dirname(assetFile), { recursive: true });
  writeFileSync(assetFile, Buffer.from(`${MARK}-media-bytes-0123456789`));
  const segments = transcripts.corrected.segments;
  const summaryArtifactId = repository.withTransaction((scope) => {
    scope.contents.insert({ id: contentId, userId, source: { kind: "local" }, title: `${MARK} lecture`, processingStatus: "succeeded", createdAt: now, updatedAt: now });
    for (const { revision, segments: rows } of [transcripts.platform, transcripts.asr, transcripts.corrected]) {
      scope.transcripts.insertRevision(userId, revision, rows);
    }
    scope.contents.setPrimaryTranscript(userId, contentId, transcripts.asr.revision.id, now);
    scope.transcripts.putDraft(userId, {
      id: newId(),
      contentId,
      baseRevisionId: transcripts.asr.revision.id,
      segments: transcripts.asr.segments.map((segment) => ({ startMs: segment.startMs, endMs: segment.endMs, text: `${MARK} ${segment.text}`, sourceSegmentIds: [segment.id] })),
      updatedAt: now,
    });
    const { artifactId } = scope.summaries.insertRevision(userId, {
      contentId,
      templateId: "summary.core",
      artifactId: newId(),
      revision: {
        id: summaryRevisionId,
        provenance: { inputs: [{ kind: "transcriptRevision", id: transcripts.corrected.revision.id }], modelRef: MODEL_SNAPSHOT, promptRef: { id: "summary.core", version: 1 }, promptSnapshot: "<s>", createdAt: now },
        quality: "normal",
        body: `${MARK} 摘要 [[seg:${segments[0]?.id}]]`,
        citations: [{ transcriptRevisionId: transcripts.corrected.revision.id, segmentId: segments[0]?.id as SegmentId }],
      },
    });
    scope.summaries.setCurrent(userId, artifactId, summaryRevisionId);
    scope.chapters.insertAiRevision(userId, contentId, {
      id: chapterRevisionId,
      artifactId: newId(),
      transcriptRevisionId: transcripts.corrected.revision.id,
      chapters: [{ startMs: 0, endMs: 20_000, title: `${MARK} 开场`, startSegmentId: segments[0]?.id as SegmentId }],
      modelRef: MODEL_SNAPSHOT,
      promptRef: { id: "chapter.ai", version: 1 },
      promptSnapshot: "<c>",
      quality: "normal",
      createdAt: now,
    });
    scope.chapters.setCurrent(userId, contentId, chapterRevisionId);
    scope.collections.insert({ id: collectionId, userId, name: `${MARK} course`, createdAt: now, updatedAt: now });
    scope.collections.addItem(userId, { id: collectionItemId, collectionId, contentId, position: 0, addedAt: now });
    scope.collections.insert({ id: bobCollectionId, userId: bobId, name: "bob course", createdAt: now, updatedAt: now });
    scope.mediaAssets.insert({
      id: assetId, userId, contentId, kind: "managed_upload", storageRef, displayName: `${MARK}.webm`, mimeType: "video/webm",
      sizeBytes: readFileSync(assetFile).length, availability: "available", retentionPolicy: "keep", createdAt: now,
    });
    scope.providerProfiles.insert({
      id: providerId, userId, name: `${MARK} relay`, protocol: "openai_compatible", baseURL: "https://llm.invalid/v1",
      models: [{ modelId: "model-a", flags: { declared: UNKNOWN_CAPABILITY_FLAGS }, limits: { declared: { contextWindowTokens: 100_000 } } }], createdAt: now,
    });
    scope.asrProfiles.insert({ id: asrProfileId, userId, name: `${MARK} asr`, provider: "dashscope", models: [{ modelId: "qwen-audio-3.1-asr-flash-filetrans" }], createdAt: now });
    scope.otherModelProfiles.insert({ id: otherModelsId, userId, name: `${MARK} other`, note: `${MARK} note`, models: [{ modelId: "image-1", kind: "image_generation" }], createdAt: now });
    scope.summaryTemplates.insert(
      { id: templateId, userId, builtin: false, name: `${MARK} template`, currentVersion: 1 },
      { templateId, version: 1, prompt: `${MARK} prompt`, createdAt: now },
    );
    scope.terminology.put({ id: newId(), userId, scope: { kind: "content", contentId }, entries: [{ id: newId(), ordinal: 0, term: `${MARK}term`, normalizedKey: `${MARK}term` }] });
    scope.terminology.put({ id: newId(), userId, scope: { kind: "collection", collectionId }, entries: [{ id: newId(), ordinal: 0, term: `${MARK}term2`, normalizedKey: `${MARK}term2` }] });
    scope.chat.insertThread(userId, { id: threadId, contentId, createdAt: now });
    scope.chat.insertMessage(userId, { id: newId(), threadId, role: "user", text: `${MARK} question`, status: "complete", citations: [], createdAt: now });
    scope.chat.insertMessage(userId, {
      id: chatAnswerId, threadId, role: "assistant", text: `${MARK} answer`, status: "complete", modelRef: MODEL_SNAPSHOT, citations: [], createdAt: now + 1, finishedAt: now + 2,
    });
    const noted = segments[0];
    scope.notes.insert({
      id: noteId, userId, contentId, transcriptRevisionId: transcripts.corrected.revision.id, startSegmentId: noted?.id as string, startOffset: 0,
      endSegmentId: noted?.id as string, endOffset: 2, quote: noted?.text.slice(0, 2) ?? "", mark: "background", color: "yellow",
      comment: `${MARK} note`, createdAt: now, updatedAt: now,
    });
    scope.search.syncContent(userId, contentId);
    scope.search.syncCollection(userId, collectionId);
    return artifactId;
  });
  // A Task stays queued: the scheduler is never started in this test.
  const { taskId, workUnitId } = transact(repository, new TaskEventBus(), (scope, outbox) => {
    const task = createTask(scope, outbox, {
      task: { id: newId(), userId, contentId, kind: "reproofread", requestJson: canonicalJson({ requestSchemaVersion: 1, kind: "reproofread" }), createdAt: now },
      sourceKind: "local",
      newId,
    });
    const [run] = scope.stageRuns.listByTask(userId, task.id);
    const workUnitId = newId();
    scope.workUnits.insert(userId, { id: workUnitId, stageRunId: run?.id as string, key: "proofread:chunk:0", status: "pending", attempt: 1, retryCount: 0, inputDigest: "d", billing: "llm" });
    return { taskId: task.id, workUnitId };
  });
  return {
    userId, contentId, asrRevisionId: transcripts.asr.revision.id, correctedRevisionId: transcripts.corrected.revision.id, segmentId: transcripts.asr.segments[0]?.id as string,
    correctedSegmentId: segments[0]?.id as string, noteId,
    summaryArtifactId, summaryRevisionId, chapterRevisionId, collectionId, collectionItemId, taskId, workUnitId, assetId, assetFile, providerId, asrProfileId, otherModelsId, templateId, bobCollectionId,
    threadId, chatAnswerId,
  };
}

/** Every row of every table except the session bookkeeping that logins legitimately touch. */
function databaseDump(): string {
  const { db } = openDatabase(join(stack.dataDir, "amber.db"), { backupDir: join(stack.dataDir, "backups") });
  try {
    const tables = (db.prepare("SELECT name FROM sqlite_master WHERE type = 'table' AND name NOT LIKE 'sqlite_%' AND name NOT LIKE 'search_index_%' ORDER BY name").all() as Array<{ name: string }>)
      .map((row) => row.name)
      .filter((name) => name !== "session");
    return JSON.stringify(tables.map((name) => [name, db.prepare(`SELECT * FROM "${name}" ORDER BY 1`).all()]), (_key, value: unknown) =>
      Buffer.isBuffer(value) ? value.toString("base64") : value,
    );
  } finally {
    db.close();
  }
}

function aliceValues(): string[] {
  return [MARK, ...Object.entries(ids).filter(([name]) => name !== "assetFile" && name !== "bobCollectionId").map(([, value]) => value)];
}

beforeAll(async () => {
  stack = await composeServerStack();
  const alice = await stack.createUser("alice");
  const bob = await stack.createUser("bob");
  bobCookie = bob.cookie;
  ids = seedAlice(alice.id, bob.id);
}, 60_000);

afterAll(async () => {
  await stack?.close();
});

describe("user B against every server route holding user A's ids", () => {
  it("has exactly one matrix entry per registered /api route", () => {
    const routes = new Set(stack.composition.routes.filter((route) => route.url.startsWith("/api/")).map((route) => `${route.method} ${route.url}`));
    expect([...routes].filter((route) => !(route in MATRIX)).sort(), "registered routes without a matrix entry").toEqual([]);
    expect(Object.keys(MATRIX).filter((key) => !routes.has(key)).sort(), "matrix entries without a route").toEqual([]);
  });

  it("self-scoped routes show B nothing of A", async () => {
    for (const [key, entry] of Object.entries(MATRIX)) {
      if (entry.kind !== "self" || entry.requests === undefined) continue;
      for (const request of entry.requests(ids)) {
        const response = await stack.send(request, bobCookie);
        expect([key, request.url, response.statusCode < 500]).toEqual([key, request.url, true]);
        for (const value of aliceValues()) {
          expect(response.body.includes(value), `${request.method} ${request.url} leaks ${value}`).toBe(false);
        }
      }
    }
    // Logout ends only the session it is sent with.
    const throwaway = await stack.login("bob");
    expect((await stack.send({ method: "POST", url: "/api/auth/logout" }, throwaway)).statusCode).toBe(204);
    expect((await stack.send(get("/api/auth/me"), throwaway)).statusCode).toBe(401);
    expect((await stack.send(get("/api/auth/me"), bobCookie)).statusCode).toBe(200);
    // Search over B's own scope does not find A's text either.
    for (const url of [`/api/search?q=${MARK}`, `/api/search?q=${MARK}&scope=library`]) {
      const response = await stack.send(get(url), bobCookie);
      expect(response.statusCode).toBe(200);
      expect(response.body.includes(MARK), url).toBe(false);
    }
  });

  it("owned resources answer 404 and administration 403, and A's data is unchanged afterwards", async () => {
    const before = databaseDump();
    const mediaBefore = readFileSync(ids.assetFile);
    // Every deviation is collected so one run names them all.
    const deviations: string[] = [];
    for (const [key, entry] of Object.entries(MATRIX)) {
      if (entry.kind === "owned") {
        for (const request of entry.requests(ids)) {
          const response = await stack.send(request, bobCookie);
          const errorClass = request.method === "HEAD" ? "not_found" : (response.json() as { error?: { class?: string } }).error?.class;
          if (response.statusCode !== 404 || errorClass !== "not_found") {
            deviations.push(`${request.method} ${request.url} → ${response.statusCode} ${response.body.slice(0, 200)}`);
          }
          const leaked = aliceValues().filter((value) => response.body.includes(value));
          if (leaked.length > 0) deviations.push(`${request.method} ${request.url} leaks ${leaked.join(", ")}`);
        }
      } else if (entry.kind === "admin") {
        for (const request of adminRequests(key, ids)) {
          const response = await stack.send(request, bobCookie);
          if (response.statusCode !== 403 || (response.json() as { error?: { class?: string } }).error?.class !== "forbidden") {
            deviations.push(`${request.method} ${request.url} → ${response.statusCode} ${response.body.slice(0, 200)}`);
          }
        }
      }
    }
    expect(deviations).toEqual([]);
    expect(databaseDump()).toBe(before);
    expect(readFileSync(ids.assetFile).equals(mediaBefore)).toBe(true);
  });

  it("A still reaches every resource B was refused", async () => {
    const alice = await stack.login("alice");
    for (const url of [
      `/api/contents/${ids.contentId}`, `/api/tasks/${ids.taskId}`, `/api/collections/${ids.collectionId}`, `/api/summaries/${ids.summaryArtifactId}/revisions`,
      `/api/summary-templates/${ids.templateId}/versions`, `/api/terminology?scope=content:${ids.contentId}`, `/api/contents/${ids.contentId}/transcript/draft`,
    ]) {
      expect([url, (await stack.send(get(url), alice)).statusCode]).toEqual([url, 200]);
    }
    // Her note, on its own revision and mapped onto the ASR original it was proofread from.
    for (const url of [`/api/contents/${ids.contentId}/notes`, `/api/contents/${ids.contentId}/notes?revision=${ids.asrRevisionId}`]) {
      const notes = await stack.send(get(url), alice);
      expect([url, notes.statusCode, notes.body.includes(ids.noteId), notes.body.includes(MARK)]).toEqual([url, 200, true, true]);
    }
    const groups = await stack.send(get("/api/notes/groups"), alice);
    expect(groups.json()).toMatchObject({ total: 1, items: [{ contentId: ids.contentId, count: 1 }] });
    const ranged = await stack.send({ method: "GET", url: `/api/media/${ids.assetId}`, headers: { range: "bytes=0-9" } }, alice);
    expect(ranged.statusCode).toBe(206);
    expect(ranged.body).toBe(MARK.slice(0, 10));
  });
});

/** Matrix entries that reach A's Content or one of its sub-resources by id. */
const CONTENT_SCOPED = (key: string): boolean =>
  /^(GET|HEAD|POST|PUT|PATCH|DELETE) \/api\/(contents\/:id|transcript\/|summaries\/|notes\/:id|tasks\/:id|media\/:assetId)/u.test(key) ||
  key === "DELETE /api/collections/:id/items/:iid" ||
  key === "POST /api/collections/:id/items";

describe("A's Content in the trash", () => {
  it("answers 404 to A herself on every route of the Content and its sub-resources, changing nothing", async () => {
    const alice = await stack.login("alice");
    // Her Task must have finished before the Content can go to the trash.
    stack.composition.repository.withTransaction((scope) => scope.tasks.setProjection(ids.userId, ids.taskId, "cancelled", Date.now()));
    expect((await stack.send({ method: "DELETE", url: `/api/contents/${ids.contentId}` }, alice)).statusCode).toBe(204);
    const trash = await stack.send(get("/api/trash"), alice);
    expect(trash.json()).toMatchObject({ total: 1, items: [{ id: ids.contentId }] });
    expect(trash.body.includes(ids.contentId)).toBe(true);

    const before = databaseDump();
    const deviations: string[] = [];
    const requests = [
      ...Object.entries(MATRIX).flatMap(([key, entry]) => (entry.kind === "owned" && CONTENT_SCOPED(key) ? entry.requests(ids) : [])),
      get(`/api/tasks?contentId=${ids.contentId}`),
      get(`/api/terminology?scope=content:${ids.contentId}`),
      { method: "PUT" as const, url: `/api/terminology?scope=content:${ids.contentId}`, payload: { entries: [{ term: "x" }] } },
    ];
    // Every Content route of the matrix is walked, not a handful.
    expect(requests.length).toBeGreaterThan(45);
    for (const request of requests) {
      const response = await stack.send(request, alice);
      const errorClass = request.method === "HEAD" ? "not_found" : (response.json() as { error?: { class?: string } }).error?.class;
      if (response.statusCode !== 404 || errorClass !== "not_found") {
        deviations.push(`${request.method} ${request.url} → ${response.statusCode} ${response.body.slice(0, 200)}`);
      }
    }
    expect(deviations).toEqual([]);
    expect(databaseDump()).toBe(before);
    // Lists and search show nothing of it either.
    for (const url of ["/api/contents", `/api/collections/${ids.collectionId}`, "/api/notes/groups", `/api/search?q=${MARK}`]) {
      const response = await stack.send(get(url), alice);
      expect([url, response.statusCode, response.body.includes(ids.contentId)]).toEqual([url, 200, false]);
    }
    // Restored, everything is hers again.
    expect((await stack.send({ method: "POST", url: `/api/trash/${ids.contentId}/restore` }, alice)).statusCode).toBe(200);
    expect((await stack.send(get(`/api/contents/${ids.contentId}`), alice)).statusCode).toBe(200);
  });
});
