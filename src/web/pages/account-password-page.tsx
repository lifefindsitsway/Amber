import { useState } from "react";
import { useTranslation } from "react-i18next";
import { Navigate } from "react-router";
import { useMe } from "../api/queries.ts";
import { ChangePasswordForm } from "../auth/change-password-form.tsx";
import { Loading, PageHeader } from "../ui/feedback.tsx";
import { Callout } from "../ui/notice.tsx";

/**
 * `/account/password` (server mode): the signed-in user changes their own
 * password. Local mode has no login credentials, so the page sends it to the settings.
 */
export function AccountPasswordPage() {
  const { t } = useTranslation();
  const me = useMe();
  const [changed, setChanged] = useState(false);
  if (me.data === undefined) {
    return <Loading />;
  }
  if (me.data.mode !== "server") {
    return <Navigate to="/settings/models" replace />;
  }
  return (
    <div className="flex h-full flex-col">
      <PageHeader title={t("auth.passwordPage.title")} />
      <div className="min-w-0 flex-1 overflow-auto p-6">
        <div className="mx-auto max-w-sm">
          <p className="mb-8 flex gap-2 text-sm" data-testid="password-page-account">
            <span className="text-muted">{t("auth.passwordPage.account")}</span>
            <span className="font-medium">{me.data.username ?? me.data.userId}</span>
            <span className="text-muted">{t(`auth.passwordPage.roleValue.${me.data.role}`)}</span>
          </p>
          {changed ? (
            <Callout tone="success" density="compact" announce="status" className="mb-5">
              {t("auth.passwordPage.changed")}
            </Callout>
          ) : null}
          <ChangePasswordForm submitLabel={t("auth.passwordPage.submit")} onDone={() => setChanged(true)} />
        </div>
      </div>
    </div>
  );
}
