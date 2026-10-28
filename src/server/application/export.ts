import { capCitationRuns } from "../../shared/citation-runs.ts";
import { API_PAGE_SIZE_MAX, CITATION_RUN_MAX } from "../../shared/defaults.ts";
import {
  BILINGUAL_EXPORT_FORMATS,
  type CollectionExportRequest,
  type ContentExportRequest,
  type MarkdownExportRequest,
  type SubtitleExportFormat,
  type SubtitleExportRequest,
} from "../../shared/dto/export.ts";
import type { BurnMode } from "../../shared/enums.ts";
import { exportFile } from "../../shared/i18n/zh-CN/export-file.ts";
import { subtitleCues } from "../../shared/subtitle-geometry.ts";
import type { SubtitleStyle } from "../../shared/subtitle-style.ts";
import { summaryTemplate } from "../../shared/i18n/zh-CN/summary-templates.ts";
import { contentView } from "../../shared/i18n/zh-CN/ui-content.ts";
import type { ChapterRevision, SummaryRevision } from "../domain/artifact.ts";
import { backlinkUrl } from "../domain/backlink.ts";
import { withoutCitations } from "../domain/citations.ts";
import { displayTitle, type Content } from "../domain/content.ts";
import { amberError } from "../domain/errors.ts";
import { assDialogue, ASS_HEADER, STYLED_ASS_PLAY_RES_Y, styledAssDocument, type AssPlayRes } from "../domain/export/ass.ts";
import type { ExportCue } from "../domain/export/cues.ts";
import { contentDisposition, exportFilename } from "../domain/export/filename.ts";
import {
  chapterLine,
  fillText,
  headerLine,
  markdownStamp,
  renderCitations,
  subtitleLine,
  transcriptChapterHeading,
  transcriptParagraphLine,
  type CitationResolver,
} from "../domain/export/markdown.ts";
import { ParagraphBuilder, type Paragraph } from "../domain/export/paragraphs.ts";
import { srtCue } from "../domain/export/srt.ts";
import { dateText, dateTimeText, durationText } from "../domain/export/time-format.ts";
import { txtParagraph } from "../domain/export/txt.ts";
import { VTT_HEADER, vttCue } from "../domain/export/vtt.ts";
import { DEFAULT_SUMMARY_TEMPLATE_ID } from "../domain/prompts.ts";
import type { TranscriptRevision, TranscriptSegment } from "../domain/transcript.ts";
import type { RequestPrincipal } from "../domain/user.ts";
import type { Repository, RepositoryScope } from "../ports/repository.ts";
import { trashedMembersOf } from "./collections.ts";

export interface ExportServiceOptions {
  repository: Repository;
  /** Amber's version, for the Markdown header. */
  version: string;
  now?: () => number;
}

/**
 * A synchronous export: everything that can be refused is checked before the
 * first byte, so a refusal is still a JSON error; the body is then produced lazily.
 */
export interface ExportFile {
  /** Title-derived file name with its extension, before `filename*` encoding. */
  filename: string;
  contentType: string;
  body: AsyncIterable<string>;
}

/**
 * A styled ASS of one display mode, in the fixed ASS styles, named the way a burn
 * request names its revisions: `revisionId` is the original, `translationRevisionId` a
 * translation of it, present exactly for the `translation` and `bilingual` modes.
 */
export interface StyledAssRequest {
  mode: BurnMode;
  revisionId: string;
  translationRevisionId?: string;
  style: SubtitleStyle;
  playRes: AssPlayRes;
  textOnly: boolean;
}

/** A downloaded styled ASS does not know its video, so it uses a 16:9 reference canvas. */
const FILE_PLAY_RES: AssPlayRes = { width: 1920, height: STYLED_ASS_PLAY_RES_Y };

/** The `Content-Disposition` header of an export file. */
export function exportDisposition(file: ExportFile): string {
  return contentDisposition(file.filename);
}

const MARKDOWN_TYPE = "text/markdown; charset=utf-8";

const SUBTITLE_FILES: Readonly<Record<SubtitleExportFormat, { extension: string; contentType: string }>> = {
  srt: { extension: "srt", contentType: "application/x-subrip; charset=utf-8" },
  "srt-bilingual": { extension: "srt", contentType: "application/x-subrip; charset=utf-8" },
  vtt: { extension: "vtt", contentType: "text/vtt; charset=utf-8" },
  txt: { extension: "txt", contentType: "text/plain; charset=utf-8" },
  ass: { extension: "ass", contentType: "text/x-ssa; charset=utf-8" },
  "ass-bilingual": { extension: "ass", contentType: "text/x-ssa; charset=utf-8" },
};

/**
 * File export of Contents and Collections. Every revision is
 * named by the request; nothing is chosen behind the user's back. Long transcripts are
 * read page by page in short transactions while the response streams, so a five-hour
 * lecture never sits whole in memory.
 */
export class ExportService {
  private readonly options: ExportServiceOptions;
  private readonly now: () => number;

  constructor(options: ExportServiceOptions) {
    this.options = options;
    this.now = options.now ?? Date.now;
  }

  exportContent(principal: RequestPrincipal, contentId: string, body: ContentExportRequest): ExportFile {
    return this.exportContentOf(principal.userId, contentId, body);
  }

  /** The same file for an owner known from a Task rather than a request; burning reads its ASS here. */
  exportContentOf(owner: string, contentId: string, body: ContentExportRequest): ExportFile {
    return this.options.repository.withTransaction((scope) => {
      const content = scope.contents.get(owner, contentId);
      if (content === undefined) {
        throw amberError("not_found", "content not found");
      }
      return body.format === "markdown" ? this.markdownFile(scope, owner, content, body) : this.subtitleFile(scope, owner, content, body);
    });
  }

  /**
   * The styled ASS a subtitled video export writes, checked like a bilingual
   * export: both revisions belong to the Content and the translation is one of the original.
   */
  styledAssOf(owner: string, contentId: string, request: StyledAssRequest): AsyncIterable<string> {
    return this.options.repository.withTransaction((scope) => {
      const content = scope.contents.get(owner, contentId);
      if (content === undefined) {
        throw amberError("not_found", "content not found");
      }
      const revision = revisionOf(scope, owner, content, request.revisionId);
      let translation: TranscriptRevision | undefined;
      if (request.mode !== "original") {
        translation = revisionOf(scope, owner, content, request.translationRevisionId as string);
        if (translation.kind !== "translated" || translation.parentRevisionId !== revision.id) {
          throw amberError("invalid_request", "the translation is not a translation of the exported revision", {
            params: { detail: "translationRevisionId" },
          });
        }
      }
      return this.styledAss(owner, request.mode, request.mode === "translation" ? undefined : revision.id, translation?.id, request);
    });
  }

  exportCollection(principal: RequestPrincipal, collectionId: string, body: CollectionExportRequest): ExportFile {
    const owner = principal.userId;
    const collection = this.options.repository.withTransaction((scope) => scope.collections.get(owner, collectionId));
    if (collection === undefined) {
      throw amberError("not_found", "collection not found");
    }
    const exportedAt = this.now();
    const service = this;
    return {
      filename: exportFilename(collection.name, exportFile.untitled, "md"),
      contentType: MARKDOWN_TYPE,
      body: (async function* () {
        yield service.options.repository.withTransaction((scope) => service.collectionMarkdown(scope, owner, collectionId, body.backlinks, exportedAt));
      })(),
    };
  }

  private subtitleFile(scope: RepositoryScope, owner: string, content: Content, body: SubtitleExportRequest): ExportFile {
    const revision = revisionOf(scope, owner, content, body.revisionId);
    let translation: TranscriptRevision | undefined;
    if (BILINGUAL_EXPORT_FORMATS.has(body.format)) {
      translation = revisionOf(scope, owner, content, body.translationRevisionId as string);
      if (translation.kind !== "translated" || translation.parentRevisionId !== revision.id) {
        throw amberError("invalid_request", "the translation is not a translation of the exported revision", {
          params: { detail: "translationRevisionId" },
        });
      }
    }
    const file = SUBTITLE_FILES[body.format];
    const filename = exportFilename(titleOf(scope, owner, content), exportFile.untitled, file.extension);
    if (body.style !== undefined && (body.format === "ass" || body.format === "ass-bilingual")) {
      // A single-language ASS of a translation shows it in the translation's appearance.
      const mode: BurnMode = translation !== undefined ? "bilingual" : revision.kind === "translated" ? "translation" : "original";
      const options = { style: body.style, playRes: FILE_PLAY_RES, textOnly: false };
      const lines = mode === "translation" ? this.styledAss(owner, mode, undefined, revision.id, options) : this.styledAss(owner, mode, revision.id, translation?.id, options);
      return { filename, contentType: file.contentType, body: lines };
    }
    const cues = this.cuesOf(owner, revision.id, translation?.id);
    const karaoke = revision.timingFidelity === "exact_words";
    let lines: AsyncIterable<string>;
    switch (body.format) {
      case "srt":
      case "srt-bilingual":
        lines = mapCues(cues, (cue, index) => srtCue(index + 1, cue));
        break;
      case "vtt":
        lines = withHeader(VTT_HEADER, mapCues(cues, (cue) => vttCue(cue)));
        break;
      case "ass":
      case "ass-bilingual":
        lines = withHeader(ASS_HEADER, mapCues(cues, (cue) => assDialogue(cue, { karaoke })));
        break;
      case "txt":
        lines = txtLines(cues);
        break;
    }
    return { filename, contentType: file.contentType, body: lines };
  }

  /**
   * Styled cues need the whole timeline at once — overlapping sentences are cut into
   * slices — so the revisions are read fully, page by page, when the body is consumed.
   */
  private async *styledAss(
    owner: string,
    mode: BurnMode,
    originalId: string | undefined,
    translationId: string | undefined,
    options: Pick<StyledAssRequest, "style" | "playRes" | "textOnly">,
  ): AsyncGenerator<string> {
    const read = async (revisionId: string | undefined): Promise<TranscriptSegment[]> => {
      const segments: TranscriptSegment[] = [];
      if (revisionId !== undefined) {
        for await (const segment of this.segmentsOf(owner, revisionId)) {
          segments.push(segment);
        }
      }
      return segments;
    };
    const cues = subtitleCues(mode, await read(originalId), await read(translationId));
    yield styledAssDocument(cues, { ...options, mode });
  }

  private markdownFile(scope: RepositoryScope, owner: string, content: Content, body: MarkdownExportRequest): ExportFile {
    const { sections } = body;
    let summary: { revision: SummaryRevision; templateName: string } | undefined;
    if (sections.summary !== undefined) {
      const template = scope.summaryTemplates.get(owner, sections.summary.templateId);
      const artifact = scope.summaries.findArtifact(owner, content.id, sections.summary.templateId);
      const revision = artifact?.currentRevisionId === undefined ? undefined : scope.summaries.getRevision(owner, artifact.currentRevisionId);
      if (template === undefined || revision === undefined) {
        throw amberError("invalid_request", "no current summary for that template", { params: { detail: "sections.summary" } });
      }
      summary = { revision, templateName: template.builtin ? i18nTemplateName(template.name) : template.name };
    }
    let chapters: ChapterRevision | undefined;
    if (sections.chapters === true) {
      chapters = scope.chapters.getCurrent(owner, content.id);
      if (chapters === undefined) {
        throw amberError("invalid_request", "the content has no current chapters", { params: { detail: "sections.chapters" } });
      }
    }
    const transcript = sections.transcript === undefined ? undefined : revisionOf(scope, owner, content, sections.transcript.revisionId);
    const subtitles = sections.subtitles === undefined ? undefined : revisionOf(scope, owner, content, sections.subtitles.revisionId);
    const title = titleOf(scope, owner, content);
    const source = content.source.sourceUrl ?? localNameOf(scope, owner, content);
    const exportedAt = this.now();
    const link = (ms: number): string | undefined => (body.backlinks ? backlinkUrl(content.source, ms) : undefined);
    const service = this;

    async function* lines(): AsyncGenerator<string> {
      yield `# ${title ?? exportFile.untitled}\n\n`;
      yield headerLine([
        ...(source === undefined ? [] : [fillText(exportFile.source, { source })]),
        ...(content.durationMs === undefined ? [] : [fillText(exportFile.duration, { duration: durationText(content.durationMs) })]),
        fillText(exportFile.exportedAt, { date: dateText(exportedAt) }),
        fillText(exportFile.app, { version: service.options.version }),
      ]);
      if (summary !== undefined) {
        const { revision, templateName } = summary;
        const rendered = service.options.repository.withTransaction((scope) =>
          renderCitations(capCitationRuns(revision.body, CITATION_RUN_MAX), service.resolver(scope, owner, body.backlinks), exportFile.unresolvedCitation),
        );
        yield `\n## ${fillText(exportFile.summary, { template: templateName })}\n\n${rendered.trim()}\n`;
      }
      if (chapters !== undefined) {
        yield `\n## ${exportFile.chapters}\n\n`;
        for (const chapter of chapters.chapters) {
          yield chapterLine(markdownStamp(chapter.startMs, link(chapter.startMs)), chapter.title, chapter.summary);
        }
      }
      if (transcript !== undefined) {
        const label = revisionLabelText(transcript);
        yield `\n## ${fillText(exportFile.transcript, { revision: label })}\n\n`;
        let pending = "";
        for await (const piece of service.transcriptPieces(owner, transcript.id, chapters, link)) {
          yield pending;
          pending = piece;
        }
        // The last paragraph ends the section with a single newline.
        yield pending.replace(/\n\n$/, "\n");
      }
      if (subtitles !== undefined) {
        yield `\n## ${exportFile.subtitles}\n\n`;
        for await (const cue of service.cuesOf(owner, subtitles.id)) {
          yield subtitleLine(cue.startMs, cue.text);
        }
      }
    }
    return { filename: exportFilename(title, exportFile.untitled, "md"), contentType: MARKDOWN_TYPE, body: lines() };
  }

  /**
   * The collection Markdown: its summary, then each item's title and inlined `summary.core`.
   * Summaries are exported as they are shown: each run of citations cut to the cap.
   */
  private collectionMarkdown(scope: RepositoryScope, owner: string, collectionId: string, backlinks: boolean, exportedAt: number): string {
    const collection = scope.collections.get(owner, collectionId);
    if (collection === undefined) {
      throw amberError("not_found", "collection not found");
    }
    const resolve = this.resolver(scope, owner, backlinks);
    const out: string[] = [
      `# ${collection.name}\n\n`,
      headerLine([fillText(exportFile.exportedAt, { date: dateText(exportedAt) }), fillText(exportFile.app, { version: this.options.version })]),
    ];
    const summary = scope.collectionSummaries.getCurrent(owner, collectionId);
    if (summary !== undefined && trashedMembersOf(scope, owner, summary).length > 0) {
      // Withheld like `GET /collections/:id/summary`: it draws on a member in the trash.
      out.push(`\n${exportFile.collectionSummaryHidden}\n`);
    } else if (summary !== undefined) {
      // A collection summary carries no citations; one stored while they still did is exported without them.
      out.push(`\n## ${exportFile.collectionSummary}\n\n${withoutCitations(summary.body).trim()}\n`);
    }
    out.push(`\n## ${exportFile.lectures}\n`);
    const items = [...scope.collections.listVisibleItems(owner, collectionId)].sort((a, b) => a.position - b.position);
    for (const item of items) {
      const content = scope.contents.get(owner, item.contentId);
      if (content === undefined) {
        continue;
      }
      const title = (titleOf(scope, owner, content) ?? exportFile.untitled).replace(/\r\n|\r|\n/g, " ");
      const heading = content.source.sourceUrl === undefined ? title : `[${title}](${content.source.sourceUrl})`;
      const artifact = scope.summaries.findArtifact(owner, content.id, DEFAULT_SUMMARY_TEMPLATE_ID);
      const core = artifact?.currentRevisionId === undefined ? undefined : scope.summaries.getRevision(owner, artifact.currentRevisionId);
      const text =
        core === undefined ? exportFile.noCoreSummary : renderCitations(capCitationRuns(core.body, CITATION_RUN_MAX), resolve, exportFile.unresolvedCitation).trim();
      out.push(`\n### ${heading}\n\n${text}\n`);
    }
    return out.join("");
  }

  /**
   * Resolves a citation to the cited sentence's start and, with back-links on, a link into
   * the Content that sentence belongs to — for collection bodies that is each member's own
   * source, not the collection's.
   */
  private resolver(scope: RepositoryScope, owner: string, backlinks: boolean): CitationResolver {
    const sources = new Map<string, Content | undefined>();
    return (segmentId) => {
      const segment = scope.transcripts.getSegment(owner, segmentId);
      if (segment === undefined) {
        return undefined;
      }
      if (!sources.has(segment.revisionId)) {
        const revision = scope.transcripts.getRevision(owner, segment.revisionId);
        sources.set(segment.revisionId, revision === undefined ? undefined : scope.contents.get(owner, revision.contentId));
      }
      const content = sources.get(segment.revisionId);
      const url = backlinks && content !== undefined ? backlinkUrl(content.source, segment.startMs) : undefined;
      return { startMs: segment.startMs, ...(url === undefined ? {} : { url }) };
    };
  }

  /**
   * The body of the transcript section (`exportFile.transcript`): reading paragraphs, and
   * where chapters were requested too, a `###` heading wherever one of that same
   * ChapterRevision's chapters starts. Chapters are projected by time — the latest chapter
   * starting at or before a sentence takes it — so they apply to whichever revision is
   * exported; a chapter start always closes the paragraph before it. Without
   * `sections.chapters` no chapter is read.
   */
  private async *transcriptPieces(
    owner: string,
    revisionId: string,
    chapters: ChapterRevision | undefined,
    link: (ms: number) => string | undefined,
  ): AsyncGenerator<string> {
    const starts = chapters === undefined ? [] : [...chapters.chapters].sort((a, b) => a.startMs - b.startMs);
    const line = (paragraph: Paragraph): string => transcriptParagraphLine(markdownStamp(paragraph.startMs, link(paragraph.startMs)), paragraph.text);
    const builder = new ParagraphBuilder();
    let next = 0;
    for await (const cue of this.cuesOf(owner, revisionId)) {
      let opened: string | undefined;
      while (next < starts.length && (starts[next] as ChapterRevision["chapters"][number]).startMs <= cue.startMs) {
        opened = (starts[next] as ChapterRevision["chapters"][number]).title;
        next += 1;
      }
      if (opened !== undefined) {
        const closed = builder.flush();
        if (closed !== undefined) {
          yield line(closed);
        }
        yield transcriptChapterHeading(opened);
      }
      const closed = builder.push(cue);
      if (closed !== undefined) {
        yield line(closed);
      }
    }
    const last = builder.flush();
    if (last !== undefined) {
      yield line(last);
    }
  }

  /**
   * The revision's sentences as cues, page by page. With a translation, each sentence
   * carries the translated text of the translated sentence pointing at it; translation
   * pages are read ahead only as far as the original has got, since a translation keeps
   * its parent's ordinals.
   */
  private async *cuesOf(owner: string, revisionId: string, translationId?: string): AsyncGenerator<ExportCue> {
    const translated = new Map<string, string>();
    let translationAfter: number | undefined;
    let translationDone = translationId === undefined;
    for await (const segment of this.segmentsOf(owner, revisionId)) {
      while (!translationDone && !translated.has(segment.id) && (translationAfter === undefined || translationAfter <= segment.ordinal)) {
        const page = this.page(owner, translationId as string, translationAfter);
        for (const child of page) {
          const parent = child.sourceSegmentIds[0];
          if (parent !== undefined) {
            translated.set(parent, child.text);
          }
        }
        translationAfter = page.at(-1)?.ordinal ?? translationAfter;
        translationDone = page.length < API_PAGE_SIZE_MAX;
      }
      const translation = translated.get(segment.id);
      translated.delete(segment.id);
      yield {
        startMs: segment.startMs,
        endMs: segment.endMs,
        text: segment.text,
        ...(segment.words === undefined ? {} : { words: segment.words }),
        ...(segment.speakerId === undefined ? {} : { speakerId: segment.speakerId }),
        ...(segment.paragraphStart === undefined ? {} : { paragraphStart: segment.paragraphStart }),
        ...(translation === undefined ? {} : { translation }),
      };
    }
  }

  private async *segmentsOf(owner: string, revisionId: string): AsyncGenerator<TranscriptSegment> {
    let after: number | undefined;
    for (;;) {
      const page = this.page(owner, revisionId, after);
      yield* page;
      if (page.length < API_PAGE_SIZE_MAX) {
        return;
      }
      after = (page.at(-1) as TranscriptSegment).ordinal;
    }
  }

  private page(owner: string, revisionId: string, afterOrdinal: number | undefined): TranscriptSegment[] {
    return this.options.repository.withTransaction((scope) =>
      scope.transcripts.listSegments(owner, revisionId, { ...(afterOrdinal === undefined ? {} : { afterOrdinal }), limit: API_PAGE_SIZE_MAX }),
    );
  }
}

/** A transcript revision of `content`, or `not_found`: an export never reaches into another Content. */
function revisionOf(scope: RepositoryScope, owner: string, content: Content, revisionId: string): TranscriptRevision {
  const revision = scope.transcripts.getRevision(owner, revisionId);
  if (revision === undefined || revision.contentId !== content.id) {
    throw amberError("not_found", "transcript revision not found");
  }
  return revision;
}

/** The title, or for a local file still without one its display name. */
function titleOf(scope: RepositoryScope, owner: string, content: Content): string | undefined {
  return displayTitle(content) ?? localNameOf(scope, owner, content);
}

/** A local Content's file name as the user knows it; platform Contents have their URL instead. */
function localNameOf(scope: RepositoryScope, owner: string, content: Content): string | undefined {
  if (content.source.sourceUrl !== undefined) {
    return undefined;
  }
  return scope.mediaAssets
    .listByContent(owner, content.id)
    .filter((asset) => asset.kind === "external_local" || asset.kind === "managed_upload")
    .find((asset) => asset.displayName !== undefined)?.displayName;
}

/** A builtin template's `name` is its i18n key, `summaryTemplate.<id>`. */
function i18nTemplateName(key: string): string {
  const name = key.startsWith("summaryTemplate.") ? (summaryTemplate as Record<string, string>)[key.slice("summaryTemplate.".length)] : undefined;
  return name ?? key;
}

async function* withHeader(header: string, rest: AsyncIterable<string>): AsyncGenerator<string> {
  yield header;
  yield* rest;
}

async function* mapCues(cues: AsyncIterable<ExportCue>, render: (cue: ExportCue, index: number) => string): AsyncGenerator<string> {
  let index = 0;
  for await (const cue of cues) {
    yield render(cue, index);
    index += 1;
  }
}

async function* paragraphsOf(cues: AsyncIterable<ExportCue>): AsyncGenerator<Paragraph> {
  const builder = new ParagraphBuilder();
  for await (const cue of cues) {
    const closed = builder.push(cue);
    if (closed !== undefined) {
      yield closed;
    }
  }
  const last = builder.flush();
  if (last !== undefined) {
    yield last;
  }
}

async function* txtLines(cues: AsyncIterable<ExportCue>): AsyncGenerator<string> {
  let first = true;
  for await (const paragraph of paragraphsOf(cues)) {
    yield txtParagraph(paragraph, first);
    first = false;
  }
}

/**
 * `{{revision_label}}`: kind, the model that produced the revision when there is one,
 * and its creation time — the same parts the reading view's version picker shows.
 */
function revisionLabelText(revision: TranscriptRevision): string {
  const { generation } = revision;
  const model = generation.kind === "llm" ? generation.modelRef.modelDisplaySnapshot || generation.modelRef.modelId : generation.kind === "asr" ? generation.modelId : undefined;
  return [contentView.revisionKind[revision.kind], ...(model === undefined ? [] : [model]), dateTimeText(revision.createdAt)].join(" · ");
}
