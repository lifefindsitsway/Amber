import { useTranslation } from "react-i18next";
import { Button } from "../../ui/button.tsx";
import { Modal } from "../../ui/modal.tsx";

/**
 * A plain confirm / cancel question, such as clearing a conversation. `danger` gives the confirm
 * button the filled destructive look, kept for the final step of an action that destroys
 * something and cannot be undone.
 */
export function ConfirmDialog(props: {
  open: boolean;
  title: string;
  message: string;
  confirmLabel?: string;
  busy?: boolean;
  danger?: boolean;
  onConfirm: () => void;
  onCancel: () => void;
}) {
  const { t } = useTranslation();
  return (
    <Modal
      open={props.open}
      onOpenChange={(open) => (open ? undefined : props.onCancel())}
      title={props.title}
      footer={
        <>
          <Button onClick={props.onCancel}>{t("common.action.cancel")}</Button>
          <Button variant={props.danger === true ? "danger-solid" : "primary"} loading={props.busy === true} onClick={props.onConfirm} data-testid="confirm-dialog-ok">
            {props.confirmLabel ?? t("common.action.confirm")}
          </Button>
        </>
      }
    >
      <p className="max-w-[70ch] text-sm">{props.message}</p>
    </Modal>
  );
}
