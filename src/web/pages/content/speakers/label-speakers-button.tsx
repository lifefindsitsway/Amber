import { UserRoundPen } from "lucide-react";
import { useTranslation } from "react-i18next";
import { Button } from "../../../ui/button.tsx";
import { Tooltip } from "../../../ui/tooltip.tsx";

/**
 * 「标注发言人」 for the reading toolbar of a transcript that has no speakers yet (or a single
 * unnamed one): the way into labelling speakers in the editor. An icon, named for screen
 * readers and with the same words as its tooltip.
 */
export function LabelSpeakersButton(props: { onClick: () => void; disabled?: boolean }) {
  const { t } = useTranslation();
  const label = t("speakerEditor.entry.labelSpeakers");
  return (
    <Tooltip content={label}>
      <Button size="sm" variant="ghost" aria-label={label} disabled={props.disabled === true} onClick={props.onClick} data-testid="label-speakers">
        <UserRoundPen size={14} aria-hidden="true" />
      </Button>
    </Tooltip>
  );
}
