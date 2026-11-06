import { ChevronDown } from "lucide-react";
import { useEffect, useRef, useState, type FormEvent } from "react";
import { useTranslation } from "react-i18next";
import { useSearchParams } from "react-router";
import { LIST_PAGE_SIZE_DEFAULT } from "../../shared/defaults.ts";
import { isListPageSize, LIST_PAGE_SIZES, type ListPageSize } from "../../shared/list-pagination.ts";
import { Button } from "./button.tsx";

/** Each list page remembers its own page size. */
export type PaginationScope = "library" | "collections" | "collectionItems" | "trash" | "notes" | "usage";

export const PAGE_PARAM = "page";
export const PAGE_SIZE_PARAM = "pageSize";

export function pageSizeStorageKey(scope: PaginationScope): string {
  return `amber.pagination.${scope}.pageSize`;
}

function storedPageSize(scope: PaginationScope): ListPageSize | undefined {
  try {
    const value = Number(localStorage.getItem(pageSizeStorageKey(scope)));
    return isListPageSize(value) ? value : undefined;
  } catch {
    return undefined;
  }
}

/** Storage can be unavailable (private mode): the choice then lasts for the session only. */
function rememberPageSize(scope: PaginationScope, size: ListPageSize): void {
  try {
    localStorage.setItem(pageSizeStorageKey(scope), String(size));
  } catch {
    // Not remembered; the pager keeps working.
  }
}

/** A positive safe integer, or `undefined` for anything else (empty, `0`, `1.5`, `abc`). */
export function parsePositiveInt(raw: string | null): number | undefined {
  if (raw === null || !/^\d+$/.test(raw.trim())) return undefined;
  const value = Number(raw);
  return Number.isSafeInteger(value) && value >= 1 ? value : undefined;
}

export function pageCountOf(total: number, pageSize: number): number {
  return Math.max(1, Math.ceil(total / pageSize));
}

export interface Pager {
  /** 1-based; clamped into range once the total is known. */
  page: number;
  pageSize: ListPageSize;
  /** `undefined` until the list has answered once. */
  total: number | undefined;
  pageCount: number | undefined;
  /** Rows before this page, for numbering and client-side slicing. */
  offset: number;
  setPage(page: number): void;
  setPageSize(size: ListPageSize): void;
  /** This page's rows of a list that arrived whole. */
  slice<T>(items: readonly T[]): T[];
}

export interface PaginationOptions {
  scope: PaginationScope;
  /** Matching rows in all pages; `undefined` while unknown. */
  total: number | undefined;
  /**
   * The total belongs to a previous page's answer still on screen; the pager shows it, but
   * the URL is not normalized against it.
   */
  totalStale?: boolean;
  /** Runs after the page or page size changed (not on first render), e.g. to scroll back to the list's top. */
  onPageShown?: () => void;
}

function positionOf(search: URLSearchParams, scope: PaginationScope): { page: number; pageSize: ListPageSize } {
  const urlPageSize = parsePositiveInt(search.get(PAGE_SIZE_PARAM));
  return {
    page: parsePositiveInt(search.get(PAGE_PARAM)) ?? 1,
    pageSize: urlPageSize !== undefined && isListPageSize(urlPageSize) ? urlPageSize : (storedPageSize(scope) ?? LIST_PAGE_SIZE_DEFAULT),
  };
}

/**
 * The page a server-paged list requests, read from the URL before any total is known: the
 * URL's page size wins over the page's remembered one, which wins over
 * `LIST_PAGE_SIZE_DEFAULT`. A page past the end answers empty with the total, and
 * `usePagination` then moves the URL to the last page.
 */
export function useListPosition(scope: PaginationScope): { page: number; pageSize: ListPageSize } {
  const [search] = useSearchParams();
  return positionOf(search, scope);
}

/**
 * Page state of a list page, kept in the URL as `page` + `pageSize`. Once
 * the total is known an out-of-range or malformed `page` and a malformed `pageSize` are
 * rewritten in place (`replace`), never before.
 */
export function usePagination(options: PaginationOptions): Pager {
  const { scope, total, totalStale = false, onPageShown } = options;
  const [search, setSearch] = useSearchParams();

  const rawPage = search.get(PAGE_PARAM);
  const rawPageSize = search.get(PAGE_SIZE_PARAM);
  const { page: requested, pageSize } = positionOf(search, scope);
  const pageCount = total === undefined ? undefined : pageCountOf(total, pageSize);
  const page = pageCount === undefined ? requested : Math.min(requested, pageCount);

  const settled = total !== undefined && !totalStale;
  useEffect(() => {
    if (!settled) return;
    const pageWrong = rawPage !== null && parsePositiveInt(rawPage) !== page;
    const sizeWrong = rawPageSize !== null && String(pageSize) !== rawPageSize;
    const sizeMissing = rawPage !== null && page !== 1 && rawPageSize === null;
    if (!pageWrong && !sizeWrong && !sizeMissing) return;
    setSearch(
      (previous) => {
        const next = new URLSearchParams(previous);
        if (page === 1) next.delete(PAGE_PARAM);
        else next.set(PAGE_PARAM, String(page));
        if (next.has(PAGE_PARAM) || next.has(PAGE_SIZE_PARAM)) next.set(PAGE_SIZE_PARAM, String(pageSize));
        return next;
      },
      { replace: true },
    );
  }, [settled, rawPage, rawPageSize, page, pageSize, setSearch]);

  const shownRef = useRef(onPageShown);
  shownRef.current = onPageShown;
  const shownKey = `${page}/${pageSize}`;
  const lastShown = useRef(shownKey);
  useEffect(() => {
    if (lastShown.current === shownKey) return;
    lastShown.current = shownKey;
    shownRef.current?.();
  }, [shownKey]);

  const offset = (page - 1) * pageSize;
  return {
    page,
    pageSize,
    total,
    pageCount,
    offset,
    setPage(target) {
      const clamped = Math.max(1, pageCount === undefined ? target : Math.min(target, pageCount));
      setSearch((previous) => {
        const next = new URLSearchParams(previous);
        if (clamped === 1) next.delete(PAGE_PARAM);
        else next.set(PAGE_PARAM, String(clamped));
        next.set(PAGE_SIZE_PARAM, String(pageSize));
        return next;
      });
    },
    setPageSize(size) {
      rememberPageSize(scope, size);
      setSearch((previous) => {
        const next = new URLSearchParams(previous);
        next.delete(PAGE_PARAM);
        next.set(PAGE_SIZE_PARAM, String(size));
        return next;
      });
    },
    slice(items) {
      return items.slice(offset, offset + pageSize);
    },
  };
}

const BOX = "inline-flex h-9 shrink-0 items-center justify-center whitespace-nowrap rounded-md border border-line bg-surface px-3 text-sm";

/**
 * The pager under a list: total · page size · previous · current page ·
 * next · jump. Shown with the same controls whenever the list has a row, even on a single
 * page; hidden while the total is unknown and when the list is empty.
 */
export function Pagination({ pager, className = "" }: { pager: Pager; className?: string }) {
  const { t } = useTranslation();
  const [jump, setJump] = useState("");
  const { total, pageCount, page } = pager;
  useEffect(() => setJump(""), [total]);

  if (total === undefined || pageCount === undefined || total === 0) return null;

  const submitJump = (event: FormEvent): void => {
    event.preventDefault();
    const target = Number(jump.trim());
    if (jump.trim() === "" || !Number.isSafeInteger(target)) return;
    pager.setPage(Math.min(Math.max(target, 1), pageCount));
    setJump("");
  };

  return (
    <nav aria-label={t("common.pagination.label")} className={`flex flex-wrap items-center justify-center gap-2 ${className}`}>
      <span className="text-sm text-muted">{t("common.pagination.total", { count: total })}</span>
      {/* Equal side padding centres the label; the drawn arrow sits midway between the label and the right border. */}
      <span className="relative inline-flex shrink-0">
        <select
          aria-label={t("common.pagination.pageSizeLabel")}
          className={`${BOX} cursor-pointer appearance-none px-5 [text-align-last:center]`}
          value={pager.pageSize}
          onChange={(event) => {
            const size = Number(event.target.value);
            if (isListPageSize(size)) pager.setPageSize(size);
          }}
        >
          {LIST_PAGE_SIZES.map((size) => (
            <option key={size} value={size}>
              {t("common.pagination.pageSize", { size })}
            </option>
          ))}
        </select>
        <ChevronDown size={12} aria-hidden="true" className="pointer-events-none absolute top-1/2 right-[4.5px] -translate-y-1/2 text-muted" />
      </span>
      <Button disabled={page <= 1} onClick={() => pager.setPage(page - 1)}>
        {t("common.pagination.previous")}
      </Button>
      <span className={BOX} aria-current="page">
        {t("common.pagination.current", { page, count: pageCount })}
      </span>
      <Button disabled={page >= pageCount} onClick={() => pager.setPage(page + 1)}>
        {t("common.pagination.next")}
      </Button>
      {/* noValidate: the browser would block an out-of-range page instead of letting it clamp. */}
      <form className="flex items-center gap-2" noValidate onSubmit={submitJump}>
        <input
          type="number"
          inputMode="numeric"
          min={1}
          max={pageCount}
          step={1}
          aria-label={t("common.pagination.jumpLabel")}
          placeholder={t("common.pagination.jumpPlaceholder")}
          // Centered, so the browser's spin buttons (shown on hover) are hidden: they would push the number aside.
          className={`${BOX} w-20 px-2 text-center [appearance:textfield] [&::-webkit-inner-spin-button]:appearance-none [&::-webkit-outer-spin-button]:appearance-none`}
          value={jump}
          onChange={(event) => setJump(event.target.value)}
        />
        <Button type="submit">{t("common.pagination.jump")}</Button>
      </form>
    </nav>
  );
}
