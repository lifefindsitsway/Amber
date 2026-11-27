import type { FastifyReply, FastifyRequest } from "fastify";
import { z } from "zod";
import type { ContentCoverImage } from "../../ports/repository.ts";

/** `POST /api/contents/:id/cover/fetch` takes no parameters; a client may send `{}` or no body at all. */
export const coverFetchRequestSchema = z.object({}).strict();

/**
 * The cover's entity tag: its version with a digest of the image. The version alone could
 * repeat after an older backup is restored, and a cached older cover must never be revalidated
 * into the new one.
 */
function coverEtag(cover: ContentCoverImage): string {
  return `"v${cover.version}-${cover.sha256.slice(0, 32)}"`;
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
 * Sends a stored cover. `no-cache` makes a replaced cover show at once; the version-keyed ETag
 * turns the revalidation into a 304 while it is unchanged.
 */
export function sendCoverImage(request: FastifyRequest, reply: FastifyReply, cover: ContentCoverImage): FastifyReply {
  const etag = coverEtag(cover);
  reply.header("etag", etag).header("cache-control", "private, no-cache").header("x-content-type-options", "nosniff");
  if (matches(request.headers["if-none-match"], etag)) {
    return reply.code(304).send();
  }
  return reply.code(200).header("content-type", "image/webp").header("content-length", String(cover.bytes.length)).send(Buffer.from(cover.bytes));
}
