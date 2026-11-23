import { useTranslation } from "react-i18next";
import { Link } from "react-router";
import { formatDuration } from "../format.ts";
import { useFigureHitLabel } from "./figure-hit.tsx";
import { Highlighted } from "./highlighted.tsx";
import { BasisChangedMark, HitSpeaker } from "./hit-speaker.tsx";
import { hitLink, summaryBasisChanged, type ContentSideHit } from "./search.ts";

/** One highlighted excerpt under a listed Content; it opens the sentence, summary or figure it came from. */
export function HitSnippet(props: { entry: ContentSideHit; query: string }) {
  const { t } = useTranslation();
  const figureLabel = useFigureHitLabel();
  const { entry } = props;
  const label = ((): string => {
    switch (entry.kind) {
      case "segment":
        return formatDuration(entry.hit.startMs);
      case "summary":
        return t("search.kind.summary");
      case "figure":
        return figureLabel(entry.hit);
      case "content":
        return t(`search.kind.${entry.hit.matchedIn}`);
    }
  })();
  return (
    <Link to={hitLink(entry, props.query)} className="mt-1 flex gap-2 text-xs text-muted hover:text-ink" data-testid="search-snippet">
      <span className="shrink-0 font-mono text-link">{label}</span>
      {entry.kind === "segment" && entry.hit.speaker !== undefined ? <HitSpeaker contentId={entry.hit.contentId} speaker={entry.hit.speaker} className="shrink-0" /> : null}
      <Highlighted text={entry.hit.snippet} ranges={entry.hit.ranges} className="line-clamp-2" />
      {entry.kind === "summary" && summaryBasisChanged(entry.hit) ? <BasisChangedMark /> : null}
    </Link>
  );
}
