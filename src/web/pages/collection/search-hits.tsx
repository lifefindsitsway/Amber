import { useTranslation } from "react-i18next";
import type { CollectionItemDto } from "../../../shared/dto/collection.ts";
import { ErrorView } from "../../components/error-view.tsx";
import type { ContentActions } from "../../components/use-content-actions.tsx";
import { hitsByContent, type useSearch } from "../../search/search.ts";
import { EmptyState, Loading } from "../../ui/feedback.tsx";
import { appErrorOf } from "../../components/confirm-dialog.tsx";
import { ItemRow, ItemTable, useItemMenu } from "./item-list.tsx";

/**
 * The members a collection-scoped search hit, best first, each with one excerpt, in the
 * member table's columns. Ordering by relevance replaces the collection order while a query
 * is in effect, so nothing here can be dragged; each row still shows its place in the
 * collection. A right click on a hit offers the Content's actions, its "open" following the
 * excerpt when the click was on it.
 */
export function SearchHits(props: {
  items: readonly CollectionItemDto[];
  search: ReturnType<typeof useSearch>;
  /** The Content actions of the page, which renders their dialogs. */
  actions: ContentActions;
}) {
  const { t } = useTranslation();
  const { search } = props;
  const menuRef = useItemMenu(props.items, props.actions);
  if (search.data === undefined) {
    return search.isError ? <ErrorView error={appErrorOf(search.error)} /> : <Loading />;
  }
  const memberOf = new Map(props.items.map((item, index) => [item.contentId, { item, index }]));
  const hits = hitsByContent(search.data).flatMap((hit) => {
    const member = memberOf.get(hit.contentId);
    return member === undefined ? [] : [{ ...hit, ...member }];
  });
  if (hits.length === 0) {
    return <EmptyState title={t("search.empty")} hint={t("search.emptyHint")} />;
  }
  return (
    <ItemTable bodyRef={menuRef}>
      {hits.map(({ item, index, first }) => (
        <ItemRow key={item.id} item={item} number={index + 1} hit={{ entry: first, query: search.query }} testId="collection-hit" />
      ))}
    </ItemTable>
  );
}
