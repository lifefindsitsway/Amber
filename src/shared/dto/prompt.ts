import { z } from "zod";

const versionSchema = z.number().int().positive();
const msSchema = z.number().int().nonnegative();

/**
 * One customizable system prompt. `nameKey` / `descriptionKey` are i18n keys; `slots` are
 * the `{{…}}` placeholders and `protocol` the literal fragments a custom text must keep,
 * both as they appear in the text. `current` is the user's own version in effect; without
 * it the builtin text is used.
 */
export const promptDtoSchema = z.object({
  id: z.string().min(1),
  nameKey: z.string().min(1),
  descriptionKey: z.string().min(1),
  slots: z.array(z.string().min(1)),
  protocol: z.array(z.string().min(1)),
  builtin: z.object({ version: versionSchema, text: z.string() }),
  current: z.object({ version: versionSchema, text: z.string(), createdAt: msSchema }).exactOptional(),
  customized: z.boolean(),
});
export type PromptDto = z.infer<typeof promptDtoSchema>;

/** `GET /api/prompts`: every customizable prompt, in settings order. */
export const promptListDtoSchema = z.object({ items: z.array(promptDtoSchema) });
export type PromptListDto = z.infer<typeof promptListDtoSchema>;

export const promptVersionDtoSchema = z.object({ version: versionSchema, text: z.string(), createdAt: msSchema, current: z.boolean() });
export type PromptVersionDto = z.infer<typeof promptVersionDtoSchema>;

/** `GET /api/prompts/:id/versions`: the user's own versions, oldest first, not paged. */
export const promptVersionListDtoSchema = z.object({ items: z.array(promptVersionDtoSchema) });
export type PromptVersionListDto = z.infer<typeof promptVersionListDtoSchema>;

/**
 * `PUT /api/prompts/:id`. Emptiness, length, placeholders and protocol fragments are checked
 * by the service, which answers `invalid_request.prompt_protocol` with what is missing or unknown.
 */
export const promptUpdateRequestSchema = z.object({ text: z.string() }).strict();
export type PromptUpdateRequest = z.infer<typeof promptUpdateRequestSchema>;
