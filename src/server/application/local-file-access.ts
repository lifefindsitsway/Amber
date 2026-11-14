import { access, constants, stat } from "node:fs/promises";
import { isAbsolute } from "node:path";
import type { FileGrant } from "../../shared/dto/local-media.ts";
import { AmberError, amberError } from "../domain/errors.ts";
import type { FileGrantVerifier } from "../ports/file-grant.ts";

/** A local path is read only under the grant the shell's file dialog issued for exactly that path. */
export function verifyFileGrant(grants: FileGrantVerifier, grant: FileGrant, path: string): void {
  if (!grants.verify(grant, { path, purpose: "local_file" })) {
    throw amberError("unauthenticated", "file grant is missing, forged or expired", { code: "unauthenticated.file_grant" });
  }
}

/** Size of an existing, readable regular file at an absolute path; anything else is `invalid_request` on `detail`. */
export async function readableFileSize(path: string, detail: string): Promise<number> {
  const invalid = (message: string): AmberError => amberError("invalid_request", message, { params: { detail } });
  if (!isAbsolute(path)) {
    throw invalid("path is not absolute");
  }
  try {
    const stats = await stat(path);
    if (!stats.isFile()) {
      throw invalid("path is not a regular file");
    }
    await access(path, constants.R_OK);
    return stats.size;
  } catch (error) {
    if (error instanceof AmberError) {
      throw error;
    }
    throw invalid("path does not name a readable file");
  }
}
