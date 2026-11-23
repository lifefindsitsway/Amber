import { useQuery, useQueryClient } from "@tanstack/react-query";
import { FolderOpen } from "lucide-react";
import { useLayoutEffect, useRef, useState, type FormEvent } from "react";
import { useTranslation } from "react-i18next";
import { z } from "zod";
import { collectionDtoSchema, collectionItemDtoSchema, collectionListDtoSchema } from "../../shared/dto/collection.ts";
import { contentDetailDtoSchema } from "../../shared/dto/content.ts";
import { ApiError } from "../api/client.ts";
import { useApi } from "../api/context.tsx";
import { queryKeys } from "../api/queries.ts";
import { Button } from "../ui/button.tsx";
import { Checkbox } from "../ui/checkbox.tsx";
import { EmptyState, SkeletonRows } from "../ui/feedback.tsx";
import { Modal } from "../ui/modal.tsx";
import { isComposingEnter, TextInput } from "../ui/text-field.tsx";
import { ErrorView } from "./error-view.tsx";

/**
 * Which collections one Content belongs to: ticking adds it, unticking
 * removes the membership only, and a new collection can be created and joined at once.
 * Shared by the library row, the content page toolbar and the sidebar row menu.
 *
 * The list scrolls on its own while the creation form and any error stay in the footer, so a
 * long list never pushes them out of reach.
 */
export function CollectionMembershipDialog(props: { contentId: string | undefined; onOpenChange: (open: boolean) => void }) {
  const { t } = useTranslation();
  const client = useApi();
  const queryClient = useQueryClient();
  const { contentId } = props;
  const open = contentId !== undefined;

  // Every opening (or another Content) starts clean: no locked rows, no leftover name or error.
  const [shownFor, setShownFor] = useState(contentId);
  const [opening, setOpening] = useState(0);
  const [pending, setPending] = useState<ReadonlySet<string>>(new Set());
  const [error, setError] = useState<unknown>(undefined);
  const [name, setName] = useState("");
  const [creating, setCreating] = useState(false);
  if (contentId !== shownFor) {
    setShownFor(contentId);
    setOpening((current) => current + 1);
    if (contentId !== undefined) {
      setPending(new Set());
      setError(undefined);
      setName("");
      setCreating(false);
    }
  }
  // The dialog stays mounted between openings, so an answer can arrive after it was closed or
  // reopened for another Content (or the same one afresh). Such an answer belongs to an opening
  // that is gone: it must not show its error, unlock rows or clear the name in this one.
  const currentOpening = useRef(opening);
  useLayoutEffect(() => {
    currentOpening.current = opening;
  }, [opening]);
  const stillOpen = (startedIn: number): boolean => currentOpening.current === startedIn;

  // Read only while open: the dialog stays mounted with its opener. Same keys and schemas as
  // the content page and the collection list, so they share one cached copy.
  const content = useQuery({
    queryKey: queryKeys.content(contentId ?? ""),
    queryFn: () => client.get(`/api/contents/${encodeURIComponent(contentId ?? "")}`, contentDetailDtoSchema),
    enabled: open,
  });
  const collections = useQuery({ queryKey: queryKeys.collections, queryFn: () => client.get("/api/collections", collectionListDtoSchema), enabled: open });
  const ready = open && content.data !== undefined && collections.data !== undefined;

  const refresh = async (target: string, collectionId: string): Promise<void> => {
    await Promise.all([
      // Exact: the chapters, summaries and tasks keyed under the content do not show membership.
      queryClient.invalidateQueries({ queryKey: queryKeys.content(target), exact: true }),
      queryClient.invalidateQueries({ queryKey: queryKeys.contentsAll }),
      queryClient.invalidateQueries({ queryKey: queryKeys.collections }),
      queryClient.invalidateQueries({ queryKey: queryKeys.collection(collectionId) }),
    ]);
  };
  const join = (target: string, collectionId: string): Promise<unknown> =>
    client.post(`/api/collections/${encodeURIComponent(collectionId)}/items`, collectionItemDtoSchema, { body: { contentId: target } });

  // A row stays locked until the refreshed detail shows the new state: a second click on a
  // membership already removed would only answer 404.
  const toggle = async (target: string, collectionId: string, itemId: string | undefined): Promise<void> => {
    const startedIn = opening;
    setPending((current) => new Set(current).add(collectionId));
    setError(undefined);
    try {
      if (itemId === undefined) {
        await join(target, collectionId);
      } else {
        await client.delete(`/api/collections/${encodeURIComponent(collectionId)}/items/${encodeURIComponent(itemId)}`, z.undefined());
      }
      await refresh(target, collectionId);
    } catch (caught) {
      if (stillOpen(startedIn)) setError(caught);
    } finally {
      if (stillOpen(startedIn)) {
        setPending((current) => {
          const next = new Set(current);
          next.delete(collectionId);
          return next;
        });
      }
    }
  };

  const create = async (event: FormEvent): Promise<void> => {
    event.preventDefault();
    if (contentId === undefined || !ready || name.trim() === "" || creating) return;
    const startedIn = opening;
    setCreating(true);
    setError(undefined);
    try {
      const collection = await client.post("/api/collections", collectionDtoSchema, { body: { name: name.trim() } });
      await join(contentId, collection.id);
      await refresh(contentId, collection.id);
      if (stillOpen(startedIn)) setName("");
    } catch (caught) {
      if (stillOpen(startedIn)) setError(caught);
    } finally {
      if (stillOpen(startedIn)) setCreating(false);
    }
  };

  const failed = content.error ?? collections.error;
  let body;
  if (contentId === undefined) {
    body = null;
  } else if (content.data === undefined || collections.data === undefined) {
    body = failed instanceof ApiError ? <ErrorView error={failed.error} /> : <SkeletonRows count={3} rowHeight={32} gap={4} />;
  } else if (collections.data.items.length === 0) {
    body = <EmptyState icon={<FolderOpen size={28} />} title={t("library.membership.empty")} />;
  } else {
    const memberships = new Map(content.data.collections.map((membership) => [membership.id, membership.itemId]));
    body = (
      <ul className="flex flex-col gap-1" data-testid="membership-list">
        {collections.data.items.map((collection) => {
          const itemId = memberships.get(collection.id);
          return (
            <li key={collection.id}>
              <Checkbox
                checked={itemId !== undefined}
                disabled={pending.has(collection.id)}
                onChange={() => void toggle(contentId, collection.id, itemId)}
                labelClassName="w-full rounded px-2 py-1.5 hover:bg-sunken"
              >
                <span className="block truncate">{collection.name}</span>
              </Checkbox>
            </li>
          );
        })}
      </ul>
    );
  }

  return (
    <Modal
      open={open}
      onOpenChange={props.onOpenChange}
      title={t("library.membership.title")}
      description={t("library.membership.intro")}
      testId="collection-membership-dialog"
      footer={
        <>
          {error instanceof ApiError ? (
            <div className="basis-full">
              <ErrorView error={error.error} />
            </div>
          ) : null}
          {/* Disabled rather than absent until the lists load, so the footer never changes shape. */}
          <form onSubmit={(event) => void create(event)} className="flex min-w-0 flex-1 gap-2">
            <TextInput
              aria-label={t("library.membership.newName")}
              placeholder={t("library.membership.newName")}
              value={name}
              disabled={!ready}
              onChange={(event) => setName(event.target.value)}
              // The Enter that picks an input-method candidate must not also submit the form.
              onKeyDown={(event) => {
                if (event.key === "Enter" && isComposingEnter(event)) event.preventDefault();
              }}
              className="flex-1"
            />
            <Button type="submit" variant="primary" loading={creating} disabled={!ready || name.trim() === ""}>
              {t("library.membership.create")}
            </Button>
          </form>
        </>
      }
    >
      {body}
    </Modal>
  );
}
