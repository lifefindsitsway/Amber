import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { useId, useState } from "react";
import { useTranslation } from "react-i18next";
import { TERMINOLOGY_MAX_ENTRIES } from "../../shared/defaults.ts";
import { terminologyDtoSchema, type PutTerminologyRequest, type TerminologyDto } from "../../shared/dto/terminology.ts";
import { ApiError } from "../api/client.ts";
import { useApi } from "../api/context.tsx";
import { queryString } from "../api/queries.ts";
import { Button } from "../ui/button.tsx";
import { Checkbox } from "../ui/checkbox.tsx";
import { Loading } from "../ui/feedback.tsx";
import { FieldError, InlineNote } from "../ui/notice.tsx";
import { TextInput } from "../ui/text-field.tsx";
import { ErrorView } from "./error-view.tsx";

type Entry = PutTerminologyRequest["entries"][number];

interface Row {
  term: string;
  translation: string;
  keepOriginal: boolean;
}

function rowsOf(dto: TerminologyDto): Row[] {
  return dto.entries.map((entry) => ({ term: entry.term, translation: entry.translation ?? "", keepOriginal: entry.rule === "keep_original" }));
}

function entriesOf(rows: readonly Row[]): Entry[] {
  return rows
    .filter((row) => row.term.trim() !== "")
    .map((row) => ({
      term: row.term.trim(),
      ...(row.translation.trim() === "" ? {} : { translation: row.translation.trim() }),
      ...(row.keepOriginal ? { rule: "keep_original" as const } : {}),
    }));
}

/**
 * Edits one terminology scope (`global`, `collection:<id>`, `content:<id>`) as a whole
 * table: saving replaces every entry, order included. Limits and duplicate
 * keys are the server's to reject; its AppError is shown as is.
 */
export function TerminologyEditor({ scope }: { scope: string }) {
  const { t } = useTranslation();
  const client = useApi();
  const queryClient = useQueryClient();
  const errorId = useId();
  const key = ["terminology", scope] as const;
  const path = `/api/terminology${queryString({ scope })}`;
  const loaded = useQuery({ queryKey: key, queryFn: () => client.get(path, terminologyDtoSchema) });
  const [rows, setRows] = useState<Row[] | undefined>(undefined);
  const save = useMutation({
    mutationFn: (entries: Entry[]) => client.put(path, terminologyDtoSchema, { body: { entries } }),
    onSuccess: (dto) => {
      queryClient.setQueryData(key, dto);
      setRows(undefined);
    },
  });
  if (loaded.isPending) {
    return <Loading />;
  }
  if (loaded.data === undefined) {
    return loaded.error instanceof ApiError ? <ErrorView error={loaded.error.error} /> : null;
  }
  const shown = rows ?? rowsOf(loaded.data);
  const update = (index: number, change: Partial<Row>): void => setRows(shown.map((row, i) => (i === index ? { ...row, ...change } : row)));
  const tooMany = shown.length > TERMINOLOGY_MAX_ENTRIES;
  return (
    <div data-terminology-scope={scope}>
      {shown.length === 0 ? <InlineNote className="mb-2">{t("settings.terminology.empty")}</InlineNote> : null}
      {shown.length === 0 ? null : (
        <table className="mb-2 w-full text-sm">
          <thead>
            <tr className="text-left text-xs text-muted">
              <th className="pb-1 font-medium">{t("settings.terminology.term")}</th>
              <th className="pb-1 font-medium">{t("settings.terminology.translation")}</th>
              <th className="pb-1 font-medium">{t("settings.terminology.ruleKeepOriginal")}</th>
              <th />
            </tr>
          </thead>
          <tbody>
            {shown.map((row, index) => (
              <tr key={index}>
                <td className="pr-2 pb-1">
                  <TextInput size="md" aria-label={t("settings.terminology.term")} className="w-full" value={row.term} onChange={(event) => update(index, { term: event.target.value })} />
                </td>
                <td className="pr-2 pb-1">
                  <TextInput
                    size="md"
                    aria-label={t("settings.terminology.translation")}
                    className="w-full"
                    value={row.translation}
                    onChange={(event) => update(index, { translation: event.target.value })}
                  />
                </td>
                <td className="pr-2 pb-1 text-center">
                  <Checkbox
                    aria-label={t("settings.terminology.ruleKeepOriginal")}
                    checked={row.keepOriginal}
                    onChange={(event) => update(index, { keepOriginal: event.target.checked })}
                  />
                </td>
                <td className="pb-1">
                  <Button size="sm" variant="ghost" onClick={() => setRows(shown.filter((_, i) => i !== index))}>
                    {t("settings.terminology.remove")}
                  </Button>
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      )}
      <div className="flex flex-wrap items-center gap-2">
        <Button size="sm" disabled={shown.length >= TERMINOLOGY_MAX_ENTRIES} onClick={() => setRows([...shown, { term: "", translation: "", keepOriginal: false }])}>
          {t("settings.terminology.add")}
        </Button>
        <Button
          size="sm"
          variant="primary"
          loading={save.isPending}
          disabled={rows === undefined || tooMany}
          aria-describedby={tooMany ? errorId : undefined}
          onClick={() => save.mutate(entriesOf(shown))}
        >
          {t("common.action.save")}
        </Button>
        <span className={`text-xs ${tooMany ? "text-danger" : "text-muted"}`}>{t("settings.terminology.count", { count: shown.length, max: TERMINOLOGY_MAX_ENTRIES })}</span>
      </div>
      {/* Only a set saved before the limit was lowered can be over it: adding stops at the limit. */}
      {tooMany ? (
        <FieldError id={errorId} className="mt-1.5" testId="terminology-too-many">
          {t("settings.terminology.tooMany", { max: TERMINOLOGY_MAX_ENTRIES })}
        </FieldError>
      ) : null}
      {save.error instanceof ApiError ? (
        <div className="mt-2">
          <ErrorView error={save.error.error} />
        </div>
      ) : null}
    </div>
  );
}
