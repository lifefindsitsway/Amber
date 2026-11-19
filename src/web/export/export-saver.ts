import type { ExportedFile } from "../api/client.ts";
import { isDesktop } from "../desktop/bridge.ts";

/**
 * Where an exported file goes. Every export action saves through this one
 * seam, so a native save dialog can replace the browser download here without any
 * business component knowing which one ran.
 */
export interface ExportSaver {
  /** The name the file was saved under, for the confirmation; `undefined` when the user cancelled. */
  save(file: ExportedFile): Promise<string | undefined>;
}

/** The browser download: an object URL behind a transient `<a download>`. */
export const browserDownloadSaver: ExportSaver = {
  async save(file) {
    const url = URL.createObjectURL(file.blob);
    try {
      const anchor = document.createElement("a");
      anchor.href = url;
      anchor.download = file.filename;
      anchor.rel = "noopener";
      document.body.append(anchor);
      anchor.click();
      anchor.remove();
      return file.filename;
    } finally {
      // Revoked after the click has been dispatched; the download keeps its own reference.
      setTimeout(() => URL.revokeObjectURL(url), 0);
    }
  },
};

/** The extension of a file name, lower-cased and without the dot, if it has one. */
function extensionOf(filename: string): string | undefined {
  const dot = filename.lastIndexOf(".");
  return dot <= 0 || dot === filename.length - 1 ? undefined : filename.slice(dot + 1).toLowerCase();
}

/**
 * The desktop client's native save dialog: the chosen path joins the fs
 * scope for this write only. Cancelling the dialog is not an error.
 */
export const tauriDialogSaver: ExportSaver = {
  async save(file) {
    const { save } = await import("@tauri-apps/plugin-dialog");
    const extension = extensionOf(file.filename);
    const path = await save({
      defaultPath: file.filename,
      ...(extension === undefined ? {} : { filters: [{ name: extension.toUpperCase(), extensions: [extension] }] }),
    });
    if (path === null) {
      return undefined;
    }
    const { writeFile } = await import("@tauri-apps/plugin-fs");
    await writeFile(path, new Uint8Array(await file.blob.arrayBuffer()));
    // The user may have renamed it in the dialog; the confirmation names what is on disk.
    return path.split(/[\\/]/).at(-1) || file.filename;
  },
};

/** Picks the native dialog inside the desktop client and the browser download elsewhere. */
export function exportSaver(): ExportSaver {
  return {
    async save(file) {
      const saver = (await isDesktop()) ? tauriDialogSaver : browserDownloadSaver;
      return saver.save(file);
    },
  };
}
