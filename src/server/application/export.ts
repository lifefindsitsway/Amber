import { capCitationRuns } from "../../shared/citation-runs.ts";
import { API_PAGE_SIZE_MAX, CITATION_RUN_MAX, FIGURE_IMAGE_MAX_BYTES, FIGURES_PER_CONTENT_MAX, SUBTITLE_IMPORT_MAX_BYTES } from "../../shared/defaults.ts";
import {
  BILINGUAL_EXPORT_FORMATS,
  type CollectionExportRequest,
  type ContentExportRequest,
  type MarkdownExportRequest,
  type SubtitleExportFormat,
  type SubtitleExportRequest,
  type SubtitlePackageExportRequest,
} from "../../shared/dto/export.ts";
import type { BurnMode } from "../../shared/enums.ts";
import { placeFigures, type SentenceMapper } from "../../shared/figure-placement.ts";
import { exportFile } from "../../shared/i18n/zh-CN/export-file.ts";
import type { SpeakerLabelMode } from "../../shared/speakers.ts";
import { subtitleCues } from "../../shared/subtitle-geometry.ts";
import type { SubtitleStyle } from "../../shared/subtitle-style.ts";
import { BYTES_PER_MB } from "../../shared/units.ts";
import { summaryTemplate } from "../../shared/i18n/zh-CN/summary-templates.ts";
import { contentView } from "../../shared/i18n/zh-CN/ui-content.ts";
import type { ChapterRevision, SummaryRevision } from "../domain/artifact.ts";
import { backlinkUrl } from "../domain/backlink.ts";
import { withoutCitations } from "../domain/citations.ts";
import { displayTitle, type Content } from "../domain/content.ts";
import { amberError } from "../domain/errors.ts";
import { buildSubtitlePackage, withAssRestoreData } from "../domain/export/ambersub.ts";
import { assDialogue, ASS_HEADER, STYLED_ASS_PLAY_RES_Y, styledAssDocument, type AssPlayRes } from "../domain/export/ass.ts";
import type { GlyphAdvances } from "../domain/export/subtitle-breaks.ts";
import type { ExportCue } from "../domain/export/cues.ts";
import {
  figureImagePath,
  interleaveFigures,
  markdownFigureBlock,
  SentenceParagraphBuilder,
  txtFigureBlock,
  type SectionItem,
  type SectionPiece,
  type SentenceParagraph,
} from "../domain/export/figures.ts";
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
import { isChinese, SpeakerLabeler, speakerLabels, speakerPrefix } from "../domain/export/speaker-labels.ts";
import { srtCue } from "../domain/export/srt.ts";
import { dateText, dateTimeText, durationText } from "../domain/export/time-format.ts";
import { txtParagraph } from "../domain/export/txt.ts";
import { VTT_HEADER, vttCue } from "../domain/export/vtt.ts";
import type { ContentFigure } from "../domain/figure.ts";
import { DEFAULT_SUMMARY_TEMPLATE_ID } from "../domain/prompts.ts";
import { mapSegment } from "../domain/segment-map.ts";
import type { ContentSpeaker } from "../domain/speaker.ts";
import { serializeSubtitlePackage, SUBTITLE_PACKAGE_EXTENSION } from "../domain/subtitle-package.ts";
import { checkZip, ZipLimitError, zipStream, type ZipEntry } from "../domain/export/zip.ts";
import type { TranscriptRevision, TranscriptSegment } from "../domain/transcript.ts";
import type { RequestPrincipal } from "../domain/user.ts";
import type { Repository, RepositoryScope } from "../ports/repository.ts";
import type { SubtitleFontMetrics } from "../ports/subtitle-font-metrics.ts";
import { trashedMembersOf } from "./collections.ts";

export interface ExportServiceOptions {
  repository: Repository;
  /** Amber's version, for the Markdown header. */
  version: string;
  now?: () => number;
  /** The bundled subtitle font's advances, which styled ASS breaks its lines by; absent, lines are left to the renderer. */
  fontMetrics?: SubtitleFontMetrics;
}

/**
 * A synchronous export: everything that can be refused is checked before the
 * first byte, so a refusal is still a JSON error; the body is then produced lazily. Text
 * files stream as strings; a transcript exported with its figures is a zip of bytes.
 */
export interface ExportFile<Chunk extends string | Uint8Array = string | Uint8Array> {
  /** Title-derived file name with its extension, before `filename*` encoding. */
  filename: string;
  contentType: string;
  body: AsyncIterable<Chunk>;
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
  /**
   * Each speaker's label, frozen when the export was requested; drawn as label lines when
   * the style's appearance asks for them. Absent = no label lines.
   */
  speakerLabels?: Readonly<Record<string, string>>;
}

/** A downloaded styled ASS does not know its video, so it uses a 16:9 reference canvas. */
const FILE_PLAY_RES: AssPlayRes = { width: 1920, height: STYLED_ASS_PLAY_RES_Y };

/** The `Content-Disposition` header of an export file. */
export function exportDisposition(file: ExportFile): string {
  return contentDisposition(file.filename);
}

const MARKDOWN_TYPE = "text/markdown; charset=utf-8";
const ZIP_TYPE = "application/zip";

const SUBTITLE_FILES: Readonly<Record<SubtitleExportFormat, { extension: string; contentType: string }>> = {
  srt: { extension: "srt", contentType: "application/x-subrip; charset=utf-8" },
  "srt-bilingual": { extension: "srt", contentType: "application/x-subrip; charset=utf-8" },
  vtt: { extension: "vtt", contentType: "text/vtt; charset=utf-8" },
  txt: { extension: "txt", contentType: "text/plain; charset=utf-8" },
  ass: { extension: "ass", contentType: "text/x-ssa; charset=utf-8" },
  "ass-bilingual": { extension: "ass", contentType: "text/x-ssa; charset=utf-8" },
};

const SUBTITLE_PACKAGE_TYPE = "application/json; charset=utf-8";

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

  /** A download: a styled ASS carries restore data, so it re-imports as exactly as a subtitle package. */
  exportContent(principal: RequestPrincipal, contentId: string, body: ContentExportRequest): ExportFile {
    return this.contentFile(principal.userId, contentId, body, true, true);
  }

  /**
   * The same file for an owner known from a Task rather than a request; burning reads its ASS
   * here. Never with restore data: a burned picture or a muxed track is not re-imported.
   * Always the text file: figures are for downloads only.
   */
  exportContentOf(owner: string, contentId: string, body: ContentExportRequest): ExportFile<string> {
    return this.contentFile(owner, contentId, body, false, false);
  }

  /** With `figures`, a Markdown or TXT request that asks for figures, of a Content that has some, becomes a zip. */
  private contentFile(owner: string, contentId: string, body: ContentExportRequest, restoreData: boolean, figures: false): ExportFile<string>;
  private contentFile(owner: string, contentId: string, body: ContentExportRequest, restoreData: boolean, figures: boolean): ExportFile;
  private contentFile(owner: string, contentId: string, body: ContentExportRequest, restoreData: boolean, figures: boolean): ExportFile {
    return this.options.repository.withTransaction((scope) => {
      const content = scope.contents.get(owner, contentId);
      if (content === undefined) {
        throw amberError("not_found", "content not found");
      }
      switch (body.format) {
        case "markdown":
          return this.markdownFile(scope, owner, content, body, figures);
        case "ambersub":
          return this.packageFile(scope, owner, content, body);
        default:
          return this.subtitleFile(scope, owner, content, body, restoreData, figures);
      }
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
      const labels = request.speakerLabels === undefined ? undefined : new Map(Object.entries(request.speakerLabels));
      return this.styledAss(owner, request.mode, request.mode === "translation" ? undefined : revision.id, translation?.id, request, undefined, labels);
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

  /**
   * The Amber subtitle package of one original revision with every current translation made
   * from it. It is built whole before the first byte: a package too large to import again is
   * refused rather than produced.
   */
  private packageFile(scope: RepositoryScope, owner: string, content: Content, body: SubtitlePackageExportRequest): ExportFile {
    const revision = revisionOf(scope, owner, content, body.revisionId);
    if (revision.kind === "translated") {
      throw amberError("invalid_request", "a subtitle package starts from an original, not a translation", { params: { detail: "revisionId" } });
    }
    const translations = scope.translations.listArtifacts(owner, content.id).flatMap((artifact) => {
      const current = artifact.currentRevisionId === undefined ? undefined : scope.transcripts.getRevision(owner, artifact.currentRevisionId);
      // Only translations made from this very revision: one of another revision would point at sentences the package does not hold.
      return current !== undefined && current.contentId === content.id && current.kind === "translated" && current.parentRevisionId === revision.id
        ? [{ language: current.language, segments: allSegments(scope, owner, current.id) }]
        : [];
    });
    const pkg = buildSubtitlePackage({
      revision,
      segments: allSegments(scope, owner, revision.id),
      speakers: scope.speakers.list(owner, content.id),
      translations,
      version: this.options.version,
    });
    if (pkg.original.segments.length === 0) {
      throw amberError("invalid_request", "the revision has no sentence with text to package", { params: { detail: "revisionId" } });
    }
    const serialized = serializeSubtitlePackage(pkg);
    if (Buffer.byteLength(serialized, "utf8") > SUBTITLE_IMPORT_MAX_BYTES) {
      throw amberError("media_too_large", "subtitle package is larger than an import takes", { params: { limit: `${SUBTITLE_IMPORT_MAX_BYTES / BYTES_PER_MB} MB` } });
    }
    return {
      filename: exportFilename(titleOf(scope, owner, content), exportFile.untitled, SUBTITLE_PACKAGE_EXTENSION),
      contentType: SUBTITLE_PACKAGE_TYPE,
      body: (async function* () {
        yield serialized;
      })(),
    };
  }

  private subtitleFile(scope: RepositoryScope, owner: string, content: Content, body: SubtitleExportRequest, restoreData: boolean, figures: boolean): ExportFile {
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
    // Read once, and only when asked: without `includeSpeakers` the output is what it always was.
    const speakers: SpeakerNames | undefined =
      body.includeSpeakers === true
        ? { names: speakerLabels(scope.speakers.list(owner, content.id)), chinese: isChinese(revision.language), mode: body.speakerLabels ?? "turn" }
        : undefined;
    if (body.style !== undefined && (body.format === "ass" || body.format === "ass-bilingual")) {
      // A single-language ASS of a translation shows it in the translation's appearance.
      const mode: BurnMode = translation !== undefined ? "bilingual" : revision.kind === "translated" ? "translation" : "original";
      const options = { style: body.style, playRes: FILE_PLAY_RES, textOnly: false };
      // A downloaded file is made now, so its label lines carry the names as they are now.
      const labels = body.style.appearance.speaker === undefined ? undefined : (speakers?.names ?? speakerLabels(scope.speakers.list(owner, content.id)));
      const originalId = mode === "translation" ? undefined : revision.id;
      const translationId = mode === "translation" ? revision.id : translation?.id;
      const restore: RestoreData | undefined = restoreData
        ? {
            language: revision.language,
            ...(revision.looseJoin === true ? { looseJoin: true as const } : {}),
            ...(translation === undefined ? {} : { translationLanguage: translation.language }),
            speakers: scope.speakers.list(owner, content.id),
          }
        : undefined;
      return { filename, contentType: file.contentType, body: this.styledAss(owner, mode, originalId, translationId, options, speakers?.names, labels, restore) };
    }
    if (figures && body.format === "txt" && body.figures === true) {
      const zip = this.figureTxtFile(scope, owner, content, revision, speakers);
      if (zip !== undefined) {
        return zip;
      }
    }
    const cues = this.cuesOf(owner, revision.id, translation?.id);
    const karaoke = revision.timingFidelity === "exact_words";
    let lines: AsyncIterable<string>;
    switch (body.format) {
      case "srt":
      case "srt-bilingual": {
        const labels = speakers === undefined ? undefined : new SpeakerLabeler(speakers.mode);
        lines = mapCues(cues, (cue, index) => srtCue(index + 1, cue, labelFor(speakers, labels, cue.speakerId)));
        break;
      }
      case "vtt":
        lines = withHeader(VTT_HEADER, mapCues(cues, (cue) => vttCue(cue, nameOf(speakers, cue.speakerId))));
        break;
      case "ass":
      case "ass-bilingual":
        lines = withHeader(ASS_HEADER, mapCues(cues, (cue) => assDialogue(cue, { karaoke, ...speakerField(nameOf(speakers, cue.speakerId)) })));
        break;
      case "txt":
        lines = txtLines(cues, speakers);
        break;
    }
    return { filename, contentType: file.contentType, body: lines };
  }

  /**
   * Styled cues need the whole timeline at once — overlapping sentences are cut into
   * slices — so the revisions are read fully, page by page, when the body is consumed.
   * `speakerNames` fill the events' `Name` field; `labelLines` are the speaker labels drawn
   * above the cues when the style asks for them. With `restore`, the document carries the
   * package of exactly what it shows: the shown revision as the original and, bilingually,
   * the translation it pairs with.
   */
  private async *styledAss(
    owner: string,
    mode: BurnMode,
    originalId: string | undefined,
    translationId: string | undefined,
    options: Pick<StyledAssRequest, "style" | "playRes" | "textOnly">,
    speakerNames?: ReadonlyMap<string, string>,
    labelLines?: ReadonlyMap<string, string>,
    restore?: RestoreData,
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
    const original = await read(originalId);
    const translation = await read(translationId);
    const cues = subtitleCues(mode, original, translation);
    // One cue per sentence of the revision the mode shows, in that order.
    const shown = mode === "translation" ? translation : original;
    const ofCue = shown.map((segment) => segment.speakerId);
    const document = styledAssDocument(cues, {
      style: options.style,
      playRes: options.playRes,
      textOnly: options.textOnly,
      mode,
      ...(options.textOnly ? {} : glyphsOf(this.options.fontMetrics)),
      ...(speakerNames === undefined ? {} : { speakers: { ofCue, names: speakerNames } }),
      ...(labelLines === undefined ? {} : { speakerLines: { ofCue, labels: labelLines } }),
    });
    if (restore === undefined) {
      yield document;
      return;
    }
    const pkg = buildSubtitlePackage({
      revision: { language: restore.language, ...(restore.looseJoin === true ? { looseJoin: true } : {}) },
      segments: shown,
      speakers: restore.speakers,
      translations: mode === "bilingual" && restore.translationLanguage !== undefined ? [{ language: restore.translationLanguage, segments: translation }] : [],
      version: this.options.version,
    });
    // Without a sentence the package would not import; the file then re-imports as a plain ASS.
    yield pkg.original.segments.length === 0 ? document : withAssRestoreData(document, serializeSubtitlePackage(pkg));
  }

  private markdownFile(scope: RepositoryScope, owner: string, content: Content, body: MarkdownExportRequest, figures: boolean): ExportFile {
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
    const speakerNames = body.includeSpeakers === true && transcript !== undefined ? speakerLabels(scope.speakers.list(owner, content.id)) : undefined;
    // With figures, the transcript section is written here, from the sentences, figures and images read in this one transaction.
    const figured =
      figures && sections.transcript?.figures === true && transcript !== undefined ? this.figuredMarkdownTranscript(scope, owner, content, transcript.id, chapters, link, speakerNames) : undefined;
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
        for await (const piece of figured?.section ?? service.transcriptPieces(owner, transcript.id, chapters, link, speakerNames)) {
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
    const filename = exportFilename(title, exportFile.untitled, "md");
    if (figured !== undefined) {
      return { filename: exportFilename(title, exportFile.untitled, "zip"), contentType: ZIP_TYPE, body: zipBody(filename, lines(), figured.images, exportedAt) };
    }
    return { filename, contentType: MARKDOWN_TYPE, body: lines() };
  }

  /**
   * The transcript section of a Markdown export with its figures, or `undefined` when the
   * Content has no live figure (the export is then the plain `.md`). Sentences, figures and
   * images are read in the caller's transaction; the section is cut into paragraphs exactly
   * like the streamed one, so its text is the same with the figure blocks added.
   */
  private figuredMarkdownTranscript(
    scope: RepositoryScope,
    owner: string,
    content: Content,
    revisionId: string,
    chapters: ChapterRevision | undefined,
    link: (ms: number) => string | undefined,
    speakerNames: ReadonlyMap<string, string> | undefined,
  ): { section: string[]; images: Uint8Array[] } | undefined {
    const live = liveFigures(scope, owner, content.id);
    if (live.length === 0) {
      return undefined;
    }
    const writer = new TranscriptSectionWriter(chapters, link, speakerNames);
    const pieces: SectionPiece[] = [];
    for (const segment of allSegments(scope, owner, revisionId)) {
      pieces.push(...writer.push({ ...cueOf(segment), id: segment.id }));
    }
    pieces.push(...writer.finish());
    const { items, images } = placeAndLoad(scope, owner, content.id, revisionId, pieces, live);
    return { section: items.map((item) => (item.kind === "text" ? item.text : markdownFigureBlock(item.number, item.figure, link))), images };
  }

  /**
   * The TXT export with its figures, or `undefined` when the Content has no live figure.
   * Paragraphs and speaker prefixes are those of the plain TXT; each figure is a block of its
   * own, separated from its neighbours by a blank line like a paragraph.
   */
  private figureTxtFile(scope: RepositoryScope, owner: string, content: Content, revision: TranscriptRevision, speakers: SpeakerNames | undefined): ExportFile | undefined {
    const live = liveFigures(scope, owner, content.id);
    if (live.length === 0) {
      return undefined;
    }
    const labels = speakers === undefined ? undefined : new SpeakerLabeler(speakers.mode);
    const builder = new SentenceParagraphBuilder();
    const pieces: SectionPiece[] = [];
    const add = (closed: SentenceParagraph | undefined): void => {
      if (closed !== undefined) {
        pieces.push({ kind: "paragraph", text: `${labelFor(speakers, labels, closed.paragraph.speakerId)}${closed.paragraph.text}\n`, sentences: closed.sentences });
      }
    };
    for (const segment of allSegments(scope, owner, revision.id)) {
      add(builder.push({ ...cueOf(segment), id: segment.id }));
    }
    add(builder.flush());
    const { items, images } = placeAndLoad(scope, owner, content.id, revision.id, pieces, live);
    const document = items.map((item) => (item.kind === "text" ? item.text : txtFigureBlock(item.number, item.figure))).join("\n");
    const title = titleOf(scope, owner, content);
    const filename = exportFilename(title, exportFile.untitled, SUBTITLE_FILES.txt.extension);
    return {
      filename: exportFilename(title, exportFile.untitled, "zip"),
      contentType: ZIP_TYPE,
      body: zipBody(filename, single(document), images, this.now()),
    };
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

  /** The transcript section streamed page by page (`TranscriptSectionWriter`). */
  private async *transcriptPieces(
    owner: string,
    revisionId: string,
    chapters: ChapterRevision | undefined,
    link: (ms: number) => string | undefined,
    speakerNames?: ReadonlyMap<string, string>,
  ): AsyncGenerator<string> {
    const writer = new TranscriptSectionWriter(chapters, link, speakerNames);
    for await (const cue of this.cuesOf(owner, revisionId)) {
      for (const piece of writer.push(cue)) {
        yield piece.text;
      }
    }
    for (const piece of writer.finish()) {
      yield piece.text;
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
      yield { ...cueOf(segment), ...(translation === undefined ? {} : { translation }) };
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

/**
 * The body of the transcript section (`exportFile.transcript`): reading paragraphs, and
 * where chapters were requested too, a `###` heading wherever one of that same
 * ChapterRevision's chapters starts. Chapters are projected by time — the latest chapter
 * starting at or before a sentence takes it — so they apply to whichever revision is
 * exported; a chapter start always closes the paragraph before it. Without
 * `sections.chapters` no chapter is read. Fed one sentence at a time, it serves both the
 * streamed section and the one written with figures, so the two never differ in text.
 */
class TranscriptSectionWriter {
  private readonly starts: ChapterRevision["chapters"];
  private readonly link: (ms: number) => string | undefined;
  private readonly speakerNames: ReadonlyMap<string, string> | undefined;
  // The first paragraph of each speaker's turn names the speaker; a chapter heading starts a new turn, as in the reading view.
  private readonly turns = new SpeakerLabeler("turn");
  private readonly builder = new SentenceParagraphBuilder();
  private next = 0;

  constructor(chapters: ChapterRevision | undefined, link: (ms: number) => string | undefined, speakerNames: ReadonlyMap<string, string> | undefined) {
    this.starts = chapters === undefined ? [] : [...chapters.chapters].sort((a, b) => a.startMs - b.startMs);
    this.link = link;
    this.speakerNames = speakerNames;
  }

  /** The pieces this sentence completes: the paragraph a chapter start closes, the heading, the paragraph the sentence closes. */
  push(cue: ExportCue & { id?: string }): SectionPiece[] {
    const pieces: SectionPiece[] = [];
    let opened: string | undefined;
    while (this.next < this.starts.length && (this.starts[this.next] as ChapterRevision["chapters"][number]).startMs <= cue.startMs) {
      opened = (this.starts[this.next] as ChapterRevision["chapters"][number]).title;
      this.next += 1;
    }
    if (opened !== undefined) {
      const closed = this.builder.flush();
      if (closed !== undefined) {
        pieces.push(this.paragraph(closed));
      }
      this.turns.restart();
      pieces.push({ kind: "heading", text: transcriptChapterHeading(opened) });
    }
    const closed = this.builder.push(cue);
    if (closed !== undefined) {
      pieces.push(this.paragraph(closed));
    }
    return pieces;
  }

  /** The last paragraph, if any. */
  finish(): SectionPiece[] {
    const last = this.builder.flush();
    return last === undefined ? [] : [this.paragraph(last)];
  }

  private paragraph({ paragraph, sentences }: SentenceParagraph): SectionPiece {
    const labelled = this.turns.next(paragraph.speakerId);
    const speaker = labelled && paragraph.speakerId !== undefined ? this.speakerNames?.get(paragraph.speakerId) : undefined;
    return { kind: "paragraph", text: transcriptParagraphLine(markdownStamp(paragraph.startMs, this.link(paragraph.startMs)), paragraph.text, speaker), sentences };
  }
}

/** A stored sentence as an export cue, without a translation. */
function cueOf(segment: TranscriptSegment): ExportCue {
  return {
    startMs: segment.startMs,
    endMs: segment.endMs,
    text: segment.text,
    ...(segment.words === undefined ? {} : { words: segment.words }),
    ...(segment.speakerId === undefined ? {} : { speakerId: segment.speakerId }),
    ...(segment.paragraphStart === undefined ? {} : { paragraphStart: segment.paragraphStart }),
    ...(segment.looseJoin === true ? { looseJoin: true } : {}),
  };
}

/** The Content's figures that are not deleted; deleted ones are never exported. */
function liveFigures(scope: RepositoryScope, owner: string, contentId: string): ContentFigure[] {
  return scope.figures.listByContent(owner, contentId).filter((figure) => figure.deletedAt === undefined);
}

/**
 * Maps a sentence of another revision of the Content to the exported one the way the reading
 * view jumps between versions (`mapSegment`); `undefined` when the anchor's revision or
 * sentence is gone or nothing matches, and the figure then falls back to its time.
 */
function sentenceMapper(scope: RepositoryScope, owner: string, contentId: string, readingRevisionId: string): SentenceMapper {
  let revisions: Map<string, TranscriptRevision> | undefined;
  const loaded = new Map<string, TranscriptSegment[]>();
  const segmentsOf = (revisionId: string): TranscriptSegment[] => {
    let segments = loaded.get(revisionId);
    if (segments === undefined) {
      segments = allSegments(scope, owner, revisionId);
      loaded.set(revisionId, segments);
    }
    return segments;
  };
  return (fromRevisionId, segmentId) => {
    revisions ??= new Map(scope.transcripts.listRevisions(owner, contentId).map((revision) => [revision.id, revision]));
    if (!revisions.has(fromRevisionId)) {
      return undefined;
    }
    const source = scope.transcripts.getSegment(owner, segmentId);
    if (source === undefined || source.revisionId !== fromRevisionId) {
      return undefined;
    }
    return mapSegment({ source, targetRevisionId: readingRevisionId, revisions, segmentsOf }).segmentId ?? undefined;
  };
}

/**
 * Places the figures between the export's paragraphs, numbers them in reading order and
 * reads their images, all in the caller's transaction. Every image must be there and the
 * archive must stay within the figure caps; otherwise the export is refused here, before
 * the first byte.
 */
function placeAndLoad(
  scope: RepositoryScope,
  owner: string,
  contentId: string,
  revisionId: string,
  pieces: readonly SectionPiece[],
  live: readonly ContentFigure[],
): { items: Array<SectionItem<ContentFigure>>; images: Uint8Array[] } {
  const paragraphs = pieces.flatMap((piece) => (piece.kind === "paragraph" ? [{ segments: piece.sentences }] : []));
  const layout = placeFigures({ readingRevisionId: revisionId, paragraphs, figures: live, mapSentence: sentenceMapper(scope, owner, contentId, revisionId) });
  const { items, figures } = interleaveFigures(pieces, layout);
  const cap = FIGURES_PER_CONTENT_MAX * FIGURE_IMAGE_MAX_BYTES;
  const tooLarge = () => amberError("media_too_large", "figure images pass the export cap", { params: { limit: `${cap / BYTES_PER_MB} MB` } });
  let total = 0;
  const images = figures.map((figure) => {
    const bytes = scope.figures.getImage(owner, figure.id);
    if (bytes === undefined) {
      throw amberError("internal", "a figure's image is missing");
    }
    total += bytes.length;
    return bytes;
  });
  if (total > cap) {
    throw tooLarge();
  }
  try {
    // The document's size is not known yet; the images alone must already fit.
    checkZip([{ name: "document", size: 0 }, ...images.map((image, index) => ({ name: figureImagePath(index + 1), size: image.length }))]);
  } catch (error) {
    if (error instanceof ZipLimitError) {
      throw tooLarge();
    }
    throw error;
  }
  return { items, images };
}

/** The zip of a document and its figure images, `images/001.webp` on; the document is gathered first, as stored entries need their size up front. */
async function* zipBody(documentName: string, document: AsyncIterable<string>, images: readonly Uint8Array[], modifiedAt: number): AsyncGenerator<Uint8Array> {
  let text = "";
  for await (const piece of document) {
    text += piece;
  }
  const entries: ZipEntry[] = [{ name: documentName, data: Buffer.from(text, "utf8") }, ...images.map((data, index) => ({ name: figureImagePath(index + 1), data }))];
  yield* zipStream(entries, { modifiedAt });
}

async function* single(text: string): AsyncGenerator<string> {
  yield text;
}

/** Every sentence of a revision in ordinal order, read inside the caller's transaction. */
function allSegments(scope: RepositoryScope, owner: string, revisionId: string): TranscriptSegment[] {
  const segments: TranscriptSegment[] = [];
  let after: number | undefined;
  for (;;) {
    const page = scope.transcripts.listSegments(owner, revisionId, { ...(after === undefined ? {} : { afterOrdinal: after }), limit: API_PAGE_SIZE_MAX });
    segments.push(...page);
    if (page.length < API_PAGE_SIZE_MAX) {
      return segments;
    }
    after = (page.at(-1) as TranscriptSegment).ordinal;
  }
}

/**
 * What a styled ASS download needs besides its sentences to embed restore data: the shown
 * revision's language and joining, the paired translation's language when bilingual, and the speakers.
 */
interface RestoreData {
  language: string;
  /** The shown revision's `looseJoin`: the package takes it from the revision, not from its sentences. */
  looseJoin?: true;
  translationLanguage?: string;
  speakers: readonly ContentSpeaker[];
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

async function* txtLines(cues: AsyncIterable<ExportCue>, speakers: SpeakerNames | undefined): AsyncGenerator<string> {
  const labels = speakers === undefined ? undefined : new SpeakerLabeler(speakers.mode);
  let first = true;
  for await (const paragraph of paragraphsOf(cues)) {
    yield txtParagraph(paragraph, first, labelFor(speakers, labels, paragraph.speakerId));
    first = false;
  }
}

/** What the speaker options of a subtitle export resolve to. */
interface SpeakerNames {
  names: ReadonlyMap<string, string>;
  /** The exported revision is Chinese: names are followed by a full-width colon. */
  chinese: boolean;
  mode: SpeakerLabelMode;
}

/** The display name of a cue's speaker; absent for unassigned sentences and without `includeSpeakers`. */
function nameOf(speakers: SpeakerNames | undefined, speakerId: string | undefined): string | undefined {
  return speakerId === undefined ? undefined : speakers?.names.get(speakerId);
}

/** `exactOptionalPropertyTypes`-safe `{ speaker }` for a name that may be absent. */
function speakerField(name: string | undefined): { speaker?: string } {
  return name === undefined ? {} : { speaker: name };
}

/** The `名字：` prefix of the next item of a line-based format, or nothing when it is not labelled. */
function labelFor(speakers: SpeakerNames | undefined, labeler: SpeakerLabeler | undefined, speakerId: string | undefined): string {
  if (speakers === undefined || labeler === undefined) return "";
  const labelled = labeler.next(speakerId);
  const name = nameOf(speakers, speakerId);
  return labelled && name !== undefined ? speakerPrefix(name, speakers.chinese) : "";
}

/**
 * `{{revision_label}}`: kind, the model that produced the revision when there is one,
 * and its creation time — the same parts the reading view's version picker shows. A revision
 * brought in with a content pack names the model the pack recorded.
 */
function revisionLabelText(revision: TranscriptRevision): string {
  const { generation } = revision;
  const model =
    generation.kind === "llm"
      ? generation.modelRef.modelDisplaySnapshot || generation.modelRef.modelId
      : generation.kind === "asr"
        ? generation.modelId
        : generation.kind === "pack"
          ? generation.modelName || undefined
          : undefined;
  return [contentView.revisionKind[revision.kind], ...(model === undefined ? [] : [model]), dateTimeText(revision.createdAt)].join(" · ");
}

/** The `glyphs` option of a styled document: present only when the font could be read. */
function glyphsOf(metrics: SubtitleFontMetrics | undefined): { glyphs: GlyphAdvances } | Record<string, never> {
  const glyphs = metrics?.advances();
  return glyphs === undefined ? {} : { glyphs };
}
