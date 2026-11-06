import { randomBytes } from "node:crypto";
import { beforeEach, describe, expect, it } from "vitest";
import { AesGcmSecretStore } from "../../../../src/server/adapters/secret-store/aes-gcm-secret-store.ts";
import type { SqliteConnection } from "../../../../src/server/adapters/sqlite/database.ts";
import { sqliteSecretEnvelopeStore } from "../../../../src/server/adapters/sqlite/repositories/secret-envelopes.ts";
import { isAmberError } from "../../../../src/server/domain/errors.ts";
import type { SecretEnvelopeStore } from "../../../../src/server/ports/secret-store.ts";
import { insertRow, openTempDatabase } from "../../../tools/sqlite.ts";

/** Placeholder credential; not a real key. */
const PLACEHOLDER = "<placeholder-llm-key>-0123456789abcdef";
const T0 = 1_790_000_000_000;

let db: SqliteConnection;
let envelopes: SecretEnvelopeStore;
let key: Buffer;
const withKey = (masterKey: Uint8Array | undefined) => new AesGcmSecretStore({ masterKey, envelopes, now: () => T0 });
const store = () => withKey(key);

function codeOf(work: () => unknown): string | undefined {
  try {
    work();
  } catch (error) {
    return isAmberError(error) ? error.appError.code : `non-AmberError: ${String(error)}`;
  }
  return undefined;
}

beforeEach(() => {
  db = openTempDatabase().db;
  envelopes = sqliteSecretEnvelopeStore(db);
  key = randomBytes(32);
  for (const id of ["alice", "bob"]) insertRow(db, "user", { id, role: "user", status: "active", created_at: T0 });
});

describe("round trip and stored form", () => {
  it("reads back what was stored, and the secret table holds no plaintext substring", () => {
    const secrets = store();
    const ref = secrets.store("alice", PLACEHOLDER);
    expect(secrets.reveal("alice", ref)).toBe(PLACEHOLDER);

    const rows = db.prepare("SELECT * FROM secret").all() as Array<Record<string, unknown>>;
    expect(rows).toHaveLength(1);
    const dump = rows
      .flatMap((row) => Object.values(row))
      .map((value) => (Buffer.isBuffer(value) ? value.toString("latin1") + value.toString("utf8") : String(value)))
      .join("\n");
    for (const needle of [PLACEHOLDER, "placeholder-llm-key", "0123456789abcdef"]) {
      expect(dump.includes(needle), needle).toBe(false);
    }
    expect(rows[0]).toMatchObject({ id: ref, user_id: "alice", envelope_version: 1 });
    expect((rows[0]?.["kdf_salt"] as Buffer).length).toBe(16);
    expect((rows[0]?.["nonce"] as Buffer).length).toBe(12);
    expect((rows[0]?.["auth_tag"] as Buffer).length).toBe(16);
  });

  it("uses a fresh salt and nonce for every write, even for equal plaintexts", () => {
    const secrets = store();
    const first = envelopes.get("alice", secrets.store("alice", PLACEHOLDER));
    const second = envelopes.get("alice", secrets.store("alice", PLACEHOLDER));
    expect(Buffer.from(first?.kdfSalt ?? []).equals(Buffer.from(second?.kdfSalt ?? []))).toBe(false);
    expect(Buffer.from(first?.nonce ?? []).equals(Buffer.from(second?.nonce ?? []))).toBe(false);
    expect(Buffer.from(first?.ciphertext ?? []).equals(Buffer.from(second?.ciphertext ?? []))).toBe(false);
  });
});

describe("replace and remove", () => {
  it("replace keeps the credentialRef and re-encrypts in place", () => {
    const secrets = store();
    const ref = secrets.store("alice", PLACEHOLDER);
    const before = envelopes.get("alice", ref);
    secrets.replace("alice", ref, "<placeholder-second-key>");
    const after = envelopes.get("alice", ref);
    expect(secrets.reveal("alice", ref)).toBe("<placeholder-second-key>");
    expect(after?.createdAt).toBe(before?.createdAt);
    expect(Buffer.from(after?.nonce ?? []).equals(Buffer.from(before?.nonce ?? []))).toBe(false);
    expect(db.prepare("SELECT count(*) AS n FROM secret").get()).toEqual({ n: 1 });
  });

  it("remove is idempotent and works without a master key", () => {
    const ref = store().store("alice", PLACEHOLDER);
    const keyless = withKey(undefined);
    keyless.remove("alice", ref);
    keyless.remove("alice", ref);
    expect(keyless.status("alice", ref)).toBe("missing");
  });
});

describe("owner binding", () => {
  it("never resolves another user's reference", () => {
    const secrets = store();
    const ref = secrets.store("alice", PLACEHOLDER);
    expect(codeOf(() => secrets.reveal("bob", ref))).toBe("not_found");
    expect(codeOf(() => secrets.replace("bob", ref, "x"))).toBe("not_found");
    expect(secrets.status("bob", ref)).toBe("missing");
    secrets.remove("bob", ref);
    expect(secrets.reveal("alice", ref)).toBe(PLACEHOLDER);
  });

  it("fails authentication when a ciphertext is moved onto another owner's row", () => {
    const secrets = store();
    const ref = secrets.store("alice", PLACEHOLDER);
    db.prepare("UPDATE secret SET user_id = 'bob' WHERE id = ?").run(ref);
    expect(secrets.status("bob", ref)).toBe("unavailable");
    expect(codeOf(() => secrets.reveal("bob", ref))).toBe("internal.secret_unavailable");
  });
});

describe("credentialStatus", () => {
  it("is missing without a reference or envelope, configured when decryptable", () => {
    const secrets = store();
    expect(secrets.status("alice", undefined)).toBe("missing");
    expect(secrets.status("alice", "01J00000000000000000000000")).toBe("missing");
    expect(secrets.status("alice", secrets.store("alice", PLACEHOLDER))).toBe("configured");
  });

  it("is unavailable when the master key is absent or different, and nothing is silently re-keyed", () => {
    const ref = store().store("alice", PLACEHOLDER);
    const before = db.prepare("SELECT * FROM secret").all();
    for (const other of [withKey(undefined), withKey(randomBytes(32))]) {
      expect(other.status("alice", ref)).toBe("unavailable");
      expect(codeOf(() => other.reveal("alice", ref))).toBe("internal.secret_unavailable");
    }
    expect(codeOf(() => withKey(undefined).store("alice", PLACEHOLDER))).toBe("internal.secret_unavailable");
    expect(db.prepare("SELECT * FROM secret").all()).toEqual(before);
  });

  it("rejects a master key of the wrong length", () => {
    expect(() => withKey(randomBytes(16))).toThrow(/32 bytes/);
  });
});

describe("replacing the master key in place", () => {
  it("seals and opens with the new key; envelopes of the old key become unavailable", () => {
    const secrets = store();
    const old = secrets.store("alice", PLACEHOLDER);
    const next = randomBytes(32);
    secrets.replaceMasterKey(next);
    expect(secrets.status("alice", old)).toBe("unavailable");
    const fresh = secrets.store("alice", PLACEHOLDER);
    expect(withKey(next).reveal("alice", fresh)).toBe(PLACEHOLDER);
    expect(() => secrets.replaceMasterKey(randomBytes(16))).toThrow(TypeError);
  });
});

describe("deleteAll", () => {
  it("removes every envelope of every owner", () => {
    const secrets = store();
    secrets.store("alice", PLACEHOLDER);
    secrets.store("bob", PLACEHOLDER);
    expect(envelopes.deleteAll()).toBe(2);
    expect(envelopes.anyExists()).toBe(false);
  });
});

describe("credential versions", () => {
  const versionOf = (ref: string) => {
    const row = db.prepare("SELECT version_id, version_set_at FROM secret WHERE id = ?").get(ref) as { version_id: string; version_set_at: number };
    return { versionId: row.version_id, setAt: row.version_set_at };
  };

  it("gives every stored secret its own ULID version, set when it was stored", () => {
    const secrets = store();
    const first = secrets.store("alice", PLACEHOLDER);
    const second = secrets.store("alice", PLACEHOLDER);
    expect(versionOf(first).versionId).toMatch(/^[0-9A-HJKMNP-TV-Z]{26}$/);
    expect(versionOf(first).versionId).not.toBe(versionOf(second).versionId);
    expect(versionOf(first).setAt).toBe(T0);
  });

  it("reveals the plaintext together with the version it belongs to", () => {
    const secrets = store();
    const ref = secrets.store("alice", PLACEHOLDER);
    expect(secrets.revealVersioned("alice", ref)).toEqual({ plaintext: PLACEHOLDER, version: versionOf(ref) });
    expect(secrets.reveal("alice", ref)).toBe(PLACEHOLDER);
    expect(codeOf(() => secrets.revealVersioned("bob", ref))).toBe("not_found");
    expect(codeOf(() => withKey(randomBytes(32)).revealVersioned("alice", ref))).toBe("internal.secret_unavailable");
  });

  it("keeps the version when a secret is replaced with the same plaintext, even though the ciphertext is rewritten", () => {
    let clock = T0;
    const secrets = new AesGcmSecretStore({ masterKey: key, envelopes, now: () => (clock += 1_000) });
    const ref = secrets.store("alice", PLACEHOLDER);
    const before = { version: versionOf(ref), ciphertext: envelopes.get("alice", ref)?.ciphertext, nonce: envelopes.get("alice", ref)?.nonce };
    secrets.replace("alice", ref, PLACEHOLDER);
    const after = envelopes.get("alice", ref);
    expect(versionOf(ref)).toEqual(before.version);
    expect(Buffer.compare(after?.nonce as Uint8Array, before.nonce as Uint8Array)).not.toBe(0);
    expect(after?.updatedAt).toBeGreaterThan(before.version.setAt);
    expect(secrets.revealVersioned("alice", ref).version).toEqual(before.version);
  });

  it("starts a new version when the plaintext differs, however small the difference", () => {
    let clock = T0;
    const secrets = new AesGcmSecretStore({ masterKey: key, envelopes, now: () => (clock += 1_000) });
    const ref = secrets.store("alice", PLACEHOLDER);
    const first = versionOf(ref);
    secrets.replace("alice", ref, `${PLACEHOLDER} `);
    const second = versionOf(ref);
    expect(second.versionId).not.toBe(first.versionId);
    expect(second.setAt).toBeGreaterThan(first.setAt);
    secrets.replace("alice", ref, `${PLACEHOLDER} `.slice(0, -1));
    expect(versionOf(ref).versionId).not.toBe(second.versionId);
    // Multi-byte text is compared as UTF-8, not as UTF-16 units.
    secrets.replace("alice", ref, "密钥甲");
    const chinese = versionOf(ref);
    secrets.replace("alice", ref, "密钥甲");
    expect(versionOf(ref)).toEqual(chinese);
    secrets.replace("alice", ref, "密钥乙");
    expect(versionOf(ref).versionId).not.toBe(chinese.versionId);
  });

  it("starts a new version when the old value cannot be decrypted, even for the same plaintext", () => {
    const ref = store().store("alice", PLACEHOLDER);
    const before = versionOf(ref);
    const rotated = withKey(randomBytes(32));
    rotated.replace("alice", ref, PLACEHOLDER);
    expect(versionOf(ref).versionId).not.toBe(before.versionId);
    expect(rotated.reveal("alice", ref)).toBe(PLACEHOLDER);
  });

  it("leaves versions untouched when the master key is switched, and a secret stored afterwards has a new one", () => {
    const secrets = store();
    const ref = secrets.store("alice", PLACEHOLDER);
    const before = versionOf(ref);
    secrets.replaceMasterKey(randomBytes(32));
    expect(versionOf(ref)).toEqual(before);
    const fresh = secrets.store("alice", PLACEHOLDER);
    expect(versionOf(fresh).versionId).not.toBe(before.versionId);
  });

  it("round-trips the version columns through the envelope store and refuses a row without them", () => {
    const ref = store().store("alice", PLACEHOLDER);
    const envelope = envelopes.get("alice", ref);
    expect(envelope).toMatchObject({ versionSetAt: T0, versionId: versionOf(ref).versionId });
    envelopes.update({ ...(envelope as NonNullable<typeof envelope>), versionId: "version-x", versionSetAt: 42 });
    expect(versionOf(ref)).toEqual({ versionId: "version-x", setAt: 42 });
    db.prepare("UPDATE secret SET version_id = NULL WHERE id = ?").run(ref);
    expect(() => envelopes.get("alice", ref)).toThrow(/no credential version/);
  });
});
