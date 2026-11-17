import { TriangleAlert } from "lucide-react";
import { useTranslation } from "react-i18next";

/**
 * Over the editor while sentences of the draft name a speaker that no longer exists (deleted in
 * another window, or the server refused a commit for it): how many, and 「设为未分配」, which
 * clears them as one undoable step. Nothing when there are none.
 */
export function MissingSpeakerNotice(props: { count: number; onUnassign: () => void; disabled?: boolean }) {
  const { t } = useTranslation();
  if (props.count <= 0) return null;
  return (
    <div className="flex flex-wrap items-center gap-2 border-b border-line bg-accent-soft px-4 py-1.5 text-xs" role="status" data-testid="missing-speaker-notice">
      <TriangleAlert size={13} className="shrink-0 text-accent" aria-hidden="true" />
      <span className="tabular-nums">{t("speakerEditor.missing.message", { count: props.count })}</span>
      <button
        type="button"
        className="ml-auto rounded px-1.5 py-0.5 font-medium hover:bg-sunken focus-visible:outline-2 focus-visible:outline-accent disabled:cursor-not-allowed disabled:opacity-50"
        disabled={props.disabled === true}
        onClick={props.onUnassign}
        data-testid="missing-speaker-unassign"
      >
        {t("speakerEditor.missing.unassign")}
      </button>
    </div>
  );
}
