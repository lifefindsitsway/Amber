import type { CollectionDetailDto, CollectionDto } from "../../../src/shared/dto/collection.ts";
import type { ContentDto } from "../../../src/shared/dto/content.ts";
import type { ProviderProfileDto } from "../../../src/shared/dto/provider.ts";
import type { UserSettingsDto } from "../../../src/shared/dto/settings.ts";
import type { StageRunDto, TaskDetailDto, TaskDto } from "../../../src/shared/dto/task.ts";

// DTO builders for shell, new page and task flow tests; values are synthetic.

export const SETTINGS: UserSettingsDto = { theme: "light", language: "zh-CN", shortcuts: {}, updatedAt: 1 };

export function content(id: string, overrides: Partial<ContentDto> = {}): ContentDto {
  return { id, source: { kind: "youtube" }, title: `内容 ${id}`, processingStatus: "succeeded", collections: [], createdAt: 1, updatedAt: 1, ...overrides };
}

export function collection(id: string, name: string, itemCount = 0): CollectionDto {
  return { id, name, itemCount, createdAt: 1, updatedAt: 1 };
}

export function collectionDetail(id: string, name: string, contentIds: readonly string[]): CollectionDetailDto {
  return {
    ...collection(id, name, contentIds.length),
    items: contentIds.map((contentId, position) => ({ id: `item-${contentId}`, contentId, position, addedAt: 1, title: `第 ${position + 1} 讲`, processingStatus: "succeeded", source: { kind: "youtube" }, updatedAt: 1 })),
  };
}

const CAPABILITY_FLAGS = { stream: "supported", tools: "unknown", structuredOutput: "supported", vision: "unknown", audioInput: "unknown", reasoning: "unknown" } as const;

export function provider(id: string, name: string, modelIds: readonly string[]): ProviderProfileDto {
  return {
    id,
    name,
    protocol: "openai_compatible",
    baseURL: "https://llm.example.com/v1",
    createdAt: 1,
    credentialStatus: "configured",
    hasCredential: true,
    models: modelIds.map((modelId) => ({
      modelId,
      flags: { declared: CAPABILITY_FLAGS },
      limits: { declared: {}, userOverride: { contextWindowTokens: 128000 } },
      effective: { flags: CAPABILITY_FLAGS, limits: { contextWindowTokens: 128000 } },
    })),
  };
}

export function task(id: string, overrides: Partial<TaskDto> = {}): TaskDto {
  return { id, kind: "process_content", statusProjection: "running", contentId: `content-${id}`, createdAt: 1, ...overrides };
}

export function stageRun(taskId: string, stage: StageRunDto["stage"], status: StageRunDto["status"], overrides: Partial<StageRunDto> = {}): StageRunDto {
  return { id: `${taskId}-${stage}-${overrides.attempt ?? 1}`, taskId, stage, attempt: 1, status, progress: 0, dependencies: [], ...overrides };
}

export function taskDetail(id: string, stageRuns: StageRunDto[], overrides: Partial<TaskDetailDto> = {}): TaskDetailDto {
  return { ...task(id), stageRuns, workUnits: [], eventSeq: 0, ...overrides };
}

/** The reads every shell page issues, answered with empty or minimal data. */
export function baseRoutes(extra: { mode?: "local" | "server" } = {}) {
  return {
    "GET /api/version": { body: { version: "0.0.0-test", mode: extra.mode ?? "local" } },
    "GET /api/auth/me": {
      body: { userId: "u1", ...(extra.mode === "server" ? { username: "admin" } : {}), role: "admin", mode: extra.mode ?? "local", mustChangePassword: false },
    },
    "GET /api/settings": { body: SETTINGS },
    "GET /api/providers": { body: { items: [] } },
    "GET /api/collections": { body: { items: [] } },
    "GET /api/contents": { body: { items: [], total: 0 } },
    "GET /api/summary-templates": {
      body: { items: [{ id: "summary.core", builtin: true, name: "summaryTemplate.core", currentVersion: 1, deleted: false }] },
    },
    "GET /api/tasks": { body: { items: [], eventSeq: 0 } },
    "GET /api/tasks/events": {},
  };
}
