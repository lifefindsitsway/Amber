import type { FastifyInstance } from "fastify";
import { z } from "zod";
import { webSearchProfileDtoSchema, webSearchProfilePutSchema, webSearchTestResultSchema } from "../../../shared/dto/web-search.ts";
import type { WebSearchService } from "../../application/web-search.ts";
import { principalOf } from "../auth.ts";
import { parseInput, sendValidated } from "../validation.ts";
import { requestSignal } from "./contents.ts";

// Server-side only: a schema carrying a key must never be shared with the client code.
const putCredentialRequestSchema = z.object({ value: z.string().min(1) }).strict();

/** `/api/web-search*`: the caller's own search service; its key only ever goes in. */
export function registerWebSearchRoutes(app: FastifyInstance, deps: { webSearch: WebSearchService }): void {
  const { webSearch } = deps;

  app.get("/api/web-search", async (request, reply) => sendValidated(reply, 200, webSearchProfileDtoSchema, webSearch.getProfile(principalOf(request))));

  app.put("/api/web-search", async (request, reply) => {
    const body = parseInput(webSearchProfilePutSchema, request.body, "body");
    return sendValidated(reply, 200, webSearchProfileDtoSchema, webSearch.putProfile(principalOf(request), body));
  });

  app.put("/api/web-search/credential", async (request, reply) => {
    const { value } = parseInput(putCredentialRequestSchema, request.body, "body");
    return sendValidated(reply, 200, webSearchProfileDtoSchema, webSearch.putCredential(principalOf(request), value));
  });

  app.delete("/api/web-search", async (request, reply) => {
    webSearch.deleteProfile(principalOf(request));
    return reply.code(204).send();
  });

  // A real search on the user's quota; it stops when the client goes away.
  app.post("/api/web-search/test", async (request, reply) =>
    sendValidated(reply, 200, webSearchTestResultSchema, await webSearch.test(principalOf(request), requestSignal(reply))),
  );
}
