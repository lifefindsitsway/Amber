import type { SecretEnvelope, SecretEnvelopeStore } from "../../../ports/secret-store.ts";
import type { SqliteConnection } from "../database.ts";

interface SecretRow {
  id: string;
  user_id: string;
  envelope_version: number;
  kdf_salt: Buffer;
  nonce: Buffer;
  ciphertext: Buffer;
  auth_tag: Buffer;
  version_id: string | null;
  version_set_at: number | null;
  created_at: number;
  updated_at: number;
}

const blob = (bytes: Uint8Array): Buffer => Buffer.from(bytes.buffer, bytes.byteOffset, bytes.byteLength);

/** Envelope rows of the `secret` table. Invariant: the table only ever holds ciphertext. */
export function sqliteSecretEnvelopeStore(db: SqliteConnection): SecretEnvelopeStore {
  const select = db.prepare("SELECT * FROM secret WHERE id = ? AND user_id = ?");
  const insert = db.prepare(
    `INSERT INTO secret (id, user_id, envelope_version, kdf_salt, nonce, ciphertext, auth_tag, version_id, version_set_at, created_at, updated_at)
     VALUES (@id, @userId, @envelopeVersion, @kdfSalt, @nonce, @ciphertext, @authTag, @versionId, @versionSetAt, @createdAt, @updatedAt)`,
  );
  const update = db.prepare(
    `UPDATE secret
     SET envelope_version = @envelopeVersion, kdf_salt = @kdfSalt, nonce = @nonce, ciphertext = @ciphertext,
         auth_tag = @authTag, version_id = @versionId, version_set_at = @versionSetAt, updated_at = @updatedAt
     WHERE id = @id AND user_id = @userId`,
  );
  const remove = db.prepare("DELETE FROM secret WHERE id = ? AND user_id = ?");
  const any = db.prepare("SELECT EXISTS (SELECT 1 FROM secret) AS present");
  const removeAll = db.prepare("DELETE FROM secret");

  const params = (envelope: SecretEnvelope) => ({
    id: envelope.id,
    userId: envelope.userId,
    envelopeVersion: envelope.envelopeVersion,
    kdfSalt: blob(envelope.kdfSalt),
    nonce: blob(envelope.nonce),
    ciphertext: blob(envelope.ciphertext),
    authTag: blob(envelope.authTag),
    versionId: envelope.versionId,
    versionSetAt: envelope.versionSetAt,
    createdAt: envelope.createdAt,
    updatedAt: envelope.updatedAt,
  });

  return {
    get(ownerUserId, id) {
      const row = select.get(id, ownerUserId) as SecretRow | undefined;
      if (row === undefined) {
        return undefined;
      }
      if (row.envelope_version !== 1) {
        throw new Error(`secret ${row.id} has unsupported envelope version ${row.envelope_version}`);
      }
      if (row.version_id === null || row.version_set_at === null) {
        throw new Error(`secret ${row.id} has no credential version`);
      }
      return {
        id: row.id,
        userId: row.user_id,
        envelopeVersion: 1,
        kdfSalt: row.kdf_salt,
        nonce: row.nonce,
        ciphertext: row.ciphertext,
        authTag: row.auth_tag,
        versionId: row.version_id,
        versionSetAt: row.version_set_at,
        createdAt: row.created_at,
        updatedAt: row.updated_at,
      };
    },
    insert(envelope) {
      insert.run(params(envelope));
    },
    update(envelope) {
      const { createdAt: _createdAt, ...rest } = params(envelope);
      return update.run(rest).changes > 0;
    },
    delete(ownerUserId, id) {
      return remove.run(id, ownerUserId).changes > 0;
    },
    anyExists() {
      return (any.get() as { present: number }).present === 1;
    },
    deleteAll() {
      return removeAll.run().changes;
    },
  };
}
