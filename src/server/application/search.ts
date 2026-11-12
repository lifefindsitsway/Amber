import { SEARCH_GROUP_LIMIT, SEARCH_SHORT_QUERY_LIMIT } from "../../shared/defaults.ts";
import type { ContentHitDto, SearchQuery, SearchResultDto, SpeakerHitDto } from "../../shared/dto/search.ts";
import type { SegmentId } from "../../shared/ids.ts";
import { amberError } from "../domain/errors.ts";
import { highlightSnippet, parseSearchQuery } from "../domain/search-query.ts";
import type { RequestPrincipal } from "../domain/user.ts";
import type { Repository, RepositoryScope, SearchScope } from "../ports/repository.ts";
import { displayTitleOf } from "../domain/content.ts";
import { summarySpeakerContext } from "./artifact-speakers.ts";
import { SpeakerLineageReader } from "./speaker-lineage.ts";

export interface SearchServiceOptions {
  repository: Repository;
  /** Shared with the other readers of speaker states, so a revision pair is compared once. */
  speakerLineage?: SpeakerLineageReader;
}

/** `global` unless given; `library`; anything else names one of the owner's collections. */
function scopeOf(scope: RepositoryScope, owner: string, value: string | undefined): SearchScope {
  if (value === undefined || value === "global") {
    return { kind: "global" };
  }
  if (value === "library") {
    return { kind: "library" };
  }
  if (scope.collections.get(owner, value) === undefined) {
    throw amberError("not_found", "collection not found");
  }
  return { kind: "collection", collectionId: value };
}

/**
 * The one search contract over the FTS projection, used by every caller alike: grouped hits
 * with snippets and offsets. Titles shown next to a hit come from the business tables, so a
 * renamed Content reads correctly even where its rows were indexed under the old title.
 *
 * Speakers are read as they are now and never indexed: a sentence hit carries who it is given
 * to (and whether that revision's speakers were reviewed), a summary hit the state of the
 * speakers it was generated with — it stays findable and keeps its rank whatever the state —
 * and the `global` and `library` scopes add a group of speakers whose name matches.
 */
export class SearchService {
  private readonly options: SearchServiceOptions;
  private readonly lineage: SpeakerLineageReader;

  constructor(options: SearchServiceOptions) {
    this.options = options;
    this.lineage = options.speakerLineage ?? new SpeakerLineageReader();
  }

  search(principal: RequestPrincipal, query: SearchQuery): SearchResultDto {
    const owner = principal.userId;
    const parsed = parseSearchQuery(query.q);
    return this.options.repository.withTransaction((scope) => {
      const searchScope = scopeOf(scope, owner, query.scope);
      const hits = scope.search.query(owner, {
        terms: parsed.terms,
        mode: parsed.mode,
        scope: searchScope,
        groupLimit: SEARCH_GROUP_LIMIT,
        likeLimit: SEARCH_SHORT_QUERY_LIMIT,
      });
      const titles = new Map<string, string | undefined>();
      const titleOf = (contentId: string): string | undefined => {
        if (!titles.has(contentId)) {
          titles.set(contentId, displayTitleOf(scope.contents.get(owner, contentId)));
        }
        return titles.get(contentId);
      };
      const withTitle = (contentId: string, key: "title" | "contentTitle") => {
        const title = titleOf(contentId);
        return title === undefined ? {} : { [key]: title };
      };
      const result: SearchResultDto = { contents: [], segments: [], summaries: [], collections: [] };
      const titleHits: ContentHitDto[] = [];
      const referenceHits: ContentHitDto[] = [];
      for (const hit of hits) {
        const text = highlightSnippet(hit.text, parsed.terms);
        switch (hit.kind) {
          case "title":
          case "reference":
            (hit.kind === "title" ? titleHits : referenceHits).push({ contentId: hit.contentId, ...withTitle(hit.contentId, "title"), matchedIn: hit.kind, ...text });
            break;
          case "segment":
            result.segments.push({
              contentId: hit.contentId,
              ...withTitle(hit.contentId, "contentTitle"),
              transcriptRevisionId: hit.transcriptRevisionId,
              segmentId: hit.segmentId as SegmentId,
              startMs: hit.startMs,
              ...(hit.speaker === undefined ? {} : { speaker: { ...hit.speaker } }),
              ...text,
            });
            break;
          case "summary": {
            const revision = scope.summaries.getRevision(owner, hit.summaryRevisionId);
            const state = revision === undefined ? undefined : summarySpeakerContext(scope, owner, this.lineage, hit.contentId, revision)?.state;
            result.summaries.push({
              contentId: hit.contentId,
              ...withTitle(hit.contentId, "contentTitle"),
              artifactId: hit.artifactId,
              templateId: hit.templateId,
              summaryRevisionId: hit.summaryRevisionId,
              ...(state === undefined ? {} : { speakerContextState: state }),
              ...text,
            });
            break;
          }
          case "collection": {
            const collection = scope.collections.get(owner, hit.collectionId);
            if (collection !== undefined) {
              result.collections.push({ collectionId: hit.collectionId, name: collection.name, ...text });
            }
            break;
          }
        }
      }
      // One entry per Content: a title match outranks a reference-text match.
      const seen = new Set<string>();
      for (const hit of [...titleHits, ...referenceHits]) {
        if (!seen.has(hit.contentId) && result.contents.length < SEARCH_GROUP_LIMIT) {
          seen.add(hit.contentId);
          result.contents.push(hit);
        }
      }
      // Only the global and library scopes look up names; an empty group is left out.
      const speakers = searchScope.kind === "collection" ? [] : scope.search.matchSpeakers(owner, parsed.terms, SEARCH_GROUP_LIMIT);
      if (speakers.length > 0) {
        result.speakers = speakers.map(
          (match): SpeakerHitDto => ({
            contentId: match.contentId,
            ...withTitle(match.contentId, "contentTitle"),
            speakerId: match.speakerId,
            ordinal: match.ordinal,
            name: match.name,
            colorIndex: match.colorIndex,
            sentences: match.sentences,
          }),
        );
      }
      return result;
    });
  }

  /** Re-derives the whole projection; an internal maintenance method, not an endpoint. */
  rebuild(): void {
    this.options.repository.withTransaction((scope) => scope.search.rebuild());
  }

  /** Start-up: rebuilds the projection when it is missing or fails its integrity check. */
  ensureReady(): void {
    if (!this.options.repository.withTransaction((scope) => scope.search.healthy())) {
      this.rebuild();
    }
  }
}
