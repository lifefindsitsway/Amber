export type RunModeName = "server" | "local";

/** One `/api` route, without the prefix, and the run modes that register it. */
export interface ApiRoute {
  method: "GET" | "HEAD" | "POST" | "PUT" | "PATCH" | "DELETE";
  path: string;
  modes: readonly RunModeName[];
}

const BOTH: readonly RunModeName[] = ["server", "local"];

/**
 * Every `/api` route of both run modes, grouped by resource. `server` routes exist only in the
 * multi-user server (password login and setup, uploads, media streaming to the browser, QR
 * login, storage quotas, administration); `local` routes exist only behind the desktop client
 * (local-file import, burn, media caching and relinking, save grants, the cache location,
 * browser cookie import, system activity and maintenance, backup).
 */
export const API_ROUTES: readonly ApiRoute[] = [
  // auth
  { method: "POST", path: "/auth/login", modes: ["server"] },
  { method: "POST", path: "/auth/logout", modes: BOTH },
  { method: "GET", path: "/auth/me", modes: BOTH },
  { method: "POST", path: "/auth/change-password", modes: ["server"] },
  // setup
  { method: "GET", path: "/setup", modes: ["server"] },
  { method: "POST", path: "/setup", modes: ["server"] },
  // contents
  { method: "POST", path: "/contents/inspect", modes: BOTH },
  { method: "POST", path: "/contents/import", modes: BOTH },
  { method: "POST", path: "/contents/upload", modes: ["server"] },
  { method: "POST", path: "/contents/local-file", modes: ["local"] },
  { method: "POST", path: "/contents/:id/subtitle-import", modes: BOTH },
  { method: "GET", path: "/contents", modes: BOTH },
  { method: "PATCH", path: "/contents/:id", modes: BOTH },
  { method: "GET", path: "/contents/:id", modes: BOTH },
  { method: "DELETE", path: "/contents/:id", modes: BOTH },
  // tasks
  { method: "GET", path: "/tasks", modes: BOTH },
  { method: "GET", path: "/tasks/:id", modes: BOTH },
  { method: "POST", path: "/tasks/:id/cancel", modes: BOTH },
  { method: "POST", path: "/tasks/:id/retry-stage", modes: BOTH },
  { method: "POST", path: "/tasks/:id/work-units/:wid/confirm-resend", modes: BOTH },
  { method: "GET", path: "/tasks/events", modes: BOTH },
  // transcripts
  { method: "GET", path: "/contents/:id/transcript/revisions", modes: BOTH },
  { method: "GET", path: "/transcript/revisions/:rid/segments", modes: BOTH },
  { method: "PUT", path: "/contents/:id/primary-transcript", modes: BOTH },
  { method: "GET", path: "/contents/:id/transcript/draft", modes: BOTH },
  { method: "PUT", path: "/contents/:id/transcript/draft", modes: BOTH },
  { method: "DELETE", path: "/contents/:id/transcript/draft", modes: BOTH },
  { method: "POST", path: "/contents/:id/transcript/draft/commit", modes: BOTH },
  { method: "PUT", path: "/transcript/revisions/:rid/archived", modes: BOTH },
  { method: "DELETE", path: "/transcript/revisions/:rid", modes: BOTH },
  { method: "POST", path: "/contents/:id/transcript/proofread", modes: BOTH },
  { method: "POST", path: "/contents/:id/transcript/retranscribe", modes: BOTH },
  { method: "GET", path: "/transcript/segments/:sid/map", modes: BOTH },
  // summaries
  { method: "GET", path: "/contents/:id/summaries", modes: BOTH },
  { method: "POST", path: "/contents/:id/summaries", modes: BOTH },
  { method: "GET", path: "/summaries/:aid/revisions", modes: BOTH },
  { method: "PUT", path: "/summaries/:aid/current", modes: BOTH },
  // chapters and highlights
  { method: "GET", path: "/contents/:id/chapters", modes: BOTH },
  { method: "POST", path: "/contents/:id/chapters/regenerate", modes: BOTH },
  { method: "PUT", path: "/contents/:id/chapters/current", modes: BOTH },
  { method: "GET", path: "/contents/:id/highlights", modes: BOTH },
  { method: "POST", path: "/contents/:id/highlights/recompute", modes: BOTH },
  // translations
  { method: "POST", path: "/contents/:id/translations", modes: BOTH },
  { method: "GET", path: "/contents/:id/translations", modes: BOTH },
  // collections
  { method: "GET", path: "/collections", modes: BOTH },
  { method: "POST", path: "/collections", modes: BOTH },
  { method: "GET", path: "/collections/:id", modes: BOTH },
  { method: "PATCH", path: "/collections/:id", modes: BOTH },
  { method: "DELETE", path: "/collections/:id", modes: BOTH },
  { method: "POST", path: "/collections/:id/items", modes: BOTH },
  { method: "PUT", path: "/collections/:id/items/order", modes: BOTH },
  { method: "DELETE", path: "/collections/:id/items/:iid", modes: BOTH },
  { method: "POST", path: "/collections/:id/summary", modes: BOTH },
  { method: "GET", path: "/collections/:id/summary", modes: BOTH },
  // trash
  { method: "GET", path: "/trash", modes: BOTH },
  { method: "POST", path: "/trash/:id/restore", modes: BOTH },
  { method: "DELETE", path: "/trash/:id", modes: BOTH },
  { method: "DELETE", path: "/trash", modes: BOTH },
  // search
  { method: "GET", path: "/search", modes: BOTH },
  // chat
  { method: "GET", path: "/contents/:id/chat", modes: BOTH },
  { method: "GET", path: "/contents/:id/chat/threads", modes: BOTH },
  { method: "POST", path: "/contents/:id/chat/threads", modes: BOTH },
  { method: "PATCH", path: "/contents/:id/chat/threads/:tid", modes: BOTH },
  { method: "DELETE", path: "/contents/:id/chat/threads/:tid", modes: BOTH },
  { method: "POST", path: "/contents/:id/chat/messages", modes: BOTH },
  { method: "POST", path: "/contents/:id/chat/messages/:mid/retry", modes: BOTH },
  { method: "POST", path: "/contents/:id/chat/turns/delete", modes: BOTH },
  { method: "DELETE", path: "/contents/:id/chat", modes: BOTH },
  // web search
  { method: "GET", path: "/web-search", modes: BOTH },
  { method: "PUT", path: "/web-search", modes: BOTH },
  { method: "DELETE", path: "/web-search", modes: BOTH },
  { method: "PUT", path: "/web-search/credential", modes: BOTH },
  { method: "POST", path: "/web-search/test", modes: BOTH },
  // notes
  { method: "GET", path: "/contents/:id/notes", modes: BOTH },
  { method: "POST", path: "/contents/:id/notes", modes: BOTH },
  { method: "PATCH", path: "/notes/:id", modes: BOTH },
  { method: "DELETE", path: "/notes/:id", modes: BOTH },
  { method: "GET", path: "/notes/groups", modes: BOTH },
  // export
  { method: "POST", path: "/contents/:id/export", modes: BOTH },
  { method: "POST", path: "/collections/:id/export", modes: BOTH },
  { method: "POST", path: "/contents/:id/burn", modes: ["local"] },
  { method: "GET", path: "/fonts/subtitle", modes: BOTH },
  // media
  { method: "GET", path: "/media/:assetId", modes: ["server"] },
  { method: "HEAD", path: "/media/:assetId", modes: ["server"] },
  { method: "POST", path: "/contents/:id/cache-media/inspect", modes: ["local"] },
  { method: "POST", path: "/contents/:id/cache-media", modes: ["local"] },
  { method: "DELETE", path: "/media/:assetId", modes: BOTH },
  { method: "PUT", path: "/media/:assetId/relink", modes: ["local"] },
  { method: "GET", path: "/media/burn-outputs", modes: ["local"] },
  { method: "POST", path: "/media/:assetId/save-grant", modes: ["local"] },
  { method: "GET", path: "/media/cache-location", modes: ["local"] },
  { method: "PUT", path: "/media/cache-location", modes: ["local"] },
  { method: "POST", path: "/media/cache-location/holds/:assetId/keep", modes: ["local"] },
  { method: "POST", path: "/media/cache-location/holds/:assetId/restore", modes: ["local"] },
  // summary templates
  { method: "GET", path: "/summary-templates", modes: BOTH },
  { method: "POST", path: "/summary-templates", modes: BOTH },
  { method: "PATCH", path: "/summary-templates/:id", modes: BOTH },
  { method: "DELETE", path: "/summary-templates/:id", modes: BOTH },
  { method: "GET", path: "/summary-templates/:id/versions", modes: BOTH },
  // terminology
  { method: "GET", path: "/terminology", modes: BOTH },
  { method: "PUT", path: "/terminology", modes: BOTH },
  // providers
  { method: "GET", path: "/providers", modes: BOTH },
  { method: "POST", path: "/providers", modes: BOTH },
  { method: "PUT", path: "/providers/order", modes: BOTH },
  { method: "PATCH", path: "/providers/:id", modes: BOTH },
  { method: "DELETE", path: "/providers/:id", modes: BOTH },
  { method: "PUT", path: "/providers/:id/credential", modes: BOTH },
  { method: "POST", path: "/providers/:id/probe", modes: BOTH },
  { method: "PUT", path: "/providers/:id/models/:mid/override", modes: BOTH },
  { method: "PUT", path: "/providers/:id/model-pricing", modes: BOTH },
  { method: "GET", path: "/asr-profiles", modes: BOTH },
  { method: "POST", path: "/asr-profiles", modes: BOTH },
  { method: "PUT", path: "/asr-profiles/order", modes: BOTH },
  { method: "PATCH", path: "/asr-profiles/:id", modes: BOTH },
  { method: "DELETE", path: "/asr-profiles/:id", modes: BOTH },
  { method: "PUT", path: "/asr-profiles/:id/credential", modes: BOTH },
  { method: "POST", path: "/asr-profiles/:id/probe", modes: BOTH },
  { method: "POST", path: "/asr-profiles/:id/test", modes: BOTH },
  { method: "PUT", path: "/asr-profiles/:id/model-pricing", modes: BOTH },
  { method: "GET", path: "/other-models", modes: BOTH },
  { method: "POST", path: "/other-models", modes: BOTH },
  { method: "PUT", path: "/other-models/order", modes: BOTH },
  { method: "PATCH", path: "/other-models/:id", modes: BOTH },
  { method: "DELETE", path: "/other-models/:id", modes: BOTH },
  { method: "PUT", path: "/other-models/:id/model-pricing", modes: BOTH },
  // platform accounts
  { method: "GET", path: "/platform-accounts", modes: BOTH },
  { method: "POST", path: "/platform-accounts/bilibili/qr", modes: ["server"] },
  { method: "GET", path: "/platform-accounts/bilibili/qr/:attemptId", modes: ["server"] },
  { method: "PUT", path: "/platform-accounts/:platform/cookies", modes: BOTH },
  { method: "POST", path: "/platform-accounts/youtube/import-browser", modes: ["local"] },
  { method: "DELETE", path: "/platform-accounts/:platform", modes: BOTH },
  { method: "POST", path: "/platform-accounts/:platform/check", modes: BOTH },
  // settings
  { method: "GET", path: "/settings", modes: BOTH },
  { method: "PATCH", path: "/settings", modes: BOTH },
  { method: "GET", path: "/instance-settings", modes: BOTH },
  { method: "PATCH", path: "/instance-settings", modes: BOTH },
  // usage
  { method: "GET", path: "/usage", modes: BOTH },
  { method: "GET", path: "/storage", modes: ["server"] },
  // admin
  { method: "GET", path: "/admin/users", modes: ["server"] },
  { method: "POST", path: "/admin/users", modes: ["server"] },
  { method: "PATCH", path: "/admin/users/:id", modes: ["server"] },
  { method: "POST", path: "/admin/users/:id/reset-password", modes: ["server"] },
  { method: "DELETE", path: "/admin/users/:id", modes: ["server"] },
  { method: "GET", path: "/admin/storage", modes: ["server"] },
  { method: "GET", path: "/admin/network-allowlist", modes: ["server"] },
  { method: "PUT", path: "/admin/network-allowlist", modes: ["server"] },
  { method: "POST", path: "/admin/credentials/reset", modes: BOTH },
  // system
  { method: "GET", path: "/health", modes: BOTH },
  { method: "GET", path: "/version", modes: BOTH },
  { method: "GET", path: "/system/activity", modes: ["local"] },
  { method: "POST", path: "/system/maintenance", modes: ["local"] },
  { method: "DELETE", path: "/system/maintenance", modes: ["local"] },
  // backup
  { method: "POST", path: "/backup/estimate", modes: ["local"] },
  { method: "POST", path: "/backup/exports", modes: ["local"] },
  { method: "GET", path: "/backup/exports/:id", modes: ["local"] },
  { method: "POST", path: "/backup/exports/:id/cancel", modes: ["local"] },
  { method: "GET", path: "/backup/restore-readiness", modes: ["local"] },
];
