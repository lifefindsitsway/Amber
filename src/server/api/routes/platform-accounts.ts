import type { FastifyInstance } from "fastify";
import { z } from "zod";
import {
  platformAccountDtoSchema,
  platformAccountListDtoSchema,
  platformCheckDtoSchema,
  platformQrAttemptDtoSchema,
  platformQrStatusDtoSchema,
  importBrowserRequestSchema,
} from "../../../shared/dto/platform-account.ts";
import type { Platform, RunMode } from "../../../shared/enums.ts";
import { LOGIN_PLATFORMS } from "../../../shared/platforms.ts";
import type { PlatformAccountService } from "../../application/platform-accounts.ts";
import type { PlatformQrLoginService } from "../../application/platform-qr-login.ts";
import { amberError } from "../../domain/errors.ts";
import { principalOf } from "../auth.ts";
import { parseInput, sendValidated } from "../validation.ts";
import { requestSignal, TEXT_BODY_LIMIT_BYTES } from "./contents.ts";

const platformParamsSchema = z.object({ platform: z.string().min(1) });
const qrAttemptParamsSchema = z.object({ attemptId: z.string().min(1) });
/** Secret-bearing request body: defined here on the server only, never in `src/shared` (the shared-secrets guard). */
const putCookiesRequestSchema = z.object({ value: z.string().min(1) }).strict();

function platformOf(params: unknown): Platform {
  const { platform } = parseInput(platformParamsSchema, params, "params");
  // A platform without login support has no account routes: the same 404 as an unknown one.
  if (!(LOGIN_PLATFORMS as readonly string[]).includes(platform)) {
    throw amberError("not_found", "no such platform");
  }
  return platform as Platform;
}

/**
 * `/api/platform-accounts*`; an unsupported platform, or one without login support, is a 404
 * like any unknown path. The QR login routes exist in server mode only; the desktop client logs in
 * through its own window instead.
 */
export function registerPlatformAccountRoutes(
  app: FastifyInstance,
  deps: { platformAccounts: PlatformAccountService; mode: RunMode; qrLogin?: PlatformQrLoginService },
): void {
  const { platformAccounts, qrLogin } = deps;

  if (deps.mode === "server" && qrLogin !== undefined) {
    app.post("/api/platform-accounts/bilibili/qr", async (request, reply) =>
      sendValidated(reply, 200, platformQrAttemptDtoSchema, await qrLogin.start(principalOf(request), "bilibili", requestSignal(reply))),
    );

    app.get("/api/platform-accounts/bilibili/qr/:attemptId", async (request, reply) => {
      const { attemptId } = parseInput(qrAttemptParamsSchema, request.params, "params");
      return sendValidated(reply, 200, platformQrStatusDtoSchema, await qrLogin.status(principalOf(request), "bilibili", attemptId, requestSignal(reply)));
    });
  }

  if (deps.mode === "local") {
    // The desktop client reads YouTube's login from a local browser profile.
    app.post("/api/platform-accounts/youtube/import-browser", async (request, reply) => {
      const { browser } = parseInput(importBrowserRequestSchema, request.body ?? {}, "body");
      return sendValidated(
        reply,
        200,
        platformAccountDtoSchema,
        await platformAccounts.importFromBrowser(principalOf(request), "youtube", browser, requestSignal(reply)),
      );
    });
  }

  app.get("/api/platform-accounts", async (request, reply) => {
    return sendValidated(reply, 200, platformAccountListDtoSchema, platformAccounts.list(principalOf(request)));
  });

  app.put("/api/platform-accounts/:platform/cookies", { bodyLimit: TEXT_BODY_LIMIT_BYTES }, async (request, reply) => {
    const platform = platformOf(request.params);
    const { value } = parseInput(putCookiesRequestSchema, request.body, "body");
    return sendValidated(reply, 200, platformAccountDtoSchema, platformAccounts.putCookies(principalOf(request), platform, value));
  });

  app.post("/api/platform-accounts/:platform/check", async (request, reply) => {
    const platform = platformOf(request.params);
    return sendValidated(reply, 200, platformCheckDtoSchema, await platformAccounts.check(principalOf(request), platform, requestSignal(reply)));
  });

  app.delete("/api/platform-accounts/:platform", async (request, reply) => {
    const platform = platformOf(request.params);
    platformAccounts.delete(principalOf(request), platform);
    return reply.code(204).send();
  });
}
