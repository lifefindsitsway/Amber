import { useMemo } from "react";
import { useTranslation } from "react-i18next";
import type { TranscriptRevisionListItemDto } from "../../../../../shared/dto/content.ts";
import { Button } from "../../../../ui/button.tsx";
import { useSegments } from "../../content-data.ts";
import { revisionLabel } from "../../labels.ts";
import { comparedSentences, comparisonCandidates, recognitionModel, useAttributionComparison } from "./comparison-data.ts";

const NO_OVERRIDES: ReadonlyMap<string, string | null> = new Map();

/**
 * The one-line cross-recognition summary of the speaker review panel: the reviewed revision
 * against the transcription the editor's comparison would pick first, with the automatic
 * correspondences, and a way to the editor to see the list. No paid action here: without
 * anything to compare with it only says so.
 */
export function ComparisonSummary(props: {
  /** The reviewed revision. */
  revisionId: string;
  revisions: readonly TranscriptRevisionListItemDto[];
  /** Opens the editor on the comparison; left out where the revision cannot be edited, which hides the button. */
  onOpenEditor?: (() => void) | undefined;
}) {
  const { t, i18n } = useTranslation();
  const other = useMemo(() => comparisonCandidates(props.revisions, props.revisionId)[0], [props.revisions, props.revisionId]);
  const own = useSegments(other === undefined ? undefined : props.revisionId);
  const theirs = useSegments(other?.id);
  const sentences = useMemo(() => (own.data === undefined ? undefined : comparedSentences(own.data)), [own.data]);
  const result = useAttributionComparison(sentences, theirs.data, NO_OVERRIDES);
  const counts = result?.comparison.counts;
  return (
    <div className="flex flex-wrap items-center gap-x-3 gap-y-1 text-xs" data-testid="comparison-summary">
      <p className="min-w-0 flex-1 text-muted">
        <span className="font-medium text-ink">{t("speakerCompare.title")}</span>
        <span className="mx-1.5" aria-hidden="true">
          ·
        </span>
        {other === undefined ? (
          t("speakerCompare.summary.none")
        ) : counts === undefined ? null : (
          <>
            <span data-testid="comparison-summary-line">{t("speakerCompare.summary.line", {
                // A recognition that recorded no model is named by its label, as the editor's comparison does.
                model: recognitionModel(other) ?? revisionLabel(other, undefined, t, i18n, props.revisions),
                ...counts,
              })}</span>
            {result?.comparison.unreliable === true ? <span className="ml-1.5 font-medium text-ink">{t("speakerCompare.summary.unreliable")}</span> : null}
          </>
        )}
      </p>
      {props.onOpenEditor === undefined ? null : (
        <Button size="sm" variant="ghost" onClick={props.onOpenEditor} data-testid="comparison-summary-open">
          {t("speakerCompare.summary.open")}
        </Button>
      )}
    </div>
  );
}
