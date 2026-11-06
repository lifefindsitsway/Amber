import type { FixtureCall, FixtureGroup, FixtureModel, FixturePrice, FixtureProfile, FixtureScenario } from "./types.ts";
import { asrCall, beijing, group, llmCall, MS_PER_MINUTE, model, profile, randomSource, SCENARIO_NOW } from "./builders.ts";

// Prices ----------------------------------------------------------------------------------------

const PRICE_CLAUDE: FixturePrice = { currency: "CNY", inputPerMillion: 21.6, outputPerMillion: 108, cacheReadPerMillion: 2.16 };
const PRICE_GPT: FixturePrice = { currency: "CNY", inputPerMillion: 9, outputPerMillion: 72, cacheReadPerMillion: 0.9 };
const PRICE_DEEPSEEK: FixturePrice = { currency: "CNY", inputPerMillion: 2, outputPerMillion: 8 };
const PRICE_QWEN_AUDIO: FixturePrice = { currency: "CNY", billedInputPerMillion: 1.2, billedOutputPerMillion: 4.8 };
const PRICE_FUN_ASR: FixturePrice = { currency: "CNY", audioPerSecond: 0.00022 };
const PRICE_GPT_USD: FixturePrice = { currency: "USD", inputPerMillion: 1.25, outputPerMillion: 10, cacheReadPerMillion: 0.125 };

// World -----------------------------------------------------------------------------------------

interface World {
  relay: FixtureProfile;
  deepseek: FixtureProfile;
  bailian: FixtureProfile;
  claude: FixtureModel;
  gpt: FixtureModel;
  deepseekChat: FixtureModel;
  qwenAudio: FixtureModel;
  funAsr: FixtureModel;
}

function world(): World {
  const relay = profile("relay", "llm", "Auth2API", [
    ["relay-v1", beijing(2026, 10, 12, 9)],
    ["relay-v2", beijing(2026, 11, 3, 8, 30)],
  ]);
  const deepseek = profile("deepseek", "llm", "DeepSeek", [["deepseek-v1", beijing(2026, 10, 20, 14)]]);
  const bailian = profile("bailian", "asr", "阿里云百炼", [["bailian-v1", beijing(2026, 10, 18, 11)]]);
  return {
    relay,
    deepseek,
    bailian,
    claude: model(relay, "claude-sonnet-4-5", PRICE_CLAUDE),
    gpt: model(relay, "gpt-5.6-sol", PRICE_GPT),
    deepseekChat: model(deepseek, "deepseek-v4-chat", PRICE_DEEPSEEK),
    qwenAudio: model(bailian, "qwen-audio-3.1-asr-flash-filetrans", PRICE_QWEN_AUDIO),
    funAsr: model(bailian, "fun-asr", PRICE_FUN_ASR),
  };
}

// Activity builders -----------------------------------------------------------------------------

const SECOND = 1000;

interface TaskSpec {
  asr?: { model: FixtureModel; audioMin: number; billed?: boolean };
  proofread?: { model: FixtureModel; chunks: number; cached?: boolean };
  chapter?: { model: FixtureModel };
  summary?: { model: FixtureModel; passes: number };
  translate?: { model: FixtureModel; batches: number };
  /** Calls of the task after this index use the other credential version of their profile. */
  versionSwitchAfter?: number;
}

/** The calls of one processing task, one after another with small gaps, as a pipeline makes them. */
function taskCalls(rand: () => number, owner: FixtureGroup, start: number, spec: TaskSpec): FixtureCall[] {
  const calls: FixtureCall[] = [];
  let at = start;
  const step = (): number => {
    at += Math.round((18 + rand() * 30) * SECOND);
    return at;
  };
  const versionFor = (target: FixtureModel): string | null => {
    const versions = target.profile.versions;
    if (spec.versionSwitchAfter === undefined || versions.length < 2) return versions.at(-1)?.id ?? null;
    return calls.length < spec.versionSwitchAfter ? (versions.at(-2)?.id ?? null) : (versions.at(-1)?.id ?? null);
  };
  if (spec.asr !== undefined) {
    const audioMs = Math.round(spec.asr.audioMin * MS_PER_MINUTE);
    const billed = spec.asr.billed ?? spec.asr.model.currentPrice?.billedInputPerMillion !== undefined;
    calls.push(
      asrCall(owner, spec.asr.model, step(), {
        audioMs,
        ...(billed ? { billedInput: Math.round(audioMs / 24), billedOutput: Math.round(audioMs / 520) } : {}),
      }),
    );
  }
  for (let index = 0; index < (spec.proofread?.chunks ?? 0); index += 1) {
    const target = spec.proofread?.model as FixtureModel;
    const input = Math.round(6200 + rand() * 3000);
    const cacheRead = spec.proofread?.cached === true && index > 0 ? Math.round(input * (0.35 + rand() * 0.4)) : undefined;
    calls.push(
      llmCall(owner, target, "proofread", step(), {
        input,
        output: Math.round(input * (0.82 + rand() * 0.1)),
        version: versionFor(target),
        ...(cacheRead === undefined ? {} : { cacheRead }),
      }),
    );
  }
  if (spec.chapter !== undefined) {
    calls.push(
      llmCall(owner, spec.chapter.model, "chapter", step(), {
        input: Math.round(48_000 + rand() * 30_000),
        output: Math.round(1100 + rand() * 600),
        version: versionFor(spec.chapter.model),
      }),
    );
  }
  for (let index = 0; index < (spec.summary?.passes ?? 0); index += 1) {
    const target = spec.summary?.model as FixtureModel;
    calls.push(
      llmCall(owner, target, "summary", step(), {
        input: Math.round(52_000 + rand() * 70_000),
        output: Math.round(1500 + rand() * 900),
        reasoning: 400,
        version: versionFor(target),
      }),
    );
  }
  for (let index = 0; index < (spec.translate?.batches ?? 0); index += 1) {
    const target = spec.translate?.model as FixtureModel;
    calls.push(llmCall(owner, target, "translate", step(), { input: Math.round(7000 + rand() * 2500), output: Math.round(7600 + rand() * 2500), version: versionFor(target) }));
  }
  return calls;
}

function chatCalls(rand: () => number, owner: FixtureGroup, target: FixtureModel, at: number, rounds: number): FixtureCall[] {
  return Array.from({ length: rounds }, (_, index) =>
    llmCall(owner, target, index === 0 ? "chat_search_plan" : "chat", at + index * 9 * SECOND, {
      input: Math.round(index === 0 ? 900 : 18_000 + rand() * 60_000),
      output: Math.round(index === 0 ? 60 : 280 + rand() * 700),
    }),
  );
}

const CONTENTS = {
  attention: "第 3 讲：注意力机制与 Transformer",
  opening: "生成式软件工程 · 开场",
  tokenizer: "Let's build the GPT Tokenizer",
  scaling: "Scaling Laws 与算力预算（上）",
  rag: "检索增强生成：从原理到落地",
  agents: "Agent 评测方法与失败案例复盘",
  diffusion: "扩散模型入门（中文字幕）",
  prompt: "提示词工程：结构化输出与约束",
};

/** The scenario most screenshots use: one currency, a mix of models, tasks, chats and tests over five weeks. */
export function mainScenario(): FixtureScenario {
  const w = world();
  const rand = randomSource(20261106);
  const calls: FixtureCall[] = [];

  const task = (id: string, title: string, contentKey: string, at: number, spec: TaskSpec) =>
    calls.push(...taskCalls(rand, group(id, "task", title, `content-${contentKey}`), at, spec));
  const chat = (id: string, title: string, contentKey: string, at: number, target: FixtureModel, rounds: number) =>
    calls.push(...chatCalls(rand, group(id, "chat", title, `content-${contentKey}`), target, at, rounds));
  const test = (id: string, at: number, target: FixtureModel) => {
    const owner = group(id, "test", null, null);
    calls.push(
      target.profile.modality === "asr"
        ? asrCall(owner, target, at, {
            audioMs: 2000,
            feature: "test_connection",
            ...(target.currentPrice?.billedInputPerMillion === undefined ? {} : { billedInput: 83, billedOutput: 3 }),
          })
        : llmCall(owner, target, "test_connection", at, { input: 24, output: 5 }),
    );
  };

  // The last two days.
  task("t-attention", CONTENTS.attention, "attention", beijing(2026, 11, 6, 9, 41), {
    asr: { model: w.qwenAudio, audioMin: 153.6 },
    proofread: { model: w.gpt, chunks: 6, cached: true },
    chapter: { model: w.claude },
    summary: { model: w.claude, passes: 2 },
  });
  chat("c-attention-1", CONTENTS.attention, "attention", beijing(2026, 11, 6, 9, 52), w.gpt, 3);
  task("t-opening", CONTENTS.opening, "opening", beijing(2026, 11, 5, 21, 8), {
    asr: { model: w.funAsr, audioMin: 71 },
    proofread: { model: w.deepseekChat, chunks: 4, cached: true },
    summary: { model: w.gpt, passes: 1 },
  });
  test("x-relay", beijing(2026, 11, 5, 18, 2), w.claude);
  task("t-tokenizer", CONTENTS.tokenizer, "tokenizer", beijing(2026, 11, 5, 10, 20), {
    asr: { model: w.funAsr, audioMin: 133 },
    proofread: { model: w.claude, chunks: 5 },
    translate: { model: w.gpt, batches: 5 },
    summary: { model: w.claude, passes: 1 },
  });
  chat("c-tokenizer", CONTENTS.tokenizer, "tokenizer", beijing(2026, 11, 4, 22, 30), w.claude, 4);
  test("x-qwen", beijing(2026, 11, 4, 16, 44), w.qwenAudio);

  // The key was replaced on 11-03: a task spanning it uses both versions.
  task("t-scaling", CONTENTS.scaling, "scaling", beijing(2026, 11, 3, 8, 22), {
    proofread: { model: w.claude, chunks: 6 },
    summary: { model: w.claude, passes: 2 },
    versionSwitchAfter: 4,
  });
  task("t-rag", CONTENTS.rag, "rag", beijing(2026, 11, 2, 15, 3), {
    asr: { model: w.qwenAudio, audioMin: 98 },
    proofread: { model: w.gpt, chunks: 4, cached: true },
    chapter: { model: w.gpt },
  });

  // Old enough to have no frozen price: the history before prices were recorded.
  const legacyGroup = group("t-prompt", "task", CONTENTS.prompt, "content-prompt");
  const legacySpec: TaskSpec = { proofread: { model: w.claude, chunks: 3 }, summary: { model: w.claude, passes: 1 } };
  calls.push(...taskCalls(rand, legacyGroup, beijing(2026, 10, 31, 20, 14), legacySpec).map((call) => ({ ...call, price: null, version: null })));

  // A task that was removed afterwards: its content remains, so the calls are summed by day.
  const contentDay = group("d-agents-1030", "content_day", CONTENTS.agents, "content-agents");
  calls.push(...taskCalls(rand, contentDay, beijing(2026, 10, 30, 19, 40), { proofread: { model: w.gpt, chunks: 2 }, summary: { model: w.gpt, passes: 1 } }));
  const removed = group("d-gone-1029", "deleted_day", null, null);
  calls.push(...taskCalls(rand, removed, beijing(2026, 10, 29, 11, 5), { proofread: { model: w.deepseekChat, chunks: 3 } }));

  // October.
  task("t-diffusion", CONTENTS.diffusion, "diffusion", beijing(2026, 10, 27, 13, 12), {
    asr: { model: w.funAsr, audioMin: 86 },
    proofread: { model: w.claude, chunks: 4 },
    summary: { model: w.claude, passes: 1 },
  });
  chat("c-diffusion", CONTENTS.diffusion, "diffusion", beijing(2026, 10, 24, 20, 3), w.gpt, 2);
  task("t-attention-old", CONTENTS.attention, "attention", beijing(2026, 10, 21, 9, 30), {
    asr: { model: w.qwenAudio, audioMin: 150 },
    proofread: { model: w.claude, chunks: 6 },
    summary: { model: w.claude, passes: 1 },
    versionSwitchAfter: 0,
  });
  task("t-rag-old", CONTENTS.rag, "rag", beijing(2026, 10, 15, 16, 40), { proofread: { model: w.claude, chunks: 3 }, chapter: { model: w.claude } });
  task("t-agents", CONTENTS.agents, "agents", beijing(2026, 10, 9, 10, 10), {
    asr: { model: w.funAsr, audioMin: 64 },
    proofread: { model: w.deepseekChat, chunks: 2 },
  });

  // A failed and an unknown-result request inside the newest task, and a cancelled transcription.
  const failedGroup = group("t-fail", "task", "Mamba 与状态空间模型", "content-mamba");
  calls.push(
    llmCall(failedGroup, w.gpt, "proofread", beijing(2026, 11, 6, 8, 12), { input: 7400, output: 0, result: "failed", version: "relay-v2" }),
    llmCall(failedGroup, w.gpt, "proofread", beijing(2026, 11, 6, 8, 13), { input: 7400, output: 6600, version: "relay-v2" }),
    llmCall(failedGroup, w.gpt, "chapter", beijing(2026, 11, 6, 8, 15), { input: 0, output: 0, result: "outcome_unknown", version: "relay-v2" }),
    asrCall(failedGroup, w.funAsr, beijing(2026, 11, 6, 8, 9), { audioMs: 12 * MS_PER_MINUTE, result: "cancelled" }),
  );

  const now = SCENARIO_NOW;
  return { id: "main", now, calls: calls.filter((call) => call.at < now), cacheObserved: [w.gpt, w.deepseekChat] };
}

/** Both currencies in the history: part of the calls were priced in dollars. */
export function dualCurrencyScenario(): FixtureScenario {
  const base = mainScenario();
  const w = world();
  const dollars = model(w.relay, "gpt-5.6-sol", PRICE_GPT_USD);
  const calls = base.calls.map((call) =>
    call.model.modelId === "gpt-5.6-sol" ? { ...call, model: dollars, price: call.version === null ? null : PRICE_GPT_USD } : call,
  );
  return { ...base, id: "dual", calls, cacheObserved: [dollars] };
}

/** Many requests the estimate leaves out, for every reason group. */
export function partialScenario(): FixtureScenario {
  const base = mainScenario();
  const rand = randomSource(77);
  const w = world();
  const bare = model(w.deepseek, "deepseek-v4-reasoner", null);
  const extra: FixtureCall[] = [];
  const owner = group("t-reasoner", "task", "未定价模型的任务", "content-reasoner");
  for (let index = 0; index < 5; index += 1) {
    extra.push(llmCall(owner, bare, "proofread", beijing(2026, 11, 5, 14, index * 3), { input: Math.round(5000 + rand() * 2000), output: 4400, price: null }));
  }
  extra.push(llmCall(owner, w.claude, "summary", beijing(2026, 11, 5, 14, 20), { input: 0, output: 1620, version: "relay-v2" }));
  return { ...base, id: "partial", calls: [...base.calls, ...extra], cacheObserved: [...base.cacheObserved, bare] };
}

const LONG_PROFILE = "我的中转站（公司内部自建 OpenAI 兼容网关，北京机房）";
const LONG_MODEL = "gpt-5.6-sol-2026-10-31-preview-high-reasoning-long-context";

/** Long profile and model names in every place a name appears. */
export function longNamesScenario(): FixtureScenario {
  const rand = randomSource(5);
  const owner = profile("long-relay", "llm", LONG_PROFILE, [
    ["long-v1", beijing(2026, 10, 1)],
    ["long-v2", beijing(2026, 11, 1)],
  ]);
  const target = model(owner, LONG_MODEL, PRICE_GPT);
  const other = model(owner, "claude-sonnet-4-5-20260901-extended-thinking-with-a-very-long-suffix", PRICE_CLAUDE);
  const calls: FixtureCall[] = [];
  const titles = ["第十二讲：从零实现带有分组查询注意力与滑动窗口的解码器——兼谈长上下文外推的几种做法", "A very long English lecture title: Understanding KV-cache eviction policies in long-context inference"];
  titles.forEach((title, index) => {
    const owner2 = group(`long-${index}`, "task", title, `content-long-${index}`);
    const spec: TaskSpec = { proofread: { model: target, chunks: 3, cached: true }, summary: { model: other, passes: 1 } };
    calls.push(...taskCalls(rand, owner2, beijing(2026, 11, 5 - index, 10), spec));
  });
  return { id: "long-names", now: SCENARIO_NOW, calls, cacheObserved: [target] };
}

/** Eleven models of similar weight, so the grey remainder outweighs every coloured series. */
export function otherDominantScenario(): FixtureScenario {
  const rand = randomSource(11);
  const owner = profile("many", "llm", "OpenRouter", [["many-v1", beijing(2026, 10, 1)]]);
  const calls: FixtureCall[] = [];
  const ids = ["gpt-5.6-sol", "claude-sonnet-4-5", "deepseek-v4-chat", "qwen3-max", "glm-5", "kimi-k3", "gemini-3-pro", "llama-4-405b", "mistral-large-3", "grok-4", "yi-lightning"];
  ids.forEach((modelId, modelIndex) => {
    const target = model(owner, modelId, { currency: "CNY", inputPerMillion: 4 + modelIndex, outputPerMillion: 16 + modelIndex });
    for (let day = 0; day < 6; day += 1) {
      const owner2 = group(`many-${modelIndex}-${day}`, "task", `${modelId} 批量任务 ${day + 1}`, `content-many-${modelIndex}-${day}`);
      const count = modelIndex < 2 ? 2 : 3 + Math.floor(rand() * 3);
      calls.push(...taskCalls(rand, owner2, beijing(2026, 11, 6 - day, 8 + modelIndex % 8), { proofread: { model: target, chunks: count } }));
    }
  });
  return { id: "other-dominant", now: SCENARIO_NOW, calls: calls.filter((call) => call.at < SCENARIO_NOW), cacheObserved: [] };
}

/** A deleted profile, a historic transcription whose profile cannot be told apart, and a removed content. */
export function deletedScenario(): FixtureScenario {
  const base = mainScenario();
  const rand = randomSource(9);
  const gone = profile("gone", "llm", "旧中转站", [["gone-v1", beijing(2026, 9, 20)]], true);
  const goneModel = model(gone, "gpt-5-mini", null);
  const unknownAsr = profile("", "asr", null, [], true);
  const unknownModel = model(unknownAsr, "fun-asr", null);
  const extra: FixtureCall[] = [];
  const goneGroup = group("t-gone", "task", "旧中转站处理过的课程", "content-gone");
  const goneSpec: TaskSpec = { proofread: { model: goneModel, chunks: 3 }, summary: { model: goneModel, passes: 1 } };
  extra.push(...taskCalls(rand, goneGroup, beijing(2026, 11, 4, 11), goneSpec).map((call) => ({ ...call, version: "gone-v1" })));
  extra.push(
    asrCall(group("t-old-asr", "task", "升级前转写的内容", "content-old-asr"), unknownModel, beijing(2026, 11, 3, 9), { audioMs: 55 * MS_PER_MINUTE, version: null, price: null }),
  );
  return { ...base, id: "deleted", calls: [...base.calls, ...extra] };
}

/** Only transcription calls. */
export function asrOnlyScenario(): FixtureScenario {
  const rand = randomSource(3);
  const w = world();
  const calls: FixtureCall[] = [];
  const lectures: Array<[string, number, FixtureModel, number, number]> = [
    ["第 1 讲：课程导论", 41, w.funAsr, 6, 9],
    ["第 2 讲：线性代数回顾", 97, w.qwenAudio, 5, 15],
    ["第 3 讲：概率与信息论", 122, w.funAsr, 4, 10],
    ["第 4 讲：优化方法", 88, w.qwenAudio, 3, 20],
    ["第 5 讲：神经网络基础", 134, w.funAsr, 1, 11],
  ];
  lectures.forEach(([title, minutes, target, daysAgo, hour], index) => {
    calls.push(...taskCalls(rand, group(`asr-${index}`, "task", title, `content-asr-${index}`), beijing(2026, 11, 6 - daysAgo, hour), { asr: { model: target, audioMin: minutes } }));
  });
  calls.push(asrCall(group("x-asr", "test", null, null), w.funAsr, beijing(2026, 11, 5, 17), { audioMs: 2000, feature: "test_connection" }));
  calls.push(asrCall(group("t-accepted", "task", "刚提交的转写", "content-accepted"), w.qwenAudio, beijing(2026, 11, 6, 9, 58), { audioMs: 64 * MS_PER_MINUTE, accepted: true }));
  return { id: "asr-only", now: SCENARIO_NOW, calls, cacheObserved: [] };
}

export function emptyScenario(): FixtureScenario {
  return { id: "empty", now: SCENARIO_NOW, calls: [], cacheObserved: [] };
}

/** The main data, answered slowly, to look at the loading state. */
export function loadingScenario(): FixtureScenario {
  return { ...mainScenario(), id: "loading", delayMs: 60 * 1000 };
}

/** Every usage request fails. */
export function errorScenario(): FixtureScenario {
  return { ...mainScenario(), id: "error", failing: true };
}

export const SCENARIOS = {
  main: mainScenario,
  dual: dualCurrencyScenario,
  partial: partialScenario,
  "long-names": longNamesScenario,
  "other-dominant": otherDominantScenario,
  deleted: deletedScenario,
  "asr-only": asrOnlyScenario,
  empty: emptyScenario,
  loading: loadingScenario,
  error: errorScenario,
} as const;

export type ScenarioId = keyof typeof SCENARIOS;
