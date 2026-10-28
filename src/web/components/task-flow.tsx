import { useMutation } from "@tanstack/react-query";
import { CheckCircle2, Circle, CircleAlert, CircleDashed, CircleSlash, Clock, LoaderCircle } from "lucide-react";
import { useState } from "react";
import { useTranslation } from "react-i18next";
import { Link } from "react-router";
import type { AsrModelRefDto, ModelRefDto } from "../../shared/dto/model-ref.ts";
import { taskAcceptedDtoSchema, taskDetailDtoSchema, type StageRunDto, type TaskDetailDto, type WorkUnitDto } from "../../shared/dto/task.ts";
import { STAGE_IDS, type StageId, type StageStatus, type TaskKind } from "../../shared/enums.ts";
import { workStepOf, type WorkStep } from "../../shared/work-steps.ts";
import { ApiError } from "../api/client.ts";
import { useApi, useTask, useTaskHub } from "../api/context.tsx";
import { useAsrProfiles, useProviders, useSettings } from "../api/queries.ts";
import { formatDateTime, formatTime, sameLocalDay } from "../format.ts";
import { AsrModelSelect, encodeAsrModel, initialAsrModelRef, useAsrModelLabel } from "./asr-model-select.tsx";
import { Button } from "../ui/button.tsx";
import { Spinner } from "../ui/feedback.tsx";
import { ErrorView, useEngineLabel } from "./error-view.tsx";

/** Stages whose work is an LLM call; they wait for a model binding when none is configured. */
const LLM_STAGES: ReadonlySet<StageId> = new Set(["proofread", "chapter", "summary", "highlight", "translate", "collection_summary"]);

const TERMINAL = new Set(["succeeded", "failed", "cancelled"]);

/** The latest attempt of each stage, in pipeline order. */
export function latestStageRuns(detail: Pick<TaskDetailDto, "stageRuns">): StageRunDto[] {
  const latest = new Map<StageId, StageRunDto>();
  for (const run of detail.stageRuns) {
    const seen = latest.get(run.stage);
    if (seen === undefined || run.attempt > seen.attempt) {
      latest.set(run.stage, run);
    }
  }
  return [...latest.values()].sort((a, b) => STAGE_IDS.indexOf(a.stage) - STAGE_IDS.indexOf(b.stage));
}

/** Work units parked on an unknown-outcome paid call in the latest attempt of each stage. */
export function waitingUnits(detail: Pick<TaskDetailDto, "stageRuns" | "workUnits">): WorkUnitDto[] {
  const latest = new Set(latestStageRuns(detail).map((run) => run.id));
  return detail.workUnits.filter((unit) => unit.status === "waiting_user_action" && latest.has(unit.stageRunId));
}

/**
 * The named step a stage run is busy with: the step of its running work
 * unit, the latest listed one when several run; with none running, the step of a named unit
 * that waits for its next try (an ASR job being awaited between two queries); `undefined`
 * when none of them is named.
 */
export function runningStep(detail: Pick<TaskDetailDto, "workUnits">, runId: string): WorkStep | undefined {
  let step: WorkStep | undefined;
  let waiting: WorkStep | undefined;
  for (const unit of detail.workUnits) {
    if (unit.stageRunId !== runId) continue;
    if (unit.status === "running") {
      step = workStepOf(unit.key) ?? step;
    } else if (unit.status === "pending" && unit.retryNotBefore !== undefined) {
      waiting = workStepOf(unit.key) ?? waiting;
    }
  }
  return step ?? waiting;
}

/**
 * One confirmation for every parked unit: a stage resumes only after all of its parked units
 * are confirmed, so per-unit buttons would leave earlier clicks without visible effect. The
 * count is shown so this single explicit action authorizes each re-send.
 */
export function ResendPrompt(props: { taskId: string; units: WorkUnitDto[] }) {
  const { t } = useTranslation();
  const api = useApi();
  const hub = useTaskHub();
  const resend = useMutation({
    mutationFn: async (unitIds: string[]) => {
      // Sequential so a failure stops before any further paid call is re-authorized.
      for (const unitId of unitIds) {
        await api.post(`/api/tasks/${encodeURIComponent(props.taskId)}/work-units/${encodeURIComponent(unitId)}/confirm-resend`, taskAcceptedDtoSchema, {
          idempotent: true,
        });
      }
    },
    onSettled: () => hub.refresh(props.taskId),
  });
  if (props.units.length === 0) return null;
  const count = props.units.length;
  return (
    <div data-testid="resend-prompt" className="mt-2 rounded-md border border-accent/40 bg-accent-soft p-2 text-sm" role="alert">
      <p>{t("shell.flow.resendWarning", { count })}</p>
      <Button size="sm" variant="primary" className="mt-2" disabled={resend.isPending} onClick={() => resend.mutate(props.units.map((unit) => unit.id))}>
        {t("shell.flow.confirmResend", { count })}
      </Button>
      {resend.error instanceof ApiError ? (
        <div className="mt-2">
          <ErrorView error={resend.error.error} />
        </div>
      ) : null}
    </div>
  );
}

const STATUS_ICONS: Record<StageStatus, typeof Circle> = {
  pending: Circle,
  waiting_configuration: Clock,
  running: LoaderCircle,
  succeeded: CheckCircle2,
  failed: CircleAlert,
  skipped: CircleDashed,
  interrupted: CircleAlert,
  cancelled: CircleSlash,
};

function encodeModel(ref: ModelRefDto): string {
  return JSON.stringify([ref.providerProfileId, ref.modelId]);
}

function decodeModel(value: string): ModelRefDto | undefined {
  try {
    const [providerProfileId, modelId] = JSON.parse(value) as [string, string];
    return { providerProfileId, modelId };
  } catch {
    return undefined;
  }
}

interface ModelOption {
  value: string;
  label: string;
}

/** Every model of the user's provider profiles, as `<select>` options keyed by `encodeModel`. */
function useModelOptions(): ModelOption[] {
  const providers = useProviders();
  return (providers.data?.items ?? []).flatMap((profile) =>
    profile.models.map((model) => ({ value: encodeModel({ providerProfileId: profile.id, modelId: model.modelId }), label: `${profile.name} · ${model.modelId}` })),
  );
}

/** Stage flow of one task, live over SSE, with failures rendered as AppError. */
export function TaskFlow(props: { taskId: string }) {
  const { t } = useTranslation();
  const view = useTask(props.taskId);
  if (view.detail === undefined) {
    return view.error === undefined ? <Spinner /> : <p className="text-sm text-danger">{t("shell.flow.loadFailed")}</p>;
  }
  const detail = view.detail;
  return <FlowSection task={detail} status={detail.statusProjection} rows={latestStageRuns(detail).map((run) => ({ run, owner: detail }))} />;
}

/** Stages a single-stage Task can redo after `process_content`. */
export const REDO_STAGES = ["asr", "proofread", "chapter", "summary"] as const;
export type RedoStage = (typeof REDO_STAGES)[number];

/** A row of a stage flow: the run shown and the Task it belongs to, which its actions address. */
export interface FlowRow {
  run: StageRunDto;
  owner: TaskDetailDto;
  /** Set when the run belongs to a later Task than the one the flow is about. */
  redone?: true;
}

/**
 * The rows of a `process_content` flow where each redoable stage shows the run of a later
 * single-stage Task that redid it, when there is one: a redo counts when it
 * was created after its stage last started, or after the Task itself when that stage never
 * started (skipped or still pending). Only stages the Task has are replaced; none is added.
 */
export function contentFlowRows(main: TaskDetailDto, redos: Partial<Record<RedoStage, TaskDetailDto>>): FlowRow[] {
  return latestStageRuns(main).map((run) => {
    const redo = (REDO_STAGES as readonly StageId[]).includes(run.stage) ? redos[run.stage as RedoStage] : undefined;
    if (redo === undefined || redo.createdAt <= (run.startedAt ?? main.createdAt)) return { run, owner: main };
    const redoneRun = latestStageRuns(redo).find((candidate) => candidate.stage === run.stage);
    return redoneRun === undefined ? { run, owner: main } : { run: redoneRun, owner: redo, redone: true };
  });
}

/**
 * The flow of a Content's `process_content` Task with the later redos of its stages
 * (retranscribe, reproofread, regenerate_chapters, regenerate_summary) folded in. The caller
 * picks the latest redo of each stage; every Task taking part stays live over SSE, and each
 * row's actions address the Task that owns it. Cancelling from the title stays with the
 * processing Task; redos are cancelled from the task panel.
 */
export function ContentTaskFlow(props: { taskId: string; redos: Partial<Record<RedoStage, string>> }) {
  const { t } = useTranslation();
  const view = useTask(props.taskId);
  // One slot per redoable stage, so the number of hooks never changes.
  const asr = useTask(props.redos.asr);
  const proofread = useTask(props.redos.proofread);
  const chapter = useTask(props.redos.chapter);
  const summary = useTask(props.redos.summary);
  if (view.detail === undefined) {
    return view.error === undefined ? <Spinner /> : <p className="text-sm text-danger">{t("shell.flow.loadFailed")}</p>;
  }
  const detail = view.detail;
  const redos: Partial<Record<RedoStage, TaskDetailDto>> = {};
  for (const [stage, slot] of [
    ["asr", asr],
    ["proofread", proofread],
    ["chapter", chapter],
    ["summary", summary],
  ] as const) {
    if (slot.detail !== undefined) redos[stage] = slot.detail;
  }
  const rows = contentFlowRows(detail, redos);
  const redoRunning = rows.some((row) => row.redone === true && !TERMINAL.has(row.owner.statusProjection));
  return <FlowSection task={detail} status={redoRunning ? "running" : detail.statusProjection} rows={rows} />;
}

/** The flow's title with its status and the cancel action of `task`, then one row per stage. */
function FlowSection(props: { task: TaskDetailDto; status: TaskDetailDto["statusProjection"]; rows: FlowRow[] }) {
  const { t } = useTranslation();
  const api = useApi();
  const hub = useTaskHub();
  const taskId = props.task.id;
  const cancel = useMutation({
    mutationFn: () => api.post(`/api/tasks/${encodeURIComponent(taskId)}/cancel`, taskDetailDtoSchema),
    onSettled: () => hub.refresh(taskId),
  });
  const finished = TERMINAL.has(props.task.statusProjection);
  return (
    <section data-testid="task-flow" data-status={props.status} className="flex flex-col gap-2">
      <div className="flex items-center justify-between gap-2">
        <h2 className="text-sm font-semibold">
          {t("shell.flow.title")} · {t(`common.status.${props.status}`)}
        </h2>
        {finished ? null : (
          <Button size="sm" variant="ghost" disabled={cancel.isPending} onClick={() => cancel.mutate()}>
            {t("shell.flow.cancelTask")}
          </Button>
        )}
      </div>
      <ol className="flex flex-col gap-1.5">
        {props.rows.map(({ run, owner, redone }) => (
          <StageRow
            key={run.id}
            taskId={owner.id}
            run={run}
            step={runningStep(owner, run.id)}
            // Only parked units: the resend prompt authorizes a paid re-send for each unit it is given.
            units={owner.workUnits.filter((unit) => unit.stageRunId === run.id && unit.status === "waiting_user_action")}
            {...(redone === true ? { redoneBy: { kind: owner.kind, at: run.startedAt ?? owner.createdAt } } : {})}
          />
        ))}
      </ol>
    </section>
  );
}

/** When a later Task redid the stage: its kind and when it started, local time of day for today. */
function RedoneBy(props: { kind: TaskKind; at: number }) {
  const { t, i18n } = useTranslation();
  const at = sameLocalDay(props.at, Date.now()) ? formatTime(props.at, i18n.language) : formatDateTime(props.at, i18n.language);
  return (
    <span className="text-xs text-muted" data-testid="stage-source">
      {t(`common.taskKind.${props.kind}`)} · {at}
    </span>
  );
}

function StageRow(props: { taskId: string; run: StageRunDto; step?: WorkStep | undefined; units: WorkUnitDto[]; redoneBy?: { kind: TaskKind; at: number } }) {
  const { t } = useTranslation();
  const api = useApi();
  const hub = useTaskHub();
  const { run } = props;
  const engineLabel = useEngineLabel(run.engine);
  const Icon = STATUS_ICONS[run.status];
  const retry = useMutation({
    mutationFn: (choice: StageChoice = {}) =>
      api.post(`/api/tasks/${encodeURIComponent(props.taskId)}/retry-stage`, taskAcceptedDtoSchema, {
        body: {
          stage: run.stage,
          ...(choice.modelRef === undefined ? {} : { modelRef: choice.modelRef }),
          ...(choice.asrModelRef === undefined ? {} : { asrModelRef: choice.asrModelRef }),
        },
        idempotent: true,
      }),
    onSettled: () => hub.refresh(props.taskId),
  });
  const actionError = retry.error;

  return (
    <li data-testid={`stage-${run.stage}`} data-status={run.status} className="rounded-md border border-line px-3 py-2">
      <div className="flex items-center gap-2 text-sm">
        <Icon size={16} className={run.status === "running" ? "animate-spin text-accent" : run.status === "failed" ? "text-danger" : run.status === "succeeded" ? "text-ok" : "text-muted"} aria-hidden="true" />
        <span className="font-medium">{t(`common.stage.${run.stage}`)}</span>
        <span className="text-muted">
          {t(`common.stageStatus.${run.status}`)}
          {run.status === "running" && props.step !== undefined ? ` · ${t(`shell.flow.step.${props.step}`)}` : null}
        </span>
        {props.redoneBy === undefined ? null : <RedoneBy kind={props.redoneBy.kind} at={props.redoneBy.at} />}
        {run.status === "running" ? <span className="ml-auto font-mono text-xs text-muted">{t("shell.tasks.progress", { percent: Math.round(run.progress * 100) })}</span> : null}
      </div>
      {run.status === "running" ? (
        <div className="mt-1.5 h-1 overflow-hidden rounded bg-sunken">
          <div className="h-full bg-accent transition-all" style={{ width: `${Math.round(run.progress * 100)}%` }} />
        </div>
      ) : null}
      {/* The transcription service reports nothing while it works, so the bar rests after the upload. */}
      {run.status === "running" && (props.step === "transcribe" || props.step === "awaitResult") ? (
        <p className="mt-1 text-xs text-muted" data-testid="step-hint">
          {t(props.step === "transcribe" ? "shell.flow.transcribeHint" : "shell.flow.awaitResultHint")}
        </p>
      ) : null}
      {engineLabel === undefined || run.status === "failed" ? null : <p className="mt-1 text-xs text-muted">{t("shell.flow.engine", { engine: engineLabel })}</p>}
      {run.status === "failed" && run.error !== undefined ? (
        <div className="mt-2">
          <ErrorView error={run.error} stage={run.stage} {...(run.engine === undefined ? {} : { engine: run.engine })}>
            <RerunControls run={run} pending={retry.isPending} onRerun={(choice) => retry.mutate(choice ?? {})} />
            {/* A re-run reads the prompts in effect now, so an edit or a restore made since the failure applies. */}
            {LLM_STAGES.has(run.stage) ? <span className="self-center text-xs text-muted">{t("shell.flow.rerunPromptHint")}</span> : null}
            {run.error.class === "auth_required" ? (
              <Link className="self-center text-sm text-accent underline" to="/settings/platform-accounts">
                {t("shell.flow.platformAccounts")}
              </Link>
            ) : null}
          </ErrorView>
        </div>
      ) : null}
      {run.status === "waiting_configuration" ? <WaitingConfiguration run={run} pending={retry.isPending} onContinue={(choice) => retry.mutate(choice ?? {})} /> : null}
      <ResendPrompt taskId={props.taskId} units={props.units} />
      {actionError instanceof ApiError ? (
        <div className="mt-2">
          <ErrorView error={actionError.error} />
        </div>
      ) : null}
    </li>
  );
}

/** What a resumed or re-run stage is given: a model for an LLM stage, an ASR model for the ASR stage. */
interface StageChoice {
  modelRef?: ModelRefDto;
  asrModelRef?: AsrModelRefDto;
}

function WaitingConfiguration(props: { run: StageRunDto; pending: boolean; onContinue: (choice?: StageChoice) => void }) {
  if (props.run.stage === "asr") {
    return <WaitingAsrConfiguration run={props.run} pending={props.pending} onContinue={props.onContinue} />;
  }
  return <WaitingModelConfiguration run={props.run} pending={props.pending} onContinue={props.onContinue} />;
}

/**
 * The ASR stage waits for a model when none is bound, or for the bound profile's key.
 * Without a binding the user picks one here (the default preselected when set, else none,
 * as on the new page); with one, continuing only checks the requirement again.
 */
function WaitingAsrConfiguration(props: { run: StageRunDto; pending: boolean; onContinue: (choice?: StageChoice) => void }) {
  const { t } = useTranslation();
  const profiles = useAsrProfiles();
  const settings = useSettings();
  const options = profiles.data?.items ?? [];
  const needsModel = props.run.engine === undefined;
  const [picked, setPicked] = useState<AsrModelRefDto | undefined>(undefined);
  const chosen = picked ?? initialAsrModelRef(options, settings.data?.defaultAsrModelRef);
  return (
    <div className="mt-2 flex flex-wrap items-center gap-2 text-sm">
      <span className="text-muted">{t("shell.flow.waitingConfiguration")}</span>
      <Link className="text-accent underline" to="/settings/transcription">
        {t("shell.flow.configureAsr")}
      </Link>
      {needsModel && options.length > 0 ? (
        <AsrModelSelect
          profiles={options}
          value={chosen}
          onChange={setPicked}
          label={t("shell.flow.pickAsrModel")}
          placeholder={t("shell.flow.pickAsrModel")}
          className="h-7 rounded border border-line bg-surface px-1 text-xs"
        />
      ) : null}
      <Button
        size="sm"
        disabled={props.pending || (needsModel && chosen === undefined)}
        onClick={() => props.onContinue(needsModel && chosen !== undefined ? { asrModelRef: chosen } : {})}
      >
        {t("shell.flow.continue")}
      </Button>
    </div>
  );
}

function WaitingModelConfiguration(props: { run: StageRunDto; pending: boolean; onContinue: (choice?: StageChoice) => void }) {
  const { t } = useTranslation();
  const isLlm = LLM_STAGES.has(props.run.stage);
  const needsModel = isLlm && props.run.engine === undefined;
  const options = useModelOptions();
  // Undefined until the user picks; the first listed model is offered meanwhile.
  const [picked, setPicked] = useState<string | undefined>(undefined);
  const chosen = picked ?? options[0]?.value;
  return (
    <div className="mt-2 flex flex-wrap items-center gap-2 text-sm">
      <span className="text-muted">{t("shell.flow.waitingConfiguration")}</span>
      <Link className="text-accent underline" to={isLlm ? "/settings/models" : "/settings/transcription"}>
        {isLlm ? t("shell.flow.configureLlm") : t("shell.flow.configureAsr")}
      </Link>
      {needsModel && options.length > 0 ? (
        <select aria-label={t("shell.flow.pickModel")} className="h-7 rounded border border-line bg-surface px-1 text-xs" value={chosen} onChange={(event) => setPicked(event.target.value)}>
          {options.map((option) => (
            <option key={option.value} value={option.value}>
              {option.label}
            </option>
          ))}
        </select>
      ) : null}
      <Button
        size="sm"
        disabled={props.pending || (needsModel && options.length === 0)}
        onClick={() => {
          const modelRef = needsModel && chosen !== undefined ? decodeModel(chosen) : undefined;
          props.onContinue(modelRef === undefined ? {} : { modelRef });
        }}
      >
        {t("shell.flow.continue")}
      </Button>
    </div>
  );
}

/**
 * "Re-run from this step"; a bound LLM stage may switch its model and the ASR stage its
 * profile for the re-run.
 */
function RerunControls(props: { run: StageRunDto; pending: boolean; onRerun: (choice?: StageChoice) => void }) {
  const { t } = useTranslation();
  const engine = props.run.engine;
  if (props.run.stage === "asr" && engine?.kind === "asr") {
    return <RerunWithAsrModel current={engine.asrModelRef} provider={engine.provider} pending={props.pending} onRerun={props.onRerun} />;
  }
  if (!LLM_STAGES.has(props.run.stage) || engine?.kind !== "llm") {
    return (
      <Button size="sm" disabled={props.pending} onClick={() => props.onRerun({})}>
        {t("shell.flow.rerun")}
      </Button>
    );
  }
  return <RerunWithModel current={engine.modelRef} pending={props.pending} onRerun={(modelRef) => props.onRerun(modelRef === undefined ? {} : { modelRef })} />;
}

/**
 * The ASR stage re-run with its bound model preselected; another model submits the audio
 * anew and may be billed again. An unchanged selection never sends a model.
 */
function RerunWithAsrModel(props: { current: AsrModelRefDto; provider: string | undefined; pending: boolean; onRerun: (choice?: StageChoice) => void }) {
  const { t } = useTranslation();
  const profiles = useAsrProfiles();
  const options = profiles.data?.items ?? [];
  const label = useAsrModelLabel();
  const [selected, setSelected] = useState<AsrModelRefDto>(props.current);
  const changed = encodeAsrModel(selected) !== encodeAsrModel(props.current);
  const pickable = options.flatMap((profile) => profile.models.filter((model) => model.available)).length;
  return (
    <>
      {profiles.isSuccess && pickable > 0 ? (
        <AsrModelSelect
          profiles={options}
          value={selected}
          currentLabel={label(props.current, options, props.provider)}
          onChange={(ref) => setSelected(ref ?? props.current)}
          label={t("shell.flow.rerunAsrModel")}
          className="h-7 rounded border border-line bg-surface px-1 text-xs"
        />
      ) : null}
      <Button size="sm" disabled={props.pending} onClick={() => props.onRerun(changed ? { asrModelRef: selected } : {})}>
        {t("shell.flow.rerun")}
      </Button>
      {changed ? <span className="self-center text-xs text-muted">{t("shell.flow.rerunAsrModelHint")}</span> : null}
    </>
  );
}

function RerunWithModel(props: { current: ModelRefDto; pending: boolean; onRerun: (modelRef?: ModelRefDto) => void }) {
  const { t } = useTranslation();
  const listed = useModelOptions();
  const currentLabel = useEngineLabel({ kind: "llm", modelRef: props.current });
  const current = encodeModel(props.current);
  // The current binding stays selectable even when its profile no longer lists it, so an
  // unchanged selection always means "keep the model" and never sends a modelRef.
  const options = listed.some((option) => option.value === current) ? listed : [{ value: current, label: currentLabel ?? props.current.modelId }, ...listed];
  const [selected, setSelected] = useState(current);
  const changed = selected !== current;
  return (
    <>
      <select aria-label={t("shell.flow.rerunModel")} className="h-7 rounded border border-line bg-surface px-1 text-xs" value={selected} onChange={(event) => setSelected(event.target.value)}>
        {options.map((option) => (
          <option key={option.value} value={option.value}>
            {option.label}
          </option>
        ))}
      </select>
      <Button size="sm" disabled={props.pending} onClick={() => props.onRerun(changed ? decodeModel(selected) : undefined)}>
        {t("shell.flow.rerun")}
      </Button>
      {changed ? <span className="self-center text-xs text-muted">{t("shell.flow.rerunModelHint")}</span> : null}
    </>
  );
}
