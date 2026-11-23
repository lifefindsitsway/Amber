import { useEffect, useRef } from "react";
import { useTranslation } from "react-i18next";
import { useSearchParams } from "react-router";
import { FOCUS_RING } from "../../ui/button.tsx";
import { CONTENT_TABS, parseTab, type ContentTab } from "./content-context.tsx";
import { HighlightsTab } from "./highlights-tab.tsx";
import { SubtitlesTab } from "./subtitles-tab.tsx";
import { SummaryTab } from "./summary-tab.tsx";
import { TranscriptTab } from "./transcript-tab.tsx";
import { TranslationTab } from "./translation-tab.tsx";

/**
 * The outputs column: one row of tabs over the selected output.
 * The tab lives only in the URL; switching only changes what is read, never calls a model.
 */
export function OutputTabs() {
  const { t } = useTranslation();
  const [params, setParams] = useSearchParams();
  const tab = parseTab(params.get("tab"));
  const selected = useRef<HTMLButtonElement>(null);
  // The row scrolls sideways when the column is narrow; a deep link or a
  // programmatic switch must not leave the current tab out of view.
  useEffect(() => {
    const button = selected.current;
    if (button !== null && typeof button.scrollIntoView === "function") {
      button.scrollIntoView({ inline: "nearest", block: "nearest" });
    }
  }, [tab]);
  const open = (next: ContentTab): void => {
    const search = new URLSearchParams(params);
    search.set("tab", next);
    setParams(search, { replace: true });
  };
  return (
    <div className="flex h-full min-h-0 flex-col">
      <div className="flex gap-1 overflow-x-auto border-b border-line px-3 pt-2" role="tablist" aria-label={t("contentView.layout.outputs")}>
        {CONTENT_TABS.map((item) => (
          <button
            key={item}
            ref={item === tab ? selected : undefined}
            type="button"
            role="tab"
            aria-selected={item === tab}
            data-testid={`output-tab-${item}`}
            className={`shrink-0 whitespace-nowrap rounded-t-md px-3 py-1.5 text-sm transition-colors duration-150 motion-reduce:transition-none ${FOCUS_RING} ${item === tab ? "border-b-2 border-accent font-medium" : "text-muted hover:text-ink"}`}
            onClick={() => open(item)}
          >
            {t(`contentView.tab.${item}`)}
          </button>
        ))}
      </div>
      <div className="min-h-0 flex-1 overflow-auto" role="tabpanel">
        <TabBody tab={tab} />
      </div>
    </div>
  );
}

function TabBody(props: { tab: ContentTab }) {
  switch (props.tab) {
    case "summary":
      return <SummaryTab />;
    case "transcript":
      return <TranscriptTab />;
    case "subtitles":
      return <SubtitlesTab />;
    case "translation":
      return <TranslationTab />;
    case "ai-highlights":
      return <HighlightsTab />;
  }
}
