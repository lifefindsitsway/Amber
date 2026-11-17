/**
 * Golden samples of joining sentences into running text, shared by every surface that joins
 * them (reading view, copy, selection, note quotes, TXT and Markdown exports), so they cannot
 * drift apart. Each sample lists the sentences of one paragraph and the text expected for a
 * revision that is proofread (marked) and for one without marks; a loosely joined revision
 * (paragraphed by hand without proofreading) must give the unmarked text.
 */
export interface JoinSample {
  name: string;
  texts: readonly string[];
  marked: string;
  unmarked: string;
}

export const JOIN_SAMPLES: readonly JoinSample[] = [
  {
    name: "CJK sentence across two time slices",
    texts: ["但这样就等于你同时拒绝了你的老师", "和牛逼的网课，", "进入一种恶性循环。"],
    marked: "但这样就等于你同时拒绝了你的老师和牛逼的网课，进入一种恶性循环。",
    unmarked: "但这样就等于你同时拒绝了你的老师 和牛逼的网课，进入一种恶性循环。",
  },
  {
    name: "unpunctuated ASR slices",
    texts: ["大学的崩溃是系统性的", "我有自己的理解", "呃这个问题我们后面再说"],
    marked: "大学的崩溃是系统性的我有自己的理解呃这个问题我们后面再说",
    unmarked: "大学的崩溃是系统性的 我有自己的理解 呃这个问题我们后面再说",
  },
  {
    name: "mixed scripts",
    texts: ["AI 替我上大学的诱惑力", "实在太大了。", "Stanford", "的课程"],
    marked: "AI 替我上大学的诱惑力实在太大了。Stanford 的课程",
    unmarked: "AI 替我上大学的诱惑力 实在太大了。Stanford 的课程",
  },
  {
    name: "English",
    texts: ["so the question is", "what do we do next.", "Nobody knows"],
    marked: "so the question is what do we do next. Nobody knows",
    unmarked: "so the question is what do we do next. Nobody knows",
  },
];
