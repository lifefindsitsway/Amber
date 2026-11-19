import { FileUp, Mic } from "lucide-react";
import { useTranslation } from "react-i18next";
import { useSearchParams } from "react-router";
import type { ContentProcessingStatus } from "../../../shared/enums.ts";
import { Button } from "../../ui/button.tsx";
import { EmptyState } from "../../ui/feedback.tsx";
import { useContentPage } from "./content-context.tsx";

/** Statuses of a processing task that may still bring a transcript by itself. */
const PENDING: ReadonlySet<ContentProcessingStatus> = new Set(["queued", "running", "waiting"]);

/** What the empty reading view says: wait for the processing, or do something about it. */
export function transcriptEmptyHint(status: ContentProcessingStatus): "emptyHintPending" | "emptyHintIdle" {
  return PENDING.has(status) ? "emptyHintPending" : "emptyHintIdle";
}

/**
 * The reading view of a Content without a transcript. While a processing task may still
 * bring one it says so; otherwise (a finished or failed processing, a Content imported from
 * a content pack without a transcript) it offers the two existing ways to get one, which
 * both live on the 「字幕」 tab: transcription and subtitle import. `subtitleAction` tells
 * that tab which of the two the user came for.
 */
export function TranscriptEmptyState() {
  const { t } = useTranslation();
  const { content } = useContentPage();
  const [params, setParams] = useSearchParams();
  const hint = transcriptEmptyHint(content.processingStatus);
  const open = (action: "transcribe" | "import"): void => {
    const next = new URLSearchParams(params);
    next.set("tab", "subtitles");
    next.set("subtitleAction", action);
    setParams(next, { replace: true });
  };
  return (
    <EmptyState title={t("contentView.transcript.empty")} hint={t(`contentView.transcript.${hint}`)}>
      {hint === "emptyHintIdle" ? (
        <div className="mt-1 flex flex-wrap justify-center gap-2" data-testid="transcript-empty-actions">
          <Button size="sm" onClick={() => open("transcribe")} data-testid="transcript-empty-transcribe">
            <Mic size={14} aria-hidden="true" />
            {t("contentView.transcript.emptyTranscribe")}
          </Button>
          <Button size="sm" onClick={() => open("import")} data-testid="transcript-empty-import">
            <FileUp size={14} aria-hidden="true" />
            {t("contentView.transcript.emptyImportSubtitle")}
          </Button>
        </div>
      ) : null}
    </EmptyState>
  );
}
