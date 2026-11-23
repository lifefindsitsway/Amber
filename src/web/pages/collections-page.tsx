import { useQueryClient } from "@tanstack/react-query";
import { FolderOpen, Pencil, Plus } from "lucide-react";
import { useCallback, useRef, useState } from "react";
import { useTranslation } from "react-i18next";
import { Link, useNavigate } from "react-router";
import { collectionDetailDtoSchema, type CollectionDto } from "../../shared/dto/collection.ts";
import { DISPLAY_NAME_MAX_CHARS } from "../../shared/defaults.ts";
import { useApi } from "../api/context.tsx";
import { queryKeys, useCollections } from "../api/queries.ts";
import { useCollectionActions } from "../components/collection/use-collection-actions.tsx";
import { ErrorView } from "../components/error-view.tsx";
import { formatDateTime } from "../format.ts";
import { Button, FOCUS_RING } from "../ui/button.tsx";
import { useContextMenuTarget } from "../ui/context-menu.tsx";
import { EmptyState, PageHeader, SkeletonRows } from "../ui/feedback.tsx";
import { Modal } from "../ui/modal.tsx";
import { Pagination, usePagination } from "../ui/pagination.tsx";
import { TextArea, TextInput } from "../ui/text-field.tsx";
import { Tooltip } from "../ui/tooltip.tsx";
import { appErrorOf } from "../components/confirm-dialog.tsx";
import type { AppError } from "../../shared/errors.ts";

/**
 * Collection list (`/collections`). The API returns every collection, so the
 * cards are paged in the browser; the pager stays at the page foot below the scrolling grid.
 */
export function CollectionsPage() {
  const { t } = useTranslation();
  const collections = useCollections();
  const [creating, setCreating] = useState(false);
  const scrollRef = useRef<HTMLDivElement>(null);
  const toTop = useCallback(() => {
    if (scrollRef.current !== null) scrollRef.current.scrollTop = 0;
  }, []);
  const pager = usePagination({ scope: "collections", total: collections.data?.items.length, onPageShown: toTop });
  return (
    <div className="flex h-full flex-col">
      <PageHeader
        title={t("library.collections.title")}
        actions={
          <Button variant="primary" onClick={() => setCreating(true)}>
            <Plus size={14} />
            {t("library.collections.create")}
          </Button>
        }
      />
      <div ref={scrollRef} className="min-h-0 flex-1 overflow-auto p-6">
        {collections.isPending ? (
          <SkeletonRows count={4} rowHeight={88} gap={12} testId="collections-loading" />
        ) : collections.isError ? (
          <ErrorView error={appErrorOf(collections.error)} />
        ) : collections.data.items.length === 0 ? (
          <EmptyState icon={<FolderOpen size={28} />} title={t("library.collections.empty")} hint={t("library.collections.emptyHint")} />
        ) : (
          <ul className="grid gap-3 sm:grid-cols-2 xl:grid-cols-3">
            {pager.slice(collections.data.items).map((collection) => (
              <CollectionCard key={collection.id} collection={collection} />
            ))}
          </ul>
        )}
      </div>
      <Pagination pager={pager} className="border-t border-line px-6 py-3" />
      <CreateCollectionDialog open={creating} onOpenChange={setCreating} />
    </div>
  );
}

/**
 * One collection; right-click offers the same menu as its sidebar row. The
 * edit button sits beside the card link rather than inside it, so it edits without opening.
 */
function CollectionCard(props: { collection: CollectionDto }) {
  const { t, i18n } = useTranslation();
  const { collection } = props;
  const actions = useCollectionActions(collection);
  const menuTarget = useContextMenuTarget<HTMLLIElement>(() => ({ kind: "object", href: `/collections/${collection.id}`, entries: actions.menu("context") }));
  return (
    <li ref={menuTarget} className="relative">
      <Link to={`/collections/${collection.id}`} className="block h-full rounded-lg border border-line p-4 pr-12 hover:bg-panel" data-testid="collection-card">
        <p className="truncate font-medium">{collection.name}</p>
        {collection.description === undefined ? null : <p className="mt-1 text-sm break-words whitespace-pre-wrap text-muted">{collection.description}</p>}
        <p className="mt-2 text-xs text-muted">
          {t("library.collections.itemCount", { count: collection.itemCount })}
          {" · "}
          {t("library.collections.updatedAt", { date: formatDateTime(collection.updatedAt, i18n.language) })}
        </p>
      </Link>
      <Tooltip content={t("library.collection.edit")}>
        <button
          type="button"
          className={`absolute top-3 right-3 rounded p-1.5 text-muted hover:bg-sunken hover:text-ink ${FOCUS_RING}`}
          aria-label={t("library.collection.edit")}
          data-testid="collection-card-edit"
          onClick={() => actions.action("edit")?.onSelect()}
        >
          <Pencil size={14} aria-hidden="true" />
        </button>
      </Tooltip>
      {actions.dialogs}
    </li>
  );
}

export function CreateCollectionDialog(props: { open: boolean; onOpenChange: (open: boolean) => void }) {
  const { t } = useTranslation();
  const client = useApi();
  const queryClient = useQueryClient();
  const navigate = useNavigate();
  const [name, setName] = useState("");
  const [description, setDescription] = useState("");
  const [error, setError] = useState<AppError | undefined>(undefined);
  const [busy, setBusy] = useState(false);
  const submit = async (): Promise<void> => {
    setBusy(true);
    setError(undefined);
    try {
      const created = await client.post("/api/collections", collectionDetailDtoSchema, {
        body: { name: name.trim(), ...(description.trim() === "" ? {} : { description: description.trim() }) },
      });
      await queryClient.invalidateQueries({ queryKey: queryKeys.collections });
      props.onOpenChange(false);
      setName("");
      setDescription("");
      void navigate(`/collections/${created.id}`);
    } catch (caught) {
      setError(appErrorOf(caught));
    } finally {
      setBusy(false);
    }
  };
  return (
    <Modal open={props.open} onOpenChange={props.onOpenChange} title={t("library.collections.createTitle")}>
      <form
        className="flex flex-col gap-3"
        onSubmit={(event) => {
          event.preventDefault();
          void submit();
        }}
      >
        <label className="flex flex-col gap-1.5 text-sm">
          {t("library.collections.nameLabel")}
          <TextInput value={name} maxLength={DISPLAY_NAME_MAX_CHARS} onChange={(event) => setName(event.target.value)} autoFocus />
        </label>
        <label className="flex flex-col gap-1.5 text-sm">
          {t("library.collections.descriptionLabel")}
          <TextArea className="min-h-16" value={description} onChange={(event) => setDescription(event.target.value)} />
        </label>
        {error === undefined ? null : <ErrorView error={error} />}
        <div className="flex justify-end gap-2">
          <Button onClick={() => props.onOpenChange(false)}>{t("common.action.cancel")}</Button>
          <Button type="submit" variant="primary" disabled={busy || name.trim() === ""}>
            {t("common.action.create")}
          </Button>
        </div>
      </form>
    </Modal>
  );
}
