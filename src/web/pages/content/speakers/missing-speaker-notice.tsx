import { useTranslation } from "react-i18next";
import { Button } from "../../../ui/button.tsx";
import { Banner } from "../../../ui/notice.tsx";

/**
 * Over the editor while sentences of the draft name a speaker that no longer exists (deleted in
 * another window, or the server refused a commit for it): how many, and 「设为未分配」, which
 * clears them as one undoable step. Nothing when there are none.
 */
export function MissingSpeakerNotice(props: { count: number; onUnassign: () => void; disabled?: boolean }) {
  const { t } = useTranslation();
  if (props.count <= 0) return null;
  return (
    // A problem of the whole draft to deal with before committing: a strip across the editor.
    <Banner
      tone="warn"
      announce="status"
      testId="missing-speaker-notice"
      actions={
        <Button size="sm" disabled={props.disabled === true} onClick={props.onUnassign} data-testid="missing-speaker-unassign">
          {t("speakerEditor.missing.unassign")}
        </Button>
      }
    >
      <span className="tabular-nums">{t("speakerEditor.missing.message", { count: props.count })}</span>
    </Banner>
  );
}
