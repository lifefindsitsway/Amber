import { GripVertical } from "lucide-react";
import type { ReactNode } from "react";
import { useTranslation } from "react-i18next";
import { Link, useParams } from "react-router";
import type { CollectionItemDto } from "../../../shared/dto/collection.ts";
import { actionTarget, type ContentActions } from "../../components/use-content-actions.tsx";
import { formatDateTime, formatDuration } from "../../format.ts";
import { listLoopState } from "../../player/list-loop.ts";
import { HitSnippet } from "../../search/hit-snippet.tsx";
import type { ContentSideHit } from "../../search/search.ts";
import { COLUMN, COMPACT_UP, Cover, NARROW, StatusBadge, WIDE_ONLY } from "../library-page.tsx";
import { useContextMenuTarget } from "../../ui/context-menu.tsx";
import { useDragOrder } from "../../ui/use-drag-order.ts";

/**
 * Members of one page in collection order. `startIndex` is the position of the first row
 * in the whole collection, so a member keeps its number on every page. Nothing here
 * moves: reordering happens in `ReorderList`, which always shows every member. A right
 * click on a row offers the Content's actions; leaving the collection goes through their
 * collection membership dialog, so a row has no removal control of its own.
 */
export function ItemList(props: {
  items: readonly CollectionItemDto[];
  startIndex: number;
  /** The Content actions of the page, which renders their dialogs. */
  actions: ContentActions;
}) {
  const menuRef = useItemMenu(props.items, props.actions);
  return (
    <ItemTable bodyRef={menuRef}>
      {props.items.map((item, index) => (
        <ItemRow key={item.id} item={item} number={props.startIndex + index + 1} />
      ))}
    </ItemTable>
  );
}

/**
 * The draft order of all members while the user rearranges them, in the same columns as
 * the list with a drag handle in front. Moving uses native pointer events on the handle (no
 * drag-and-drop library) and arrow keys on a focused handle; every finished move hands the
 * complete draft to `onChange` and nothing is sent until the page saves it. Only the primary
 * button drags, so a right click on the handle opens the menu without starting a drag.
 */
export function ReorderList(props: {
  items: readonly CollectionItemDto[];
  order: readonly string[];
  onChange: (order: string[]) => void;
  /** The Content actions of the page, which renders their dialogs. */
  actions: ContentActions;
}) {
  const { t } = useTranslation();
  const { order, dragging, rowRef, handleProps } = useDragOrder(props.order, props.onChange);
  const byId = new Map(props.items.map((item) => [item.id, item]));
  const menuRef = useItemMenu(props.items, props.actions);
  return (
    <ItemTable bodyRef={menuRef} withHandle>
      {order.map((id, index) => {
        const item = byId.get(id);
        if (item === undefined) {
          return null;
        }
        return (
          <ItemRow
            key={id}
            item={item}
            number={index + 1}
            rowRef={rowRef(id)}
            dragging={dragging === id}
            handle={
              <button
                type="button"
                className="cursor-grab touch-none rounded p-1 text-muted hover:bg-sunken"
                aria-label={`${t("library.collection.dragHandle")} · ${item.title ?? t("library.untitled")}`}
                {...handleProps(id)}
              >
                <GripVertical size={14} />
              </button>
            }
          />
        );
      })}
    </ItemTable>
  );
}

/**
 * The member table: a header and one row per member, its columns folding at the content
 * list's widths. The container query measures this table's own box, so the folding follows
 * the collection page's column rather than the window.
 */
export function ItemTable(props: { bodyRef: (element: HTMLTableSectionElement | null) => void; withHandle?: boolean; children: ReactNode }) {
  const { t } = useTranslation();
  return (
    <div className="@container overflow-hidden rounded-lg border border-line" data-testid="collection-items">
      <table className="w-full text-sm">
        <thead className="bg-panel text-left text-xs text-muted">
          <tr>
            {props.withHandle === true ? (
              <th className={`${NARROW} pl-2`}>
                <span className="sr-only">{t("library.collection.dragHandle")}</span>
              </th>
            ) : null}
            <th className={`${NARROW} ${props.withHandle === true ? "pl-1" : "pl-3"} pr-2`}>{t("library.column.position")}</th>
            <th className={`${COMPACT_UP} ${NARROW} px-2`}>{t("library.column.cover")}</th>
            <th className="w-full px-2 py-2 font-medium @5xl:w-[45%]">{t("library.column.title")}</th>
            <th className={`${WIDE_ONLY} ${COLUMN} w-[10%]`}>{t("library.column.source")}</th>
            <th className={`${WIDE_ONLY} ${COLUMN} w-[8%]`}>{t("library.column.duration")}</th>
            <th className={`${COLUMN} w-px whitespace-nowrap @5xl:w-[10%]`}>{t("library.column.status")}</th>
            <th className={`${WIDE_ONLY} ${COLUMN} w-[15%] pr-3 whitespace-nowrap`}>{t("library.column.updatedAt")}</th>
          </tr>
        </thead>
        <tbody ref={props.bodyRef}>{props.children}</tbody>
      </table>
    </div>
  );
}

/** The right-click menu of a member row, resolved through the row's `data-item-id`. */
export function useItemMenu(items: readonly CollectionItemDto[], actions: ContentActions) {
  return useContextMenuTarget<HTMLTableSectionElement>((hit) => {
    const itemId = hit.target.closest<HTMLElement>("[data-item-id]")?.dataset["itemId"];
    const item = items.find((candidate) => candidate.id === itemId);
    if (item === undefined) return undefined;
    const target = actionTarget({ id: item.contentId, title: item.title, pinnedAt: item.pinnedAt, sourceUrl: item.sourceUrl });
    return actions.menu(target, hit);
  });
}

/** One member in the table's columns; a search hit adds its excerpt under the title. */
export function ItemRow(props: {
  item: CollectionItemDto;
  /** 1-based position in the whole collection. */
  number: number;
  handle?: ReactNode;
  rowRef?: (element: HTMLElement | null) => void;
  dragging?: boolean;
  hit?: { entry: ContentSideHit; query: string };
  testId?: string;
}) {
  const { t, i18n } = useTranslation();
  // The collection page's own id: a member opened from here loops through this collection.
  const { id: collectionId } = useParams();
  const { item } = props;
  const duration = item.durationMs === undefined ? undefined : formatDuration(item.durationMs);
  const updatedAt = formatDateTime(item.updatedAt, i18n.language);
  const source = t(`common.source.${item.source.kind}`);
  return (
    <tr
      ref={props.rowRef}
      className={`border-b border-line last:border-b-0 ${props.dragging === true ? "bg-accent-soft" : "bg-surface hover:bg-panel"}`}
      data-testid={props.testId ?? "collection-item"}
      data-item-id={item.id}
    >
      {props.handle === undefined ? null : <td className="w-px py-2 pl-2">{props.handle}</td>}
      <td className={`py-2 ${props.handle === undefined ? "pl-3" : "pl-1"} pr-2 text-xs whitespace-nowrap text-muted`}>
        {t("library.collection.lecture", { n: props.number })}
      </td>
      <td className={`${COMPACT_UP} px-2 py-2`}>
        <Cover url={item.coverUrl} className="h-10 w-16" />
      </td>
      <td className="px-2 py-2">
        <Link
          to={`/contents/${item.contentId}`}
          state={listLoopState(collectionId === undefined ? {} : { collectionId })}
          className="line-clamp-2 font-medium hover:underline"
        >
          {item.title ?? t("library.untitled")}
        </Link>
        {/* The folded columns, shown only while their own cells are hidden. */}
        <p className="mt-0.5 text-xs text-muted @5xl:hidden" data-testid="collection-item-meta">
          {source}
          {duration === undefined ? null : ` · ${duration}`}
          {` · ${updatedAt}`}
        </p>
        {props.hit === undefined ? null : <HitSnippet entry={props.hit.entry} query={props.hit.query} />}
      </td>
      <td className={`${WIDE_ONLY} px-2 py-2 whitespace-nowrap text-muted`}>{source}</td>
      <td className={`${WIDE_ONLY} px-2 py-2 font-mono text-xs whitespace-nowrap text-muted`}>{duration ?? ""}</td>
      <td className="px-2 py-2 whitespace-nowrap">
        <StatusBadge status={item.processingStatus} />
      </td>
      <td className={`${WIDE_ONLY} py-2 pr-3 pl-2 text-xs whitespace-nowrap text-muted`}>{updatedAt}</td>
    </tr>
  );
}
