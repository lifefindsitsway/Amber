import { readFile } from "node:fs/promises";
import { SPEAKERS_PER_CONTENT_MAX, SUBTITLE_IMPORT_MAX_BYTES } from "../../shared/defaults.ts";
import type { SubtitleImportResponse } from "../../shared/dto/content.ts";
import type { SubtitleInspectLocalRequest } from "../../shared/dto/local-media.ts";
import type {
  InspectedSubtitleFormat,
  SubtitleImportOptions,
  SubtitleInspectRequest,
  SubtitleInspectResponse,
  TimedSubtitleFormat,
} from "../../shared/dto/subtitle-import.ts";
import type { SegmentId } from "../../shared/ids.ts";
import { normalizeSpeakerName } from "../../shared/speakers.ts";
import { BYTES_PER_MB } from "../../shared/units.ts";
import type { Content } from "../domain/content.ts";
import { AmberError, amberError } from "../domain/errors.ts";
import {
  inspectSubtitleDocument,
  planSubtitleImport,
  readSubtitleDocument,
  type PlannedSpeaker,
  type SubtitleDocument,
  type SubtitleImportPlan,
} from "../domain/subtitle-document.ts";
import { canonicalLanguageTag, decodeSubtitleText, importedTranscript, parseTimedSubtitle, type ParsedSubtitle } from "../domain/subtitle-file.ts";
import { subtitleTextDigest } from "../domain/subtitle-package.ts";
import { importedSubtitleWarnings, judgeSubtitle } from "../domain/subtitle-verdict.ts";
import { timingFidelityFor, type TranscriptRevision, type TranscriptSegment } from "../domain/transcript.ts";
import type { RequestPrincipal } from "../domain/user.ts";
import type { FileGrantVerifier } from "../ports/file-grant.ts";
import type { Repository, RepositoryScope } from "../ports/repository.ts";
import { readableFileSize, verifyFileGrant } from "./local-file-access.ts";

/** File extensions that name a subtitle format; anything else is decided by the content. */
const FORMAT_BY_EXTENSION: Readonly<Record<string, InspectedSubtitleFormat>> = {
  srt: "srt",
  vtt: "vtt",
  ass: "ass",
  ssa: "ass",
  ambersub: "ambersub",
  txt: "txt",
  md: "md",
  markdown: "md",
};

/** Formats that only the shared subtitle reader understands; the plain SRT / VTT import never sees them. */
const READER_ONLY_FORMATS: ReadonlySet<InspectedSubtitleFormat> = new Set(["ass", "ambersub"]);

/** The format a file name's extension names, if any. Works on Windows paths too. */
export function subtitleFormatOfFilename(filename: string | undefined): InspectedSubtitleFormat | undefined {
  const extension = filename?.toLowerCase().match(/\.([a-z]+)$/)?.[1];
  return extension === undefined ? undefined : FORMAT_BY_EXTENSION[extension];
}

/** Whether a request must go through the shared reader: it carries options or names a format only the reader knows. */
export function needsSubtitleReader(input: { format?: InspectedSubtitleFormat | undefined; filename?: string | undefined; options?: SubtitleImportOptions | undefined }): boolean {
  if (input.options !== undefined) {
    return true;
  }
  const format = input.format ?? subtitleFormatOfFilename(input.filename);
  return format !== undefined && READER_ONLY_FORMATS.has(format);
}

function isFormatError(error: unknown): boolean {
  return error instanceof AmberError && error.appError.code === "invalid_request.subtitle_format";
}

/**
 * A text that is neither SRT nor VTT for the plain import: an ASS or a package recognized by
 * its content, or `undefined` (the plain import then does what it always did with it).
 */
export function sniffReaderOnlyDocument(text: string): SubtitleDocument | undefined {
  try {
    const document = readSubtitleDocument(text, {});
    return READER_ONLY_FORMATS.has(document.format) ? document : undefined;
  } catch (error) {
    if (isFormatError(error)) {
      return undefined;
    }
    throw error;
  }
}

/** What a subtitle text was read as: reference text, or a timed document. */
export type SubtitleRead = { kind: "reference"; format: "txt" | "md" } | { kind: "timed"; document: SubtitleDocument };

/**
 * Reads a subtitle text the way a preview and an import with options both do, so they agree
 * on what the file is: the declared format, else the extension, else the content — a text no
 * timed format recognizes is plain text. An extension is only ever a file-name hint to the
 * reader, never a declared format: SRT and VTT are told apart by content, as the plain import
 * always has, so a VTT file named `.srt` still imports.
 */
export function readSubtitleText(text: string, hint: { format?: InspectedSubtitleFormat; filename?: string }): SubtitleRead {
  const named = hint.format ?? subtitleFormatOfFilename(hint.filename);
  if (named === "txt" || named === "md") {
    return { kind: "reference", format: named };
  }
  const declared = hint.format;
  const readerHint = {
    ...(declared === undefined || declared === "txt" || declared === "md" ? {} : { format: declared }),
    ...(hint.filename === undefined ? {} : { filename: hint.filename }),
  };
  if (named !== undefined) {
    return { kind: "timed", document: readSubtitleDocument(text, readerHint) };
  }
  try {
    return { kind: "timed", document: readSubtitleDocument(text, readerHint) };
  } catch (error) {
    if (isFormatError(error)) {
      return { kind: "reference", format: "txt" };
    }
    throw error;
  }
}

/** Options name the preview they were chosen on; a different text read now must be previewed again. */
export function checkSubtitleDigest(text: string, options: SubtitleImportOptions | undefined): void {
  if (options !== undefined && subtitleTextDigest(text) !== options.expectedDigest) {
    throw amberError("conflict", "the subtitle differs from the one previewed", { code: "conflict.subtitle_changed" });
  }
}

function subtitleTooLarge(): AmberError {
  return amberError("media_too_large", "subtitle text is too large", { params: { limit: `${SUBTITLE_IMPORT_MAX_BYTES / BYTES_PER_MB} MB` } });
}

function speakersChanged(reason: string): never {
  throw amberError("conflict", reason, { code: "conflict.speakers_changed" });
}

/**
 * A subtitle's original language: required, in canonical case, unless the file carries a
 * package — a package itself, or a styled ASS whose restore data verified — which names its
 * own language and ignores the request's.
 */
function originalLanguage(document: SubtitleDocument, language: string | undefined, detail: string): string | undefined {
  if (document.package !== undefined) {
    return undefined;
  }
  if (language !== undefined) {
    const canonical = canonicalLanguageTag(language);
    if (canonical === undefined) {
      throw amberError("invalid_request", "invalid subtitle language", { params: { detail } });
    }
    return canonical;
  }
  throw amberError("invalid_request", "a timed subtitle needs its language", { params: { detail } });
}

/** The import plan of a read document under the request's language and options. */
export function planFromDocument(document: SubtitleDocument, input: { language?: string | undefined; options?: SubtitleImportOptions | undefined; languageDetail: string }): SubtitleImportPlan {
  const language = originalLanguage(document, input.language, input.languageDetail);
  return planSubtitleImport(document, { ...(language === undefined ? {} : { language }), ...(input.options === undefined ? {} : { options: input.options }) });
}

export interface SubtitleImportWrite {
  contentId: string;
  plan: SubtitleImportPlan;
  /**
   * The Content is created in the same transaction. Its import is always the primary with
   * every translation current; `identities`, `setCurrent` and `expectedState` describe an
   * existing Content's state, so they are ignored rather than refused (a client may send the
   * preview's choices unchanged). The caller syncs search once the Content is complete.
   */
  newContent: boolean;
  options?: SubtitleImportOptions;
  newId: () => string;
  now: number;
}

export interface SubtitleImportWritten {
  revisionId: string;
  translationRevisionIds: Record<string, string>;
  speakersCreated: number;
  warnings: string[];
}

/**
 * Writes an import plan inside the caller's transaction, in the order the sentence trigger
 * requires: speakers are registered before the sentences that name them, then the original,
 * then its translations, then (when asked) the primary and each language's current
 * translation. Every check runs before anything is written, and the transaction rolls back
 * whatever a later failure would leave.
 */
export function writeSubtitleImport(scope: RepositoryScope, owner: string, input: SubtitleImportWrite): SubtitleImportWritten {
  const { contentId, plan, newId, now } = input;
  const content = scope.contents.get(owner, contentId);
  if (content === undefined) {
    throw amberError("not_found", "content not found");
  }
  const options = input.newContent ? undefined : input.options;
  const setCurrent = input.newContent || options?.setCurrent !== false;
  const translations = plan.translations.filter((translation) => translation.lines.length > 0);

  // Only speakers some sentence names are registered: an identity nobody uses would be an invisible row.
  const used = new Set(plan.segments.flatMap((segment) => (segment.speakerKey === null ? [] : [segment.speakerKey])));
  const planned = plan.speakers.filter((speaker) => used.has(speaker.key));
  if (planned.length !== used.size) {
    throw amberError("internal", "an import plan names a speaker it does not define");
  }

  const expected = options?.expectedState;
  if (setCurrent && expected !== undefined) {
    const primary = content.primaryTranscriptRevisionId;
    if ((primary ?? null) !== expected.primaryRevisionId) {
      throw amberError("conflict", "the primary transcript changed since the preview", {
        code: "conflict.primary_changed",
        ...(primary === undefined ? {} : { details: { currentPrimaryRevisionId: primary } }),
      });
    }
    for (const translation of translations) {
      const current = scope.translations.getArtifact(owner, contentId, translation.language)?.currentRevisionId;
      if (current !== expected.currentTranslations[translation.language]) {
        throw amberError("conflict", "a current translation changed since the preview", {
          code: "conflict.translation_changed",
          ...(current === undefined ? {} : { details: { currentRevisionId: current } }),
        });
      }
    }
  }

  const existing = scope.speakers.list(owner, contentId);
  // The preview never offers speakers named only by comparison transcriptions, so a request
  // naming one is treated like one naming a speaker that no longer exists.
  const comparisonOnly = options?.identities === undefined ? new Set<string>() : scope.speakers.comparisonOnlyIds(owner, contentId);
  const speakerIds = new Map<string, string>();
  for (const identity of options?.identities ?? []) {
    if (identity.speakerId === undefined || !used.has(identity.key)) {
      continue;
    }
    const speaker = existing.find((candidate) => candidate.id === identity.speakerId && !comparisonOnly.has(candidate.id));
    if (speaker === undefined) {
      speakersChanged("a speaker chosen for an imported one no longer exists");
    }
    const seen = expected?.speakers.find((candidate) => candidate.id === speaker.id);
    if (seen !== undefined && seen.name !== speaker.name) {
      speakersChanged("a speaker chosen for an imported one was renamed since the preview");
    }
    speakerIds.set(identity.key, speaker.id);
  }

  const created = planned.filter((speaker) => !speakerIds.has(speaker.key));
  const room = Math.max(0, SPEAKERS_PER_CONTENT_MAX - existing.length);
  if (created.length > room) {
    throw amberError("conflict", "not enough room for the speakers of the imported subtitle", {
      code: "conflict.speaker_capacity",
      details: { room, required: created.length },
    });
  }
  const rows = speakerRows(created, existing.map((speaker) => speaker.ordinal), newId);
  if (rows.length > 0) {
    scope.speakers.insert(owner, contentId, rows, now);
  }
  rows.forEach((row, index) => speakerIds.set((created[index] as PlannedSpeaker).key, row.id));

  const revisionId = newId();
  const segments = plan.segments.map(
    (segment, ordinal): TranscriptSegment => ({
      id: newId() as SegmentId,
      revisionId,
      ordinal,
      startMs: segment.startMs,
      endMs: segment.endMs,
      text: segment.text,
      sourceSegmentIds: [],
      ...(segment.speakerKey === null ? {} : { speakerId: speakerIds.get(segment.speakerKey) as string }),
      ...(plan.paragraphMarks ? { paragraphStart: segment.paragraphStart === true || ordinal === 0 } : {}),
    }),
  );
  const revision: TranscriptRevision = {
    id: revisionId,
    contentId,
    kind: "imported",
    language: plan.language,
    timingFidelity: timingFidelityFor("imported"),
    generation: { kind: "imported", format: plan.format },
    segmentCount: segments.length,
    createdAt: now,
  };
  // The insert refuses a revision that breaks the transcript invariants (timing, ordinals,
  // sources, paragraph marks), which rolls the whole import back.
  scope.transcripts.insertRevision(owner, revision, segments);

  const translationRevisionIds: Record<string, string> = {};
  for (const translation of translations) {
    const translated = translatedRevision(revision, segments, translation, plan.paragraphMarks, plan.format, newId, now);
    scope.transcripts.insertRevision(owner, translated.revision, translated.segments);
    translationRevisionIds[translation.language] = translated.revision.id;
  }

  if (setCurrent) {
    scope.contents.setPrimaryTranscript(owner, contentId, revisionId, now);
    // A replaced current translation stays in the history: an import is not a hand edit, so
    // the rule that drops a replaced hand edit does not apply. Drafts are left alone too.
    for (const [language, id] of Object.entries(translationRevisionIds)) {
      scope.translations.setCurrent(owner, contentId, language, id, newId());
    }
  }
  if (!input.newContent) {
    scope.search.syncContent(owner, contentId);
  }
  return {
    revisionId,
    translationRevisionIds,
    speakersCreated: rows.length,
    warnings: importWarnings(plan, segments, content),
  };
}

/**
 * Speaker rows for the identities an import creates. A speaker keeps the ordinal its file
 * asks for while it is free on the Content and within the per-Content range; the others take
 * the smallest free ordinals in order of first appearance — so a file naming its speakers
 * plus one "Speaker 11" comes back as 1, 2 and 11, the numbers (and default colors) it had —
 * and a default-style label that lost its number is kept as an ordinary name, since
 * "Speaker N" would no longer match its ordinal. Names are stored unconfirmed.
 */
function speakerRows(created: readonly PlannedSpeaker[], taken: readonly number[], newId: () => string) {
  const used = new Set(taken);
  const ordinals = created.map((speaker) => {
    const wanted = speaker.ordinal;
    if (wanted === undefined || !Number.isInteger(wanted) || wanted < 1 || wanted > SPEAKERS_PER_CONTENT_MAX || used.has(wanted)) {
      return undefined;
    }
    used.add(wanted);
    return wanted;
  });
  let next = 1;
  const nextFree = (): number => {
    while (used.has(next)) next += 1;
    used.add(next);
    return next;
  };
  return created.map((speaker, index) => {
    const kept = ordinals[index];
    const ordinal = kept ?? nextFree();
    const fallback = kept === undefined && speaker.fallbackName !== undefined ? normalizeSpeakerName(speaker.fallbackName) : undefined;
    const name = typeof fallback === "string" ? fallback : speaker.name;
    return {
      id: newId(),
      ordinal,
      ...(name === undefined ? {} : { name }),
      ...(speaker.colorIndex === undefined ? {} : { colorIndex: speaker.colorIndex }),
    };
  });
}

/**
 * One translated revision of the imported original: each line becomes a sentence with that
 * original sentence as its single source, sharing its timing, ordinal, speaker and paragraph
 * mark. Sentences without a line are simply absent (ordinals may have gaps); the first
 * sentence always opens a paragraph when marks are kept, as the invariant requires.
 */
function translatedRevision(
  original: TranscriptRevision,
  originalSegments: readonly TranscriptSegment[],
  translation: SubtitleImportPlan["translations"][number],
  paragraphMarks: boolean,
  format: TimedSubtitleFormat,
  newId: () => string,
  now: number,
): { revision: TranscriptRevision; segments: TranscriptSegment[] } {
  const revisionId = newId();
  const lines = [...translation.lines].sort((a, b) => a.segmentIndex - b.segmentIndex);
  const segments = lines.map((line, index): TranscriptSegment => {
    const source = originalSegments[line.segmentIndex];
    if (source === undefined) {
      throw amberError("internal", "an imported translation names a sentence the original does not have");
    }
    return {
      id: newId() as SegmentId,
      revisionId,
      ordinal: source.ordinal,
      startMs: source.startMs,
      endMs: source.endMs,
      text: line.text,
      sourceSegmentIds: [source.id],
      ...(source.speakerId === undefined ? {} : { speakerId: source.speakerId }),
      ...(paragraphMarks ? { paragraphStart: index === 0 || source.paragraphStart === true } : {}),
    };
  });
  return {
    revision: {
      id: revisionId,
      contentId: original.contentId,
      kind: "translated",
      parentRevisionId: original.id,
      language: translation.language,
      timingFidelity: timingFidelityFor("translated"),
      generation: { kind: "imported", format },
      segmentCount: segments.length,
      createdAt: now,
    },
    segments,
  };
}

function importWarnings(plan: SubtitleImportPlan, segments: readonly TranscriptSegment[], content: Content): string[] {
  return [
    ...(plan.droppedCues > 0 ? ["subtitle_cue_dropped"] : []),
    ...(content.durationMs === undefined ? [] : importedSubtitleWarnings(segments, content.durationMs)),
  ];
}

/** A subtitle that comes with a new Content: the plain SRT / VTT import, or a plan from the shared reader. */
export type InitialSubtitle = { kind: "plain"; subtitle: ParsedSubtitle; language: string } | { kind: "plan"; plan: SubtitleImportPlan };

/**
 * Reads the subtitle a creation entry point carries. Without options, SRT and VTT go through
 * the plain import exactly as before (format by content; a declared format must match); an
 * ASS or a package, named by format or extension or recognized by its content, goes through
 * the shared reader. With options the shared reader always reads it, after the digest check.
 */
export function prepareInitialSubtitle(
  text: string,
  input: { language: string; languageDetail: string; format?: TimedSubtitleFormat | undefined; filename?: string | undefined; options?: SubtitleImportOptions | undefined },
): InitialSubtitle {
  if (needsSubtitleReader(input)) {
    checkSubtitleDigest(text, input.options);
    const read = readSubtitleText(text, {
      ...(input.format === undefined ? {} : { format: input.format }),
      ...(input.filename === undefined ? {} : { filename: input.filename }),
    });
    if (read.kind !== "timed") {
      throw amberError("invalid_request", "an initial subtitle must have a timeline", { code: "invalid_request.subtitle_format" });
    }
    return { kind: "plan", plan: planFromDocument(read.document, { language: input.language, options: input.options, languageDetail: input.languageDetail }) };
  }
  const language = canonicalLanguageTag(input.language);
  if (language === undefined) {
    throw amberError("invalid_request", `invalid ${input.languageDetail}`, { params: { detail: input.languageDetail } });
  }
  let subtitle: ParsedSubtitle;
  try {
    subtitle = parseTimedSubtitle(text);
  } catch (error) {
    const document = input.format === undefined && isFormatError(error) ? sniffReaderOnlyDocument(text) : undefined;
    if (document === undefined) {
      throw error;
    }
    return { kind: "plan", plan: planFromDocument(document, { language, languageDetail: input.languageDetail }) };
  }
  if (input.format !== undefined && input.format !== subtitle.format) {
    throw amberError("invalid_request", "subtitle content does not match its declared format", { code: "invalid_request.subtitle_format" });
  }
  return { kind: "plain", subtitle, language };
}

/**
 * Writes a new Content's initial subtitle, made primary; returns the ids written (the
 * original first). The caller syncs search after.
 */
export function writeInitialSubtitle(
  scope: RepositoryScope,
  owner: string,
  input: { contentId: string; subtitle: InitialSubtitle; newId: () => string; now: number },
): { revisionId: string; createdIds: string[] } {
  const { contentId, subtitle, newId, now } = input;
  if (subtitle.kind === "plain") {
    const { revision, segments } = importedTranscript({ revisionId: newId(), contentId, language: subtitle.language, subtitle: subtitle.subtitle, newId, createdAt: now });
    scope.transcripts.insertRevision(owner, revision, segments);
    scope.contents.setPrimaryTranscript(owner, contentId, revision.id, now);
    return { revisionId: revision.id, createdIds: [revision.id] };
  }
  const written = writeSubtitleImport(scope, owner, { contentId, plan: subtitle.plan, newContent: true, newId, now });
  return { revisionId: written.revisionId, createdIds: [written.revisionId, ...Object.values(written.translationRevisionIds)] };
}

/**
 * `POST /contents/:id/subtitle-import` through the shared reader, inside the caller's
 * transaction: the owner's Content, then the digest, then reading and planning, then the
 * write. TXT and Markdown still become reference text.
 */
export function importSubtitleWithReader(
  scope: RepositoryScope,
  owner: string,
  input: {
    contentId: string;
    text: string;
    format?: InspectedSubtitleFormat | undefined;
    filename?: string | undefined;
    language?: string | undefined;
    options?: SubtitleImportOptions | undefined;
    /** Already read by the caller (an ASS or package recognized by content). */
    document?: SubtitleDocument;
    newId: () => string;
    now: number;
  },
): SubtitleImportResponse {
  const { contentId, text, newId, now } = input;
  if (scope.contents.get(owner, contentId) === undefined) {
    throw amberError("not_found", "content not found");
  }
  checkSubtitleDigest(text, input.options);
  const read: SubtitleRead =
    input.document !== undefined
      ? { kind: "timed", document: input.document }
      : readSubtitleText(text, { ...(input.format === undefined ? {} : { format: input.format }), ...(input.filename === undefined ? {} : { filename: input.filename }) });
  if (read.kind === "reference") {
    return { referenceTextId: insertReferenceText(scope, owner, { contentId, format: read.format, text, newId, now }), warnings: [] };
  }
  const plan = planFromDocument(read.document, { language: input.language, options: input.options, languageDetail: "language" });
  const written = writeSubtitleImport(scope, owner, {
    contentId,
    plan,
    newContent: false,
    ...(input.options === undefined ? {} : { options: input.options }),
    newId,
    now,
  });
  return {
    transcriptRevisionId: written.revisionId,
    translationRevisionIds: written.translationRevisionIds,
    speakersCreated: written.speakersCreated,
    warnings: written.warnings,
  };
}

/** TXT / Markdown into a ReferenceText of the Content; the primary is left alone. */
export function insertReferenceText(
  scope: RepositoryScope,
  owner: string,
  input: { contentId: string; format: "txt" | "md"; text: string; newId: () => string; now: number },
): string {
  const id = input.newId();
  scope.referenceTexts.insert(owner, { id, contentId: input.contentId, origin: input.format === "md" ? "md_import" : "txt_import", text: input.text, createdAt: input.now });
  scope.search.syncContent(owner, input.contentId);
  return id;
}

export interface SubtitleImportServiceOptions {
  repository: Repository;
  /** Local mode only: the verifier of file dialog grants, for previewing a local file. */
  grants?: FileGrantVerifier;
}

type InspectTarget = NonNullable<SubtitleInspectResponse["target"]>;

/** Coverage reasons of the subtitle verdict; the other reasons (music lines, gaps) are not about the time range. */
const COVERAGE_REASONS: ReadonlySet<string> = new Set(["subtitle_coverage_low", "subtitle_coverage_high", "subtitle_coverage_marginal"]);

/**
 * Whether a subtitle time range does not fit the media duration by the coverage rules that
 * judge every subtitle. Coverage looks only at the last end, so one line spanning the range
 * stands for the file; its text is speech so the music rule stays out of it.
 */
function coverageWarning(range: { start: number; end: number } | undefined, durationMs: number | undefined): boolean {
  if (range === undefined || durationMs === undefined || !(durationMs > 0)) {
    return false;
  }
  const { reasons } = judgeSubtitle([{ startMs: range.start, endMs: range.end, text: "speech" }], durationMs);
  return reasons.some((reason) => COVERAGE_REASONS.has(reason));
}

/**
 * Subtitle previews (`POST /api/subtitles/inspect`, `inspect-local`): what an import would
 * read from a file, its digest, and — for an existing Content — the state the import will
 * recheck. Nothing is written.
 */
export class SubtitleImportService {
  private readonly options: SubtitleImportServiceOptions;

  constructor(options: SubtitleImportServiceOptions) {
    this.options = options;
  }

  inspect(principal: RequestPrincipal, body: SubtitleInspectRequest): SubtitleInspectResponse {
    if (Buffer.byteLength(body.text, "utf8") > SUBTITLE_IMPORT_MAX_BYTES) {
      throw subtitleTooLarge();
    }
    return this.inspectText(principal.userId, body.text, {
      ...(body.format === undefined ? {} : { format: body.format }),
      ...(body.filename === undefined ? {} : { filename: body.filename }),
      ...(body.contentId === undefined ? {} : { contentId: body.contentId }),
    });
  }

  /** Local mode: the file must be the one the shell's dialog granted; read as UTF-8 like a local import reads it. */
  async inspectLocal(principal: RequestPrincipal, body: SubtitleInspectLocalRequest): Promise<SubtitleInspectResponse> {
    const grants = this.options.grants;
    if (grants === undefined) {
      throw new TypeError("previewing a local subtitle needs a file grant verifier");
    }
    verifyFileGrant(grants, body.grant, body.path);
    const size = await readableFileSize(body.path, "path");
    if (size > SUBTITLE_IMPORT_MAX_BYTES) {
      throw subtitleTooLarge();
    }
    const text = decodeSubtitleText(await readFile(body.path));
    return this.inspectText(principal.userId, text, { filename: body.path, ...(body.contentId === undefined ? {} : { contentId: body.contentId }) });
  }

  private inspectText(owner: string, text: string, hint: { format?: InspectedSubtitleFormat; filename?: string; contentId?: string }): SubtitleInspectResponse {
    // The owner check comes first, so another user's Content id learns nothing about the file handling.
    const state = hint.contentId === undefined ? undefined : this.targetState(owner, hint.contentId);
    const digest = subtitleTextDigest(text);
    const read = readSubtitleText(text, { ...(hint.format === undefined ? {} : { format: hint.format }), ...(hint.filename === undefined ? {} : { filename: hint.filename }) });
    const inspection: Omit<SubtitleInspectResponse, "digest" | "target"> =
      read.kind === "reference"
        ? { format: read.format, cueCount: 0, droppedCues: { count: 0, samples: [] }, speakers: { source: "none", candidates: [], sequence: [] }, limits: [] }
        : inspectSubtitleDocument(read.document);
    if (state === undefined) {
      return { ...inspection, digest };
    }
    const { durationMs, ...target } = state;
    return {
      ...inspection,
      digest,
      target: { ...target, ...(durationMs === undefined ? {} : { durationMs }), coverageWarning: coverageWarning(inspection.rangeMs, durationMs) },
    };
  }

  /** What an import into the Content will recheck, plus its speakers to map onto and its media duration. */
  private targetState(owner: string, contentId: string): Omit<InspectTarget, "coverageWarning" | "durationMs"> & { durationMs: number | undefined } {
    return this.options.repository.withTransaction((scope) => {
      const content = scope.contents.get(owner, contentId);
      if (content === undefined) {
        throw amberError("not_found", "content not found");
      }
      const used = scope.speakers.usedIds(owner, contentId);
      // Speakers named only by comparison transcriptions are left out of every picker, as in the speaker list's flag.
      const comparisonOnly = scope.speakers.comparisonOnlyIds(owner, contentId);
      const all = scope.speakers.list(owner, contentId);
      const speakers = all
        .filter((speaker) => !comparisonOnly.has(speaker.id))
        .map((speaker) => ({
          id: speaker.id,
          ordinal: speaker.ordinal,
          ...(speaker.name === undefined ? {} : { name: speaker.name }),
          colorIndex: speaker.colorIndex,
          ...(speaker.avatar === undefined ? {} : { avatarVersion: speaker.avatar.version }),
          used: used.has(speaker.id),
        }));
      const currentTranslations: Record<string, string> = {};
      for (const artifact of scope.translations.listArtifacts(owner, contentId)) {
        if (artifact.currentRevisionId !== undefined) {
          currentTranslations[artifact.targetLanguage] = artifact.currentRevisionId;
        }
      }
      return {
        primaryRevisionId: content.primaryTranscriptRevisionId ?? null,
        speakers,
        speakerRoom: Math.max(0, SPEAKERS_PER_CONTENT_MAX - all.length),
        currentTranslations,
        durationMs: content.durationMs,
      };
    });
  }
}
