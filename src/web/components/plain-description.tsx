import { useLayoutEffect, useMemo, useRef, useState } from "react";
import { useTranslation } from "react-i18next";
import { linkify } from "../linkify.ts";

/**
 * A platform's own description of a video, shown under the title as an extension of it:
 * untrusted plain text, its line breaks kept, http(s) URLs as links. Collapsed it is clipped
 * at three lines and offers to expand only when it actually overflows; expanded it scrolls
 * within a capped height so a 10 000-character description never pushes the page away.
 *
 * Links appear only when nothing is clipped: a link hidden behind the clamp would still take
 * keyboard focus. Links are ordinary `target="_blank"` anchors, which the desktop client's
 * global click handler hands to the system browser.
 */
export function PlainDescription(props: { text: string; truncated: boolean; maxChars: number; className?: string }) {
  const { t } = useTranslation();
  const { text, truncated, maxChars, className } = props;
  const [expanded, setExpanded] = useState(false);
  const [overflowing, setOverflowing] = useState(false);
  const [scrollable, setScrollable] = useState(false);
  const wrapperRef = useRef<HTMLDivElement>(null);
  const scrollRef = useRef<HTMLDivElement>(null);
  const textRef = useRef<HTMLDivElement>(null);
  const parts = useMemo(() => linkify(text), [text]);
  const showLinks = expanded || !overflowing;

  // Measured before paint so the toggle and the plain-text fallback never flash; re-measured
  // whenever the width changes, since the same text clips at three lines only when narrow.
  useLayoutEffect(() => {
    const wrapper = wrapperRef.current;
    if (wrapper === null) return undefined;
    const measure = (): void => {
      const target = expanded ? scrollRef.current : textRef.current;
      if (target === null) return;
      const exceeds = target.scrollHeight > target.clientHeight;
      if (expanded) setScrollable(exceeds);
      else setOverflowing(exceeds);
    };
    measure();
    if (typeof ResizeObserver === "undefined") return undefined;
    const observer = new ResizeObserver(measure);
    observer.observe(wrapper);
    return () => observer.disconnect();
  }, [expanded, text, truncated]);

  if (text === "") return null;
  const regionProps = expanded && scrollable ? { tabIndex: 0, role: "region", "aria-label": t("contentView.description.label") } : {};
  return (
    <div ref={wrapperRef} className={["max-w-[70ch] text-sm text-muted", className].filter(Boolean).join(" ")} data-testid="content-description">
      <div
        ref={scrollRef}
        className={expanded ? "max-h-[clamp(7.5rem,30vh,20rem)] overflow-y-auto rounded-sm outline-none focus-visible:ring-2 focus-visible:ring-accent" : undefined}
        {...regionProps}
      >
        <div
          ref={textRef}
          className={`whitespace-pre-wrap wrap-anywhere [unicode-bidi:plaintext] ${expanded ? "" : "line-clamp-3"}`}
          data-testid="content-description-text"
        >
          {showLinks
            ? parts.map((part, index) =>
                part.kind === "link" ? (
                  <a key={index} href={part.href} target="_blank" rel="noopener noreferrer" className="text-accent hover:underline">
                    {part.text}
                  </a>
                ) : (
                  part.text
                ),
              )
            : text}
        </div>
        {expanded && truncated ? (
          <p className="mt-1 text-xs" data-testid="content-description-truncated">
            {t("contentView.description.truncated", { count: maxChars })}
          </p>
        ) : null}
      </div>
      {expanded || overflowing ? (
        <button
          type="button"
          className="mt-0.5 rounded text-xs text-accent outline-none hover:underline focus-visible:ring-2 focus-visible:ring-accent"
          aria-expanded={expanded}
          onClick={() => setExpanded((value) => !value)}
          data-testid="content-description-toggle"
        >
          {t(expanded ? "contentView.description.collapse" : "contentView.description.expand")}
        </button>
      ) : null}
    </div>
  );
}
