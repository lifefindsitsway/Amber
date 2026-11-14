import { FileText, TriangleAlert } from "lucide-react";
import { useId, useState, type ReactNode } from "react";
import { useTranslation } from "react-i18next";
import type { SubtitleImportLimit } from "../../../shared/dto/subtitle-import.ts";
import { languageNames } from "../../../shared/i18n/zh-CN/languages.ts";
import { ErrorView } from "../../components/error-view.tsx";
import { formatDuration } from "../../format.ts";
import { Button } from "../../ui/button.tsx";
import { Spinner } from "../../ui/feedback.tsx";
import { languageLabel } from "./labels.ts";
import { SpeakerAvatar } from "./speakers/speaker-avatar.tsx";
import { speakerLabel } from "./speakers/speaker-data.ts";
import {
  attributionOf,
  effectiveIdentities,
  importBlockers,
  importedSpeakers,
  initialImportChoice,
  knownTranslationLanguages,
  plainImportPossible,
  replacedTranslations,
  sameNameMatches,
  speakerNeed,
  translationLanguageAllowed,
  type SameNameMatch,
  type SubtitleImportChoice,
  type SubtitlePreview,
  type UnlabeledRule,
} from "./subtitle-import-choice.ts";
import type { SubtitlePreviewState } from "./subtitle-import-data.ts";

/** Limits worded at the top as a notice rather than in the list of differences. */
const NOTICE_LIMITS: ReadonlySet<SubtitleImportLimit> = new Set(["restore_data_mismatch"]);
/** Translation language choices that are not languages. */
const PICK = "";
const SKIP = "\u0000skip";

const SECTION = "flex flex-col gap-2 border-t border-line pt-3";
const HEADING = "text-xs font-medium text-muted";
const SELECT = "h-8 min-w-0 max-w-full rounded-md border border-line bg-surface px-2 text-sm";

/**
 * The choice for the shown preview. A new preview of the same file (the same digest, after
 * 「重新预览」) keeps what the user chose, since every rule rechecks a choice against the preview;
 * another file starts from its own defaults.
 */
export function useSubtitleImportChoice(preview: SubtitlePreview | undefined): [SubtitleImportChoice | undefined, (choice: SubtitleImportChoice) => void] {
  const [held, setHeld] = useState<{ preview: SubtitlePreview; choice: SubtitleImportChoice } | undefined>(undefined);
  if (preview === undefined) return [undefined, () => undefined];
  const choice = held !== undefined && (held.preview === preview || held.preview.digest === preview.digest) ? held.choice : initialImportChoice(preview);
  return [choice, (next) => setHeld({ preview, choice: next })];
}

/** Numbers as the UI language writes them: 2,888. */
function useNumber(): (value: number) => string {
  const { i18n } = useTranslation();
  const format = new Intl.NumberFormat(i18n.language);
  return (value) => format.format(value);
}

/**
 * The subtitle preview shared by the new page and the import dialog: what the file holds and,
 * for the chosen file only, the choices it calls for. Notices come first; a package shows its
 * three numbers and what it restores; an SRT offers its leading names and how unlabelled cues
 * are attributed; a VTT or ASS shows the speakers it names; translations appear only when the
 * file has them. With an existing Content (`preview.target`) it adds same-name identities and
 * 「导入后设为当前版本」. Every choice is recounted here; nothing is requested again.
 */
export function SubtitleImportPreview(props: {
  state: SubtitlePreviewState;
  choice: SubtitleImportChoice | undefined;
  onChoice: (choice: SubtitleImportChoice) => void;
  onRefresh: () => void;
  /** The subtitle's own language, which a translation may not share. */
  originalLanguage: string | undefined;
  /** The Content whose speakers' photos the identity rows show. */
  contentId?: string;
}) {
  const { t } = useTranslation();
  const { state } = props;
  if (state.status === "idle") return null;
  if (state.status === "loading") {
    return (
      <p className="flex items-center gap-2 text-xs text-muted" role="status" data-testid="subtitle-preview-loading">
        <Spinner size={14} />
        {t("subtitleImport.preview.loading")}
      </p>
    );
  }
  if (state.status === "failed") {
    return (
      <div className="flex flex-col gap-1.5" data-testid="subtitle-preview-failed">
        <ErrorView error={state.error}>
          <Button size="sm" onClick={props.onRefresh} data-testid="subtitle-preview-retry">
            {t("subtitleImport.failed.retry")}
          </Button>
        </ErrorView>
        {plainImportPossible(state.error.code) ? <p className="text-xs text-muted">{t("subtitleImport.failed.plain")}</p> : null}
      </div>
    );
  }
  if (props.choice === undefined) return null;
  return (
    <ReadyPreview
      preview={state.preview}
      choice={props.choice}
      onChoice={props.onChoice}
      originalLanguage={props.originalLanguage}
      {...(props.contentId === undefined ? {} : { contentId: props.contentId })}
    />
  );
}

function ReadyPreview(props: {
  preview: SubtitlePreview;
  choice: SubtitleImportChoice;
  onChoice: (choice: SubtitleImportChoice) => void;
  originalLanguage: string | undefined;
  contentId?: string;
}) {
  const { t, i18n } = useTranslation();
  const { preview, choice, onChoice } = props;
  const number = useNumber();
  const regionId = useId();
  const packaged = preview.package !== undefined;
  const { needed, room } = speakerNeed(preview, choice);
  const blockers = importBlockers(preview, choice, props.originalLanguage);
  const differences = preview.limits.filter((limit) => !NOTICE_LIMITS.has(limit) && !(packaged && limit === "package_scope"));
  // A package's sentence count is one of its three numbers, so its line names the language instead.
  const summary = [
    preview.package === undefined ? t("subtitleImport.preview.sentences", { n: number(preview.cueCount) }) : t("subtitleImport.preview.language", { language: languageLabel(preview.package.language, t, i18n) }),
    ...(preview.rangeMs === undefined ? [] : [t("subtitleImport.preview.range", { start: formatDuration(preview.rangeMs.start), end: formatDuration(preview.rangeMs.end) })]),
    ...(preview.package === undefined ? [] : [t("subtitleImport.preview.generator", { app: preview.package.generator.app, version: preview.package.generator.version })]),
  ];
  const formatName = preview.format === "ass" && packaged ? t("subtitleImport.preview.styledAss") : t(`subtitleImport.preview.format.${preview.format}`);

  return (
    <section className="flex flex-col gap-3 rounded-lg border border-line bg-panel p-3 text-sm" aria-labelledby={regionId} data-testid="subtitle-preview" data-format={preview.format}>
      <Notices preview={preview} />
      <header className="flex min-w-0 items-start gap-2">
        <FileText size={16} className="mt-0.5 shrink-0 text-muted" aria-hidden="true" />
        <div className="min-w-0">
          <h3 id={regionId} className="font-medium">
            <span className="sr-only">{t("subtitleImport.preview.regionLabel")}</span>
            {formatName}
          </h3>
          <p className="text-xs text-muted tabular-nums" data-testid="subtitle-preview-summary">
            {summary.join(" · ")}
          </p>
        </div>
      </header>

      {preview.package === undefined ? (
        <>
          <SpeakerSection preview={preview} choice={choice} onChoice={onChoice} />
          <TranslationSection preview={preview} choice={choice} onChoice={onChoice} originalLanguage={props.originalLanguage} />
        </>
      ) : (
        <PackageSummary preview={preview} />
      )}

      {preview.target === undefined ? null : (
        <>
          <IdentitySection preview={preview} choice={choice} onChoice={onChoice} {...(props.contentId === undefined ? {} : { contentId: props.contentId })} />
          <CurrentSection preview={preview} choice={choice} onChoice={onChoice} />
        </>
      )}

      {differences.length === 0 ? null : (
        <details className="group text-xs text-muted" data-testid="subtitle-preview-limits">
          <summary className="cursor-pointer select-none rounded outline-none hover:text-ink focus-visible:ring-2 focus-visible:ring-accent">
            {t("subtitleImport.limits.title", { n: differences.length })}
          </summary>
          <ul className="mt-1.5 flex list-disc flex-col gap-0.5 pl-5">
            {differences.map((limit) => (
              <li key={limit}>{t(`subtitleImport.limits.${limit}`)}</li>
            ))}
          </ul>
        </details>
      )}

      {blockers.includes("speaker_capacity") || blockers.includes("translation_same_language") ? (
        <div className="flex flex-col gap-1" role="alert" data-testid="subtitle-preview-blockers">
          {blockers.includes("speaker_capacity") ? (
            <p className="text-xs text-danger" data-testid="subtitle-preview-capacity">
              {t("subtitleImport.blocker.speaker_capacity", { needed: number(needed), room: number(room) })}
            </p>
          ) : null}
          {blockers.includes("translation_same_language") ? <p className="text-xs text-danger">{t("subtitleImport.blocker.translation_same_language")}</p> : null}
        </div>
      ) : null}
    </section>
  );
}

/** What the user should know before choosing anything: skipped cues, a time range off the media, altered restore data. */
function Notices(props: { preview: SubtitlePreview }) {
  const { t } = useTranslation();
  const number = useNumber();
  const { preview } = props;
  const items: Array<{ key: string; body: ReactNode }> = [];
  if (preview.limits.includes("restore_data_mismatch")) {
    items.push({ key: "mismatch", body: t("subtitleImport.notice.mismatch") });
  }
  const target = preview.target;
  if (target?.coverageWarning === true && target.durationMs !== undefined && preview.rangeMs !== undefined) {
    items.push({
      key: "coverage",
      body: t("subtitleImport.notice.coverage", {
        start: formatDuration(preview.rangeMs.start),
        end: formatDuration(preview.rangeMs.end),
        duration: formatDuration(target.durationMs),
      }),
    });
  }
  if (preview.droppedCues.count > 0) {
    const sample = preview.droppedCues.samples[0];
    items.push({
      key: "dropped",
      body: (
        <>
          {t("subtitleImport.notice.dropped", { n: number(preview.droppedCues.count) })}
          {sample === undefined ? null : (
            <span className="mt-0.5 block truncate font-mono text-[11px] text-muted" title={sample}>
              {t("subtitleImport.notice.droppedSample", { sample })}
            </span>
          )}
        </>
      ),
    });
  }
  if (items.length === 0) return null;
  return (
    <ul className="flex flex-col gap-1.5 rounded-md border border-accent/40 bg-accent-soft px-2.5 py-2 text-xs" data-testid="subtitle-preview-notices">
      {items.map((item) => (
        <li key={item.key} className="flex items-start gap-2" data-notice={item.key}>
          <TriangleAlert size={14} className="mt-px shrink-0 text-accent" aria-hidden="true" />
          <span className="min-w-0">{item.body}</span>
        </li>
      ))}
    </ul>
  );
}

/** A package (or a styled ASS whose restore data held): three numbers and one line of what comes back. */
function PackageSummary(props: { preview: SubtitlePreview }) {
  const { t, i18n } = useTranslation();
  const number = useNumber();
  const { preview } = props;
  const pack = preview.package;
  if (pack === undefined) return null;
  const languages = pack.translationLanguages.map((tag) => languageLabel(tag, t, i18n));
  const tiles: Array<{ key: string; label: string; value: string }> = [
    { key: "sentences", label: t("subtitleImport.package.sentences"), value: number(pack.segmentCount) },
    { key: "speakers", label: t("subtitleImport.package.speakers"), value: number(pack.speakerCount) },
    { key: "translations", label: t("subtitleImport.package.translations"), value: languages.length === 0 ? t("subtitleImport.package.none") : languages.join(t("subtitleImport.separator")) },
  ];
  return (
    <div className="flex flex-col gap-2" data-testid="subtitle-preview-package">
      <dl className="grid grid-cols-3 gap-2" aria-label={t("subtitleImport.package.stats")}>
        {tiles.map((tile) => (
          <div key={tile.key} className="min-w-0 rounded-md border border-line bg-surface px-2.5 py-2" data-testid={`subtitle-preview-package-${tile.key}`}>
            <dt className="text-xs text-muted">{tile.label}</dt>
            <dd className="mt-0.5 text-base font-semibold break-words tabular-nums">{tile.value}</dd>
          </div>
        ))}
      </dl>
      <p className="text-xs text-muted">{t("subtitleImport.package.scope")}</p>
    </div>
  );
}

/** Speakers of a standard file: SRT names to choose with the unlabelled rule, or the speakers a VTT or ASS names. */
function SpeakerSection(props: { preview: SubtitlePreview; choice: SubtitleImportChoice; onChoice: (choice: SubtitleImportChoice) => void }) {
  const { t } = useTranslation();
  const number = useNumber();
  const ids = useId();
  const { preview, choice, onChoice } = props;
  const { source, candidates } = preview.speakers;
  if (source === "none" || source === "package" || candidates.length === 0) return null;
  const counts = attributionOf(preview, choice);

  if (source === "explicit") {
    return (
      <section className={SECTION} aria-labelledby={`${ids}-title`} data-testid="subtitle-preview-speakers" data-source="explicit">
        <h4 id={`${ids}-title`} className={HEADING}>
          {t("subtitleImport.speakers.title")}
          <span className="ml-2 font-normal">{t("subtitleImport.speakers.explicitHint")}</span>
        </h4>
        <ul className="flex flex-wrap gap-1.5">
          {candidates.map((candidate) => (
            <li key={candidate.key} className="inline-flex max-w-full items-center gap-1.5 rounded-full border border-line bg-surface px-2.5 py-0.5 text-xs" data-testid="subtitle-preview-speaker">
              <span className="truncate">{candidate.label}</span>
              <span className="shrink-0 text-muted tabular-nums">{t("subtitleImport.speakers.count", { n: number(candidate.count) })}</span>
            </li>
          ))}
        </ul>
        {counts.unassigned > 0 ? <p className="text-xs text-muted">{t("subtitleImport.speakers.explicitUnassigned", { n: number(counts.unassigned) })}</p> : null}
      </section>
    );
  }

  const chosen = new Set(choice.prefixNames);
  const toggle = (key: string, on: boolean): void => {
    // Kept in the file's candidate order, which is also the order the import names them.
    const next = new Set(chosen);
    if (on) next.add(key);
    else next.delete(key);
    onChoice({ ...choice, prefixNames: candidates.filter((candidate) => next.has(candidate.key)).map((candidate) => candidate.key) });
  };
  const anyUnchosen = preview.speakers.sequence.some(([index]) => index < 0 || !chosen.has(candidates[index]?.key ?? ""));
  return (
    <section className={SECTION} aria-labelledby={`${ids}-title`} data-testid="subtitle-preview-speakers" data-source="prefix">
      <h4 id={`${ids}-title`} className={HEADING}>
        {t("subtitleImport.speakers.title")}
      </h4>
      <p id={`${ids}-hint`} className="-mt-1 text-xs text-muted">
        {t("subtitleImport.speakers.prefixHint")}
      </p>
      <ul className="flex max-h-48 flex-col divide-y divide-line overflow-auto rounded-md border border-line bg-surface" role="group" aria-label={t("subtitleImport.speakers.candidates")} aria-describedby={`${ids}-hint`}>
        {candidates.map((candidate) => (
          <li key={candidate.key}>
            <label className="flex min-w-0 cursor-pointer items-center gap-2.5 px-2.5 py-1.5 hover:bg-sunken">
              <input type="checkbox" checked={chosen.has(candidate.key)} onChange={(event) => toggle(candidate.key, event.target.checked)} data-testid="subtitle-preview-candidate" data-key={candidate.key} />
              <span className="min-w-0 flex-1 truncate" title={candidate.label}>
                {candidate.label}
              </span>
              <span className="shrink-0 text-xs text-muted tabular-nums">{t("subtitleImport.speakers.count", { n: number(candidate.count) })}</span>
            </label>
          </li>
        ))}
      </ul>
      {chosen.size > 0 && anyUnchosen ? (
        <fieldset className="flex flex-col gap-1">
          <legend className="mb-1 text-xs text-muted">{t("subtitleImport.speakers.unlabeledTitle")}</legend>
          {(["inherit", "unassigned"] as const satisfies readonly UnlabeledRule[]).map((rule) => (
            <label key={rule} className="flex cursor-pointer items-start gap-2 text-sm">
              <input type="radio" className="mt-1" name={`${ids}-unlabeled`} checked={choice.unlabeled === rule} onChange={() => onChoice({ ...choice, unlabeled: rule })} data-testid={`subtitle-preview-unlabeled-${rule}`} />
              {t(`subtitleImport.speakers.${rule}`)}
            </label>
          ))}
        </fieldset>
      ) : null}
      <p className="text-xs text-muted tabular-nums" aria-live="polite" data-testid="subtitle-preview-stats">
        {t("subtitleImport.speakers.stats", { labelled: number(counts.labelled), inherited: number(counts.inherited), unassigned: number(counts.unassigned) })}
      </p>
    </section>
  );
}

/** Two real pairs, read by screen readers as original and translation. */
function Samples(props: { samples: NonNullable<SubtitlePreview["bilingual"]>["samples"] }) {
  const { t } = useTranslation();
  return (
    <ul className="flex flex-col gap-1.5" aria-label={t("subtitleImport.translation.samples")} data-testid="subtitle-preview-samples">
      {props.samples.slice(0, 2).map((sample, index) => (
        <li key={index} className="rounded-md border border-line bg-surface px-2.5 py-1.5">
          <p className="break-words">
            <span className="sr-only">{t("subtitleImport.translation.originalLabel")}</span>
            {sample.original}
          </p>
          <p className="mt-0.5 break-words text-muted">
            <span className="sr-only">{t("subtitleImport.translation.translationLabel")}</span>
            {sample.translation}
          </p>
        </li>
      ))}
    </ul>
  );
}

/** Translations of a standard file, shown only when it has them: two pairs and the language they are in. */
function TranslationSection(props: { preview: SubtitlePreview; choice: SubtitleImportChoice; onChoice: (choice: SubtitleImportChoice) => void; originalLanguage: string | undefined }) {
  const { t, i18n } = useTranslation();
  const number = useNumber();
  const ids = useId();
  const { preview, choice, onChoice } = props;
  const bilingual = preview.bilingual;
  if (bilingual === undefined) return null;
  const known = knownTranslationLanguages(preview);
  const options = Object.keys(languageNames).filter((tag) => translationLanguageAllowed(tag, props.originalLanguage));
  const value = choice.translation === undefined ? PICK : choice.translation === null ? SKIP : choice.translation;
  if (typeof choice.translation === "string" && !options.includes(choice.translation)) options.push(choice.translation);
  const lead =
    known !== undefined
      ? t("subtitleImport.translation.known", { languages: known.map((tag) => languageLabel(tag, t, i18n)).join(t("subtitleImport.separator")) })
      : t(bilingual.source === "style" ? "subtitleImport.translation.style" : "subtitleImport.translation.lines", { n: number(bilingual.count) });
  return (
    <section className={SECTION} aria-labelledby={`${ids}-title`} data-testid="subtitle-preview-translation" data-source={bilingual.source}>
      <h4 id={`${ids}-title`} className={HEADING}>
        {t("subtitleImport.translation.title")}
      </h4>
      <p className="-mt-1 text-xs text-muted">{lead}</p>
      {bilingual.samples.length === 0 ? null : <Samples samples={bilingual.samples} />}
      {known !== undefined ? null : (
        <div className="flex flex-col gap-1">
          <label className="flex flex-wrap items-center gap-x-3 gap-y-1">
            <span className="text-xs text-muted">{t("subtitleImport.translation.language")}</span>
            <select
              className={SELECT}
              value={value}
              aria-describedby={choice.translation === undefined ? `${ids}-pick` : undefined}
              onChange={(event) => onChoice({ ...choice, translation: event.target.value === SKIP ? null : event.target.value === PICK ? undefined : event.target.value })}
              data-testid="subtitle-preview-translation-language"
            >
              {/* Only a translation style must be decided; SRT lines start as not imported. */}
              {bilingual.source === "lines" ? null : (
                <option value={PICK} disabled>
                  {t("subtitleImport.translation.pick")}
                </option>
              )}
              <option value={SKIP}>{t("subtitleImport.translation.skip")}</option>
              {options.map((tag) => (
                <option key={tag} value={tag}>
                  {languageLabel(tag, t, i18n)}
                </option>
              ))}
            </select>
          </label>
          {choice.translation === undefined ? (
            <p id={`${ids}-pick`} className="text-xs text-muted" data-testid="subtitle-preview-translation-pick">
              {t("subtitleImport.translation.pickHint")}
            </p>
          ) : null}
        </div>
      )}
    </section>
  );
}

/** Existing Content: for each imported speaker named like existing ones, a new identity (default) or one of them. */
function IdentitySection(props: { preview: SubtitlePreview; choice: SubtitleImportChoice; onChoice: (choice: SubtitleImportChoice) => void; contentId?: string }) {
  const { t } = useTranslation();
  const ids = useId();
  const { preview, choice, onChoice } = props;
  const matches = sameNameMatches(preview, choice);
  if (matches.length === 0) return null;
  const effective = new Map(effectiveIdentities(preview, choice).map(({ key, speaker }) => [key, speaker.id]));
  const takenBy = new Map([...effective].map(([key, speakerId]) => [speakerId, key]));
  const choose = (key: string, speakerId: string | undefined): void => {
    const next = { ...choice.identities };
    if (speakerId === undefined) delete next[key];
    else next[key] = speakerId;
    onChoice({ ...choice, identities: next });
  };
  return (
    <section className={SECTION} aria-labelledby={`${ids}-title`} data-testid="subtitle-preview-identities">
      <h4 id={`${ids}-title`} className={HEADING}>
        {t("subtitleImport.identity.title")}
      </h4>
      <p className="-mt-1 text-xs text-muted">{t("subtitleImport.identity.hint")}</p>
      <ul className="flex flex-col gap-2">
        {matches.map((match) => (
          <IdentityRow
            key={match.candidate.key}
            match={match}
            chosen={effective.get(match.candidate.key)}
            takenBy={takenBy}
            onChoose={(speakerId) => choose(match.candidate.key, speakerId)}
            {...(props.contentId === undefined ? {} : { contentId: props.contentId })}
          />
        ))}
      </ul>
    </section>
  );
}

function IdentityRow(props: { match: SameNameMatch; chosen: string | undefined; takenBy: ReadonlyMap<string, string>; onChoose: (speakerId: string | undefined) => void; contentId?: string }) {
  const { t } = useTranslation();
  const number = useNumber();
  const name = useId();
  const { candidate, existing } = props.match;
  return (
    <li className="rounded-md border border-line bg-surface" data-testid="subtitle-preview-identity" data-key={candidate.key}>
      <fieldset className="flex flex-col gap-0.5 px-2.5 py-2">
        <legend className="float-left mb-1 w-full truncate text-sm font-medium" title={candidate.label}>
          {t("subtitleImport.identity.candidate", { name: candidate.label, n: number(candidate.count) })}
        </legend>
        <label className="clear-left flex cursor-pointer items-center gap-2 py-0.5 text-sm">
          <input type="radio" name={name} checked={props.chosen === undefined} onChange={() => props.onChoose(undefined)} data-testid="subtitle-preview-identity-create" />
          {t("subtitleImport.identity.create")}
        </label>
        {existing.map((speaker) => {
          const taken = props.takenBy.get(speaker.id);
          const blocked = taken !== undefined && taken !== candidate.key;
          return (
            <label
              key={speaker.id}
              className={`flex min-w-0 items-start gap-2 py-0.5 text-sm ${blocked ? "cursor-not-allowed opacity-50" : "cursor-pointer"}`}
              {...(blocked ? { title: t("subtitleImport.identity.taken") } : {})}
            >
              <input type="radio" className="mt-1 shrink-0" name={name} checked={props.chosen === speaker.id} disabled={blocked} onChange={() => props.onChoose(speaker.id)} data-testid="subtitle-preview-identity-reuse" data-speaker-id={speaker.id} />
              <span className="flex min-w-0 flex-1 flex-wrap items-center gap-x-2 gap-y-0.5">
                <span className="shrink-0">{t("subtitleImport.identity.reuse")}</span>
                <span className="flex min-w-0 items-center gap-1.5">
                  {props.contentId === undefined ? null : <SpeakerAvatar contentId={props.contentId} speaker={speaker} size={20} decorative />}
                  <span className="min-w-0 truncate">{speakerLabel(t, speaker)}</span>
                </span>
                <span className="text-xs text-muted tabular-nums">
                  {t("subtitleImport.identity.ordinal", { ordinal: speaker.ordinal })} · {t(speaker.used ? "subtitleImport.identity.used" : "subtitleImport.identity.unused")}
                </span>
              </span>
            </label>
          );
        })}
      </fieldset>
    </li>
  );
}

/** Existing Content: whether the import becomes current, and what that replaces. */
function CurrentSection(props: { preview: SubtitlePreview; choice: SubtitleImportChoice; onChoice: (choice: SubtitleImportChoice) => void }) {
  const { t } = useTranslation();
  const ids = useId();
  const { preview, choice, onChoice } = props;
  const replaced = replacedTranslations(preview, choice);
  const note = choice.setCurrent ? (replaced.length > 0 ? t("subtitleImport.current.replaces") : undefined) : t("subtitleImport.current.off");
  return (
    <div className={SECTION}>
      <label className="flex cursor-pointer items-center gap-2 text-sm">
        <input type="checkbox" checked={choice.setCurrent} onChange={(event) => onChoice({ ...choice, setCurrent: event.target.checked })} aria-describedby={note === undefined ? undefined : `${ids}-note`} data-testid="subtitle-preview-set-current" />
        {t("subtitleImport.current.label")}
      </label>
      {note === undefined ? null : (
        <p id={`${ids}-note`} className="-mt-1 pl-6 text-xs text-muted" data-testid="subtitle-preview-current-note">
          {note}
        </p>
      )}
    </div>
  );
}

/** Speakers the import brings, for a one-line result: the chosen ones, or what a package named. */
export function importedSpeakerCount(preview: SubtitlePreview, choice: SubtitleImportChoice): number {
  const imported = importedSpeakers(preview, choice).length;
  return preview.speakers.source === "package" && imported === 0 ? (preview.package?.speakerCount ?? 0) : imported;
}
