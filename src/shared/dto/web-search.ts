import { z } from "zod";
import { CREDENTIAL_STATUSES, WEB_SEARCH_SERVICES } from "../enums.ts";

/** `GET /api/web-search`: never carries the key; `service` is absent until one was chosen. */
export const webSearchProfileDtoSchema = z.object({
  service: z.enum(WEB_SEARCH_SERVICES).exactOptional(),
  credentialStatus: z.enum(CREDENTIAL_STATUSES),
});
export type WebSearchProfileDto = z.infer<typeof webSearchProfileDtoSchema>;

/** `PUT /api/web-search`. */
export const webSearchProfilePutSchema = z.object({ service: z.enum(WEB_SEARCH_SERVICES) }).strict();
export type WebSearchProfilePut = z.infer<typeof webSearchProfilePutSchema>;

/** `POST /api/web-search/test`: one real search went through. */
export const webSearchTestResultSchema = z.object({ ok: z.literal(true), resultCount: z.number().int().nonnegative() });
export type WebSearchTestResult = z.infer<typeof webSearchTestResultSchema>;
