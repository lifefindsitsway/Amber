import type { CredentialStatus } from "../../shared/enums.ts";

/**
 * Persisted form of one secret: AES-256-GCM ciphertext under a data key derived by
 * HKDF-SHA256 from the master key and `kdfSalt`, with AAD bound to owner and id. `id` is
 * the `credentialRef` of the one profile or account that holds it.
 */
export interface SecretEnvelope {
  id: string;
  userId: string;
  envelopeVersion: 1;
  /** 16 bytes. */
  kdfSalt: Uint8Array;
  /** 12 bytes, fresh on every write. */
  nonce: Uint8Array;
  ciphertext: Uint8Array;
  /** 16 bytes. */
  authTag: Uint8Array;
  /** Opaque identifier of the stored value; changes whenever the plaintext does. */
  versionId: string;
  /** When this version took effect. */
  versionSetAt: number;
  createdAt: number;
  updatedAt: number;
}

/**
 * Storage of envelopes. Invariant: every lookup is by `id` and owner together, so one
 * user's reference can never resolve another user's secret.
 */
export interface SecretEnvelopeStore {
  get(ownerUserId: string, id: string): SecretEnvelope | undefined;
  insert(envelope: SecretEnvelope): void;
  /** Rewrites salt, nonce, ciphertext, tag and `updatedAt` in place; false when absent. */
  update(envelope: SecretEnvelope): boolean;
  delete(ownerUserId: string, id: string): boolean;
  /** Instance-wide existence check; used only to decide the first-boot key bootstrap. */
  anyExists(): boolean;
  /**
   * Instance-wide, for "reset all credentials"; every reference to an
   * envelope must already be gone. Returns how many were deleted.
   */
  deleteAll(): number;
}

/**
 * Invariant: secrets are persisted only as ciphertext and are
 * referenced elsewhere by an opaque, exclusive `credentialRef`. Plaintext returned by
 * `reveal` lives only in the memory of the call that needs it: never logged, never put in
 * a URL, error message or DTO, and never copied further.
 *
 * Methods are synchronous so they compose with `Repository.withTransaction`: a profile
 * and its secret are written or removed in one transaction.
 */
export interface SecretStore {
  /** Encrypts and stores a new secret for its owner; returns the new `credentialRef`. */
  store(ownerUserId: string, plaintext: string): string;
  /** Throws `not_found` for an unknown reference and `internal.secret_unavailable` when it cannot be decrypted. */
  reveal(ownerUserId: string, credentialRef: string): string;
  /**
   * `reveal` together with the version of the value returned, read from one envelope. Versions
   * are opaque and only tell usage records apart by which stored value a request used; they
   * never promise that two versions are different physical keys or that equal ones are the same.
   */
  revealVersioned(ownerUserId: string, credentialRef: string): { plaintext: string; version: { versionId: string; setAt: number } };
  /**
   * Re-encrypts under the same `credentialRef` with a fresh salt and nonce. Keeps the version
   * when the new plaintext equals the old one (decided in memory, the old value is dropped at
   * once); otherwise, or when the old value cannot be decrypted, starts a new version.
   */
  replace(ownerUserId: string, credentialRef: string, plaintext: string): void;
  /** Idempotent. Works without a usable master key, so credentials can always be reset. */
  remove(ownerUserId: string, credentialRef: string): void;
  /**
   * What DTOs may say about a credential: `missing` without a reference or envelope,
   * `unavailable` when the current master key cannot decrypt it, else `configured`.
   */
  status(ownerUserId: string, credentialRef: string | undefined): CredentialStatus;
}
