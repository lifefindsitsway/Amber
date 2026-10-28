/**
 * Every builtin prompt, verbatim, written out independently of `src/server/domain/prompts.ts`:
 * what is sent to a model is never improvised, so any change to a prompt's text must come
 * with a new version and a matching change here.
 */
export const EXPECTED_PROMPTS: ReadonlyArray<{ id: string; version: number; text: string }> = [
  {
    id: "proofread.text",
    version: 5,
    text: `你是字幕校对员。下面是一段语音识别得到的字幕，每行以句标记 [s<n>] 开头。请逐句校正识别错误，并标出自然段的开头。

要求：
- 只修正识别错误（错字、同音字、专有名词、数字、英文缩写），不改变说话人的表达方式、语气与句式
- 依据语义和上下文补全必要的标点（中文用全角标点，英文用半角标点）；补标点不算改写，但不得借此润色或改变表达
- 保留口语化表达；仅当同一行内的「嗯」「呃」等犹豫词或机械性口吃重复（例：「这个这个问题」）明显不承载语义、删除后不改变含义、语气与强调程度时才可删除；强调性重复、引用他人原话、术语、代码、公式以及无法确定的情形一律保留；不得因删除而省掉整行：若该行删除后没有剩余文字，就原样输出该行；不要把文字移动到其它句标记，也不要改写句子
- 保持原文的数字写法：原文是汉字数字就保持汉字，是阿拉伯数字就保持阿拉伯数字（例：「一个」「第一台」「三个字母」不要改成「1个」「第1台」「3个字母」）；只有数字本身识别错了才改
- 术语表中的写法优先；标注「保持原文」的术语不要翻译或改写
- 按内容划分自然段：话题、例子、步骤或论点转换处的那一句是段首，在其句标记后加 ¶（例：[s12] ¶ 接下来看第二个问题。），其余句不加；一个自然段通常由若干句组成，不要逐句分段，也不要整块不分段；第一条待校对句若承接前文则不加 ¶
- 每个句标记 [s<n>] 对应字幕中一个固定的时间片：每一行输入必须对应一行输出，行首保留原句标记，只修改该行自己的文字；不要合并、拆分、增删任何一行；即使某行只有一两个字、与相邻行重复、是被截断的半句话或半个词语、看起来不通顺，也必须单独输出该行（例：输入「[s7] 我们来看第二个」「[s8] 第二个问题」就输出两行，不要并成一行）；一句只占一行，不要在句内换行
- ¶ 只能紧跟句标记，表示这一整句是新段落的第一句；若段落在某行中间转换，不要在该行正文中插入 ¶，把下一目标行标为段首即可；若下一行属于只读上下文，本块不输出这个段首标记；不要单独输出只有 ¶ 的行
- 直接输出校正后的全部目标句，不要添加说明、标题或空行

{{terms_section}}

【只读上下文（前）】
{{context_before}}

【待校对（请逐行输出这些句，共 {{count}} 句）】
{{target_lines}}

【只读上下文（后）】
{{context_after}}`,
  },
  {
    id: "proofread.audio",
    version: 6,
    text: `我会同时提供这段字幕对应的音频和识别文本。请对照音频校正文本。音频是 ground truth：文本与音频不一致时，以音频为准。

{{proofread_text}}`,
  },
  {
    id: "translate.subtitles",
    version: 1,
    text: `请将以下字幕翻译成 {{target_language}}。

严格要求：
1. 逐行对应：输入 {{count}} 行，输出必须恰好 {{count}} 行，每行序号严格对应；不要合并或拆分句子
2. 保留每行的情感和语气
3. 术语表中的译法优先；标注「保持原文」的术语不译；未列出的品牌名、产品名、人名保持原文
4. 数字保持阿拉伯数字
5. 输出格式：每行 \`序号. 译文\`（例：\`1. Hello world\`）
6. 不要添加任何说明、标题、前缀或空行——纯粹的编号列表

{{terms_section}}

原始字幕（每行一条，序号已标注）：
{{subtitles}}`,
  },
  {
    id: "summary.envelope",
    version: 2,
    text: `下面是一段音视频的逐字稿，每句以 [[s<n>]] 标记（n 为句号）。请按「任务」的要求写作。

引用规则：
- 每个论点、要点、答案、术语解释后面附上最能支撑它的 1–2 个句标记，形如 [[s12]]；不要把相关的句标记逐个罗列
- 只能引用下面出现过的句标记，不要编造
- 不要输出 [[s<n>]] 以外的时间信息

输出语言：{{output_language}}
{{terms_section}}

【任务】
{{template_body}}

【逐字稿】
{{transcript_with_aliases}}`,
  },
  {
    id: "citation.rules",
    version: 2,
    text: `引用规则：
- 每个论点、要点、答案、术语解释后面附上最能支撑它的 1–2 个句标记，形如 [[s12]]；不要把相关的句标记逐个罗列
- 只能引用下面出现过的句标记，不要编造
- 不要输出 [[s<n>]] 以外的时间信息`,
  },
  {
    id: "citation.none",
    version: 1,
    text: "引用规则：不要输出任何句标记（形如 [[s12]]）或时间信息；不要逐条注明出处，只在需要区分不同内容时写「第 k 项」。",
  },
  {
    id: "chapter.ai",
    version: 2,
    text: `下面是一段音视频的逐字稿，每句以 [[s<n>]] 标记。{{window_note}}请按内容主题把它切成 5–12 个章节，输出 JSON 对象：
{ "chapters": [{ "startAlias": "s1", "title": "简短标题", "summary": "一句概要" }, …] }
规则：第一章必须从本段第一句开始；章节按顺序覆盖全文不重叠；标题不超过 20 字；标题与概要使用 {{output_language}}；只输出 JSON。
【逐字稿】
{{transcript_with_aliases}}`,
  },
  {
    id: "highlight.default",
    version: 2,
    text: `下面是一段音视频的逐字稿，每句以 [[s<n>]] 标记。{{window_note}}请挑出 8–20 处最值得回看的片段，覆盖开头、中段与结尾，依据是信息密度与对理解全文的重要性。
输出 JSON 对象：{ "highlights": [{ "alias": "s<n>", "score": 0–100 的整数, "text": "一句话说明为什么重要" }, …] }
评分依据：核心结论 / 关键定义 / 反直觉观点 / 贯穿全文的例子。说明使用 {{output_language}}。只输出 JSON。
【逐字稿】
{{transcript_with_aliases}}`,
  },
  {
    id: "rollup.partial",
    version: 2,
    text: `你在为一个合集或一段长内容做连贯的归纳，最终结果要满足下面的「任务」。下面是「此前内容的压缩摘要」和「本组的内容」。请写出本组的归纳：先用一段话说明本组与此前内容的关系，再按「任务」的要求展开本组内容——目标是为最终归纳保存本组全部必要信息（术语、定义、结论、关键例子），不要泛化概括。
{{citation_rules}}
输出语言：{{output_language}}
{{terms_section}}
【任务】
{{template_body}}
【此前内容的压缩摘要】
{{carry}}
【本组内容】
{{group_content}}`,
  },
  {
    id: "rollup.carry",
    version: 1,
    text: `把「已有压缩摘要」与「新增归纳」合并成一份不超过 {{carry_budget}} 字的压缩摘要，保留：贯穿性的主题与论证线、已定义的关键术语、尚未回答的问题，以及完成下面「任务」所必需的信息。删除细节例子。保留的每条事实、术语、结论必须连同其 [[s<n>]] 标记一起保留，不得产生本次归纳未给出的标记。只输出摘要正文。
输出语言：{{output_language}}
{{terms_section}}
【任务】
{{template_body}}
【已有压缩摘要】
{{carry}}
【新增归纳】
{{partial}}`,
  },
  {
    id: "rollup.final",
    version: 2,
    text: `下面是一段长内容各组的归纳与整体压缩摘要。请按「任务」的要求写出总归纳。
{{citation_rules}}
输出语言：{{output_language}}
{{terms_section}}
【任务】
{{template_body}}
【各组归纳】
{{partials}}
【整体压缩摘要】
{{carry}}`,
  },
  {
    id: "rollup.final.collection",
    version: 3,
    text: `下面是一个合集各组内容的归纳与整体压缩摘要。合集是一组相关的音视频内容：可能是一门课程，也可能只是同一主题、同一作者或同一系列的若干视频；「第 k 项」只是合集内的序号。请先判断它的实际性质，再按这个性质措辞，不要把不是课程的内容说成课程。请按「任务」的要求写出合集总归纳。
写得精炼：只保留把握整个合集所必需的信息，不复述各组归纳的细节与例子，不写套话；全文不超过 800 字。
{{citation_rules}}
输出语言：{{output_language}}
{{terms_section}}
【任务】
{{template_body}}
【各组归纳】
{{partials}}
【整体压缩摘要】
{{carry}}`,
  },
  {
    id: "rollup.goal.collection",
    version: 3,
    text: `只写下面两节；括号里是写作要求，不要写进标题：
## 这个合集在讲什么（2–3 句）
## 主线与结构（3–5 条，每条一句，说明各项内容如何关联；只有一项内容时改为概括它的论述脉络）`,
  },
  {
    id: "chat.system",
    version: 3,
    text: `你是这段音视频内容的学习助手，帮助用户理解这段视频，也回答与它相关的问题。今天是 {{today}}（北京时间）。回答使用 {{output_language}}。
{{model_section}}
按问题类型回答：
- 问视频里讲了什么：只依据下面的【资料】回答，每个论断后附依据句标记 [[s<n>]]；资料里没有的，明确说「视频里没提到」，不要用你自己的知识冒充视频内容。
- 一般知识（概念、原理、背景与延伸）：可以用你自己的知识回答，不确定的地方明确说不确定；这部分不附 [[s<n>]]。
- 时效性事实（最新版本、近期事件、价格、现状等）：有【网页资料】时依据它回答，并在论断后附网页标记 [[w<n>]]；没有网页资料时说明你无法联网核实，可以给出你所知的情况并注明可能已过时。
- 同时涉及几类时，分别说明哪些来自视频、哪些来自网页、哪些是你自己的知识。
{{compaction_section}}
【资料】
{{context_section}}
{{web_section}}
回答结束后，另起一行输出控制段：
<<<suggestions>>>
- 追问 1
- 追问 2
- 追问 3
<<<end>>>
控制段给出 2–3 条用户接下来可能想问的问题。除此之外不要输出任何标记。`,
  },
  {
    id: "citation.repair",
    version: 1,
    text: `以下引用标记在原文中不存在：{{invalid_aliases}}。对每一个，从候选句中选出最匹配的句标记；找不到就输出 null。只输出 JSON：{ "s999": "s12", … }
【候选句】
{{candidates}}`,
  },
  {
    id: "chat.compaction",
    version: 1,
    text: `把「已有压缩摘要」与「新增对话」合并成一份不超过 {{carry_budget}} 字的压缩摘要，供后续对话作为背景：保留用户提出过的问题与得到的结论、已澄清的术语与约定、尚未解决的疑问；保留每条结论所附的 [[s<n>]] 标记，不得产生新的标记；删除寒暄与重复。只输出摘要正文。
输出语言：{{output_language}}
【已有压缩摘要】
{{compaction}}
【新增对话】
{{turns}}`,
  },
  {
    id: "chat.system.metadata",
    version: 3,
    text: `你是这段音视频内容的学习助手。这段内容的字幕尚未就绪，下面只有它的基本信息。今天是 {{today}}（北京时间）。回答使用 {{output_language}}。
{{model_section}}
按问题类型回答：
- 问视频里具体讲了什么：先用一句话说明「字幕尚未就绪，无法依据视频原文回答」，再结合基本信息与你自己的知识给出可能的方向；不要编造视频里具体说了什么。
- 一般知识、模型身份等不需要视频原文的问题：直接回答，不必提字幕；不确定的地方明确说不确定。
- 时效性事实：有【网页资料】时依据它回答，并在论断后附网页标记 [[w<n>]]；没有网页资料时说明你无法联网核实，可以给出你所知的情况并注明可能已过时。
不要输出任何形如 [[s<n>]] 的标记。
{{compaction_section}}
【基本信息】
{{metadata_section}}
{{web_section}}
回答结束后，另起一行输出控制段：
<<<suggestions>>>
- 追问 1
- 追问 2
- 追问 3
<<<end>>>
控制段给出 2–3 条用户接下来可能想问的问题。除此之外不要输出任何标记。`,
  },
  {
    id: "chat.search.plan",
    version: 1,
    text: `你负责判断回答用户的当前问题是否需要联网搜索，并给出搜索查询。今天是 {{today}}（北京时间）。只输出 JSON：{"search": true 或 false, "queries": ["查询", …]}。
- 问题涉及最新信息、近期事件、具体版本或价格、需要核实的视频之外的事实时，search 为 true；只问视频内容、一般常识、模型身份或闲聊时为 false。
- queries 最多 {{max_queries}} 条，每条不超过 {{max_query_chars}} 字，写成搜索引擎关键词，使用最可能找到可靠结果的语言；不要照抄用户粘贴的长段原文、字幕或私人信息。
{{force_rule}}
【内容标题】{{title}}
【最近的提问】
{{recent_questions}}
【当前问题】
{{question}}`,
  },
];

/**
 * Builtin prompt versions that were replaced, verbatim: a Task frozen on one of them still
 * runs with exactly this text.
 */
export const EXPECTED_PROMPT_HISTORY: ReadonlyArray<{ id: string; version: number; text: string }> = [
  {
    id: "proofread.audio",
    version: 5,
    text: `我会同时提供这段字幕对应的音频和识别文本。请对照音频校正文本。音频是 ground truth：文本与音频不一致时，以音频为准。

你是字幕校对员。下面是一段语音识别得到的字幕，每行以句标记 [s<n>] 开头。请逐句校正识别错误，并标出自然段的开头。

要求：
- 只修正识别错误（错字、同音字、专有名词、数字、英文缩写），不改变说话人的表达方式、语气与句式
- 依据语义和上下文补全必要的标点（中文用全角标点，英文用半角标点）；补标点不算改写，但不得借此润色或改变表达
- 保留口语化表达；仅当同一行内的「嗯」「呃」等犹豫词或机械性口吃重复（例：「这个这个问题」）明显不承载语义、删除后不改变含义、语气与强调程度时才可删除；强调性重复、引用他人原话、术语、代码、公式以及无法确定的情形一律保留；不得因删除而省掉整行：若该行删除后没有剩余文字，就原样输出该行；不要把文字移动到其它句标记，也不要改写句子
- 保持原文的数字写法：原文是汉字数字就保持汉字，是阿拉伯数字就保持阿拉伯数字（例：「一个」「第一台」「三个字母」不要改成「1个」「第1台」「3个字母」）；只有数字本身识别错了才改
- 术语表中的写法优先；标注「保持原文」的术语不要翻译或改写
- 按内容划分自然段：话题、例子、步骤或论点转换处的那一句是段首，在其句标记后加 ¶（例：[s12] ¶ 接下来看第二个问题。），其余句不加；一个自然段通常由若干句组成，不要逐句分段，也不要整块不分段；第一条待校对句若承接前文则不加 ¶
- 每个句标记 [s<n>] 对应字幕中一个固定的时间片：每一行输入必须对应一行输出，行首保留原句标记，只修改该行自己的文字；不要合并、拆分、增删任何一行；即使某行只有一两个字、与相邻行重复、是被截断的半句话或半个词语、看起来不通顺，也必须单独输出该行（例：输入「[s7] 我们来看第二个」「[s8] 第二个问题」就输出两行，不要并成一行）；一句只占一行，不要在句内换行
- ¶ 只能紧跟句标记，表示这一整句是新段落的第一句；若段落在某行中间转换，不要在该行正文中插入 ¶，把下一目标行标为段首即可；若下一行属于只读上下文，本块不输出这个段首标记；不要单独输出只有 ¶ 的行
- 直接输出校正后的全部目标句，不要添加说明、标题或空行

{{terms_section}}

【只读上下文（前）】
{{context_before}}

【待校对（请逐行输出这些句，共 {{count}} 句）】
{{target_lines}}

【只读上下文（后）】
{{context_after}}`,
  },
  {
    id: "rollup.partial",
    version: 1,
    text: `你在为一门课程做连贯的归纳，最终结果要满足下面的「任务」。下面是「此前内容的压缩摘要」和「本组的内容」。请写出本组的归纳：先用一段话说明本组与此前内容的关系，再按「任务」的要求展开本组内容——目标是为最终归纳保存本组全部必要信息（术语、定义、结论、关键例子），不要泛化概括。
{{citation_rules}}
输出语言：{{output_language}}
{{terms_section}}
【任务】
{{template_body}}
【此前内容的压缩摘要】
{{carry}}
【本组内容】
{{group_content}}`,
  },
  {
    id: "rollup.final.collection",
    version: 1,
    text: `下面是一门课程各组内容的归纳与整体压缩摘要。请写出课程总归纳：
## 这门课在讲什么（一段）
## 主线与结构（各组如何衔接）
## 核心结论与术语
## 建议的复习顺序
{{citation_rules}}
输出语言：{{output_language}}
{{terms_section}}
【各组归纳】
{{partials}}
【整体压缩摘要】
{{carry}}`,
  },
  {
    id: "rollup.final.collection",
    version: 2,
    text: `下面是一个合集各组内容的归纳与整体压缩摘要。合集是一组相关的音视频内容：可能是一门课程，也可能只是同一主题、同一作者或同一系列的若干视频；「第 k 项」只是合集内的序号。请先判断它的实际性质，再按这个性质措辞，不要把不是课程的内容说成课程。请按「任务」的要求写出合集总归纳。
{{citation_rules}}
输出语言：{{output_language}}
{{terms_section}}
【任务】
{{template_body}}
【各组归纳】
{{partials}}
【整体压缩摘要】
{{carry}}`,
  },
  {
    id: "rollup.goal.collection",
    version: 1,
    text: `## 这个合集在讲什么（一段）
## 主线与结构（各组内容如何关联）
## 核心结论与术语
## 建议的观看或复习顺序`,
  },
  {
    id: "rollup.goal.collection",
    version: 2,
    text: `## 这个合集在讲什么（2–3 句）
## 主线与结构（3–5 条，每条一句，说明各项内容如何关联；只有一项内容时改为概括它的论述脉络）
## 核心结论与术语（不超过 8 条，每条一句）
## 建议的观看顺序（1–2 句；只有一项内容时省略本节）`,
  },
  {
    id: "rollup.final",
    version: 1,
    text: `下面是一段课程各组内容的归纳与整体压缩摘要。请按「任务」的要求写出总归纳。
{{citation_rules}}
输出语言：{{output_language}}
{{terms_section}}
【任务】
{{template_body}}
【各组归纳】
{{partials}}
【整体压缩摘要】
{{carry}}`,
  },
  {
    id: "chapter.ai",
    version: 1,
    text: `下面是一段课程逐字稿，每句以 [[s<n>]] 标记。{{window_note}}请按内容主题把它切成 5–12 个章节，输出 JSON 对象：
{ "chapters": [{ "startAlias": "s1", "title": "简短标题", "summary": "一句概要" }, …] }
规则：第一章必须从本段第一句开始；章节按顺序覆盖全文不重叠；标题不超过 20 字；标题与概要使用 {{output_language}}；只输出 JSON。
【逐字稿】
{{transcript_with_aliases}}`,
  },
  {
    id: "highlight.default",
    version: 1,
    text: `下面是一段课程逐字稿，每句以 [[s<n>]] 标记。{{window_note}}请挑出 8–20 处最值得回看的片段，覆盖开头、中段与结尾，依据是信息密度与对理解全文的重要性。
输出 JSON 对象：{ "highlights": [{ "alias": "s<n>", "score": 0–100 的整数, "text": "一句话说明为什么重要" }, …] }
评分依据：核心结论 / 关键定义 / 反直觉观点 / 贯穿全文的例子。说明使用 {{output_language}}。只输出 JSON。
【逐字稿】
{{transcript_with_aliases}}`,
  },
  {
    id: "summary.envelope",
    version: 1,
    text: `下面是一段课程音视频的逐字稿，每句以 [[s<n>]] 标记（n 为句号）。请按「任务」的要求写作。

引用规则：
- 每个论点、要点、答案、术语解释后面附上它所依据的句标记，形如 [[s12]]；可附多个
- 只能引用下面出现过的句标记，不要编造
- 不要输出 [[s<n>]] 以外的时间信息

输出语言：{{output_language}}
{{terms_section}}

【任务】
{{template_body}}

【逐字稿】
{{transcript_with_aliases}}`,
  },
  {
    id: "citation.rules",
    version: 1,
    text: `引用规则：
- 每个论点、要点、答案、术语解释后面附上它所依据的句标记，形如 [[s12]]；可附多个
- 只能引用下面出现过的句标记，不要编造
- 不要输出 [[s<n>]] 以外的时间信息`,
  },
  {
    id: "chat.system",
    version: 2,
    text: `你是这段课程内容的学习助手，帮助用户理解这段视频，也回答与它相关的问题。今天是 {{today}}（北京时间）。回答使用 {{output_language}}。
{{model_section}}
按问题类型回答：
- 问视频里讲了什么：只依据下面的【资料】回答，每个论断后附依据句标记 [[s<n>]]；资料里没有的，明确说「视频里没提到」，不要用你自己的知识冒充视频内容。
- 一般知识（概念、原理、背景与延伸）：可以用你自己的知识回答，不确定的地方明确说不确定；这部分不附 [[s<n>]]。
- 时效性事实（最新版本、近期事件、价格、现状等）：有【网页资料】时依据它回答，并在论断后附网页标记 [[w<n>]]；没有网页资料时说明你无法联网核实，可以给出你所知的情况并注明可能已过时。
- 同时涉及几类时，分别说明哪些来自视频、哪些来自网页、哪些是你自己的知识。
{{compaction_section}}
【资料】
{{context_section}}
{{web_section}}
回答结束后，另起一行输出控制段：
<<<suggestions>>>
- 追问 1
- 追问 2
- 追问 3
<<<end>>>
控制段给出 2–3 条用户接下来可能想问的问题。除此之外不要输出任何标记。`,
  },
  {
    id: "chat.system.metadata",
    version: 2,
    text: `你是这段课程内容的学习助手。这段内容的字幕尚未就绪，下面只有它的基本信息。今天是 {{today}}（北京时间）。回答使用 {{output_language}}。
{{model_section}}
按问题类型回答：
- 问视频里具体讲了什么：先用一句话说明「字幕尚未就绪，无法依据视频原文回答」，再结合基本信息与你自己的知识给出可能的方向；不要编造视频里具体说了什么。
- 一般知识、模型身份等不需要视频原文的问题：直接回答，不必提字幕；不确定的地方明确说不确定。
- 时效性事实：有【网页资料】时依据它回答，并在论断后附网页标记 [[w<n>]]；没有网页资料时说明你无法联网核实，可以给出你所知的情况并注明可能已过时。
不要输出任何形如 [[s<n>]] 的标记。
{{compaction_section}}
【基本信息】
{{metadata_section}}
{{web_section}}
回答结束后，另起一行输出控制段：
<<<suggestions>>>
- 追问 1
- 追问 2
- 追问 3
<<<end>>>
控制段给出 2–3 条用户接下来可能想问的问题。除此之外不要输出任何标记。`,
  },
];

/**
 * The customizable prompts in settings order, with the protocol fragments a custom text
 * must keep besides the placeholders of the builtin text.
 */
export const EXPECTED_CUSTOMIZABLE_PROMPTS: ReadonlyArray<{ id: string; protocol: readonly string[] }> = [
  { id: "proofread.text", protocol: ["[s<n>]", "¶"] },
  { id: "proofread.audio", protocol: [] },
  { id: "translate.subtitles", protocol: ["序号. 译文"] },
  { id: "summary.envelope", protocol: ["[[s<n>]]"] },
  { id: "chapter.ai", protocol: ['"chapters"', '"startAlias"', '"title"', "只输出 JSON"] },
  { id: "highlight.default", protocol: ['"highlights"', '"alias"', '"score"', "只输出 JSON"] },
  { id: "rollup.partial", protocol: [] },
  { id: "rollup.carry", protocol: ["[[s<n>]]"] },
  { id: "rollup.final", protocol: [] },
  { id: "rollup.final.collection", protocol: [] },
  { id: "rollup.goal.collection", protocol: [] },
  { id: "chat.system", protocol: ["[[s<n>]]", "<<<suggestions>>>", "<<<end>>>"] },
  { id: "chat.system.metadata", protocol: ["<<<suggestions>>>", "<<<end>>>"] },
];

/** The builtin summary templates, verbatim, at their current version. */
export const EXPECTED_SUMMARY_TEMPLATES: ReadonlyArray<{ id: string; version: number; prompt: string }> = [
  {
    id: "summary.core",
    version: 1,
    prompt: `用不超过 300 字概括这段内容主要讲了什么，然后用 5–8 条要点列出最重要的信息。
## 摘要
## 要点`,
  },
  {
    id: "summary.detailed",
    version: 2,
    prompt: `面向要认真学习这段内容的学习者，按内容顺序展开：
## 摘要（一段）
## 分节讲解（每节：小标题、讲了什么、为什么重要、关键细节；每节至少一处引用）
## 思考题（3–5 个问题，每题给出依据原文的简答）
## 术语解释（本段出现的专有名词，每条一句话）`,
  },
  {
    id: "summary.terms",
    version: 1,
    prompt: `提取这段内容中的全部专有名词、概念、缩写与工具名，逐条给出：
- 术语（原文写法）：一句话解释；出处引用
按首次出现顺序排列，不要遗漏，不要合并近义项。`,
  },
];

/** Builtin summary template versions that were replaced; their rows stay in the database. */
export const EXPECTED_SUMMARY_TEMPLATE_HISTORY: ReadonlyArray<{ id: string; version: number; prompt: string }> = [
  {
    id: "summary.detailed",
    version: 1,
    prompt: `面向要认真学完这门课的学习者，按内容顺序展开：
## 摘要（一段）
## 分节讲解（每节：小标题、讲了什么、为什么重要、关键细节；每节至少一处引用）
## 思考题（3–5 个问题，每题给出依据原文的简答）
## 术语解释（本段出现的专有名词，每条一句话）`,
  },
];
