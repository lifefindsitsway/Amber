import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { ArrowUpDown, BookA, MoreHorizontal, Pencil, Plus, RefreshCw } from "lucide-react";
import { DropdownMenu } from "radix-ui";
import { useCallback, useEffect, useRef, useState } from "react";
import { useTranslation } from "react-i18next";
import { useParams } from "react-router";
import { z } from "zod";
import {
  collectionDetailDtoSchema,
  collectionSummaryDtoSchema,
  type CollectionDetailDto,
  type CollectionItemDto,
} from "../../shared/dto/collection.ts";
import { taskAcceptedDtoSchema, taskListDtoSchema } from "../../shared/dto/task.ts";
import type { AppError } from "../../shared/errors.ts";
import { useApi, useTaskHub } from "../api/context.tsx";
import { queryKeys, queryString, useSettings } from "../api/queries.ts";
import { CollectionEditForm } from "../components/collection/edit-collection-dialog.tsx";
import { useCollectionActions, type CollectionAction } from "../components/collection/use-collection-actions.tsx";
import { ErrorView } from "../components/error-view.tsx";
import { useContentActions } from "../components/use-content-actions.tsx";
import { useSearch } from "../search/search.ts";
import { TerminologyEditor } from "../components/terminology-editor.tsx";
import { Button } from "../ui/button.tsx";
import { MENU_CONTENT_CLASS, MenuEntries, useContextMenuTarget, type MenuEntry } from "../ui/context-menu.tsx";
import { EmptyState, Loading, PageHeader } from "../ui/feedback.tsx";
import { Modal } from "../ui/modal.tsx";
import { Pagination, usePagination } from "../ui/pagination.tsx";
import { useDocumentTitle } from "../use-document-title.ts";
import { ItemList, ReorderList } from "./collection/item-list.tsx";
import { SearchHits } from "./collection/search-hits.tsx";
import { SummaryCard } from "./collection/summary-card.tsx";
import { appErrorOf } from "../components/confirm-dialog.tsx";

const summaryKey = (id: string) => [...queryKeys.collection(id), "summary"] as const;
// Under the collection's key, so the task events that refresh the card read it again.
const latestSummaryTaskKey = (id: string) => [...queryKeys.collection(id), "latest-summary-task"] as const;

/**
 * One collection: header actions, rollup summary card and the ordered
 * lectures, paged in the browser since the detail carries them all. The order changes only
 * through 「调整顺序」: a draft of every lecture, sent as one complete order on save. The
 * lecture search goes through the search service with `scope=<collectionId>`.
 */
export function CollectionPage() {
  const { id = "" } = useParams();
  const { t } = useTranslation();
  const client = useApi();
  const hub = useTaskHub();
  const queryClient = useQueryClient();
  const settings = useSettings();
  const path = `/api/collections/${encodeURIComponent(id)}`;

  const detail = useQuery({ queryKey: queryKeys.collection(id), queryFn: () => client.get(path, collectionDetailDtoSchema) });
  const summary = useQuery({ queryKey: summaryKey(id), queryFn: () => client.get(`${path}/summary`, collectionSummaryDtoSchema) });
  // The latest summary Task, offered for a re-run on the card when it failed.
  const latestSummaryTask = useQuery({
    queryKey: latestSummaryTaskKey(id),
    queryFn: async () =>
      (await client.get(`/api/tasks${queryString({ collectionId: id, kind: "summarize_collection", limit: 1 })}`, taskListDtoSchema)).items[0] ?? null,
  });
  useDocumentTitle(detail.data?.name);

  const [query, setQuery] = useState("");
  const found = useSearch(query, id);
  const [editing, setEditing] = useState<"name" | "description" | undefined>(undefined);
  const [terminology, setTerminology] = useState(false);
  // The draft order while 「调整顺序」 is on; `undefined` in the normal (paged) view.
  const [draft, setDraft] = useState<string[] | undefined>(undefined);
  const [orderChanged, setOrderChanged] = useState(false);
  const lecturesRef = useRef<HTMLElement>(null);
  // The lectures sit below the description and summary in one scrolling column, so a new
  // page scrolls to the lecture list rather than to the page top. jsdom has no scrollIntoView.
  const showLectures = useCallback(() => {
    const element = lecturesRef.current;
    if (element !== null && typeof element.scrollIntoView === "function") element.scrollIntoView({ block: "start" });
  }, []);
  const pager = usePagination({ scope: "collectionItems", total: detail.data?.items.length, onPageShown: showLectures });
  // Leaving 「调整顺序」 changes the list's length; the scroll waits for that render.
  const scrollOnExit = useRef(false);
  useEffect(() => {
    if (draft === undefined && scrollOnExit.current) {
      scrollOnExit.current = false;
      showLectures();
    }
  }, [draft, showLectures]);
  const leaveReorder = (): void => {
    scrollOnExit.current = true;
    setDraft(undefined);
  };
  const saveOrder = useMutation({
    mutationFn: (itemIds: string[]) => client.put(`${path}/items/order`, collectionDetailDtoSchema, { body: { itemIds } }),
    onSuccess: async (updated) => {
      queryClient.setQueryData(queryKeys.collection(id), updated);
      leaveReorder();
      await queryClient.invalidateQueries({ queryKey: summaryKey(id) });
    },
    onError: async (caught) => {
      // The body is always a well-formed id list, so the only invalid request is a draft whose
      // members no longer match the collection (a lecture added or removed meanwhile): the
      // draft cannot be saved, so it is dropped for the current lectures. Any other failure
      // keeps the draft for another try.
      if (appErrorOf(caught).code !== "invalid_request") return;
      setOrderChanged(true);
      leaveReorder();
      await queryClient.invalidateQueries({ queryKey: queryKeys.collection(id) });
    },
  });
  // A click starts the summary at once; a refusal (e.g. lectures without a core summary) shows inline.
  const summarize = useMutation({
    mutationFn: () => {
      const modelRef = settings.data?.defaultModelRef;
      return client.post(`${path}/summary`, taskAcceptedDtoSchema, { body: modelRef === undefined ? {} : { modelRef }, idempotent: true });
    },
    onSuccess: () => queryClient.invalidateQueries({ queryKey: summaryKey(id) }),
  });
  const summarizing = summary.data?.activeTaskId !== undefined || summarize.isPending;
  // Deleting the summary unfreezes the member summary revisions it was built from, so every
  // summary history list is read again; the card waits for its own data before closing.
  const deleteSummary = async (): Promise<void> => {
    await client.delete(`${path}/summary`, z.undefined());
    summarize.reset();
    void queryClient.invalidateQueries({ queryKey: ["summary-revisions"] });
    await queryClient.invalidateQueries({ queryKey: summaryKey(id) });
  };
  const actions = useCollectionActions(
    { id, name: detail.data?.name ?? "" },
    { ownPage: true, inlineEdit: () => setEditing("name"), summarize: () => summarize.mutate(), summarizeDisabled: summarizing },
  );
  // The lectures' dialogs live here, not in the list: removing the last lecture through
  // 「合集归属」 empties the list, and the dialog must outlive it.
  const lectureActions = useContentActions();
  // The header 「⋯」 keeps its own order: delete, then export.
  const overflow = (["delete", "export"] as const).flatMap((actionId): CollectionAction[] => {
    const entry = actions.action(actionId);
    return entry === undefined ? [] : [entry];
  });

  // Member statuses and the summary task advance through task events. Stage and unit events
  // are ignored: what the lecture list and summary card read is written by the task projection
  // refresh or a stage's publish transaction, which relies on the stage graph being a chain to
  // always come with `task.updated` / `task.finished` (a stage's success moves the projection).
  useEffect(
    () =>
      hub.onEvent((event) => {
        if (event.type !== "task.updated" && event.type !== "task.finished") {
          return;
        }
        void queryClient.invalidateQueries({ queryKey: queryKeys.collection(id) });
        if (event.type === "task.finished") {
          void queryClient.invalidateQueries({ queryKey: queryKeys.contentsAll });
        }
      }),
    [hub, queryClient, id],
  );

  if (detail.isPending) {
    return <Loading />;
  }
  if (detail.isError) {
    return (
      <div className="p-6">
        <ErrorView error={appErrorOf(detail.error)} />
      </div>
    );
  }
  const collection = detail.data;
  const reordering = draft !== undefined;
  const enterReorder = (): void => {
    saveOrder.reset();
    setOrderChanged(false);
    setDraft(collection.items.map((item) => item.id));
  };
  const cancelReorder = (): void => {
    saveOrder.reset();
    leaveReorder();
  };

  return (
    <div className="flex h-full flex-col">
      <PageHeader
        title={<CollectionName collection={collection} editing={editing !== undefined} onEdit={() => setEditing("name")} menu={() => actions.menu("context")} />}
        actions={
          <>
            <Button onClick={() => actions.action("batch-add")?.onSelect()}>
              <Plus size={14} />
              {t("library.collection.batchAdd")}
            </Button>
            <Button onClick={() => summarize.mutate()} disabled={summarizing} data-testid="collection-summarize">
              <RefreshCw size={14} />
              {t("library.collection.summarize")}
            </Button>
            <DropdownMenu.Root>
              <DropdownMenu.Trigger asChild>
                <Button variant="ghost" aria-label={t("library.collection.more")}>
                  <MoreHorizontal size={16} />
                </Button>
              </DropdownMenu.Trigger>
              <DropdownMenu.Portal>
                <DropdownMenu.Content align="end" className={MENU_CONTENT_CLASS}>
                  <MenuEntries entries={overflow} testIdPrefix="collection-" />
                </DropdownMenu.Content>
              </DropdownMenu.Portal>
            </DropdownMenu.Root>
          </>
        }
      />
      <div className="min-h-0 flex-1 overflow-auto p-6">
        <div className="mx-auto flex max-w-7xl flex-col gap-6">
          {editing === undefined ? (
            <CollectionDescription description={collection.description} onEdit={() => setEditing("description")} />
          ) : (
            <section className="rounded-lg border border-line bg-surface p-4" data-testid="collection-edit-card">
              <CollectionEditForm collection={collection} focus={editing} onDone={() => setEditing(undefined)} />
            </section>
          )}
          {actions.exportError === undefined ? null : <ErrorView error={actions.exportError} />}
          {summarize.error === null ? null : <SummaryError error={appErrorOf(summarize.error)} items={collection.items} />}
          {summary.isPending ? (
            <Loading />
          ) : summary.isError ? (
            <ErrorView error={appErrorOf(summary.error)} />
          ) : (
            <SummaryCard
              collectionId={id}
              summary={summary.data}
              latestTask={latestSummaryTask.data}
              onGenerate={() => summarize.mutate()}
              generating={summarize.isPending}
              onDelete={deleteSummary}
            />
          )}
          <section ref={lecturesRef} className="scroll-mt-6">
            <div className="mb-2 flex items-center justify-between gap-3">
              <h2 className="text-sm font-semibold">{t("library.collection.items")}</h2>
              {reordering ? (
                <div className="flex items-center gap-2">
                  <Button size="sm" onClick={cancelReorder} disabled={saveOrder.isPending}>
                    {t("library.collection.reorderCancel")}
                  </Button>
                  <Button size="sm" variant="primary" onClick={() => saveOrder.mutate(draft)} disabled={saveOrder.isPending}>
                    {t("library.collection.reorderSave")}
                  </Button>
                </div>
              ) : (
                <div className="flex items-center gap-2">
                  {found.active || collection.items.length < 2 ? null : (
                    <Button size="sm" onClick={enterReorder}>
                      <ArrowUpDown size={14} />
                      {t("library.collection.reorder")}
                    </Button>
                  )}
                  <input
                    className="h-8 w-48 rounded-md border border-line bg-surface px-2 text-sm"
                    type="search"
                    placeholder={t("search.collectionPlaceholder")}
                    aria-label={t("search.collectionPlaceholder")}
                    value={query}
                    onChange={(event) => setQuery(event.target.value)}
                    data-testid="collection-search"
                  />
                  <Button size="sm" onClick={() => setTerminology(true)}>
                    <BookA size={14} />
                    {t("library.collection.terminology")}
                  </Button>
                </div>
              )}
            </div>
            {reordering ? <p className="mb-2 text-sm text-muted">{t("library.collection.reorderHint")}</p> : null}
            {orderChanged && !reordering ? (
              <p className="mb-2 rounded-md border border-danger/40 bg-danger/5 p-3 text-sm" role="alert" data-testid="collection-order-changed">
                {t("library.collection.reorderChanged")}
              </p>
            ) : null}
            {reordering && saveOrder.error !== null ? (
              <div className="mb-2">
                <ErrorView error={appErrorOf(saveOrder.error)} />
              </div>
            ) : null}
            {collection.items.length === 0 ? (
              <EmptyState title={t("library.collection.emptyItems")} />
            ) : reordering ? (
              <ReorderList items={collection.items} order={draft} onChange={setDraft} actions={lectureActions} />
            ) : found.active ? (
              <SearchHits items={collection.items} search={found} actions={lectureActions} />
            ) : (
              <ItemList items={pager.slice(collection.items)} startIndex={pager.offset} actions={lectureActions} />
            )}
          </section>
        </div>
      </div>
      {/* The page foot, as on every paged list, however short the lecture list is. */}
      {reordering || found.active ? null : <Pagination pager={pager} className="border-t border-line px-6 py-3" />}

      {actions.dialogs}
      {lectureActions.dialogs}
      <Modal open={terminology} onOpenChange={setTerminology} title={t("library.collection.terminologyTitle")} wide>
        <TerminologyEditor scope={`collection:${id}`} />
      </Modal>
    </div>
  );
}

/**
 * The collection name. Its right-click menu holds the collection's actions; while the edit
 * card is open there is none.
 */
function CollectionName(props: { collection: CollectionDetailDto; editing: boolean; onEdit: () => void; menu: () => MenuEntry[] }) {
  const { t } = useTranslation();
  const menuTarget = useContextMenuTarget<HTMLElement>(() => (props.editing ? undefined : { kind: "object", entries: props.menu() }));
  return (
    <span ref={menuTarget} className="inline-flex items-center gap-2" data-testid="collection-name">
      <span className="truncate">{props.collection.name}</span>
      <button type="button" className="rounded p-1 text-muted hover:bg-sunken" aria-label={t("library.collection.edit")} onClick={props.onEdit}>
        <Pencil size={14} />
      </button>
    </span>
  );
}

/**
 * The description above the summary card; a click edits it, unless the click ended a text
 * selection (the description stays copyable). Without one, an "add description" entry.
 */
function CollectionDescription(props: { description: string | undefined; onEdit: () => void }) {
  const { t } = useTranslation();
  if (props.description === undefined) {
    return (
      <button type="button" className="-mx-1 self-start rounded px-1 text-sm text-muted hover:bg-sunken" onClick={props.onEdit} data-testid="collection-add-description">
        {t("library.collection.addDescription")}
      </button>
    );
  }
  return (
    <div
      role="button"
      tabIndex={0}
      title={t("library.collection.edit")}
      className="-mx-1 cursor-text rounded px-1 text-sm whitespace-pre-wrap text-muted hover:bg-sunken"
      data-testid="collection-description"
      onClick={() => {
        if (window.getSelection()?.isCollapsed === false) return;
        props.onEdit();
      }}
      onKeyDown={(event) => {
        if (event.key === "Enter" || event.key === " ") {
          event.preventDefault();
          props.onEdit();
        }
      }}
    >
      {props.description}
    </div>
  );
}

/** A failed summarize request; lectures without a core summary are named. */
export function SummaryError({ error, items }: { error: AppError; items: readonly CollectionItemDto[] }) {
  const { t } = useTranslation();
  const missing = error.code === "invalid_request.collection_summary_missing" ? error.details?.["missingContentIds"] : undefined;
  if (!Array.isArray(missing)) {
    return <ErrorView error={error} />;
  }
  return (
    <div className="rounded-md border border-danger/40 bg-danger/5 p-3 text-sm" role="alert">
      <p>{t("library.summary.missing")}</p>
      <ul className="mt-1 list-disc pl-5" data-testid="missing-summaries">
        {missing.map((contentId) => {
          const item = items.find((candidate) => candidate.contentId === contentId);
          const index = item === undefined ? -1 : items.indexOf(item);
          return (
            <li key={contentId}>
              {index === -1 ? contentId : `${t("library.collection.lecture", { n: index + 1 })} · ${item?.title ?? t("library.untitled")}`}
            </li>
          );
        })}
      </ul>
    </div>
  );
}
