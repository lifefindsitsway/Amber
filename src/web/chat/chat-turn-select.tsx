import { useTranslation } from "react-i18next";
import { Button } from "../ui/button.tsx";

/** The check box a turn shows while turns are being picked for deletion. */
export function TurnCheckbox(props: { checked: boolean; disabled: boolean; onChange: (checked: boolean) => void }) {
  const { t } = useTranslation();
  return (
    <input
      type="checkbox"
      className="mt-2.5 size-4 shrink-0 accent-accent"
      checked={props.checked}
      disabled={props.disabled}
      aria-label={t("chat.select.turn")}
      data-testid="chat-turn-check"
      onChange={(event) => props.onChange(event.target.checked)}
    />
  );
}

/** The bar under the history while picking turns: how many are picked · delete them · cancel. */
export function TurnSelectBar(props: { count: number; busy: boolean; onDelete: () => void; onCancel: () => void }) {
  const { t } = useTranslation();
  return (
    <div className="flex items-center gap-2 rounded-md border border-line bg-sunken px-2 py-1.5 text-xs" data-testid="chat-select-bar">
      <span data-testid="chat-select-count">{t("chat.select.count", { count: props.count })}</span>
      <div className="ml-auto flex items-center gap-1">
        <Button size="sm" variant="danger" disabled={props.count === 0 || props.busy} onClick={props.onDelete} data-testid="chat-select-delete">
          {t("chat.select.delete")}
        </Button>
        <Button size="sm" variant="ghost" onClick={props.onCancel} data-testid="chat-select-cancel">
          {t("chat.select.cancel")}
        </Button>
      </div>
    </div>
  );
}
