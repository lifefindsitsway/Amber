import { createCipheriv, createDecipheriv, hkdfSync, randomBytes, timingSafeEqual } from "node:crypto";
import { ulid } from "ulid";
import type { CredentialStatus } from "../../../shared/enums.ts";
import { amberError, type AmberError } from "../../domain/errors.ts";
import type { SecretEnvelope, SecretEnvelopeStore, SecretStore } from "../../ports/secret-store.ts";
import { MASTER_KEY_BYTES } from "./master-key.ts";

/** Envelope v1 parameters. */
const HKDF_INFO = "amber/secret-store/aes-256-gcm/v1";
const AAD_DOMAIN = "amber-secret-v1";
const SALT_BYTES = 16;
const NONCE_BYTES = 12;
const TAG_BYTES = 16;
const DATA_KEY_BYTES = 32;

export interface AesGcmSecretStoreOptions {
  /** Absent when no master key is available: stored secrets then report `unavailable`. */
  masterKey: Uint8Array | undefined;
  envelopes: SecretEnvelopeStore;
  now?: () => number;
  newId?: () => string;
  /** Source of credential version identifiers; ULIDs by default. */
  newVersionId?: () => string;
}

/**
 * The AAD binds an envelope to its owner and id, so a ciphertext copied onto another row
 * or another user fails authentication instead of decrypting.
 */
function aad(userId: string, id: string): Buffer {
  return Buffer.from(JSON.stringify([AAD_DOMAIN, userId, id]), "utf8");
}

function unavailable(): AmberError {
  return amberError("internal", "secret cannot be decrypted with the current master key", {
    code: "internal.secret_unavailable",
  });
}

/**
 * SecretStore over AES-256-GCM envelopes. Each write draws a fresh 16-byte salt and a
 * fresh 12-byte nonce, and the data key is derived per envelope with HKDF-SHA256, so a
 * nonce is never reused under the same key.
 */
export class AesGcmSecretStore implements SecretStore {
  private masterKey: Buffer | undefined;
  private readonly envelopes: SecretEnvelopeStore;
  private readonly now: () => number;
  private readonly newId: () => string;
  private readonly newVersionId: () => string;

  constructor(options: AesGcmSecretStoreOptions) {
    if (options.masterKey !== undefined && options.masterKey.length !== MASTER_KEY_BYTES) {
      throw new TypeError(`master key must be ${MASTER_KEY_BYTES} bytes`);
    }
    this.masterKey = options.masterKey === undefined ? undefined : Buffer.from(options.masterKey);
    this.envelopes = options.envelopes;
    this.now = options.now ?? Date.now;
    this.newId = options.newId ?? ulid;
    this.newVersionId = options.newVersionId ?? ulid;
  }

  /**
   * Switches to a new master key in place. Only valid once no envelope sealed under the
   * old key remains, i.e. right after every credential was reset.
   */
  replaceMasterKey(masterKey: Uint8Array): void {
    if (masterKey.length !== MASTER_KEY_BYTES) {
      throw new TypeError(`master key must be ${MASTER_KEY_BYTES} bytes`);
    }
    this.masterKey?.fill(0);
    this.masterKey = Buffer.from(masterKey);
  }

  store(ownerUserId: string, plaintext: string): string {
    const id = this.newId();
    const at = this.now();
    this.envelopes.insert({
      ...this.seal(ownerUserId, id, plaintext),
      versionId: this.newVersionId(),
      versionSetAt: at,
      createdAt: at,
      updatedAt: at,
    });
    return id;
  }

  reveal(ownerUserId: string, credentialRef: string): string {
    const envelope = this.envelopes.get(ownerUserId, credentialRef);
    if (envelope === undefined) {
      throw amberError("not_found", `secret ${credentialRef} not found for this owner`);
    }
    const plaintext = this.open(envelope);
    if (plaintext === undefined) {
      throw unavailable();
    }
    return plaintext.toString("utf8");
  }

  revealVersioned(ownerUserId: string, credentialRef: string): { plaintext: string; version: { versionId: string; setAt: number } } {
    const envelope = this.envelopes.get(ownerUserId, credentialRef);
    if (envelope === undefined) {
      throw amberError("not_found", `secret ${credentialRef} not found for this owner`);
    }
    const plaintext = this.open(envelope);
    if (plaintext === undefined) {
      throw unavailable();
    }
    return { plaintext: plaintext.toString("utf8"), version: { versionId: envelope.versionId, setAt: envelope.versionSetAt } };
  }

  /**
   * Re-sealing the value that is already stored keeps its version, so saving a form
   * unchanged does not split a credential's usage history. The old value is decrypted only
   * to compare and is wiped right after; a value that cannot be decrypted (another master
   * key) cannot be shown equal, so the new one starts a new version.
   */
  replace(ownerUserId: string, credentialRef: string, plaintext: string): void {
    const existing = this.envelopes.get(ownerUserId, credentialRef);
    if (existing === undefined) {
      throw amberError("not_found", `secret ${credentialRef} not found for this owner`);
    }
    const at = this.now();
    const unchanged = this.sameValue(existing, plaintext);
    const sealed = this.seal(ownerUserId, credentialRef, plaintext);
    this.envelopes.update({
      ...sealed,
      versionId: unchanged ? existing.versionId : this.newVersionId(),
      versionSetAt: unchanged ? existing.versionSetAt : at,
      createdAt: existing.createdAt,
      updatedAt: at,
    });
  }

  remove(ownerUserId: string, credentialRef: string): void {
    this.envelopes.delete(ownerUserId, credentialRef);
  }

  status(ownerUserId: string, credentialRef: string | undefined): CredentialStatus {
    if (credentialRef === undefined) {
      return "missing";
    }
    const envelope = this.envelopes.get(ownerUserId, credentialRef);
    if (envelope === undefined) {
      return "missing";
    }
    const plaintext = this.open(envelope);
    if (plaintext === undefined) {
      return "unavailable";
    }
    plaintext.fill(0);
    return "configured";
  }

  /** Whether the stored value decrypts to exactly `plaintext`; both buffers are wiped before returning. */
  private sameValue(envelope: SecretEnvelope, plaintext: string): boolean {
    const current = this.open(envelope);
    if (current === undefined) {
      return false;
    }
    const next = Buffer.from(plaintext, "utf8");
    try {
      return current.length === next.length && timingSafeEqual(current, next);
    } finally {
      current.fill(0);
      next.fill(0);
    }
  }

  private requireKey(): Buffer {
    if (this.masterKey === undefined) {
      throw unavailable();
    }
    return this.masterKey;
  }

  private dataKey(salt: Uint8Array): Buffer {
    return Buffer.from(hkdfSync("sha256", this.requireKey(), salt, HKDF_INFO, DATA_KEY_BYTES));
  }

  private seal(userId: string, id: string, plaintext: string): Omit<SecretEnvelope, "versionId" | "versionSetAt" | "createdAt" | "updatedAt"> {
    const kdfSalt = randomBytes(SALT_BYTES);
    const nonce = randomBytes(NONCE_BYTES);
    const cipher = createCipheriv("aes-256-gcm", this.dataKey(kdfSalt), nonce, { authTagLength: TAG_BYTES });
    cipher.setAAD(aad(userId, id));
    const ciphertext = Buffer.concat([cipher.update(plaintext, "utf8"), cipher.final()]);
    return { id, userId, envelopeVersion: 1, kdfSalt, nonce, ciphertext, authTag: cipher.getAuthTag() };
  }

  /** Plaintext bytes, or `undefined` when there is no key or authentication fails. */
  private open(envelope: SecretEnvelope): Buffer | undefined {
    if (this.masterKey === undefined) {
      return undefined;
    }
    try {
      const decipher = createDecipheriv("aes-256-gcm", this.dataKey(envelope.kdfSalt), envelope.nonce, {
        authTagLength: TAG_BYTES,
      });
      decipher.setAAD(aad(envelope.userId, envelope.id));
      decipher.setAuthTag(envelope.authTag);
      return Buffer.concat([decipher.update(envelope.ciphertext), decipher.final()]);
    } catch {
      return undefined;
    }
  }
}
