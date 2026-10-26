import { monotonicFactory } from "ulid";
import { USER_DELETE_DRAIN_TIMEOUT_MS } from "../../shared/defaults.ts";
import type { AdminStorageDto, AdminUserDto, AdminUserListDto, CredentialsResetDto, NetworkAllowlistDto } from "../../shared/dto/admin.ts";
import type { UserRole, UserStatus } from "../../shared/enums.ts";
import { amberError, type AmberError } from "../domain/errors.ts";
import { normalizeAllowlistOrigin } from "../domain/network-policy.ts";
import { isAcceptablePassword, normalizeUsername, type User, type RequestPrincipal } from "../domain/user.ts";
import type { FileStore } from "../ports/file-store.ts";
import type { Logger } from "../ports/logger.ts";
import type { MasterKeyRotation } from "../ports/master-key-rotation.ts";
import type { PasswordHasher } from "../ports/password-hasher.ts";
import type { Repository, RepositoryScope } from "../ports/repository.ts";
import type { TaskEventBus } from "../pipeline/events.ts";
import { transact } from "../pipeline/publish.ts";
import { cancelTaskState, loadTaskState } from "../pipeline/task-state.ts";
import { defaultInstanceSettings } from "./instance-settings.ts";
import { filesOfAssets, type PendingFileDeleter } from "./pending-file-delete.ts";
import type { SessionRevocations } from "./session-revocations.ts";
import { userAssetsPrefix } from "./storage-quota.ts";
import type { TaskControl } from "./tasks.ts";

/** What deleting a user needs from the scheduler beyond `TaskControl`. */
export interface AdminTaskControl extends TaskControl {
  /** Resolves once none of the Tasks has an execution left in this process. */
  settleTasks(taskIds: readonly string[]): Promise<void>;
  isExecuting(taskId: string): boolean;
}

/** What deleting a user needs from the chat service. */
export interface AdminChatControl {
  abortOwner(ownerUserId: string): Promise<void>;
  hasInflight(ownerUserId: string): boolean;
}

export interface AdminServiceOptions {
  repository: Repository;
  bus: TaskEventBus;
  control: AdminTaskControl;
  chat: AdminChatControl;
  hasher: PasswordHasher;
  revocations: SessionRevocations;
  files: Pick<FileStore, "usedBytes" | "remove" | "diskUsage">;
  /**
   * A deleted user's caches lie flat in the shared cache directory, outside their assets
   * prefix: they are registered with the pending-file queue in the deletion transaction.
   */
  fileDeleter: Pick<PendingFileDeleter, "register" | "kick">;
  rotation: MasterKeyRotation;
  logger: Logger;
  /** `USER_DELETE_DRAIN_TIMEOUT_MS` unless a test shortens it. */
  drainTimeoutMs?: number;
  now?: () => number;
  newId?: () => string;
}

export interface CreateUserRequest {
  username: string;
  password: string;
  displayName?: string;
  role: UserRole;
}

/** Absent fields stay; `null` clears an optional one. */
export interface PatchUserRequest {
  status?: UserStatus;
  role?: UserRole;
  displayName?: string | null;
  storageLimitGB?: number | null;
}

/** Administration is admin-only; routes call this before parsing so a non-admin learns nothing from validation. */
export function requireAdmin(principal: RequestPrincipal): void {
  if (principal.role !== "admin") {
    throw amberError("forbidden", "administration requires the admin role");
  }
}

function lastAdmin(): AmberError {
  return amberError("conflict", "the last active administrator must stay", { code: "conflict.last_admin" });
}

function stillRunning(): AmberError {
  return amberError("conflict", "the user's work did not stop in time", { code: "conflict.tasks_still_running" });
}

function invalid(detail: string, message: string): AmberError {
  return amberError("invalid_request", message, { params: { detail } });
}

const isActiveAdmin = (user: User): boolean => user.role === "admin" && user.status === "active";

/**
 * Administration: accounts, storage, the outbound allowlist and the credentials reset.
 * Every method checks the admin role itself. Invariant: this is the only place that reaches
 * across owners; every other service scopes what it reads and writes to the principal. The
 * instance always keeps one active administrator, and every suspension, password reset or
 * deletion revokes the user's sessions at once.
 */
export class AdminService {
  private readonly options: AdminServiceOptions;
  private readonly now: () => number;
  private readonly newId: () => string;

  constructor(options: AdminServiceOptions) {
    this.options = options;
    this.now = options.now ?? Date.now;
    this.newId = options.newId ?? monotonicFactory();
  }

  listUsers(principal: RequestPrincipal): AdminUserListDto {
    requireAdmin(principal);
    return this.options.repository.withTransaction((scope) => ({ users: scope.users.list().map((user) => toDto(scope, user)) }));
  }

  async createUser(principal: RequestPrincipal, body: CreateUserRequest): Promise<AdminUserDto> {
    requireAdmin(principal);
    const username = normalizeUsername(body.username);
    if (username === undefined) {
      throw invalid("username", "username must be 3-32 characters of [a-z0-9._-] after normalization");
    }
    if (!isAcceptablePassword(body.password)) {
      throw invalid("password", "password is too short");
    }
    this.requireFreeUsername(username);
    // Hashing is slow; the name is checked again inside the transaction.
    const passwordHash = await this.options.hasher.hash(body.password);
    return this.options.repository.withTransaction((scope) => {
      if (scope.users.findCredentialByUsername(username) !== undefined) {
        throw usernameTaken();
      }
      const user: User = {
        id: this.newId(),
        role: body.role,
        status: "active",
        ...(body.displayName === undefined ? {} : { displayName: body.displayName }),
        createdAt: this.now(),
      };
      scope.users.insert(user);
      scope.users.putCredential({ userId: user.id, username, passwordHash, mustChangePassword: true });
      return toDto(scope, user);
    });
  }

  patchUser(principal: RequestPrincipal, userId: string, patch: PatchUserRequest): AdminUserDto {
    requireAdmin(principal);
    const { dto, revoked } = this.options.repository.withTransaction((scope) => {
      const user = requireUser(scope, userId);
      const next: User = { ...user };
      if (patch.status !== undefined) {
        next.status = patch.status;
      }
      if (patch.role !== undefined) {
        next.role = patch.role;
      }
      if (patch.displayName === null) {
        delete next.displayName;
      } else if (patch.displayName !== undefined) {
        next.displayName = patch.displayName;
      }
      if (patch.storageLimitGB === null) {
        delete next.storageLimitGB;
      } else if (patch.storageLimitGB !== undefined) {
        next.storageLimitGB = patch.storageLimitGB;
      }
      if (isActiveAdmin(user) && !isActiveAdmin(next) && scope.users.countActiveAdmins() <= 1) {
        throw lastAdmin();
      }
      scope.users.update(next);
      const suspended = user.status === "active" && next.status === "suspended";
      return { dto: toDto(scope, next), revoked: suspended ? scope.sessions.revokeAllOf(userId, this.now()) : [] };
    });
    this.options.revocations.add(revoked);
    return dto;
  }

  /** The administrator sets the new password; the user must change it at the next login. */
  async resetPassword(principal: RequestPrincipal, userId: string, body: { newPassword: string }): Promise<void> {
    requireAdmin(principal);
    if (!isAcceptablePassword(body.newPassword)) {
      throw invalid("newPassword", "password is too short");
    }
    this.options.repository.withTransaction((scope) => requireCredential(scope, userId));
    const passwordHash = await this.options.hasher.hash(body.newPassword);
    const revoked = this.options.repository.withTransaction((scope) => {
      const credential = requireCredential(scope, userId);
      scope.users.putCredential({ ...credential, passwordHash, mustChangePassword: true });
      return scope.sessions.revokeAllOf(userId, this.now());
    });
    this.options.revocations.add(revoked);
  }

  /**
   * Deletes an account and everything it owns. First a barrier: the user is suspended,
   * every session revoked and every unfinished Task cancelled in one transaction, so no
   * request of theirs can start new work. Then the executions and streaming answers are
   * drained, at most `USER_DELETE_DRAIN_TIMEOUT_MS`. The deletion transaction checks again
   * that nothing of theirs runs; otherwise, like on a timeout, the user stays suspended
   * and the call fails with `conflict.tasks_still_running` so it can be retried. The same
   * transaction registers the user's cache files, available or evicted, with the
   * pending-file queue; the files of their assets prefix go after the commit. An
   * administrator cannot delete their own account.
   */
  async deleteUser(principal: RequestPrincipal, userId: string): Promise<void> {
    requireAdmin(principal);
    if (userId === principal.userId) {
      throw amberError("conflict", "administrators cannot delete their own account");
    }
    const { control, chat } = this.options;
    const { taskIds, revoked } = transact(this.options.repository, this.options.bus, (scope, outbox) => {
      const user = requireUser(scope, userId);
      if (isActiveAdmin(user) && scope.users.countActiveAdmins() <= 1) {
        throw lastAdmin();
      }
      const now = this.now();
      if (user.status !== "suspended") {
        scope.users.update({ ...user, status: "suspended" });
      }
      const revokedHashes = scope.sessions.revokeAllOf(userId, now);
      const unfinished = scope.tasks.listUnfinishedOf(userId);
      for (const task of unfinished) {
        // Abort first so the execution stops writing before the cancelled state commits.
        control.abortTask(task.id);
        const state = loadTaskState(scope, userId, task.id);
        if (state !== undefined) {
          cancelTaskState(scope, outbox, state, now);
        }
      }
      return { taskIds: unfinished.map((task) => task.id), revoked: revokedHashes };
    });
    this.options.revocations.add(revoked);
    control.kick();

    const drained = await withinTimeout(
      Promise.all([control.settleTasks(taskIds), chat.abortOwner(userId)]),
      this.options.drainTimeoutMs ?? USER_DELETE_DRAIN_TIMEOUT_MS,
    );
    if (!drained) {
      this.options.logger.warn("user_delete_drain_timeout", { userId, tasks: taskIds.length });
      throw stillRunning();
    }
    // One synchronous transaction on the single connection: nothing can start between the
    // re-check and the delete.
    this.options.repository.withTransaction((scope) => {
      const running =
        scope.tasks.listUnfinishedOf(userId).length > 0 || taskIds.some((id) => control.isExecuting(id)) || chat.hasInflight(userId);
      if (running) {
        throw stillRunning();
      }
      this.options.fileDeleter.register(scope, filesOfAssets(scope, scope.mediaAssets.listCachesOfUser(userId)));
      scope.users.delete(userId);
    });
    this.options.fileDeleter.kick();
    try {
      await this.options.files.remove(userAssetsPrefix(userId));
    } catch (error) {
      this.options.logger.warn("user_assets_not_removed", { userId, error: String(error) });
    }
  }

  async storage(principal: RequestPrincipal): Promise<AdminStorageDto> {
    requireAdmin(principal);
    const users = this.options.repository.withTransaction((scope) => scope.users.list());
    const disk = await this.options.files.diskUsage();
    const perUser = [];
    for (const user of users) {
      perUser.push({
        userId: user.id,
        usedBytes: await this.options.files.usedBytes(userAssetsPrefix(user.id)),
        ...(user.storageLimitGB === undefined ? {} : { storageLimitGB: user.storageLimitGB }),
      });
    }
    return { totalBytes: disk.totalBytes, freeBytes: disk.freeBytes, usedBytes: disk.usedBytes, users: perUser };
  }

  getAllowlist(principal: RequestPrincipal): NetworkAllowlistDto {
    requireAdmin(principal);
    return { origins: this.options.repository.withTransaction((scope) => scope.networkAllowlist.list().map((entry) => entry.origin)) };
  }

  /**
   * Replaces the whole list; every entry must be one exact origin `scheme://host[:port]`,
   * without wildcards, CIDRs or paths.
   */
  putAllowlist(principal: RequestPrincipal, body: NetworkAllowlistDto): NetworkAllowlistDto {
    requireAdmin(principal);
    const origins = [...new Set(body.origins.map(normalizeAllowlistOrigin))];
    const now = this.now();
    return this.options.repository.withTransaction((scope) => {
      const existing = new Map(scope.networkAllowlist.list().map((entry) => [entry.origin, entry]));
      // Entries that stay keep their original actor and time.
      scope.networkAllowlist.replace(origins.map((origin) => existing.get(origin) ?? { origin, createdByUserId: principal.userId, createdAt: now }));
      return { origins: scope.networkAllowlist.list().map((entry) => entry.origin) };
    });
  }

  /**
   * "Reset all credentials", in its fixed order: one transaction removes
   * every Secret with every reference to one and records the time; replacing the master
   * key follows as a separate step. A failure there leaves a consistent state (nothing
   * left to decrypt) and the call can simply be repeated.
   */
  async resetCredentials(principal: RequestPrincipal): Promise<CredentialsResetDto> {
    requireAdmin(principal);
    const credentialsResetAt = this.now();
    this.options.repository.withTransaction((scope) => {
      scope.platformAccounts.deleteAll();
      scope.providerProfiles.clearAllCredentialRefs();
      scope.asrProfiles.clearAllCredentialRefs();
      scope.webSearchProfiles.clearCredentials();
      scope.secretEnvelopes.deleteAll();
      const settings = scope.instanceSettings.get() ?? defaultInstanceSettings(credentialsResetAt);
      scope.instanceSettings.put({ ...settings, credentialsResetAt });
    });
    await this.options.rotation.rotate();
    return { credentialsResetAt };
  }

  private requireFreeUsername(username: string): void {
    if (this.options.repository.withTransaction((scope) => scope.users.findCredentialByUsername(username)) !== undefined) {
      throw usernameTaken();
    }
  }
}

function usernameTaken(): AmberError {
  return amberError("conflict", "username already exists", { code: "conflict.username_taken" });
}

function requireUser(scope: RepositoryScope, userId: string): User {
  const user = scope.users.get(userId);
  if (user === undefined) {
    throw amberError("not_found", `user ${userId}`);
  }
  return user;
}

function requireCredential(scope: RepositoryScope, userId: string) {
  requireUser(scope, userId);
  const credential = scope.users.getCredential(userId);
  if (credential === undefined) {
    throw amberError("not_found", `user ${userId} has no login`);
  }
  return credential;
}

function toDto(scope: RepositoryScope, user: User): AdminUserDto {
  const credential = scope.users.getCredential(user.id);
  return {
    id: user.id,
    // Only a user without a login (never created through administration) falls back to its id.
    username: credential?.username ?? user.id,
    role: user.role,
    status: user.status,
    ...(user.displayName === undefined ? {} : { displayName: user.displayName }),
    ...(user.storageLimitGB === undefined ? {} : { storageLimitGB: user.storageLimitGB }),
    mustChangePassword: credential?.mustChangePassword ?? false,
    createdAt: user.createdAt,
  };
}

/** True when `work` settled within `timeoutMs`; its rejection counts as settled too. */
async function withinTimeout(work: Promise<unknown>, timeoutMs: number): Promise<boolean> {
  let timer: NodeJS.Timeout | undefined;
  const timedOut = new Promise<false>((resolve) => {
    timer = setTimeout(() => resolve(false), timeoutMs);
  });
  try {
    return await Promise.race([work.then(() => true, () => true), timedOut]);
  } finally {
    clearTimeout(timer);
  }
}
