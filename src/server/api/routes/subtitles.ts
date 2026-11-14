import type { FastifyInstance } from "fastify";
import { subtitleInspectLocalRequestSchema } from "../../../shared/dto/local-media.ts";
import { subtitleInspectRequestSchema, subtitleInspectResponseSchema } from "../../../shared/dto/subtitle-import.ts";
import type { SubtitleImportService } from "../../application/subtitle-import.ts";
import { principalOf } from "../auth.ts";
import { parseInput, sendValidated } from "../validation.ts";
import { TEXT_BODY_LIMIT_BYTES } from "./contents.ts";

/**
 * Subtitle previews before an import: `inspect` for a text the client read (both modes) and,
 * in local mode, `inspect-local` for a file picked in the shell's dialog under its grant.
 * Nothing is written.
 */
export function registerSubtitleRoutes(app: FastifyInstance, deps: { subtitleImport: SubtitleImportService; local: boolean }): void {
  const { subtitleImport } = deps;
  app.post("/api/subtitles/inspect", { bodyLimit: TEXT_BODY_LIMIT_BYTES }, async (request, reply) => {
    const body = parseInput(subtitleInspectRequestSchema, request.body, "body");
    return sendValidated(reply, 200, subtitleInspectResponseSchema, subtitleImport.inspect(principalOf(request), body));
  });

  if (deps.local) {
    app.post("/api/subtitles/inspect-local", async (request, reply) => {
      const body = parseInput(subtitleInspectLocalRequestSchema, request.body, "body");
      return sendValidated(reply, 200, subtitleInspectResponseSchema, await subtitleImport.inspectLocal(principalOf(request), body));
    });
  }
}
