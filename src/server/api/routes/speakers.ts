import { createHash } from "node:crypto";
import type { FastifyInstance } from "fastify";
import { z } from "zod";
import { SPEAKER_AVATAR_MAX_BYTES } from "../../../shared/defaults.ts";
import {
  speakerCreateRequestSchema,
  speakerDtoSchema,
  speakerListDtoSchema,
  speakerPatchRequestSchema,
  speakerSuggestionListDtoSchema,
} from "../../../shared/dto/speaker.ts";
import { speakerReviewDtoSchema, speakersConfirmedRequestSchema } from "../../../shared/dto/transcript.ts";
import type { SpeakerService } from "../../application/speakers.ts";
import { principalOf } from "../auth.ts";
import { parseInput, sendValidated } from "../validation.ts";

const contentParamsSchema = z.object({ id: z.string().min(1) });
const speakerParamsSchema = z.object({ id: z.string().min(1), sid: z.string().min(1) });
const revisionParamsSchema = z.object({ rid: z.string().min(1) });
/** `contentId` only leaves that Content's own speakers out of the suggestions; it is no scope, so an unknown or foreign id changes nothing. */
const suggestionsQuerySchema = z.object({ q: z.string().default(""), contentId: z.string().min(1).exactOptional() }).strict();

/** Room in a photo upload for the JSON around the base64 text (mime, field names, the copy-from alternative). */
const PATCH_JSON_OVERHEAD_BYTES = 1024;
/** The base64 form of a largest allowed photo plus the JSON around it; a larger body cannot hold an acceptable photo. */
export const SPEAKER_PATCH_BODY_LIMIT_BYTES = Math.ceil(SPEAKER_AVATAR_MAX_BYTES / 3) * 4 + PATCH_JSON_OVERHEAD_BYTES;

/**
 * The photo's entity tag: a digest of the photo with its speaker and version. The version
 * alone could repeat after an older backup is restored, and a cached older photo must never
 * be revalidated into the new one.
 */
function avatarEtag(contentId: string, speakerId: string, version: number, bytes: Uint8Array): string {
  const digest = createHash("sha256").update(`${contentId}\n${speakerId}\n${version}\n`).update(bytes).digest("hex");
  return `"${digest.slice(0, 32)}"`;
}

/** Whether an `If-None-Match` header names `etag` (or is `*`); weak and strong forms compare alike. */
function matches(header: string | undefined, etag: string): boolean {
  if (header === undefined) {
    return false;
  }
  return header.split(",").some((candidate) => {
    const tag = candidate.trim();
    return tag === "*" || tag.replace(/^W\//u, "") === etag;
  });
}

/**
 * Speaker identities of a Content, their photos, suggestions from the user's other
 * Contents, and the review of who says each sentence of a transcript revision.
 */
export function registerSpeakerRoutes(app: FastifyInstance, deps: { speakers: SpeakerService }): void {
  const { speakers } = deps;

  app.get("/api/contents/:id/speakers", async (request, reply) => {
    const { id } = parseInput(contentParamsSchema, request.params, "params");
    return sendValidated(reply, 200, speakerListDtoSchema, speakers.list(principalOf(request), id));
  });

  app.post("/api/contents/:id/speakers", async (request, reply) => {
    const { id } = parseInput(contentParamsSchema, request.params, "params");
    const body = parseInput(speakerCreateRequestSchema, request.body, "body");
    return sendValidated(reply, 201, speakerDtoSchema, speakers.create(principalOf(request), id, body));
  });

  app.patch("/api/contents/:id/speakers/:sid", { bodyLimit: SPEAKER_PATCH_BODY_LIMIT_BYTES }, async (request, reply) => {
    const { id, sid } = parseInput(speakerParamsSchema, request.params, "params");
    const body = parseInput(speakerPatchRequestSchema, request.body, "body");
    return sendValidated(reply, 200, speakerDtoSchema, speakers.patch(principalOf(request), id, sid, body));
  });

  // `no-cache` makes a changed photo show at once; the version-keyed ETag turns the
  // revalidation into a 304 while it is unchanged.
  app.get("/api/contents/:id/speakers/:sid/avatar", async (request, reply) => {
    const { id, sid } = parseInput(speakerParamsSchema, request.params, "params");
    const avatar = speakers.avatar(principalOf(request), id, sid);
    const etag = avatarEtag(id, sid, avatar.version, avatar.bytes);
    reply.header("etag", etag).header("cache-control", "private, no-cache").header("x-content-type-options", "nosniff");
    if (matches(request.headers["if-none-match"], etag)) {
      return reply.code(304).send();
    }
    return reply.code(200).header("content-type", avatar.mime).header("content-length", String(avatar.bytes.length)).send(Buffer.from(avatar.bytes));
  });

  app.get("/api/transcript/revisions/:rid/speaker-review", async (request, reply) => {
    const { rid } = parseInput(revisionParamsSchema, request.params, "params");
    return sendValidated(reply, 200, speakerReviewDtoSchema, speakers.review(principalOf(request), rid));
  });

  app.put("/api/transcript/revisions/:rid/speakers-confirmed", async (request, reply) => {
    const { rid } = parseInput(revisionParamsSchema, request.params, "params");
    const body = parseInput(speakersConfirmedRequestSchema, request.body, "body");
    return sendValidated(reply, 200, speakerReviewDtoSchema, speakers.setRevisionConfirmed(principalOf(request), rid, body));
  });

  app.get("/api/speakers/suggestions", async (request, reply) => {
    const { q, contentId } = parseInput(suggestionsQuerySchema, request.query, "query");
    return sendValidated(reply, 200, speakerSuggestionListDtoSchema, speakers.suggestions(principalOf(request), q, contentId));
  });
}
