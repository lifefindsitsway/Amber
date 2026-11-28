import { z } from "zod";
import { amberError } from "../../../domain/errors.ts";
import type { OutboundHttpClient } from "../../../ports/outbound-http.ts";
import { platformGetJsonWithCookies, type PlatformGetJson } from "../http.ts";

/*
 * bilibili's web API wraps every answer in `{ code, message, data }`. An answer is checked in
 * two layers: the envelope first (an integer `code`), so an error code is classified even when
 * `data` is absent or shaped differently; then, only for `code == 0`, the `data` of the one
 * endpoint against a schema that declares just the fields Amber reads. A declared field of the
 * wrong type fails the read; the many other fields the platform sends are dropped.
 */

const envelopeSchema = z.object({
  code: z.number().int(),
  data: z.unknown().optional(),
});

/** An API answer whose envelope checked out: its code and the still unchecked `data`. */
export interface BilibiliEnvelope {
  code: number;
  data: unknown;
  setCookies: readonly string[];
}

/** An API error code: -101 not logged in, -352 / -412 / -509 risk control, -403 no access; the rest unreachable. */
export function apiError(code: number): Error {
  if (code === -412 || code === -352 || code === -509) {
    return amberError("platform_blocked", `bilibili api code ${code}`);
  }
  if (code === -101 || code === -403) {
    return amberError("auth_required", `bilibili api code ${code}`);
  }
  return amberError("source_unreachable", `bilibili api code ${code}`);
}

function unexpected(what: string): Error {
  return amberError("source_unreachable", `bilibili answered ${what} in an unexpected shape`);
}

/** GETs one API document (read within `PLATFORM_JSON_MAX_BYTES`) and checks its envelope. */
export async function bilibiliEnvelope(http: OutboundHttpClient, request: PlatformGetJson): Promise<BilibiliEnvelope> {
  const { body, setCookies } = await platformGetJsonWithCookies(http, request);
  const envelope = envelopeSchema.safeParse(body);
  if (!envelope.success) {
    throw unexpected("an envelope");
  }
  return { code: envelope.data.code, data: envelope.data.data, setCookies };
}

/** The `data` of a `code == 0` answer checked against `schema`; a mismatch is unreachable. */
export function dataOf<T extends z.ZodType>(schema: T, data: unknown, what: string): z.output<T> {
  const parsed = schema.safeParse(data);
  if (!parsed.success) {
    throw unexpected(what);
  }
  return parsed.data;
}

const text = z.string().nullish();
const count = z.number().nullish();

/** `x/player/pagelist`: the submission's parts. */
export const pageListSchema = z
  .array(
    z.object({
      cid: z.number().int().positive(),
      page: z.number().int().positive(),
      part: text,
      duration: count,
    }),
  )
  .nullish();

/** `x/player/wbi/v2`: the subtitle list (non-empty only with a login). */
export const playerSchema = z
  .object({
    subtitle: z
      .object({
        subtitles: z
          .array(
            z.object({
              lan: text,
              lan_doc: text,
              subtitle_url: text,
              type: count,
              ai_type: count,
            }),
          )
          .nullish(),
      })
      .nullish(),
  })
  .nullish();

/** `x/web-interface/nav`: whether the cookies are a working login. */
export const navSchema = z.object({ isLogin: z.boolean().nullish() }).nullish();

/** `x/polymer/web-space/seasons_archives_list`: one page of a 合集's submissions. */
export const seasonArchivesSchema = z
  .object({
    archives: z.array(z.object({ bvid: text, title: text, pic: text })).nullish(),
    page: z.object({ total: count }).nullish(),
  })
  .nullish();

/** A signed subtitle document (not an API envelope): its sentence lines. */
export const subtitleBodySchema = z.object({
  body: z.array(z.object({ from: count, to: count, content: text })).nullish(),
});
