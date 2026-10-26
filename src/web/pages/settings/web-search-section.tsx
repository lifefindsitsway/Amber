import { useTranslation } from "react-i18next";
import { CHAT_SEARCH_PLAN_TURNS, WEB_SEARCH_QUERIES_MAX, WEB_SEARCH_QUERY_MAX_CHARS } from "../../../shared/defaults.ts";
import { WEB_SEARCH_SERVICES, type WebSearchService } from "../../../shared/enums.ts";
import { useWebSearchMutations, useWebSearchProfile } from "../../api/queries.ts";
import { Button } from "../../ui/button.tsx";
import { Loading } from "../../ui/feedback.tsx";
import { ConfirmButton, CredentialInput, CredentialStatus, Field, INPUT_CLASS, RequestError, SettingsBlock } from "./settings-ui.tsx";

const DEFAULT_SERVICE: WebSearchService = WEB_SEARCH_SERVICES[0];

/**
 * `/settings/web-search`: the search service the chat uses when it searches the web, its
 * write-only key (status, set / reset, remove), a "test" that sends one real search, and
 * what is sent where and what it costs.
 */
export function WebSearchSection() {
  const { t } = useTranslation();
  const profile = useWebSearchProfile();
  const mutations = useWebSearchMutations();
  if (profile.isPending) {
    return <Loading />;
  }
  if (profile.data === undefined) {
    return <RequestError error={profile.error} />;
  }
  const { service, credentialStatus } = profile.data;
  const stored = credentialStatus !== "missing";
  return (
    <div>
      <p className="mb-4 text-sm text-muted">{t("settings.webSearch.intro")}</p>
      <SettingsBlock
        title={t(`settings.webSearch.services.${service ?? DEFAULT_SERVICE}`)}
        actions={
          service === undefined && !stored ? undefined : (
            <ConfirmButton
              label={t("settings.webSearch.remove")}
              variant="danger"
              message={t("settings.webSearch.removeConfirm")}
              disabled={mutations.remove.isPending}
              onConfirm={() => mutations.remove.mutate()}
              testId="web-search-remove"
            />
          )
        }
      >
        <Field label={t("settings.webSearch.service")} htmlFor="web-search-service">
          <select
            id="web-search-service"
            className={INPUT_CLASS}
            value={service ?? DEFAULT_SERVICE}
            data-testid="web-search-service"
            onChange={(event) => mutations.service.mutate({ service: event.target.value as WebSearchService })}
          >
            {WEB_SEARCH_SERVICES.map((item) => (
              <option key={item} value={item}>
                {t(`settings.webSearch.services.${item}`)}
              </option>
            ))}
          </select>
        </Field>
        <Field
          label={t("settings.webSearch.keyLabel")}
          hint={t("settings.common.credential.writeOnly")}
          htmlFor="web-search-key"
          aside={
            <span data-testid="web-search-credential">
              <CredentialStatus status={credentialStatus} />
            </span>
          }
        >
          <CredentialInput
            key={credentialStatus}
            id="web-search-key"
            hasCredential={stored}
            pending={mutations.credential.isPending}
            onSubmit={(value) => mutations.credential.mutate({ value, service, fallback: DEFAULT_SERVICE })}
          />
        </Field>
        <RequestError error={mutations.credential.error ?? mutations.service.error ?? mutations.remove.error} />
        <div className="mt-2 flex flex-wrap items-center gap-3">
          <Button size="sm" disabled={credentialStatus !== "configured" || mutations.test.isPending} onClick={() => mutations.test.mutate()} data-testid="web-search-test">
            {mutations.test.isPending ? t("settings.webSearch.testing") : t("settings.webSearch.test")}
          </Button>
          {mutations.test.data === undefined || mutations.test.isPending ? null : (
            <span className="text-xs text-ok" role="status" data-testid="web-search-test-result">
              {t("settings.webSearch.testOk", { count: mutations.test.data.resultCount })}
            </span>
          )}
        </div>
        <p className="mt-1 text-xs text-muted" data-testid="web-search-test-hint">
          {t("settings.webSearch.testHint")}
        </p>
        <RequestError error={mutations.test.error} />
      </SettingsBlock>
      <SettingsBlock title={t("settings.webSearch.privacyTitle")}>
        <ul className="list-disc space-y-1 pl-5 text-sm text-muted" data-testid="web-search-privacy">
          <li>{t("settings.webSearch.privacy.model", { turns: CHAT_SEARCH_PLAN_TURNS })}</li>
          <li>{t("settings.webSearch.privacy.service", { chars: WEB_SEARCH_QUERY_MAX_CHARS })}</li>
          <li>{t("settings.webSearch.privacy.logs")}</li>
        </ul>
      </SettingsBlock>
      <SettingsBlock title={t("settings.webSearch.billingTitle")}>
        <p className="text-sm text-muted" data-testid="web-search-billing">
          {t("settings.webSearch.billing", { queries: WEB_SEARCH_QUERIES_MAX })}
        </p>
      </SettingsBlock>
    </div>
  );
}
