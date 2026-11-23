import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { useState, type FormEvent } from "react";
import { useTranslation } from "react-i18next";
import { networkAllowlistDtoSchema } from "../../../shared/dto/admin.ts";
import { useApi } from "../../api/context.tsx";
import { Button } from "../../ui/button.tsx";
import { Loading } from "../../ui/feedback.tsx";
import { FieldHint } from "../../ui/notice.tsx";
import { TextArea } from "../../ui/text-field.tsx";
import { RequestError, SettingsBlock } from "../settings/settings-ui.tsx";
import { adminKeys } from "./admin-data.ts";

/**
 * `/admin/network`: the outbound allowlist of exact origins. The whole list
 * is replaced on save; the server normalizes entries and rejects wildcards, CIDRs and paths.
 */
export function NetworkSection() {
  const { t } = useTranslation();
  const client = useApi();
  const queryClient = useQueryClient();
  const allowlist = useQuery({ queryKey: adminKeys.allowlist, queryFn: () => client.get("/api/admin/network-allowlist", networkAllowlistDtoSchema) });
  const [draft, setDraft] = useState<string | undefined>(undefined);
  const [saved, setSaved] = useState<number | undefined>(undefined);
  const text = draft ?? allowlist.data?.origins.join("\n") ?? "";
  const save = useMutation({
    mutationFn: (origins: string[]) => client.put("/api/admin/network-allowlist", networkAllowlistDtoSchema, { body: { origins } }),
    onSuccess: (next) => {
      queryClient.setQueryData(adminKeys.allowlist, next);
      setDraft(undefined);
      setSaved(next.origins.length);
    },
  });
  const submit = (event: FormEvent): void => {
    event.preventDefault();
    setSaved(undefined);
    save.mutate(text.split("\n").map((line) => line.trim()).filter((line) => line !== ""));
  };
  return (
    <SettingsBlock intro={t("admin.network.intro")}>
      {allowlist.isPending ? <Loading /> : null}
      <RequestError error={allowlist.error} />
      {allowlist.data === undefined ? null : (
        <form onSubmit={submit}>
          <label className="mb-1 block text-xs font-medium text-muted" htmlFor="allowlist-origins">
            {t("admin.network.label")}
          </label>
          <TextArea
            id="allowlist-origins"
            rows={6}
            spellCheck={false}
            className="w-full font-mono"
            aria-describedby="allowlist-origins-hint"
            value={text}
            onChange={(event) => setDraft(event.target.value)}
          />
          <FieldHint id="allowlist-origins-hint" className="mt-1.5">
            {t("admin.network.hint")}
          </FieldHint>
          <RequestError error={save.error} />
          {saved === undefined ? null : (
            <p className="mt-2 text-sm text-ok" role="status">
              {t("admin.network.saved", { count: saved })}
            </p>
          )}
          <div className="mt-3 flex justify-end">
            <Button type="submit" variant="primary" disabled={draft === undefined} loading={save.isPending}>
              {t("common.action.save")}
            </Button>
          </div>
        </form>
      )}
    </SettingsBlock>
  );
}
