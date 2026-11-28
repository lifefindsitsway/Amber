import type { StorageDto } from "../../shared/dto/storage.ts";
import { BYTES_PER_GB, formatBytes } from "../../shared/units.ts";
import { amberError, type AmberError } from "../domain/errors.ts";
import type { RequestPrincipal } from "../domain/user.ts";
import type { FileStore } from "../ports/file-store.ts";
import type { Repository } from "../ports/repository.ts";

/** Where every asset of a user lives; quota and storage reports measure this tree. */
export function userAssetsPrefix(userId: string): string {
  return `assets/${userId}`;
}

/** One upload in progress: its bytes count against the owner's quota until it is released. */
export interface QuotaReservation {
  /** Passes the stream through, failing with `storage_quota_exceeded` once the owner's limit is crossed. */
  meter(stream: AsyncIterable<Uint8Array>): AsyncIterable<Uint8Array>;
  /** Called once the upload is committed or abandoned; idempotent. */
  release(): void;
}

interface Reservation {
  bytes: number;
}

/** `usedBytes` is what the user held before this upload: committed bytes and other uploads in flight. */
function quotaExceeded(usedBytes: number, limitGB: number): AmberError {
  return amberError("storage_quota_exceeded", "upload exceeds the user's storage limit", {
    params: {
      remaining: formatBytes(limitGB * BYTES_PER_GB - usedBytes),
      used: formatBytes(usedBytes),
      // As the administrator set it, rather than its binary size.
      limit: `${limitGB} GB`,
    },
  });
}

/**
 * Per-user storage limits (`User.storageLimitGB`). Usage is the
 * committed bytes under `assets/<userId>/**`, plus the user's local cover copies (kept in the
 * database rather than as files), plus the bytes of this process's uploads still streaming. An upload is refused at its start when that already exceeds the limit
 * and aborted as soon as its own bytes push it over. Users without a limit draw from the
 * global pool, which only the disk watermark guards.
 */
export class StorageQuota {
  private readonly repository: Repository;
  private readonly files: Pick<FileStore, "usedBytes">;
  private readonly reservations = new Map<string, Set<Reservation>>();

  constructor(options: { repository: Repository; files: Pick<FileStore, "usedBytes"> }) {
    this.repository = options.repository;
    this.files = options.files;
  }

  /** The caller's own usage and limit. */
  async usage(principal: RequestPrincipal): Promise<StorageDto> {
    const limitGB = this.repository.withTransaction((scope) => scope.users.get(principal.userId)?.storageLimitGB);
    const usedBytes = await this.committedBytes(principal.userId);
    return { usedBytes, ...(limitGB === undefined ? {} : { storageLimitGB: limitGB }) };
  }

  /** The owner's files plus their cover copies. */
  private async committedBytes(ownerUserId: string): Promise<number> {
    const fileBytes = await this.files.usedBytes(userAssetsPrefix(ownerUserId));
    return fileBytes + this.repository.withTransaction((scope) => scope.contentCovers.totalBytes(ownerUserId));
  }

  /** `undefined` when the owner has no limit. */
  async begin(ownerUserId: string): Promise<QuotaReservation | undefined> {
    const limitGB = this.repository.withTransaction((scope) => scope.users.get(ownerUserId)?.storageLimitGB);
    if (limitGB === undefined) {
      return undefined;
    }
    const limitBytes = limitGB * BYTES_PER_GB;
    const usedBytes = await this.committedBytes(ownerUserId);
    const reservations = this.reservations.get(ownerUserId) ?? new Set<Reservation>();
    const inFlight = (): number => [...reservations].reduce((sum, reservation) => sum + reservation.bytes, 0);
    if (usedBytes + inFlight() > limitBytes) {
      throw quotaExceeded(usedBytes + inFlight(), limitGB);
    }
    const reservation: Reservation = { bytes: 0 };
    reservations.add(reservation);
    this.reservations.set(ownerUserId, reservations);
    return {
      meter: async function* (stream) {
        for await (const chunk of stream) {
          reservation.bytes += chunk.byteLength;
          if (usedBytes + inFlight() > limitBytes) {
            throw quotaExceeded(usedBytes + inFlight() - reservation.bytes, limitGB);
          }
          yield chunk;
        }
      },
      release: () => {
        reservations.delete(reservation);
        if (reservations.size === 0 && this.reservations.get(ownerUserId) === reservations) {
          this.reservations.delete(ownerUserId);
        }
      },
    };
  }
}
