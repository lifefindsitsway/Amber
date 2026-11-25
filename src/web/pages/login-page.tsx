import { useMutation, useQueryClient } from "@tanstack/react-query";
import { useId, useState, type FormEvent, type ReactNode } from "react";
import { useTranslation } from "react-i18next";
import { Link, Navigate } from "react-router";
import { authMeDtoSchema } from "../../shared/dto/system.ts";
import { ApiError } from "../api/client.ts";
import { useApi } from "../api/context.tsx";
import { queryKeys, useMe, useSetupStatus } from "../api/queries.ts";
import { AUTH_FORM, AUTH_PASSWORD_INPUT, AuthCard, AuthField } from "../auth/auth-card.tsx";
import { ChangePasswordForm } from "../auth/change-password-form.tsx";
import { peekNext } from "../auth/next-path.ts";
import { ErrorView } from "../components/error-view.tsx";
import { Button } from "../ui/button.tsx";
import { Loading } from "../ui/feedback.tsx";
import { Callout, TEXT_ACTION_CLASS } from "../ui/notice.tsx";
import { PasswordInput } from "../ui/password-input.tsx";
import { TextInput } from "../ui/text-field.tsx";

/**
 * `/login`: username and password, then — when an administrator reset
 * the password — a second step that sets a new one before anything else is reachable.
 * Success returns to the page remembered by the auth boundary. The link to the setup wizard
 * appears only while the instance has no administrator yet.
 */
export function LoginPage() {
  const { t } = useTranslation();
  const client = useApi();
  const queryClient = useQueryClient();
  const me = useMe();
  const formId = useId();
  const [username, setUsername] = useState("");
  const [password, setPassword] = useState("");
  // The password just verified by the login step, so the change step need not ask again.
  const [verified, setVerified] = useState<string | undefined>(undefined);
  const login = useMutation({
    mutationFn: () => client.post("/api/auth/login", authMeDtoSchema, { body: { username, password }, authRedirect: false }),
    onSuccess: (principal) => {
      // A new principal: nothing cached for a previous session may survive.
      queryClient.removeQueries({ predicate: (query) => query.queryKey[0] !== queryKeys.me[0] });
      queryClient.setQueryData(queryKeys.me, principal);
      // The new principal re-renders this page: straight on to the remembered page, or the
      // change step for a temporary password.
      if (principal.mustChangePassword) {
        setVerified(password);
      }
      setPassword("");
    },
  });

  if (me.isPending) {
    return <Loading />;
  }
  if (me.data !== undefined && !me.data.mustChangePassword) {
    return <Navigate to={peekNext()} replace />;
  }
  if (me.data?.mustChangePassword === true) {
    return (
      <AuthCard title={t("auth.changePassword.title")} intro={t("auth.changePassword.intro")}>
        <ChangePasswordForm
          {...(verified === undefined ? {} : { currentPassword: verified })}
          submitLabel={t("auth.changePassword.submit")}
          onDone={() => undefined}
        />
      </AuthCard>
    );
  }

  const submit = (event: FormEvent): void => {
    event.preventDefault();
    login.mutate();
  };
  const failure = login.error instanceof ApiError ? login.error : undefined;
  return (
    <LoginCard>
      <form onSubmit={submit} className={AUTH_FORM} data-testid="login-form">
        <AuthField
          id={`${formId}-username`}
          label={t("auth.login.username")}
          control={(field) => <TextInput {...field} autoComplete="username" required value={username} onChange={(event) => setUsername(event.target.value)} className="w-full" />}
        />
        <AuthField
          id={`${formId}-password`}
          label={t("auth.login.password")}
          control={(field) => (
            <PasswordInput {...field} autoComplete="current-password" required value={password} onChange={(event) => setPassword(event.target.value)} className={AUTH_PASSWORD_INPUT} />
          )}
        />
        {/* Not tied to one field: a refused login never says whether the user name or the password was wrong. */}
        {failure === undefined ? null : failure.error.class === "rate_limited" ? (
          <Callout tone="error" density="compact" announce="alert">
            {failure.retryAfterSeconds === undefined
              ? t("auth.login.rateLimitedNoDelay")
              : t("auth.login.rateLimited", { seconds: failure.retryAfterSeconds })}
          </Callout>
        ) : (
          <ErrorView error={failure.error} />
        )}
        <Button type="submit" variant="primary" loading={login.isPending}>
          {t("auth.login.submit")}
        </Button>
      </form>
    </LoginCard>
  );
}

/**
 * The login form's card. It owns the setup-status query so the observer unmounts with the
 * form: once a login succeeds and the cache is cleared, `/api/setup` is not fetched again.
 * Only a 401 `unauthenticated.setup_token` means "not initialized"; an initialized instance,
 * local mode (404), any other failure and the pending state all leave the footer out — the
 * divider included — so the link never flashes in and out.
 */
function LoginCard(props: { children: ReactNode }) {
  const { t } = useTranslation();
  const setup = useSetupStatus();
  const uninitialized = setup.error instanceof ApiError && setup.error.status === 401 && setup.error.error.code === "unauthenticated.setup_token";
  return (
    <AuthCard
      title={t("auth.login.title")}
      centerTitle
      {...(uninitialized
        ? {
            footer: (
              <Link to="/setup" className={TEXT_ACTION_CLASS}>
                {t("auth.login.setupLink")}
              </Link>
            ),
          }
        : {})}
    >
      {props.children}
    </AuthCard>
  );
}
