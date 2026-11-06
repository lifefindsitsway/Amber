import type { UsageGranularity } from "../../../../shared/dto/usage-analytics.ts";
import {
  USAGE_COMPONENT,
  USAGE_FLAG,
  USAGE_UTC_OFFSET_MS,
  type UsageActivityIdentity,
  type UsageScope,
} from "../../../domain/usage-analytics.ts";

/**
 * SQL text for usage analytics. Token and ASR rows are normalized into one row shape so a
 * single aggregation serves both; the filters are applied inside each branch so the time-range
 * indexes (which are built on exactly `OCCURRED`) can drive the scan.
 */

/** The time a call is attributed to: when the request left, or when it was recorded for older rows. */
const OCCURRED = "COALESCE(sent_at, created_at)";

const MS_PER_MINUTE = 60_000;
const MS_PER_HOUR = 3_600_000;
const MS_PER_DAY = 86_400_000;
/** 1970-01-01 was a Thursday; adding 3 to a day number makes Monday the first weekday (0). */
const EPOCH_DAYS_TO_MONDAY = 3;

export interface BuiltSql {
  sql: string;
  params: Record<string, unknown>;
}

type Branch = "llm" | "asr";

function flag(condition: string, bit: number): string {
  return `CASE WHEN ${condition} THEN ${bit} ELSE 0 END`;
}

/** SQL expressions of a call's quantities, from the raw columns of its table; absent ones count as zero. */
interface Quantities {
  rawInput: string;
  /** What is priced as input: LLM input without cache reads and writes (never negative), or billed input tokens. */
  input: string;
  output: string;
  reasoning: string;
  cacheRead: string;
  /** Cache writes without the one-hour part. */
  cacheWrite: string;
  cacheWrite1h: string;
  audioBilled: string;
  audioLocal: string;
}

const LLM_QUANTITIES: Quantities = {
  rawInput: "COALESCE(input_tokens, 0)",
  input: "MAX(COALESCE(input_tokens, 0) - COALESCE(cache_read_tokens, 0) - COALESCE(cache_write_tokens, 0), 0)",
  output: "COALESCE(output_tokens, 0)",
  reasoning: "COALESCE(reasoning_tokens, 0)",
  cacheRead: "COALESCE(cache_read_tokens, 0)",
  cacheWrite: "MAX(COALESCE(cache_write_tokens, 0) - COALESCE(cache_write_1h_tokens, 0), 0)",
  cacheWrite1h: "COALESCE(cache_write_1h_tokens, 0)",
  audioBilled: "0",
  audioLocal: "0",
};

const ASR_QUANTITIES: Quantities = {
  rawInput: "COALESCE(billed_input_tokens, 0)",
  input: "COALESCE(billed_input_tokens, 0)",
  output: "COALESCE(billed_output_tokens, 0)",
  reasoning: "0",
  cacheRead: "0",
  cacheWrite: "0",
  cacheWrite1h: "0",
  audioBilled: "COALESCE(billed_audio_ms, 0)",
  audioLocal: "audio_ms",
};

const LLM_FLAGS = [
  flag("input_tokens IS NULL AND output_tokens IS NULL", USAGE_FLAG.usageAbsent),
  flag("input_tokens = 0 AND output_tokens > 0", USAGE_FLAG.inputMissing),
  flag("cache_read_tokens IS NOT NULL OR cache_write_tokens IS NOT NULL", USAGE_FLAG.cacheReported),
].join(" + ");

const ASR_FLAGS = [
  flag("billed_input_tokens IS NOT NULL OR billed_output_tokens IS NOT NULL", USAGE_FLAG.billedTokens),
  flag("billed_audio_ms IS NOT NULL", USAGE_FLAG.billedAudio),
  flag("job_id IS NOT NULL AND job_outcome IS NULL AND outcome = 'succeeded'", USAGE_FLAG.accepted),
].join(" + ");

/** Which priced quantities of a call are above zero. */
function bitmapOf(q: Quantities): string {
  return [
    flag(`${q.input} > 0`, USAGE_COMPONENT.input),
    flag(`${q.cacheRead} > 0`, USAGE_COMPONENT.cacheRead),
    flag(`${q.cacheWrite} > 0`, USAGE_COMPONENT.cacheWrite),
    flag(`${q.cacheWrite1h} > 0`, USAGE_COMPONENT.cacheWrite1h),
    flag(`${q.output} > 0`, USAGE_COMPONENT.output),
  ].join(" + ");
}

/** The normalized columns of a call, each as an expression over the raw columns of one table. */
const COLUMN_NAMES = [
  "modality",
  "id",
  "occurred_at",
  "profile_id",
  "model_id",
  "credential_version",
  "credential_set_at",
  "feature",
  "task_id",
  "chat_message_id",
  "content_id",
  "result",
  "snapshot",
  "flags",
  "bitmap",
  "raw_input",
  "input",
  "output",
  "reasoning",
  "cache_read",
  "cache_write",
  "cache_write_1h",
  "audio_billed",
  "audio_local",
] as const;
type ColumnName = (typeof COLUMN_NAMES)[number];

function columnsOf(branch: Branch): Record<ColumnName, string> {
  const llm = branch === "llm";
  const q = llm ? LLM_QUANTITIES : ASR_QUANTITIES;
  return {
    modality: `'${branch}'`,
    id: "id",
    occurred_at: OCCURRED,
    profile_id: llm ? "COALESCE(provider_profile_id, '')" : "COALESCE(profile_id_snapshot, '')",
    model_id: llm ? "COALESCE(model_id, '')" : "model",
    credential_version: "credential_version",
    credential_set_at: "credential_set_at",
    feature: "feature",
    task_id: "task_id",
    chat_message_id: llm ? "chat_message_id" : "NULL",
    content_id: "content_id",
    result: llm ? "outcome" : "COALESCE(job_outcome, outcome)",
    snapshot: "price_snapshot_json",
    flags: llm ? LLM_FLAGS : ASR_FLAGS,
    bitmap: bitmapOf(q),
    raw_input: q.rawInput,
    input: q.input,
    output: q.output,
    reasoning: q.reasoning,
    cache_read: q.cacheRead,
    cache_write: q.cacheWrite,
    cache_write_1h: q.cacheWrite1h,
    audio_billed: q.audioBilled,
    audio_local: q.audioLocal,
  };
}

/** What every aggregate of the summary needs of a call. */
const SUMMARY_COLUMNS: readonly ColumnName[] = [
  "modality",
  "occurred_at",
  "profile_id",
  "model_id",
  "credential_version",
  "credential_set_at",
  "result",
  "snapshot",
  "flags",
  "bitmap",
  "raw_input",
  "input",
  "output",
  "reasoning",
  "cache_read",
  "cache_write",
  "cache_write_1h",
  "audio_billed",
  "audio_local",
];

/** Besides the summary's, what grouping calls into activities needs. */
const ACTIVITY_SOURCE_COLUMNS: readonly ColumnName[] = [...SUMMARY_COLUMNS, "feature", "task_id", "chat_message_id", "content_id"];

/** Every column, one call per row. */
const CALL_COLUMNS: readonly ColumnName[] = [...ACTIVITY_SOURCE_COLUMNS, "id"];

/** A bound integer; `bigint` keeps millisecond timestamps integral for the index comparison. */
function integer(value: number): bigint {
  return BigInt(value);
}

function modalityAllowed(scope: UsageScope, branch: Branch): boolean {
  return [scope.modality, scope.profile?.modality, scope.model?.modality, scope.narrow === undefined ? undefined : narrowModality(scope.narrow)].every(
    (modality) => modality === undefined || modality === branch,
  );
}

/** The one modality an identity can hold calls of, if it names one. */
function narrowModality(identity: UsageActivityIdentity): Branch | undefined {
  return identity.kind === "test" || identity.kind === "deleted_day" ? identity.modality : undefined;
}

/** `column = @name`, or `column IS NULL` for the empty id that stands for "not recorded". */
function matchesId(column: string, name: string, value: string, params: Record<string, unknown>): string {
  if (value === "") {
    return `${column} IS NULL`;
  }
  params[name] = value;
  return `${column} = @${name}`;
}

/** Start of a Beijing calendar day, `YYYY-MM-DD`, in Unix ms. */
function beijingDayStart(day: string): number {
  const [year, month, date] = day.split("-").map(Number) as [number, number, number];
  return Date.UTC(year, month - 1, date) - USAGE_UTC_OFFSET_MS;
}

/** The time window an identity's calls fall in, when it implies one. */
function narrowWindow(identity: UsageActivityIdentity): { from: number; to: number } | undefined {
  if (identity.kind === "test") {
    return { from: identity.minute * MS_PER_MINUTE, to: (identity.minute + 1) * MS_PER_MINUTE };
  }
  if (identity.kind === "content_day" || identity.kind === "deleted_day") {
    const from = beijingDayStart(identity.day);
    return { from, to: from + MS_PER_DAY };
  }
  return undefined;
}

/**
 * Conditions that narrow a branch to the rows an activity can hold, so the lookup of one
 * activity does not read the whole range. The activity key is still checked exactly afterwards.
 */
function narrowConditions(identity: UsageActivityIdentity, branch: Branch, params: Record<string, unknown>): string[] {
  switch (identity.kind) {
    case "task":
      return [matchesId("task_id", "narrowTask", identity.taskId, params)];
    case "chat":
      return branch === "llm" ? [matchesId("chat_message_id", "narrowChat", identity.chatMessageId, params)] : ["0"];
    case "content_day":
      return [matchesId("content_id", "narrowContent", identity.contentId, params)];
    case "test":
    case "deleted_day":
      return [];
  }
}

/** The scope's time bounds, tightened by the window of the activity it looks up. */
function effectiveBounds(scope: UsageScope): { from?: number; to?: number } {
  const window = scope.narrow === undefined ? undefined : narrowWindow(scope.narrow);
  const from = window === undefined ? scope.from : Math.max(scope.from ?? window.from, window.from);
  const to = window === undefined ? scope.to : Math.min(scope.to ?? window.to, window.to);
  return { ...(from === undefined ? {} : { from }), ...(to === undefined ? {} : { to }) };
}

/** The `WHERE` conditions of one branch, owner first. A branch the scope excludes gets a constant false. */
function conditions(scope: UsageScope, branch: Branch, params: Record<string, unknown>, withTime: boolean): string[] {
  params["owner"] = scope.owner;
  const result = ["user_id = @owner"];
  if (!modalityAllowed(scope, branch)) {
    return [...result, "0"];
  }
  const profileColumn = branch === "llm" ? "provider_profile_id" : "profile_id_snapshot";
  const modelColumn = branch === "llm" ? "model_id" : "model";
  const bounds = withTime ? effectiveBounds(scope) : {};
  if (bounds.from !== undefined) {
    params["from"] = integer(bounds.from);
    result.push(`${OCCURRED} >= @from`);
  }
  if (bounds.to !== undefined) {
    params["to"] = integer(bounds.to);
    result.push(`${OCCURRED} < @to`);
  }
  if (scope.profile !== undefined) {
    result.push(matchesId(profileColumn, "profileFilter", scope.profile.profileId, params));
  }
  if (scope.model !== undefined) {
    result.push(matchesId(profileColumn, "modelProfile", scope.model.profileId, params));
    result.push(matchesId(modelColumn, "modelId", scope.model.modelId, params));
  }
  if (scope.credentialVersion !== undefined) {
    if (scope.credentialVersion === null) {
      result.push("credential_version IS NULL");
    } else {
      params["credential"] = scope.credentialVersion;
      result.push("credential_version = @credential");
    }
  }
  if (scope.narrow !== undefined) {
    result.push(...narrowConditions(scope.narrow, branch, params));
  }
  return result;
}

function selectList(branch: Branch, columns: readonly ColumnName[], bucket: UsageGranularity | undefined): string {
  const expressions = columnsOf(branch);
  const list = columns.map((name) => `${expressions[name]} AS ${name}`);
  if (bucket !== undefined) {
    list.push(`${bucketStartSql(bucket, OCCURRED)} AS bucket_start`);
  }
  return list.join(", ");
}

interface SourceOptions {
  columns?: readonly ColumnName[];
  /** Adds `bucket_start`, the start of the Beijing-time bucket of the call. */
  bucket?: UsageGranularity;
}

/**
 * The normalized calls of a scope as a derived table of the requested columns. The filters sit
 * inside each branch so the time-range indexes, built on exactly `OCCURRED`, can drive the scan.
 */
export function usageSource(scope: UsageScope, options: SourceOptions = {}): BuiltSql {
  const params: Record<string, unknown> = {};
  const columns = options.columns ?? SUMMARY_COLUMNS;
  const branch = (name: Branch, table: string): string =>
    `SELECT ${selectList(name, columns, options.bucket)} FROM ${table} WHERE ${conditions(scope, name, params, true).join(" AND ")}`;
  return { sql: `(${branch("llm", "token_usage")} UNION ALL ${branch("asr", "asr_usage")})`, params };
}

/** `MIN(COALESCE(sent_at, created_at))` of one branch; used for the start of an all-time range. */
export function earliestSql(scope: UsageScope): BuiltSql {
  const params: Record<string, unknown> = {};
  const llmWhere = conditions(scope, "llm", params, false).join(" AND ");
  const asrWhere = conditions(scope, "asr", params, false).join(" AND ");
  return {
    sql: `SELECT MIN(first_at) AS first_at FROM (
      SELECT MIN(${OCCURRED}) AS first_at FROM token_usage WHERE ${llmWhere}
      UNION ALL
      SELECT MIN(${OCCURRED}) FROM asr_usage WHERE ${asrWhere}
    )`,
    params,
  };
}

/** The sums every grouped query reports; aliases carry a `sum_` prefix so they never shadow source columns. */
export const MEASURE_SUMS = `
  COUNT(*) AS requests,
  SUM(raw_input) AS sum_raw_input,
  SUM(input) AS sum_input,
  SUM(output) AS sum_output,
  SUM(reasoning) AS sum_reasoning,
  SUM(cache_read) AS sum_cache_read,
  SUM(cache_write) AS sum_cache_write,
  SUM(cache_write_1h) AS sum_cache_write_1h,
  SUM(audio_billed) AS sum_audio_billed,
  SUM(audio_local) AS sum_audio_local,
  MAX(occurred_at) AS last_at,
  MAX(credential_set_at) AS credential_set_at`;

/** The columns that make rows of one group interchangeable for the cost estimate. */
export const CLASS_COLUMNS = "snapshot, bitmap, flags, result";

/** What a row of a group is identified by besides its bucket or activity. */
export const MODEL_COLUMNS = "modality, profile_id, model_id, credential_version";

/**
 * The start (ms) of the Beijing-time bucket containing the time `occurred`. Hours and days are
 * integer division on the shifted time; a week starts on Monday; a month is the calendar month.
 */
export function bucketStartSql(granularity: UsageGranularity, occurred: string): string {
  const shifted = `(${occurred} + ${USAGE_UTC_OFFSET_MS})`;
  switch (granularity) {
    case "hour":
      return `(${shifted} / ${MS_PER_HOUR}) * ${MS_PER_HOUR} - ${USAGE_UTC_OFFSET_MS}`;
    case "day":
      return `(${shifted} / ${MS_PER_DAY}) * ${MS_PER_DAY} - ${USAGE_UTC_OFFSET_MS}`;
    case "week": {
      const day = `(${shifted} / ${MS_PER_DAY})`;
      return `(${day} - (${day} + ${EPOCH_DAYS_TO_MONDAY}) % 7) * ${MS_PER_DAY} - ${USAGE_UTC_OFFSET_MS}`;
    }
    case "month":
      return `CAST(strftime('%s', strftime('%Y-%m-01', ${shifted} / 1000, 'unixepoch')) AS INTEGER) * 1000 - ${USAGE_UTC_OFFSET_MS}`;
  }
}

/** One row per bucket, model, credential version and class: everything the summary is made of. */
export function bucketGroupsSql(scope: UsageScope, granularity: UsageGranularity): BuiltSql {
  const source = usageSource(scope, { bucket: granularity });
  return {
    sql: `SELECT bucket_start, ${MODEL_COLUMNS}, ${CLASS_COLUMNS}, ${MEASURE_SUMS}
          FROM ${source.sql} GROUP BY bucket_start, ${MODEL_COLUMNS}, ${CLASS_COLUMNS}`,
    params: source.params,
  };
}

/** Request counts per model and credential version, for the filter menus. */
export function identitiesSql(scope: UsageScope): BuiltSql {
  const source = usageSource(scope, { columns: ["modality", "profile_id", "model_id", "credential_version", "credential_set_at"] });
  return {
    sql: `SELECT ${MODEL_COLUMNS}, COUNT(*) AS requests, MAX(credential_set_at) AS credential_set_at
          FROM ${source.sql} GROUP BY ${MODEL_COLUMNS}`,
    params: source.params,
  };
}

/** Models whose usage ever reported a cache read; the partial index answers it without reading rows. */
export const CACHE_OBSERVED_SQL = `SELECT DISTINCT provider_profile_id, model_id FROM token_usage
  WHERE user_id = @owner AND cache_read_tokens > 0 AND provider_profile_id IS NOT NULL AND model_id IS NOT NULL`;

// Activities ------------------------------------------------------------------------------

/** Beijing calendar date of a call, `YYYY-MM-DD`. */
const BEIJING_DAY = `strftime('%Y-%m-%d', (occurred_at + ${USAGE_UTC_OFFSET_MS}) / 1000, 'unixepoch')`;

/**
 * Which activity a call belongs to, first match winning: its task, else its chat answer, else
 * a connection test (one per profile, model and minute), else its content and purpose on that
 * day, else a catch-all for calls whose links were all cleared by deletion. A link column is
 * NULL exactly when the thing it pointed to is gone. The five `activity_*` columns hold the
 * parts of the identity; unused parts are empty.
 */
const ACTIVITY_PARTS = `
  CASE kind
    WHEN 'task' THEN task_id
    WHEN 'chat' THEN chat_message_id
    WHEN 'content_day' THEN content_id
    ELSE modality
  END AS activity_a,
  CASE kind
    WHEN 'test' THEN profile_id
    WHEN 'content_day' THEN feature
    WHEN 'deleted_day' THEN feature
    ELSE ''
  END AS activity_b,
  CASE kind
    WHEN 'test' THEN model_id
    WHEN 'content_day' THEN ${BEIJING_DAY}
    WHEN 'deleted_day' THEN ${BEIJING_DAY}
    ELSE ''
  END AS activity_c,
  CASE kind WHEN 'test' THEN occurred_at / ${MS_PER_MINUTE} ELSE 0 END AS activity_d`;

const ACTIVITY_KIND = `CASE
    WHEN task_id IS NOT NULL THEN 'task'
    WHEN chat_message_id IS NOT NULL THEN 'chat'
    WHEN feature = 'test_connection' THEN 'test'
    WHEN content_id IS NOT NULL THEN 'content_day'
    ELSE 'deleted_day'
  END`;

/** The calls of a scope with their activity columns. */
function activitySource(scope: UsageScope, columns: readonly ColumnName[] = ACTIVITY_SOURCE_COLUMNS): BuiltSql {
  const source = usageSource(scope, { columns });
  return {
    sql: `(SELECT *, ${ACTIVITY_PARTS} FROM (SELECT *, ${ACTIVITY_KIND} AS kind FROM ${source.sql}))`,
    params: source.params,
  };
}

export const ACTIVITY_COLUMNS = "kind, activity_a, activity_b, activity_c, activity_d";

/**
 * One page of activities, newest first, with the number of all of them; the total is a window
 * over the grouped rows so one pass over the range serves both.
 */
export function activityPageSql(scope: UsageScope, page: { limit: number; offset: number }): BuiltSql {
  const source = activitySource(scope);
  return {
    sql: `SELECT ${ACTIVITY_COLUMNS}, started_at, ended_at, COUNT(*) OVER () AS total FROM (
            SELECT ${ACTIVITY_COLUMNS}, MIN(occurred_at) AS started_at, MAX(occurred_at) AS ended_at
            FROM ${source.sql} GROUP BY ${ACTIVITY_COLUMNS}
          ) ORDER BY started_at DESC, ${ACTIVITY_COLUMNS} LIMIT @limit OFFSET @offset`,
    params: { ...source.params, limit: page.limit, offset: page.offset },
  };
}

/** Number of activities in a scope; used only when a page lies past the end and carries no total. */
export function activityCountSql(scope: UsageScope): BuiltSql {
  const source = activitySource(scope);
  return {
    sql: `SELECT COUNT(*) AS total FROM (SELECT 1 FROM ${source.sql} GROUP BY ${ACTIVITY_COLUMNS})`,
    params: source.params,
  };
}

/** The groups of every activity whose calls fall in the scope's time bounds, for the caller to pick from. */
export function activityGroupsSql(scope: UsageScope): BuiltSql {
  const source = activitySource(scope);
  return {
    sql: `SELECT ${ACTIVITY_COLUMNS}, feature, content_id, ${MODEL_COLUMNS}, ${CLASS_COLUMNS}, ${MEASURE_SUMS}
          FROM ${source.sql} GROUP BY ${ACTIVITY_COLUMNS}, feature, content_id, ${MODEL_COLUMNS}, ${CLASS_COLUMNS}`,
    params: source.params,
  };
}

/** The calls of one activity, oldest first. Narrowing in the scope only speeds the lookup; this checks the parts exactly. */
export function activityCallsSql(scope: UsageScope, parts: { kind: string; a: string; b: string; c: string; d: number }): BuiltSql {
  const source = activitySource(scope, CALL_COLUMNS);
  return {
    sql: `SELECT * FROM ${source.sql}
          WHERE kind = @kind AND activity_a = @partA AND activity_b = @partB AND activity_c = @partC AND activity_d = @partD
          ORDER BY occurred_at, id`,
    params: { ...source.params, kind: parts.kind, partA: parts.a, partB: parts.b, partC: parts.c, partD: BigInt(parts.d) },
  };
}
