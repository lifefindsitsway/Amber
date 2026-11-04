import { useEffect, useState, useSyncExternalStore, type FocusEvent, type KeyboardEvent } from "react";
import { useTranslation } from "react-i18next";
import { PLAYBACK_RESUME_NOTICE_MS } from "../../shared/defaults.ts";
import { formatDuration } from "../format.ts";
import { usePlayerController } from "./player-controller.tsx";

/** How long the fade-out takes before the card leaves the page. */
const FADE_MS = 300;

/**
 * 「已从 12:34 继续播放 · 从头播放」, laid over the top-left of the player (the controls sit at the
 * bottom) after a remembered position was applied. It fades after `PLAYBACK_RESUME_NOTICE_MS`;
 * pointer or keyboard focus on it holds the timer and Escape closes it. Render it inside a
 * `relative` box that wraps the player.
 */
export function ResumeNotice() {
  const { t } = useTranslation();
  const controller = usePlayerController();
  const positionMs = useSyncExternalStore(
    (listener) => controller.subscribe(listener),
    () => controller.resumeNotice,
  );
  const [hovered, setHovered] = useState(false);
  const [focused, setFocused] = useState(false);
  const held = hovered || focused;
  const [fading, setFading] = useState(false);
  const shown = positionMs !== undefined;

  useEffect(() => {
    if (!shown || held) {
      setFading(false);
      return undefined;
    }
    const timer = setTimeout(() => setFading(true), PLAYBACK_RESUME_NOTICE_MS);
    return () => clearTimeout(timer);
  }, [shown, held, positionMs]);

  useEffect(() => {
    if (!fading) return undefined;
    const timer = setTimeout(() => controller.dismissResumeNotice(), FADE_MS);
    return () => clearTimeout(timer);
  }, [fading, controller]);

  // A card that left while hovered would otherwise keep the next one from ever fading.
  useEffect(() => {
    if (shown) return;
    setHovered(false);
    setFocused(false);
  }, [shown]);

  if (positionMs === undefined) return null;
  const release = (event: FocusEvent<HTMLDivElement>): void => {
    if (!(event.relatedTarget instanceof Node) || !event.currentTarget.contains(event.relatedTarget)) setFocused(false);
  };
  const onKeyDown = (event: KeyboardEvent<HTMLDivElement>): void => {
    if (event.key !== "Escape") return;
    event.stopPropagation();
    controller.dismissResumeNotice();
  };
  return (
    <div
      role="status"
      className={`absolute top-2 left-2 z-[2] flex max-w-[calc(100%-1rem)] items-center gap-2 rounded-md border border-line bg-surface px-3 py-1.5 text-xs text-ink shadow-md motion-safe:transition-opacity motion-safe:duration-300 ${fading ? "opacity-0" : "opacity-100"}`}
      data-testid="resume-notice"
      onMouseEnter={() => setHovered(true)}
      onMouseLeave={() => setHovered(false)}
      onFocus={() => setFocused(true)}
      onBlur={release}
      onKeyDown={onKeyDown}
    >
      <span className="min-w-0 truncate">{t("contentView.playbackResume.resumed", { time: formatDuration(positionMs) })}</span>
      <span aria-hidden="true" className="text-muted">
        ·
      </span>
      <button
        type="button"
        className="shrink-0 rounded font-medium text-accent outline-none hover:underline focus-visible:ring-2 focus-visible:ring-accent"
        onClick={() => controller.restart()}
        data-testid="resume-restart"
      >
        {t("contentView.playbackResume.restart")}
      </button>
    </div>
  );
}
