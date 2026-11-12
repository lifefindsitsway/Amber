import type { TFunction } from "i18next";
import { CircleCheck, CircleDashed } from "lucide-react";
import type { ButtonHTMLAttributes } from "react";
import { useTranslation } from "react-i18next";

/** What the mark says: the review of who said what, and, once reviewed, names still to confirm. */
export function reviewBadgeText(t: TFunction, confirmed: boolean, pendingNames: number): string {
  if (!confirmed) return t("speakerReview.badge.unconfirmed");
  return pendingNames > 0 ? t("speakerReview.badge.confirmedPendingNames", { count: pendingNames }) : t("speakerReview.badge.confirmed");
}

/**
 * The review mark beside the revision picker: a button that opens the review panel. The
 * state is in its words (and its accessible name), the icon and colour only repeat it.
 * Extra props (a popover trigger's) reach the button.
 */
export function SpeakerReviewBadge({
  confirmed,
  pendingNames,
  className = "",
  ...rest
}: { confirmed: boolean; pendingNames: number } & ButtonHTMLAttributes<HTMLButtonElement>) {
  const { t } = useTranslation();
  const text = reviewBadgeText(t, confirmed, pendingNames);
  return (
    <button
      type="button"
      className={`inline-flex h-7 shrink-0 items-center gap-1 rounded-md border px-2 text-xs font-medium whitespace-nowrap outline-none focus-visible:ring-2 focus-visible:ring-accent ${
        confirmed ? "border-line text-ink hover:bg-sunken" : "border-dashed border-muted/70 text-muted hover:bg-sunken hover:text-ink"
      } ${className}`}
      aria-label={t("speakerReview.badge.label", { state: text })}
      data-testid="speaker-review-badge"
      data-state={confirmed ? "confirmed" : "unconfirmed"}
      {...rest}
    >
      {confirmed ? <CircleCheck size={13} aria-hidden="true" /> : <CircleDashed size={13} aria-hidden="true" />}
      {text}
    </button>
  );
}
