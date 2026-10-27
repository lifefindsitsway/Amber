import type { FastifyInstance } from "fastify";
import { z } from "zod";
import { API_PAGE_SIZE_DEFAULT, API_PAGE_SIZE_MAX } from "../../../shared/defaults.ts";
import { revisionArchiveRequestSchema, transcriptRevisionDtoSchema, transcriptRevisionListItemDtoSchema } from "../../../shared/dto/content.ts";
import { taskAcceptedDtoSchema } from "../../../shared/dto/task.ts";
import {
  derivedTaskRequestSchema,
  draftCommitRequestSchema,
  segmentMapDtoSchema,
  transcriptDraftDtoSchema,
  transcriptDraftRequestSchema,
  transcriptSegmentPageDtoSchema,
} from "../../../shared/dto/transcript.ts";
import type { DerivedTaskService } from "../../application/derived-tasks.ts";
import type { TranscriptService } from "../../application/transcripts.ts";
import { principalOf } from "../auth.ts";
import { idempotencyKeyOf, parseInput, sendValidated } from "../validation.ts";
import { TEXT_BODY_LIMIT_BYTES } from "./contents.ts";

const idParamsSchema = z.object({ id: z.string().min(1) });
const revisionParamsSchema = z.object({ rid: z.string().min(1) });
const segmentParamsSchema = z.object({ sid: z.string().min(1) });
const pageQuerySchema = z
  .object({
    limit: z.coerce.number().int().min(1).max(API_PAGE_SIZE_MAX).default(API_PAGE_SIZE_DEFAULT),
    cursor: z.string().min(1).exactOptional(),
  })
  .strict();
const mapQuerySchema = z.object({ targetRevision: z.string().min(1) }).strict();
const deleteRevisionQuerySchema = z
  .object({
    withDescendants: z.enum(["true", "false"]).default("false").transform((value) => value === "true"),
    withHistory: z.enum(["true", "false"]).default("false").transform((value) => value === "true"),
  })
  .strict();

export interface TranscriptRouteDeps {
  transcripts?: TranscriptService;
  derivedTasks?: DerivedTaskService;
}

/** Transcript reading, drafts, sentence mapping and "proofread again". */
export function registerTranscriptRoutes(app: FastifyInstance, deps: TranscriptRouteDeps): void {
  const { transcripts, derivedTasks } = deps;
  if (transcripts !== undefined) {
    app.get("/api/transcript/revisions/:rid/segments", async (request, reply) => {
      const { rid } = parseInput(revisionParamsSchema, request.params, "params");
      const page = parseInput(pageQuerySchema, request.query, "query");
      return sendValidated(reply, 200, transcriptSegmentPageDtoSchema, transcripts.segments(principalOf(request), rid, page));
    });

    app.get("/api/contents/:id/transcript/draft", async (request, reply) => {
      const { id } = parseInput(idParamsSchema, request.params, "params");
      return sendValidated(reply, 200, transcriptDraftDtoSchema, transcripts.getDraft(principalOf(request), id));
    });

    // A long transcript in one autosave can exceed the default JSON body limit.
    app.put("/api/contents/:id/transcript/draft", { bodyLimit: TEXT_BODY_LIMIT_BYTES }, async (request, reply) => {
      const { id } = parseInput(idParamsSchema, request.params, "params");
      const body = parseInput(transcriptDraftRequestSchema, request.body, "body");
      return sendValidated(reply, 200, transcriptDraftDtoSchema, transcripts.putDraft(principalOf(request), id, body));
    });

    app.delete("/api/contents/:id/transcript/draft", async (request, reply) => {
      const { id } = parseInput(idParamsSchema, request.params, "params");
      transcripts.discardDraft(principalOf(request), id);
      return reply.code(204).send();
    });

    app.put("/api/transcript/revisions/:rid/archived", async (request, reply) => {
      const { rid } = parseInput(revisionParamsSchema, request.params, "params");
      const { archived } = parseInput(revisionArchiveRequestSchema, request.body, "body");
      return sendValidated(reply, 200, transcriptRevisionListItemDtoSchema, transcripts.setArchived(principalOf(request), rid, archived));
    });

    app.delete("/api/transcript/revisions/:rid", async (request, reply) => {
      const { rid } = parseInput(revisionParamsSchema, request.params, "params");
      const { withDescendants, withHistory } = parseInput(deleteRevisionQuerySchema, request.query, "query");
      transcripts.deleteRevision(principalOf(request), rid, { withDescendants, withHistory });
      return reply.code(204).send();
    });

    app.post("/api/contents/:id/transcript/draft/commit", async (request, reply) => {
      const { id } = parseInput(idParamsSchema, request.params, "params");
      const body = parseInput(draftCommitRequestSchema, request.body, "body");
      return sendValidated(reply, 201, transcriptRevisionDtoSchema, transcripts.commitDraft(principalOf(request), id, body));
    });

    app.get("/api/transcript/segments/:sid/map", async (request, reply) => {
      const { sid } = parseInput(segmentParamsSchema, request.params, "params");
      const { targetRevision } = parseInput(mapQuerySchema, request.query, "query");
      return sendValidated(reply, 200, segmentMapDtoSchema, transcripts.map(principalOf(request), sid, targetRevision));
    });
  }

  if (derivedTasks !== undefined) {
    app.post("/api/contents/:id/transcript/proofread", async (request, reply) => {
      const { id } = parseInput(idParamsSchema, request.params, "params");
      const body = parseInput(derivedTaskRequestSchema, request.body ?? {}, "body");
      const result = await derivedTasks.proofread(principalOf(request), id, body, idempotencyKeyOf(request));
      return sendValidated(reply, result.status, taskAcceptedDtoSchema, result.body);
    });
  }
}
