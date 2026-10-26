import { mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { isAmberError } from "../../../src/server/domain/errors.ts";
import type { LlmStreamEvent } from "../../../src/server/domain/llm.ts";
import type { RequestPrincipal } from "../../../src/server/domain/user.ts";
import type { StageExecutor } from "../../../src/server/pipeline/executor.ts";
import { PASSWORD_MIN_LEN } from "../../../src/shared/defaults.ts";
import { FakeLlmProvider } from "../../fixtures/llm/fake-llm.ts";
import { createAdmin, fakeHasher, insertSession } from "../../fixtures/pipeline/admin.ts";
import { configureChatModel, seedChatContent } from "../../fixtures/pipeline/chat-data.ts";
import {
  BOB,
  configureAsr,
  configureLlm,
  createHarness,
  createLocalContent,
  createTaskOfKind,
  LOCAL,
  taskOf,
  waitFor,
  type Harness,
  type HarnessOptions,
} from "../../fixtures/pipeline/harness.ts";
import { countRows } from "../../tools/sqlite.ts";

const PASSWORD = "p".repeat(PASSWORD_MIN_LEN);
const open: Harness[] = [];
afterEach(async () => {
  for (const created of open.splice(0)) await created.close();
});

function harness(options: HarnessOptions = {}): Harness {
  const created = createHarness(options);
  open.push(created);
  return created;
}

async function failure(run: () => unknown): Promise<{ class: string; code: string }> {
  try {
    await run();
  } catch (error) {
    if (isAmberError(error)) return error.appError;
    throw error;
  }
  throw new Error("expected a rejection");
}

const userOf = (h: Harness, userId: string) => h.repository.withTransaction((scope) => scope.users.get(userId));
const sessionOf = (h: Harness, hash: string) => h.repository.withTransaction((scope) => scope.sessions.get(hash));

/** Waits for the abort, then needs `unwindMs` more to stop, like a process tree that dies slowly. */
function slowToStop(unwindMs: number): StageExecutor & { started: boolean } {
  const executor = {
    started: false,
    async run(context: Parameters<StageExecutor["run"]>[0]) {
      executor.started = true;
      await new Promise<void>((resolve) => context.signal.addEventListener("abort", () => resolve(), { once: true }));
      await new Promise((resolve) => setTimeout(resolve, unwindMs));
      throw context.signal.reason;
    },
  };
  return executor;
}

describe("AdminService access", () => {
  it("refuses every operation to a non-admin", async () => {
    const h = harness();
    const { admin } = createAdmin(h);
    const calls: Array<() => unknown> = [
      () => admin.listUsers(BOB),
      () => admin.createUser(BOB, { username: "carol", password: PASSWORD, role: "user" }),
      () => admin.patchUser(BOB, LOCAL.userId, { status: "suspended" }),
      () => admin.resetPassword(BOB, LOCAL.userId, { newPassword: PASSWORD }),
      () => admin.deleteUser(BOB, LOCAL.userId),
      () => admin.storage(BOB),
      () => admin.getAllowlist(BOB),
      () => admin.putAllowlist(BOB, { origins: [] }),
      () => admin.resetCredentials(BOB),
    ];
    for (const call of calls) {
      expect((await failure(call)).class).toBe("forbidden");
    }
    expect(userOf(h, LOCAL.userId)?.status).toBe("active");
  });
});

describe("accounts", () => {
  it("creates users with a normalized unique name that must change the password", async () => {
    const h = harness();
    const { admin } = createAdmin(h);
    const created = await admin.createUser(LOCAL, { username: "  Carol.X ", password: PASSWORD, displayName: "Carol", role: "user" });
    expect(created).toMatchObject({ username: "carol.x", role: "user", status: "active", displayName: "Carol", mustChangePassword: true });
    const credential = h.repository.withTransaction((scope) => scope.users.getCredential(created.id));
    expect(await fakeHasher.verify(credential?.passwordHash as string, PASSWORD)).toEqual({ valid: true, needsRehash: false });
    expect(credential?.passwordHash).not.toContain(PASSWORD);

    expect((await failure(() => admin.createUser(LOCAL, { username: "CAROL.X", password: PASSWORD, role: "admin" }))).code).toBe("conflict.username_taken");
    expect((await failure(() => admin.createUser(LOCAL, { username: "a b", password: PASSWORD, role: "user" }))).class).toBe("invalid_request");
    expect((await failure(() => admin.createUser(LOCAL, { username: "dave", password: "short", role: "user" }))).class).toBe("invalid_request");
    expect(admin.listUsers(LOCAL).users.map((user) => user.username)).toEqual(expect.arrayContaining(["carol.x"]));
  });

  it("keeps the last active administrator and revokes the sessions of a suspended user", async () => {
    const h = harness();
    const { admin, revocations } = createAdmin(h);
    expect((await failure(() => admin.patchUser(LOCAL, LOCAL.userId, { status: "suspended" }))).code).toBe("conflict.last_admin");
    expect((await failure(() => admin.patchUser(LOCAL, LOCAL.userId, { role: "user" }))).code).toBe("conflict.last_admin");

    insertSession(h, BOB.userId, "bob-1");
    insertSession(h, BOB.userId, "bob-2");
    insertSession(h, LOCAL.userId, "local-1");
    expect(admin.patchUser(LOCAL, BOB.userId, { status: "suspended", storageLimitGB: 2, displayName: "Bob" })).toMatchObject({
      status: "suspended",
      storageLimitGB: 2,
      displayName: "Bob",
    });
    expect(sessionOf(h, "bob-1")?.revokedAt).toBeDefined();
    expect(sessionOf(h, "local-1")?.revokedAt).toBeUndefined();
    expect(revocations.has("bob-1") && revocations.has("bob-2")).toBe(true);

    const restored = admin.patchUser(LOCAL, BOB.userId, { status: "active", storageLimitGB: null, displayName: null });
    expect(restored).toEqual(expect.not.objectContaining({ storageLimitGB: expect.anything(), displayName: expect.anything() }));
    // A second active admin lifts the protection.
    admin.patchUser(LOCAL, BOB.userId, { role: "admin" });
    expect(admin.patchUser(LOCAL, LOCAL.userId, { role: "user" }).role).toBe("user");
    expect((await failure(() => admin.patchUser(LOCAL, "ghost", { status: "active" }))).class).toBe("not_found");
  });

  it("resets a password: new hash, forced change, every session revoked", async () => {
    const h = harness();
    const { admin, revocations } = createAdmin(h);
    const carol = await admin.createUser(LOCAL, { username: "carol", password: PASSWORD, role: "user" });
    h.repository.withTransaction((scope) => {
      const credential = scope.users.getCredential(carol.id);
      if (credential !== undefined) scope.users.putCredential({ ...credential, mustChangePassword: false });
    });
    insertSession(h, carol.id, "carol-1");
    const next = "n".repeat(PASSWORD_MIN_LEN);
    await admin.resetPassword(LOCAL, carol.id, { newPassword: next });
    const credential = h.repository.withTransaction((scope) => scope.users.getCredential(carol.id));
    expect(credential?.mustChangePassword).toBe(true);
    expect((await fakeHasher.verify(credential?.passwordHash as string, next)).valid).toBe(true);
    expect(sessionOf(h, "carol-1")?.revokedAt).toBeDefined();
    expect(revocations.has("carol-1")).toBe(true);
    expect((await failure(() => admin.resetPassword(LOCAL, carol.id, { newPassword: "short" }))).class).toBe("invalid_request");
    expect((await failure(() => admin.resetPassword(LOCAL, "ghost", { newPassword: next }))).class).toBe("not_found");
  });
});

describe("deleting a user", () => {
  it("suspends, revokes and cancels first, drains running work, then deletes everything the user owns", async () => {
    const executor = slowToStop(30);
    const h = harness({ executors: { cache_media: executor } });
    const { admin, revocations, files } = createAdmin(h);
    insertSession(h, BOB.userId, "bob-1");
    const taskId = createTaskOfKind(h, "cache_media", {}, { userId: BOB.userId });
    const contentId = taskOf(h, taskId, BOB.userId).contentId as string;
    await files.writeAtomic(`assets/${BOB.userId}/${contentId}/asset`, Buffer.from("media"));
    h.repository.withTransaction((scope) =>
      scope.otherModelProfiles.insert({ id: "bob-other", userId: BOB.userId, name: "tts", models: [{ modelId: "tts-1", kind: "tts" }], createdAt: 1 }),
    );
    h.scheduler.start();
    await waitFor(() => executor.started);

    const deleting = admin.deleteUser(LOCAL, BOB.userId);
    // The barrier is in place before anything is awaited.
    expect(userOf(h, BOB.userId)?.status).toBe("suspended");
    expect(sessionOf(h, "bob-1")?.revokedAt).toBeDefined();
    expect(revocations.has("bob-1")).toBe(true);
    expect(taskOf(h, taskId, BOB.userId).statusProjection).toBe("cancelled");
    expect(h.scheduler.isExecuting(taskId)).toBe(true);

    await deleting;
    expect(userOf(h, BOB.userId)).toBeUndefined();
    expect(countRows(h.db, "content", "user_id = ?", BOB.userId)).toBe(0);
    expect(countRows(h.db, "task", "user_id = ?", BOB.userId)).toBe(0);
    expect(countRows(h.db, "session", "user_id = ?", BOB.userId)).toBe(0);
    expect(countRows(h.db, "other_model_profile", "user_id = ?", BOB.userId)).toBe(0);
    expect(await files.list(`assets/${BOB.userId}`)).toEqual([]);
    expect(userOf(h, LOCAL.userId)?.status).toBe("active");
  });

  it("stops the user's streaming chat answers before deleting", async () => {
    const provider = new FakeLlmProvider();
    provider.script(async function* (_request, opts): AsyncGenerator<LlmStreamEvent> {
      yield { type: "text_delta", delta: "…" };
      await new Promise<void>((resolve) => opts.signal.addEventListener("abort", () => resolve(), { once: true }));
      yield { type: "done", stopReason: "aborted" };
    });
    const h = harness({ llmProviders: [provider] });
    const { admin } = createAdmin(h);
    const { contentId } = seedChatContent(h, 3, { userId: BOB.userId });
    const modelRef = configureChatModel(h, 128_000, BOB.userId);
    const result = h.chat.send(BOB, contentId, { text: "q", modelRef }, undefined, new AbortController().signal);
    if (result.kind !== "stream") throw new Error("expected a stream");
    const consumed = (async () => {
      for await (const _event of result.events) {
        // drained like the HTTP route does
      }
    })();

    await admin.deleteUser(LOCAL, BOB.userId);
    await consumed;
    expect(h.chat.hasInflight(BOB.userId)).toBe(false);
    expect(userOf(h, BOB.userId)).toBeUndefined();
  });

  it("keeps the user suspended and reports tasks_still_running when work outlasts the drain; a retry then succeeds", async () => {
    const executor = slowToStop(300);
    const h = harness({ executors: { cache_media: executor } });
    const { admin } = createAdmin(h, { drainTimeoutMs: 40 });
    insertSession(h, BOB.userId, "bob-1");
    const taskId = createTaskOfKind(h, "cache_media", {}, { userId: BOB.userId });
    h.scheduler.start();
    await waitFor(() => executor.started);

    expect((await failure(() => admin.deleteUser(LOCAL, BOB.userId))).code).toBe("conflict.tasks_still_running");
    expect(userOf(h, BOB.userId)?.status).toBe("suspended");
    expect(sessionOf(h, "bob-1")?.revokedAt).toBeDefined();
    expect(taskOf(h, taskId, BOB.userId).statusProjection).toBe("cancelled");

    await h.scheduler.settleTasks([taskId]);
    await admin.deleteUser(LOCAL, BOB.userId);
    expect(userOf(h, BOB.userId)).toBeUndefined();
  });

  it("queues the user's flat cache files, available or evicted, in the deletion; the queue outlives the user and removes them", async () => {
    const h = harness();
    const { admin } = createAdmin(h);
    const contentId = createLocalContent(h, BOB.userId);
    const cache = (id: string, storageRef: string, availability: "available" | "evicted") => ({
      id, userId: BOB.userId, contentId, kind: "platform_cache" as const, storageRef, mimeType: "video/mp4", sizeBytes: Buffer.byteLength(storageRef),
      availability, retentionPolicy: "evictable" as const, createdAt: 1,
    });
    h.repository.withTransaction((scope) => {
      scope.mediaAssets.insert(cache("video", "media/Bob.mp4", "available"));
      scope.mediaAssets.insert(cache("audio", "media/Bob.mp3", "evicted"));
    });
    for (const ref of ["media/Bob.mp4", "media/Bob.mp3"]) await h.media.cache.writeAtomic(ref, Buffer.from(ref));
    // A cache move in progress: the worker has to leave the cache files for later.
    const release = h.gate.tryExclusive("cache_migration");
    await admin.deleteUser(LOCAL, BOB.userId);
    await h.fileDeleter.whenIdle();
    expect(userOf(h, BOB.userId)).toBeUndefined();
    expect(h.db.prepare("SELECT storage_ref AS ref, user_id AS userId FROM pending_file_delete ORDER BY storage_ref").all()).toEqual([
      { ref: "media/Bob.mp3", userId: BOB.userId },
      { ref: "media/Bob.mp4", userId: BOB.userId },
    ]);
    release?.();
    expect(await h.fileDeleter.drainRoot(h.fileDeleter.currentCacheRoot())).toBe(true);
    expect(await h.media.cache.list("media")).toEqual([]);
  });

  it("refuses to delete oneself, an unknown user or the last active administrator", async () => {
    const h = harness();
    const { admin } = createAdmin(h);
    expect((await failure(() => admin.deleteUser(LOCAL, LOCAL.userId))).class).toBe("conflict");
    expect((await failure(() => admin.deleteUser(LOCAL, "ghost"))).class).toBe("not_found");
    // An administrator principal whose own account is not an active admin row.
    const outsider: RequestPrincipal = { userId: "outsider", mode: "server", role: "admin", mustChangePassword: false };
    expect((await failure(() => admin.deleteUser(outsider, LOCAL.userId))).code).toBe("conflict.last_admin");
    expect(userOf(h, LOCAL.userId)?.status).toBe("active");
  });
});

describe("storage and allowlist", () => {
  it("reports each user's asset bytes against the data volume", async () => {
    const h = harness();
    const { admin, files } = createAdmin(h);
    const contentId = createLocalContent(h, BOB.userId);
    await files.writeAtomic(`assets/${BOB.userId}/${contentId}/a`, Buffer.alloc(1500));
    mkdirSync(join(h.dir, "assets", LOCAL.userId), { recursive: true });
    writeFileSync(join(h.dir, "assets", LOCAL.userId, "x.partial"), "in flight");
    admin.patchUser(LOCAL, BOB.userId, { storageLimitGB: 1 });
    const report = await admin.storage(LOCAL);
    expect(report.totalBytes).toBeGreaterThan(0);
    expect(report.users).toEqual(
      expect.arrayContaining([
        { userId: BOB.userId, usedBytes: 1500, storageLimitGB: 1 },
        { userId: LOCAL.userId, usedBytes: 0 },
      ]),
    );
  });

  it("replaces the allowlist with normalized exact origins and rejects patterns", async () => {
    const h = harness();
    const { admin } = createAdmin(h);
    expect(admin.putAllowlist(LOCAL, { origins: ["HTTP://Relay.LAN:8080/", "http://relay.lan:8080", "https://10.0.0.5"] })).toEqual({
      origins: ["http://relay.lan:8080", "https://10.0.0.5"],
    });
    for (const entry of ["http://*.lan", "10.0.0.0/8", "https://relay.lan/v1", "^https://.*$"]) {
      expect((await failure(() => admin.putAllowlist(LOCAL, { origins: [entry] }))).code, entry).toBe("invalid_request.allowlist_entry");
    }
    expect(admin.getAllowlist(LOCAL)).toEqual({ origins: ["http://relay.lan:8080", "https://10.0.0.5"] });
    admin.putAllowlist(LOCAL, { origins: [] });
    expect(admin.getAllowlist(LOCAL).origins).toEqual([]);
  });
});

describe("resetting all credentials", () => {
  it("removes every secret and reference in one transaction, then rotates the key", async () => {
    const h = harness();
    let secretsAtRotation = -1;
    const { admin } = createAdmin(h, {
      rotation: {
        rotate: async () => {
          secretsAtRotation = countRows(h.db, "secret");
        },
      },
    });
    const modelRef = configureLlm(h, BOB.userId);
    configureAsr(h, LOCAL.userId);
    const cookieRef = h.secrets.store(BOB.userId, "<placeholder-cookie>");
    h.repository.withTransaction((scope) =>
      scope.platformAccounts.insert({ id: h.newId(), userId: BOB.userId, platform: "bilibili", credentialRef: cookieRef, status: "valid" }),
    );
    const searchRef = h.secrets.store(LOCAL.userId, "tvly-placeholder");
    h.repository.withTransaction((scope) => scope.webSearchProfiles.put({ userId: LOCAL.userId, service: "tavily", credentialRef: searchRef, createdAt: 1, updatedAt: 1 }));
    expect(countRows(h.db, "secret")).toBe(4);

    const { credentialsResetAt } = await admin.resetCredentials(LOCAL);
    expect(secretsAtRotation).toBe(0);
    expect(countRows(h.db, "secret")).toBe(0);
    expect(countRows(h.db, "platform_account")).toBe(0);
    expect(countRows(h.db, "provider_profile", "credential_ref IS NULL AND id = ?", modelRef.providerProfileId)).toBe(1);
    expect(countRows(h.db, "asr_provider_profile", "credential_ref IS NOT NULL")).toBe(0);
    expect(countRows(h.db, "web_search_profile", "credential_ref IS NULL")).toBe(1);
    expect(h.repository.withTransaction((scope) => scope.instanceSettings.get()?.credentialsResetAt)).toBe(credentialsResetAt);
    // Instance settings keep working with the audit field present.
    expect(h.settings.patch(LOCAL, { concurrencyPipeline: 3 }).concurrencyPipeline).toBe(3);
    expect(h.repository.withTransaction((scope) => scope.instanceSettings.get()?.credentialsResetAt)).toBe(credentialsResetAt);
  });
});
