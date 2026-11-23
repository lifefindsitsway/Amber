import { useMutation, useQuery } from "@tanstack/react-query";
import { TriangleAlert } from "lucide-react";
import { useState } from "react";
import { useTranslation } from "react-i18next";
import { API_PAGE_SIZE_DEFAULT, CONTENT_LIST_IDS_MAX, CONTENT_PACK_MERGE_DURATION_WARN_MS } from "../../../shared/defaults.ts";
import { contentListDtoSchema, type ContentDto } from "../../../shared/dto/content.ts";
import type { PackContentDiff, PackPreviewContent } from "../../../shared/dto/content-pack.ts";
import { useApi } from "../../api/context.tsx";
import { queryKeys, queryString } from "../../api/queries.ts";
import { appErrorOf } from "../../components/confirm-dialog.tsx";
import { ErrorView } from "../../components/error-view.tsx";
import { formatDuration } from "../../format.ts";
import { hitsByContent, useSearch } from "../../search/search.ts";
import { Button } from "../../ui/button.tsx";
import { EmptyState, SkeletonRows } from "../../ui/feedback.tsx";
import { Modal } from "../../ui/modal.tsx";
import { NOTE_TEXT_CLASS } from "../../ui/notice.tsx";
import { TextInput } from "../../ui/text-field.tsx";
import { durationsDiffer } from "./import-model.ts";
import { comparePack } from "./pack-api.ts";
import { sourceLine, titleOf } from "./pack-labels.ts";

/**
 * 「合并到其它内容…」: the user names the local Content a carried one goes into. Nothing here is
 * matched by title or duration; the list is the library's (recent first, or what the search
 * finds), and a duration far from the carried one is flagged before the user commits to it.
 * Picking asks the server for the diff against that Content.
 */
export function TargetPicker(props: {
  open: boolean;
  onClose: () => void;
  jobId: string;
  item: PackPreviewContent;
  onPicked: (diff: PackContentDiff, target: { title: string | undefined; durationMs: number | undefined }) => void;
}) {
  const { t } = useTranslation();
  return (
    <Modal
      open={props.open}
      onOpenChange={(open) => (open ? undefined : props.onClose())}
      title={t("contentPack.import.mergeOther.title")}
      footer={<Button onClick={props.onClose}>{t("common.action.cancel")}</Button>}
    >
      {props.open ? <PickerBody {...props} /> : null}
    </Modal>
  );
}

function PickerBody(props: { jobId: string; item: PackPreviewContent; onPicked: (diff: PackContentDiff, target: { title: string | undefined; durationMs: number | undefined }) => void }) {
  const { t } = useTranslation();
  const client = useApi();
  const [query, setQuery] = useState("");
  const found = useSearch(query, "library");
  const ids = found.active && found.data !== undefined ? hitsByContent(found.data).slice(0, CONTENT_LIST_IDS_MAX).map((hit) => hit.contentId) : [];
  const recent = useQuery({
    queryKey: [...queryKeys.contentsAll, "pack-target", "recent"],
    queryFn: () => client.get(`/api/contents${queryString({ limit: API_PAGE_SIZE_DEFAULT, page: 1 })}`, contentListDtoSchema),
    enabled: !found.active,
  });
  const hits = useQuery({
    queryKey: [...queryKeys.contentsAll, "pack-target", "hits", ids.join(",")],
    queryFn: () => client.get(`/api/contents${queryString({ ids: ids.join(","), limit: ids.length, page: 1 })}`, contentListDtoSchema),
    enabled: found.active && ids.length > 0,
  });
  const order = new Map(ids.map((id, index) => [id, index]));
  const items: ContentDto[] = found.active ? [...(hits.data?.items ?? [])].sort((a, b) => (order.get(a.id) ?? 0) - (order.get(b.id) ?? 0)) : (recent.data?.items ?? []);
  const loading = found.active ? (found.data === undefined && !found.isError) || (ids.length > 0 && hits.isPending) : recent.isPending;
  const pick = useMutation({
    mutationFn: async (content: ContentDto) => ({ diff: await comparePack(client, props.jobId, props.item.key, content.id), content }),
    onSuccess: ({ diff, content }) => props.onPicked(diff, { title: content.title, durationMs: content.durationMs }),
  });
  return (
    <div className="flex flex-col gap-3 text-sm" data-testid="pack-target-picker">
      <p className="text-muted">{t("contentPack.import.mergeOther.intro", { title: titleOf(props.item.title, t) })}</p>
      <TextInput
        type="search"
        size="md"
        placeholder={t("contentPack.import.mergeOther.search")}
        aria-label={t("contentPack.import.mergeOther.search")}
        value={query}
        onChange={(event) => setQuery(event.target.value)}
        data-testid="pack-target-search"
      />
      {found.active ? null : <p className={NOTE_TEXT_CLASS}>{t("contentPack.import.mergeOther.recent")}</p>}
      {loading ? (
        <SkeletonRows count={4} rowHeight={40} />
      ) : items.length === 0 ? (
        <EmptyState title={t("contentPack.import.mergeOther.empty")} />
      ) : (
        <ul className="flex max-h-80 flex-col divide-y divide-line overflow-auto rounded-md border border-line">
          {items.map((content) => {
            const warn = durationsDiffer(props.item.durationMs, content.durationMs, CONTENT_PACK_MERGE_DURATION_WARN_MS);
            return (
              <li key={content.id} className="flex items-start gap-3 px-3 py-2" data-testid="pack-target-option">
                <div className="min-w-0 flex-1">
                  <p className="truncate font-medium" title={titleOf(content.title, t)}>
                    {titleOf(content.title, t)}
                  </p>
                  <p className="text-xs text-muted">{sourceLine(content.source.kind, content.durationMs, t)}</p>
                  {warn ? (
                    <p className="flex items-start gap-1 text-note text-warn">
                      <TriangleAlert size={14} className="mt-[3px] shrink-0" aria-hidden="true" />
                      <span className="min-w-0">
                        {t("contentPack.import.mergeOther.durationWarning", { pack: formatDuration(props.item.durationMs ?? 0), local: formatDuration(content.durationMs ?? 0) })}
                      </span>
                    </p>
                  ) : null}
                </div>
                <Button size="sm" loading={pick.isPending && pick.variables?.id === content.id} disabled={pick.isPending} onClick={() => pick.mutate(content)} aria-label={`${t("contentPack.import.mergeOther.choose")} · ${titleOf(content.title, t)}`}>
                  {pick.isPending && pick.variables?.id === content.id ? t("contentPack.import.mergeOther.comparing") : t("contentPack.import.mergeOther.choose")}
                </Button>
              </li>
            );
          })}
        </ul>
      )}
      {pick.error === null ? null : <ErrorView error={appErrorOf(pick.error)} />}
    </div>
  );
}
