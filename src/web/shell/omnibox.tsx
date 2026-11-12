import { Command } from "cmdk";
import { Dialog, VisuallyHidden } from "radix-ui";
import { FileText, FolderOpen, Link2, PlayCircle, Quote, TerminalSquare } from "lucide-react";
import { useState } from "react";
import { useTranslation } from "react-i18next";
import { API_PAGE_SIZE_MAX, SEARCH_GROUP_LIMIT } from "../../shared/defaults.ts";
import { useCollections, useContents } from "../api/queries.ts";
import { COMMANDS, type CommandContext } from "../commands.ts";
import { formatDuration } from "../format.ts";
import { SpeakerAvatar } from "../pages/content/speakers/speaker-avatar.tsx";
import { Highlighted } from "../search/highlighted.tsx";
import { BasisChangedMark, HitSpeaker, speakerHitSubject } from "../search/hit-speaker.tsx";
import { hitLink, speakerHitLink, summaryBasisChanged, useSearch } from "../search/search.ts";
import { useShortcutRegistry } from "../shortcut-registry.tsx";
import { parseOmniboxQuery, recentItems } from "./omnibox-search.ts";

const ITEM = "flex cursor-pointer items-center gap-2 rounded-md px-2 py-1.5 text-sm data-[selected=true]:bg-sunken";
const GROUP = "px-1 py-1 text-xs text-muted [&_[cmdk-group-heading]]:px-2 [&_[cmdk-group-heading]]:py-1";

/** Search-first command palette: typed text searches everything (`scope=global`), `>` runs commands. */
export function Omnibox(props: { open: boolean; onOpenChange: (open: boolean) => void; context: CommandContext }) {
  const { t } = useTranslation();
  return (
    <Dialog.Root open={props.open} onOpenChange={props.onOpenChange}>
      <Dialog.Portal>
        <Dialog.Overlay className="fixed inset-0 z-40 bg-black/30" />
        <Dialog.Content aria-describedby={undefined} className="fixed top-[14vh] left-1/2 z-50 w-[92vw] max-w-xl -translate-x-1/2 overflow-hidden rounded-lg border border-line bg-surface shadow-xl">
          <VisuallyHidden.Root>
            <Dialog.Title>{t("shell.omnibox.label")}</Dialog.Title>
          </VisuallyHidden.Root>
          {props.open ? <OmniboxBody context={props.context} close={() => props.onOpenChange(false)} /> : null}
        </Dialog.Content>
      </Dialog.Portal>
    </Dialog.Root>
  );
}

function OmniboxBody(props: { context: CommandContext; close: () => void }) {
  const { t } = useTranslation();
  const registry = useShortcutRegistry();
  const [input, setInput] = useState("");
  const query = parseOmniboxQuery(input);
  const run = (action: () => void): void => {
    props.close();
    action();
  };

  const commands = COMMANDS.filter((command) => query.text === "" || t(command.titleKey).toLocaleLowerCase().includes(query.text.toLocaleLowerCase()));

  return (
    <Command data-testid="omnibox" label={t("shell.omnibox.label")} shouldFilter={false} loop>
      <Command.Input
        value={input}
        onValueChange={setInput}
        placeholder={t("shell.omnibox.placeholder")}
        className="h-12 w-full border-b border-line bg-transparent px-4 text-sm outline-none"
      />
      <Command.List className="max-h-[50vh] overflow-auto p-2">
        {query.mode === "command" ? (
          commands.length === 0 ? (
            <p className="px-2 py-6 text-center text-sm text-muted">{t("shell.omnibox.empty")}</p>
          ) : (
            <Command.Group heading={t("shell.omnibox.commands")} className={GROUP}>
              {commands.map((command) => (
                <Command.Item key={command.id} value={command.id} className={ITEM} onSelect={() => run(() => command.run(props.context))}>
                  <TerminalSquare size={14} className="text-muted" aria-hidden="true" />
                  <span className="flex-1 text-ink">{t(command.titleKey)}</span>
                  {command.shortcut === undefined ? null : <kbd className="font-mono text-xs text-muted">{registry.binding(command.shortcut)}</kbd>}
                </Command.Item>
              ))}
            </Command.Group>
          )
        ) : query.text === "" ? (
          <RecentGroups context={props.context} run={run} />
        ) : (
          <SearchGroups text={query.text} context={props.context} run={run} />
        )}
      </Command.List>
    </Command>
  );
}

interface GroupProps {
  context: CommandContext;
  run: (action: () => void) => void;
}

/** Before anything is typed: recent Contents and the collections. */
function RecentGroups(props: GroupProps) {
  const { t } = useTranslation();
  const contents = useContents({ limit: API_PAGE_SIZE_MAX });
  const collections = useCollections();
  const recent = recentItems(contents.data?.items ?? [], collections.data?.items ?? [], SEARCH_GROUP_LIMIT);
  if (recent.contents.length === 0 && recent.collections.length === 0) {
    return contents.isPending || collections.isPending ? null : <EmptySearch {...props} />;
  }
  return (
    <>
      {recent.contents.length === 0 ? null : (
        <Command.Group heading={t("shell.omnibox.contents")} className={GROUP}>
          {recent.contents.map((content) => (
            <Command.Item key={content.id} value={`content:${content.id}`} className={ITEM} onSelect={() => props.run(() => props.context.navigate(`/contents/${content.id}`))}>
              <PlayCircle size={14} className="text-muted" aria-hidden="true" />
              <span className="truncate text-ink">{content.title ?? t("shell.sidebar.untitled")}</span>
            </Command.Item>
          ))}
        </Command.Group>
      )}
      {recent.collections.length === 0 ? null : (
        <Command.Group heading={t("shell.omnibox.collections")} className={GROUP}>
          {recent.collections.map((collection) => (
            <Command.Item
              key={collection.id}
              value={`collection:${collection.id}`}
              className={ITEM}
              onSelect={() => props.run(() => props.context.navigate(`/collections/${collection.id}`))}
            >
              <FolderOpen size={14} className="text-muted" aria-hidden="true" />
              <span className="truncate text-ink">{collection.name}</span>
            </Command.Item>
          ))}
        </Command.Group>
      )}
    </>
  );
}

/** Typed text: the four groups of the search service, each opening where its hit is. */
function SearchGroups(props: GroupProps & { text: string }) {
  const { t } = useTranslation();
  const search = useSearch(props.text, "global");
  const result = search.data;
  const go = (path: string): void => props.run(() => props.context.navigate(path));
  if (result === undefined) {
    return <p className="px-2 py-6 text-center text-sm text-muted">{search.isError ? t("search.failed") : t("search.searching")}</p>;
  }
  const speakers = result.speakers ?? [];
  const total = result.contents.length + result.segments.length + result.summaries.length + result.collections.length + speakers.length;
  if (total === 0) {
    return search.isFetching ? <p className="px-2 py-6 text-center text-sm text-muted">{t("search.searching")}</p> : <EmptySearch {...props} />;
  }
  const q = search.query;
  return (
    <>
      {result.contents.length === 0 ? null : (
        <Command.Group heading={t("search.group.contents")} className={GROUP} data-testid="omnibox-group-contents">
          {result.contents.map((hit) => (
            <Command.Item key={`content:${hit.contentId}:${hit.matchedIn}`} value={`content:${hit.contentId}:${hit.matchedIn}`} className={ITEM} onSelect={() => go(hitLink({ kind: "content", hit }, q))}>
              <PlayCircle size={14} className="shrink-0 text-muted" aria-hidden="true" />
              <span className="min-w-0 flex-1 truncate text-ink">
                {hit.matchedIn === "title" ? <Highlighted text={hit.snippet} ranges={hit.ranges} /> : (hit.title ?? t("search.untitled"))}
              </span>
              {hit.matchedIn === "reference" ? <Highlighted text={hit.snippet} ranges={hit.ranges} className="max-w-[50%] truncate text-xs text-muted" /> : null}
            </Command.Item>
          ))}
        </Command.Group>
      )}
      {result.segments.length === 0 ? null : (
        <Command.Group heading={t("search.group.segments")} className={GROUP} data-testid="omnibox-group-segments">
          {result.segments.map((hit) => (
            <Command.Item key={`segment:${hit.segmentId}`} value={`segment:${hit.segmentId}`} className={ITEM} onSelect={() => go(hitLink({ kind: "segment", hit }, q))}>
              <Quote size={14} className="shrink-0 text-muted" aria-hidden="true" />
              <span className="min-w-0 flex-1">
                <Highlighted text={hit.snippet} ranges={hit.ranges} className="line-clamp-2 text-ink" />
                <span className="flex min-w-0 items-center gap-1 text-xs text-muted">
                  {hit.speaker === undefined ? null : (
                    <>
                      <HitSpeaker contentId={hit.contentId} speaker={hit.speaker} className="max-w-[40%] shrink-0" />
                      <span aria-hidden="true">·</span>
                    </>
                  )}
                  <span className="truncate">{`${hit.contentTitle ?? t("search.untitled")} · ${formatDuration(hit.startMs)}`}</span>
                </span>
              </span>
            </Command.Item>
          ))}
        </Command.Group>
      )}
      {result.summaries.length === 0 ? null : (
        <Command.Group heading={t("search.group.summaries")} className={GROUP} data-testid="omnibox-group-summaries">
          {result.summaries.map((hit) => (
            <Command.Item key={`summary:${hit.summaryRevisionId}`} value={`summary:${hit.summaryRevisionId}`} className={ITEM} onSelect={() => go(hitLink({ kind: "summary", hit }, q))}>
              <FileText size={14} className="shrink-0 text-muted" aria-hidden="true" />
              <span className="min-w-0 flex-1">
                <Highlighted text={hit.snippet} ranges={hit.ranges} className="line-clamp-2 text-ink" />
                <span className="block truncate text-xs text-muted">{hit.contentTitle ?? t("search.untitled")}</span>
              </span>
              {summaryBasisChanged(hit) ? <BasisChangedMark /> : null}
            </Command.Item>
          ))}
        </Command.Group>
      )}
      {speakers.length === 0 ? null : (
        // A name match only: the same name in two Contents is two entries, never one person.
        <Command.Group heading={t("speakerContext.search.group")} className={GROUP} data-testid="omnibox-group-speakers">
          {speakers.map((hit) => (
            <Command.Item
              key={`speaker:${hit.contentId}:${hit.speakerId}`}
              value={`speaker:${hit.contentId}:${hit.speakerId}`}
              className={ITEM}
              onSelect={() => go(speakerHitLink(hit))}
            >
              <SpeakerAvatar contentId={hit.contentId} speaker={speakerHitSubject(hit)} size={16} decorative />
              <span className="min-w-0 flex-1">
                <span className="block truncate text-ink">{hit.name}</span>
                <span className="block truncate text-xs text-muted">
                  {t("speakerContext.search.hitDetail", { title: hit.contentTitle ?? t("search.untitled"), count: hit.sentences })}
                </span>
              </span>
            </Command.Item>
          ))}
        </Command.Group>
      )}
      {result.collections.length === 0 ? null : (
        <Command.Group heading={t("search.group.collections")} className={GROUP} data-testid="omnibox-group-collections">
          {result.collections.map((hit) => (
            <Command.Item key={`collection:${hit.collectionId}`} value={`collection:${hit.collectionId}`} className={ITEM} onSelect={() => go(hitLink({ kind: "collection", hit }, q))}>
              <FolderOpen size={14} className="shrink-0 text-muted" aria-hidden="true" />
              <Highlighted text={hit.snippet} ranges={hit.ranges} className="truncate text-ink" />
            </Command.Item>
          ))}
        </Command.Group>
      )}
    </>
  );
}

/** Nothing found: say so and offer the way in. */
function EmptySearch(props: GroupProps) {
  const { t } = useTranslation();
  return (
    <>
      <p className="px-2 pt-6 pb-1 text-center text-sm text-muted">{t("search.empty")}</p>
      <p className="px-2 pb-3 text-center text-xs text-muted">{t("search.emptyHint")}</p>
      <Command.Item value="new" className={ITEM} onSelect={() => props.run(() => props.context.navigate("/new"))}>
        <Link2 size={14} className="text-muted" aria-hidden="true" />
        <span className="text-ink">{t("search.emptyAction")}</span>
      </Command.Item>
    </>
  );
}
