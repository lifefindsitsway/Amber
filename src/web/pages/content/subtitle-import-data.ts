import { useCallback, useEffect, useState } from "react";
import type { FileGrant } from "../../../shared/dto/local-media.ts";
import { subtitleInspectResponseSchema, type SubtitleInspectResponse } from "../../../shared/dto/subtitle-import.ts";
import type { AppError } from "../../../shared/errors.ts";
import { useApi } from "../../api/context.tsx";
import { appErrorOf } from "../../components/confirm-dialog.tsx";

/**
 * What a preview reads: a file the browser holds (its text is sent), or, in the desktop client,
 * a file the user picked through the shell (the sidecar reads it under its grant). `contentId`
 * names the Content an import would go into, which adds its state to the answer.
 */
export type SubtitlePreviewSource =
  | { kind: "text"; file: File; contentId?: string }
  | { kind: "local"; path: string; grant: FileGrant; contentId?: string };

export type SubtitlePreviewState =
  | { status: "idle" }
  | { status: "loading" }
  | { status: "ready"; preview: SubtitleInspectResponse; text?: string }
  | { status: "failed"; error: AppError };

/**
 * Previews `source` once per source (pass the same object while the file is the same) and again
 * on `refresh`. A newer source or an unmount drops a pending answer. A browser file's text is
 * kept with the answer, so the import sends exactly the text that was previewed.
 */
export function useSubtitlePreview(source: SubtitlePreviewSource | undefined): SubtitlePreviewState & { refresh: () => void } {
  const client = useApi();
  const [state, setState] = useState<SubtitlePreviewState>({ status: "idle" });
  const [round, setRound] = useState(0);
  const refresh = useCallback(() => setRound((value) => value + 1), []);

  useEffect(() => {
    if (source === undefined) {
      setState({ status: "idle" });
      return;
    }
    const controller = new AbortController();
    setState({ status: "loading" });
    const contentId = source.contentId === undefined ? {} : { contentId: source.contentId };
    const run = async (): Promise<SubtitlePreviewState> => {
      if (source.kind === "local") {
        const preview = await client.post("/api/subtitles/inspect-local", subtitleInspectResponseSchema, {
          body: { path: source.path, grant: source.grant, ...contentId },
          signal: controller.signal,
        });
        return { status: "ready", preview };
      }
      const text = await source.file.text();
      const preview = await client.post("/api/subtitles/inspect", subtitleInspectResponseSchema, {
        body: { text, filename: source.file.name, ...contentId },
        signal: controller.signal,
      });
      return { status: "ready", preview, text };
    };
    run().then(
      (next) => {
        if (!controller.signal.aborted) setState(next);
      },
      (caught: unknown) => {
        if (!controller.signal.aborted) setState({ status: "failed", error: appErrorOf(caught) });
      },
    );
    return () => controller.abort();
  }, [client, source, round]);

  return { ...state, refresh };
}
