import { useState } from "react";
import { useTranslation } from "react-i18next";
import { credentialsResetDtoSchema } from "../../../shared/dto/admin.ts";
import { useApi } from "../../api/context.tsx";
import { clearBilibiliPlayerSession, rotateMasterKey } from "../../desktop/bridge.ts";
import { useDesktop } from "../../desktop/use-desktop.ts";
import { formatDateTime } from "../../format.ts";
import { Button } from "../../ui/button.tsx";
import { ConfirmDialog } from "../../components/confirm-dialog.tsx";
import { SettingsBlock } from "../settings/settings-ui.tsx";

/**
 * Drops the bilibili login the shell gave the player iframe, which the reset also revokes.
 * Best effort: the shell logs a failure.
 */
async function clearPlayerSession(): Promise<void> {
  try {
    await clearBilibiliPlayerSession();
  } catch {
    return;
  }
}

/**
 * "Reset all credentials", for a master key that is lost or no longer
 * decrypts what is stored: `/admin/credentials` in server mode, the desktop-only
 * `/settings/credentials` section of the settings in the desktop client. Destructive, so it asks first. On the desktop the shell then replaces the
 * master key and restarts the backend; that second step may fail on its own and be retried,
 * since the state after the reset is consistent with either key.
 */
export function CredentialsSection(props: { title?: string }) {
  const { t, i18n } = useTranslation();
  const client = useApi();
  const desktop = useDesktop();
  const [open, setOpen] = useState(false);
  const [resetAt, setResetAt] = useState<number | undefined>(undefined);
  const [rotateFailed, setRotateFailed] = useState<string | undefined>(undefined);
  const [rotating, setRotating] = useState(false);

  const rotate = async (): Promise<void> => {
    setRotating(true);
    try {
      await rotateMasterKey();
      setRotateFailed(undefined);
    } catch (caught) {
      setRotateFailed(caught instanceof Error ? caught.message : String(caught));
    } finally {
      setRotating(false);
    }
  };

  return (
    <SettingsBlock {...(props.title === undefined ? {} : { title: props.title })} intro={t("admin.credentials.intro")}>
      {resetAt === undefined ? null : (
        <p className="mb-3 text-sm text-ok" role="status">
          {t("admin.credentials.done", { time: formatDateTime(resetAt, i18n.language) })}
        </p>
      )}
      {rotateFailed === undefined ? null : (
        <div className="mb-3 rounded-md border border-danger/40 bg-danger/5 p-3 text-sm" role="alert" data-testid="rotate-failed">
          <p>{t("admin.credentials.rotateFailed")}</p>
          {rotateFailed === "" ? null : <p className="mt-1 text-xs text-muted">{rotateFailed}</p>}
          <Button size="sm" className="mt-2" disabled={rotating} onClick={() => void rotate()}>
            {t("admin.credentials.rotateRetry")}
          </Button>
        </div>
      )}
      <Button variant="danger" onClick={() => setOpen(true)}>
        {t("admin.credentials.action")}
      </Button>
      <ConfirmDialog
        open={open}
        onOpenChange={setOpen}
        title={t("admin.credentials.confirmTitle")}
        description={t("admin.credentials.confirm")}
        confirmLabel={t("admin.credentials.action")}
        danger
        onConfirm={async () => {
          const result = await client.post("/api/admin/credentials/reset", credentialsResetDtoSchema);
          setResetAt(result.credentialsResetAt);
          // The reset itself succeeded; a failed key rotation is reported separately.
          if (desktop) {
            void clearPlayerSession();
            await rotate();
          }
        }}
      />
    </SettingsBlock>
  );
}
