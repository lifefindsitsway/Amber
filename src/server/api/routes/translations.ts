import type { FastifyInstance } from "fastify";
import { z } from "zod";
import { taskAcceptedDtoSchema } from "../../../shared/dto/task.ts";
import { transcriptRevisionDtoSchema } from "../../../shared/dto/content.ts";
import {
  translationDraftCommitRequestSchema,
  translationDraftDtoSchema,
  translationDraftRequestSchema,
  translationRequestSchema,
  translationsDtoSchema,
} from "../../../shared/dto/translation.ts";
import type { DerivedTaskService } from "../../application/derived-tasks.ts";
import type { TranslationDraftService } from "../../application/translation-drafts.ts";
import type { TranslationService } from "../../application/translations.ts";
import { principalOf } from "../auth.ts";
import { idempotencyKeyOf, parseInput, sendValidated } from "../validation.ts";
import { TEXT_BODY_LIMIT_BYTES } from "./contents.ts";
import { draftDiscardQuerySchema } from "./transcripts.ts";

const idParamsSchema = z.object({ id: z.string().min(1) });
/** `:language` is canonicalized by the service, so any spelling of a tag reaches its draft. */
const draftParamsSchema = z.object({ id: z.string().min(1), language: z.string().min(1) });

export interface TranslationRouteDeps {
  translations?: TranslationService;
  translationDrafts?: TranslationDraftService;
  derivedTasks?: DerivedTaskService;
}

/** `/api/contents/:id/translations` and the hand edit drafts of each language. */
export function registerTranslationRoutes(app: FastifyInstance, deps: TranslationRouteDeps): void {
  const { translations, translationDrafts, derivedTasks } = deps;
  if (translations !== undefined) {
    app.get("/api/contents/:id/translations", async (request, reply) => {
      const { id } = parseInput(idParamsSchema, request.params, "params");
      return sendValidated(reply, 200, translationsDtoSchema, translations.get(principalOf(request), id));
    });
  }

  if (translationDrafts !== undefined) {
    app.get("/api/contents/:id/translations/:language/draft", async (request, reply) => {
      const { id, language } = parseInput(draftParamsSchema, request.params, "params");
      return sendValidated(reply, 200, translationDraftDtoSchema, translationDrafts.get(principalOf(request), id, language));
    });

    // A long translation in one autosave can exceed the default JSON body limit.
    app.put("/api/contents/:id/translations/:language/draft", { bodyLimit: TEXT_BODY_LIMIT_BYTES }, async (request, reply) => {
      const { id, language } = parseInput(draftParamsSchema, request.params, "params");
      const body = parseInput(translationDraftRequestSchema, request.body, "body");
      return sendValidated(reply, 200, translationDraftDtoSchema, translationDrafts.put(principalOf(request), id, language, body));
    });

    app.delete("/api/contents/:id/translations/:language/draft", async (request, reply) => {
      const { id, language } = parseInput(draftParamsSchema, request.params, "params");
      const { version } = parseInput(draftDiscardQuerySchema, request.query, "query");
      translationDrafts.discard(principalOf(request), id, language, version);
      return reply.code(204).send();
    });

    app.post("/api/contents/:id/translations/:language/draft/commit", async (request, reply) => {
      const { id, language } = parseInput(draftParamsSchema, request.params, "params");
      const body = parseInput(translationDraftCommitRequestSchema, request.body, "body");
      return sendValidated(reply, 201, transcriptRevisionDtoSchema, translationDrafts.commit(principalOf(request), id, language, body));
    });
  }

  if (derivedTasks !== undefined) {
    app.post("/api/contents/:id/translations", async (request, reply) => {
      const { id } = parseInput(idParamsSchema, request.params, "params");
      const body = parseInput(translationRequestSchema, request.body ?? {}, "body");
      const result = await derivedTasks.translate(principalOf(request), id, body, idempotencyKeyOf(request));
      return sendValidated(reply, result.status, taskAcceptedDtoSchema, result.body);
    });
  }
}
