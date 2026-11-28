import { createHash } from "node:crypto";
import { LocalFileStore } from "../../../src/server/adapters/file-store/local-file-store.ts";
import { AdminService, type AdminServiceOptions } from "../../../src/server/application/admin.ts";
import { SessionRevocations } from "../../../src/server/application/session-revocations.ts";
import type { MasterKeyRotation } from "../../../src/server/ports/master-key-rotation.ts";
import type { PasswordHasher } from "../../../src/server/ports/password-hasher.ts";
import { silentLogger, type Harness } from "./harness.ts";

/** A stand-in for argon2id: deterministic, instant and obviously not a real hash. */
export const fakeHasher: PasswordHasher = {
  hash: async (password) => `<fake-hash:${createHash("sha256").update(password).digest("hex")}>`,
  verify: async (passwordHash, password) => ({
    valid: passwordHash === `<fake-hash:${createHash("sha256").update(password).digest("hex")}>`,
    needsRehash: false,
  }),
};

export interface AdminStack {
  admin: AdminService;
  revocations: SessionRevocations;
  files: LocalFileStore;
  rotations: number;
}

/** The AdminService over a harness: its scheduler and chat, a FileStore on its temp data directory, a counting rotation. */
export function createAdmin(h: Harness, options: Partial<Pick<AdminServiceOptions, "drainTimeoutMs" | "rotation" | "coverBackfill">> = {}): AdminStack {
  const revocations = new SessionRevocations();
  const files = new LocalFileStore(h.dir);
  const stack: AdminStack = { admin: undefined as unknown as AdminService, revocations, files, rotations: 0 };
  const rotation: MasterKeyRotation = options.rotation ?? {
    rotate: async () => {
      stack.rotations += 1;
    },
  };
  stack.admin = new AdminService({
    repository: h.repository,
    bus: h.bus,
    control: {
      kick: () => h.scheduler.kick(),
      abortTask: (taskId) => h.scheduler.abortTask(taskId),
      settleTasks: (taskIds) => h.scheduler.settleTasks(taskIds),
      isExecuting: (taskId) => h.scheduler.isExecuting(taskId),
    },
    chat: h.chat,
    hasher: fakeHasher,
    revocations,
    files,
    fileDeleter: h.fileDeleter,
    rotation,
    logger: silentLogger,
    newId: h.newId,
    ...(options.drainTimeoutMs === undefined ? {} : { drainTimeoutMs: options.drainTimeoutMs }),
    ...(options.coverBackfill === undefined ? {} : { coverBackfill: options.coverBackfill }),
  });
  return stack;
}

/** A live session row of `userId`. */
export function insertSession(h: Harness, userId: string, sessionIdHash: string): void {
  h.repository.withTransaction((scope) =>
    scope.sessions.insert({ sessionIdHash, userId, createdAt: 1, lastSeenAt: 1, expiresAt: Date.now() + 3_600_000 }),
  );
}
