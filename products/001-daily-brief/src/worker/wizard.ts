// B11/B12/B14 · 三步向导与「对编辑说一句」(docs/02-技术方案.md §6.3、§7)。
//
// 每步 = 一次「输入明确、输出 JSON」的 LLM 调用,用户确认才有下一步——旧的
// agent 工具循环(chat.ts)整个退役。控制权在这一层,不在模型手里:
//   understand  对话原话 → name + 逐句理解;用户红标圈改过的句子服务端按位置
//               强制覆盖回去(§7.2,不信任模型的自觉)
//   tags        确认后的理解 → 收/不收标签建议
//   sources     问题+理解+标签 → 候选源提议;probeFeed 逐个实抓,只回传抓通的;
//               存活 <3 带失败清单自动补提议一轮(§7.3)
//   refine      档案页「对编辑说一句」→ 定义修改 patch(只许 intent/include/
//               exclude/sourceRules 四个字段),替代原工具循环
//
// 反捏造照旧(§8.5):模型只产出待验证的 URL 字符串,抓通了才展示、才可采纳。
// mock 模式下向导照走但不联网:步骤 1 本地搭骨架,步骤 2/3 给空建议并明说。

// value import 一律带 .ts 扩展名:wizard.test.ts 经 node --experimental-strip-types
// 直接加载本模块,node 不做扩展名搜索(type-only import 会被擦掉,不受此限)。
import { AiError, complete, resolveProvider } from "../shared/ai.ts";
import type { AiConfig } from "../shared/ai";
import type { Store } from "../shared/store";
import {
	MAX_CHANGELOG,
	MAX_INTENT_SEGMENTS,
	PURPOSE_QUESTION,
	SOURCE_CATEGORIES,
	joinSegments,
	purposeOptions,
	trackerSegments,
} from "../shared/pipeline-core.ts";
import type { IntentSegment, SourceConfig, Tracker, TrackerSourceRule } from "../shared/pipeline-core";
import { catalogPromptLines } from "../shared/catalog.ts";
import { MAX_TRACKERS, bumpSourceMetrics, loadConfig, saveTrackers } from "./config.ts";
import { probeFeed } from "./feeds.ts";

/** userAiGuard 通过后的调用环境:当前用户 + 存储 + AI 配置。 */
export interface WizardContext {
	store: Store;
	email: string;
	ai: AiConfig;
}

/** 每个处理器返回统一形状,路由层(index.ts)只管转成 JSON 响应。 */
export interface WizardResult {
	status: 200 | 400 | 404;
	body: Record<string, unknown>;
}

const MAX_WIZARD_TURNS = 8;
const MAX_TURN_CHARS = 1000;
const MAX_CANDIDATES = 6;
/** 补提议一轮最多再试抓几个——两轮总子请求压在 Worker 免费档 50 以内(§8.4)。 */
const MAX_RETRY_CANDIDATES = 4;
/** 存活候选低于这个数就带失败清单自动重调一次(仅一次,防循环)。 */
const MIN_ALIVE = 3;

const MOCK_NOTE =
	"AI 未接入(mock 模式),这一步没有真实建议——交互形态照常,可手动补充后继续。" +
	"接入方法:.dev.vars 设 DEEPSEEK_API_KEY,或 wrangler secret put DEEPSEEK_API_KEY。";

// ---------- 通用小件(导出的都有测试) ----------

/** 宽容解析模型输出:剥 markdown 围栏、掐头去尾只留最外层 {...}。 */
export function parseJsonBlock(text: string): Record<string, unknown> {
	let t = text.trim();
	const fence = /^```(?:json)?\s*([\s\S]*?)\s*```$/.exec(t);
	if (fence) t = fence[1];
	const start = t.indexOf("{");
	const end = t.lastIndexOf("}");
	if (start >= 0 && end > start) t = t.slice(start, end + 1);
	const parsed = JSON.parse(t) as unknown;
	if (typeof parsed !== "object" || parsed === null || Array.isArray(parsed)) {
		throw new SyntaxError("model output is not a JSON object");
	}
	return parsed as Record<string, unknown>;
}

/**
 * §7.2 的服务端兜底:重生成回来后,把旧草稿里用户亲手改过(edited:true)的
 * 句子按位置强制覆盖回去——提示词里已要求锁定,但不信任模型的自觉。
 * 新理解比锁定位置短时,锁定句追加在尾部,宁可多留也不许弄丢用户的手改。
 */
export function mergeLockedSegments(
	prev: IntentSegment[] | undefined,
	next: IntentSegment[],
): IntentSegment[] {
	if (!prev?.some((s) => s.edited)) return next.slice(0, MAX_INTENT_SEGMENTS);
	const out = next.slice(0, MAX_INTENT_SEGMENTS);
	prev.forEach((seg, i) => {
		if (!seg.edited) return;
		if (i < out.length) out[i] = { text: seg.text, edited: true };
		else out.push({ text: seg.text, edited: true });
	});
	return out.slice(0, MAX_INTENT_SEGMENTS);
}

/** 字符串数组清洗:去空、截长、去重、限量。非数组返回 []。 */
export function cleanStringList(raw: unknown, maxItems: number, maxLen: number): string[] {
	if (!Array.isArray(raw)) return [];
	return [
		...new Set(
			raw
				.filter((x): x is string => typeof x === "string")
				.map((x) => x.trim().slice(0, maxLen))
				.filter(Boolean),
		),
	].slice(0, maxItems);
}

export interface WizardCandidate {
	name: string;
	url: string;
	category: SourceConfig["category"];
	reason?: string;
}

/** 模型提议的候选清洗:字段不全/分类非法/URL 超长的整条丢弃。 */
export function cleanCandidates(raw: unknown, max = MAX_CANDIDATES): WizardCandidate[] {
	if (!Array.isArray(raw)) return [];
	const out: WizardCandidate[] = [];
	for (const c of raw as Record<string, unknown>[]) {
		if (out.length >= max) break;
		const name = typeof c?.name === "string" ? c.name.trim().slice(0, 100) : "";
		const url = typeof c?.url === "string" ? c.url.trim() : "";
		const category = c?.category as SourceConfig["category"];
		if (!name || !url || url.length > 500 || !/^https?:\/\/\S+$/.test(url)) continue;
		if (!SOURCE_CATEGORIES.includes(category)) continue;
		if (out.some((x) => x.url === url)) continue;
		out.push({
			name,
			url,
			category,
			...(typeof c.reason === "string" && c.reason.trim() ? { reason: c.reason.trim().slice(0, 200) } : {}),
		});
	}
	return out;
}

function prependLog(t: Tracker, text: string): Tracker {
	return {
		...t,
		changelog: [{ at: new Date().toISOString(), text }, ...(t.changelog ?? [])].slice(0, MAX_CHANGELOG),
	};
}

/** 向导/refine 的 JSON 输出需要空间,别让默认 1024 截断(和生成路径同款逻辑)。 */
function withTokenFloor(cfg: AiConfig, floor: number): AiConfig {
	const cap = Number.parseInt(cfg.maxOutputTokens ?? "", 10);
	return { ...cfg, maxOutputTokens: String(Number.isFinite(cap) && cap >= floor ? cap : floor) };
}

function bad(error: string): WizardResult {
	return { status: 400, body: { error } };
}

// ---------- 步骤 1:理解 ----------

const UNDERSTAND_SYSTEM = `你是「每日简报」的编辑。用户会用自己的话描述一个想长期追踪的问题,你要把它整理成一份「编辑的理解」——一组独立短句,用户会逐句圈改,然后这份理解会长期指导每天的选材。

只输出一个 JSON 对象,不要任何其他文字:
{"name": "简报分区标题", "segments": ["一句话", "一句话", ...], "purpose": "用户拿这份追踪干什么(只有他明说了才填,否则省略)", "purposeOptions": ["选项1", "选项2", "选项3"]}

要求:
- segments 3 到 ${MAX_INTENT_SEGMENTS} 句,每句 ≤50 字,简体中文(专有名词保留原文);
- 每句只讲一个维度(追踪范围/优先什么/过滤什么/判断标准),可独立修改而不牵连其他句;
- 忠于用户原话,不发挥、不编造用户没提的偏好;拿不准的宁可少写,留给用户补;
- purpose 是「他在忙什么、什么变化会改变他的动作」(如「在做产品,怕平台改权限和定价」)。**只有用户原话里说了才填,一个字都不许猜**——没说就省略这个字段,系统会去问他;
- purposeOptions 是**没填 purpose 时**系统要拿去问他的选项,3 个,每个 ≤14 字。它们必须**贴着他这个话题**:同一个话题下,不同的人在忙的事不一样,而这决定了该给他挑哪一类内容(追 AI Agent 的可能是「在做产品盯竞品」或「在选技术栈」;追美联储的可能是「手里有仓位」或「在看购房时机」)。写成具体处境,别写成「了解行业动态」这种放之四海皆准的废话;不要写「就是想跟上」这类不表态的选项,系统会自己补;
- 用户多说了几轮时,基于全部原话整体重写完整理解,不做增量拼接;
- name 是简报里的分区标题:名词短语,≤16 字,不带标点。`;

function understandPrompts(
	messages: string[],
	locked: { index: number; text: string }[],
	purpose?: string,
): { system: string; prompt: string } {
	let system = UNDERSTAND_SYSTEM;
	if (locked.length > 0) {
		system +=
			"\n\n用户已亲手改过以下句子(按 segments 里的序号,从 1 数):逐字保留、按原序号位置输出,一个字都不许改:\n" +
			locked.map((l) => `第${l.index + 1}句:「${l.text}」`).join("\n");
	}
	const prompt =
		"用户在向导里说过的话(按时间顺序):\n" +
		messages.map((m, i) => `${i + 1}.「${m}」`).join("\n") +
		// 已经问到用途时,理解要顺着它写——同一个话题,做产品的人和看投资的人
		// 该被挑的是完全不同的两批内容。
		(purpose ? `\n\n用户已经确认了他在忙什么:「${purpose}」。理解里要有一句体现这个取舍。` : "") +
		"\n\n据此输出完整的理解 JSON。";
	return { system, prompt };
}

/** mock 模式的本地骨架:不替用户瞎猜规则,只把「该有哪几句」摆出来等圈改。 */
function skeletonSegments(): IntentSegment[] {
	return [
		{ text: "围绕这个问题的一手进展与判断依据" },
		{ text: "优先可验证、有细节的信息" },
		{ text: "过滤重复报道与宣传稿" },
	];
}

export async function wizardUnderstand(ctx: WizardContext, bodyRaw: unknown): Promise<WizardResult> {
	const body = (bodyRaw ?? {}) as { trackerKey?: unknown; messages?: unknown; purpose?: unknown };
	const trackerKey = typeof body.trackerKey === "string" ? body.trackerKey.trim().slice(0, 64) : "";
	// R8 · 用户点了选项(或填了「其他」)时带回来的用途,优先于模型的抽取
	const chosenPurpose = typeof body.purpose === "string" ? body.purpose.trim().slice(0, 200) : "";
	if (!Array.isArray(body.messages) || body.messages.length === 0 || body.messages.length > MAX_WIZARD_TURNS) {
		return bad(`messages must be a non-empty string array (max ${MAX_WIZARD_TURNS})`);
	}
	const messages = (body.messages as unknown[])
		.filter((m): m is string => typeof m === "string")
		.map((m) => m.trim().slice(0, MAX_TURN_CHARS))
		.filter(Boolean);
	if (messages.length === 0) return bad("messages must contain non-empty strings");

	const config = await loadConfig(ctx.store, ctx.email);
	const existing = trackerKey ? config.trackers.find((t) => t.key === trackerKey) : undefined;
	if (trackerKey && !existing) return { status: 404, body: { error: "trackerKey 不存在" } };
	if (existing && !existing.stage) return bad("该追踪器已生效,不在向导里——去档案页改,或对编辑说一句。");
	if (!existing && config.trackers.length >= MAX_TRACKERS) {
		return bad(`追踪器已达上限 ${MAX_TRACKERS} 个,先删掉或合并一些。`);
	}

	// 原话以第一句为准;继续对话不改原话,只改理解
	const question = messages[0].slice(0, 500);
	const locked = (existing?.intentSegments ?? [])
		.map((seg, index) => ({ index, text: seg.text, edited: seg.edited === true }))
		.filter((l) => l.edited);

	// 已知的用途:用户刚选的 > 草稿里存过的(模型抽出来的作为兜底,见下)
	let purpose = chosenPurpose || existing?.purpose || "";

	let name: string;
	let segments: IntentSegment[];
	let note: string | undefined;
	// 模型按话题生成的选项;拿不到就用通用兜底(purposeOptions 里处理)
	let generatedOptions: string[] = existing?.purposeOptions ?? [];
	if (resolveProvider(ctx.ai) === "mock") {
		name = question.slice(0, 12);
		segments = skeletonSegments();
		note = "AI 未接入(mock 模式),先按你的原话搭了理解骨架——每句都可以直接圈改。";
	} else {
		const { system, prompt } = understandPrompts(messages, locked, purpose);
		const result = await complete(withTokenFloor(ctx.ai, 2048), { prompt, system, json: true });
		const parsed = parseJsonBlock(result.text);
		name = typeof parsed.name === "string" && parsed.name.trim() ? parsed.name.trim().slice(0, 60) : question.slice(0, 16);
		segments = cleanStringList(parsed.segments, MAX_INTENT_SEGMENTS, 200).map((text) => ({ text }));
		if (segments.length === 0) throw new AiError("模型没有给出可用的理解,请重试。", 502);
		// 用户原话里本来就说了用途 → 直接采用,不必再问一遍
		if (!purpose && typeof parsed.purpose === "string") purpose = parsed.purpose.trim().slice(0, 200);
		generatedOptions = cleanStringList(parsed.purposeOptions, 3, 14);
	}

	// R8 · 只有「还不知道用途」才追问,而且只追这一轮:知道了就再也不问。
	// 两轮以上会从「帮我想清楚」变成「被盘问」,向导的放弃率会掉。
	const ask = purpose ? undefined : { question: PURPOSE_QUESTION, options: purposeOptions(generatedOptions) };
	// §7.2 兜底:用户红标圈改过的句子按位置强制覆盖,不管模型听没听话
	segments = mergeLockedSegments(existing?.intentSegments, segments);

	const now = new Date().toISOString();
	let draft: Tracker;
	if (existing) {
		draft = prependLog(
			{
				...existing,
				name,
				question,
				...(purpose ? { purpose } : {}),
				// 答完就把选项删掉:它只在向导期间有用,不该留在生效的定义里
				purposeOptions: purpose ? undefined : generatedOptions,
				intentSegments: segments,
				intent: joinSegments(segments),
				stage: "understanding",
			},
			chosenPurpose
				? `你说了在忙什么:「${chosenPurpose}」,编辑按它重写了理解`
				: "你补充了一句,编辑重写了理解(你圈改过的句子原样保留)",
		);
	} else {
		draft = {
			key: `t-${crypto.randomUUID().slice(0, 8)}`,
			name,
			question,
			...(purpose ? { purpose } : {}),
			...(purpose || generatedOptions.length === 0 ? {} : { purposeOptions: generatedOptions }),
			askedAt: now,
			intentSegments: segments,
			intent: joinSegments(segments),
			sourceMode: "selected",
			sourceKeys: [],
			quota: 3,
			stage: "understanding",
			changelog: [{ at: now, text: "向导开始:编辑起草了这份理解,等你圈改" }],
		};
	}

	const trackers = existing
		? config.trackers.map((t) => (t.key === existing.key ? draft : t))
		: [...config.trackers, draft];
	await saveTrackers(ctx.store, ctx.email, trackers);
	return { status: 200, body: { tracker: draft, trackers, ...(ask ? { ask } : {}), ...(note ? { note } : {}) } };
}

// ---------- 步骤 2:标签 ----------

const TAGS_SYSTEM = `你是「每日简报」的编辑。根据用户的长期问题和已确认的理解,为这份追踪定义起草「收/不收」关键词标签——它们是选材时的硬性信号,不是装饰。

只输出一个 JSON 对象:
{"include": ["...", ...], "exclude": ["...", ...]}

要求:
- include 3-6 个:值得收进简报的内容特征(信号类型、内容形态、具体子话题),别只把主题词换个说法;
- exclude 2-5 个:这个主题下最常见的噪音,要具体到这个主题(比如追产品动态就排除「融资传闻」,不要泛泛写「广告」);
- 每个 ≤12 字,名词或短语;简体中文为主,专有名词保留原文。`;

export async function wizardTags(ctx: WizardContext, bodyRaw: unknown): Promise<WizardResult> {
	const body = (bodyRaw ?? {}) as { trackerKey?: unknown };
	const trackerKey = typeof body.trackerKey === "string" ? body.trackerKey.trim() : "";
	if (!trackerKey) return bad("trackerKey required");
	const config = await loadConfig(ctx.store, ctx.email);
	const draft = config.trackers.find((t) => t.key === trackerKey);
	if (!draft) return { status: 404, body: { error: "trackerKey 不存在" } };
	if (!draft.stage) return bad("该追踪器已生效,不在向导里。");

	let include: string[] = [];
	let exclude: string[] = [];
	let note: string | undefined;
	if (resolveProvider(ctx.ai) === "mock") {
		include = draft.include ?? [];
		exclude = draft.exclude ?? [];
		note = MOCK_NOTE;
	} else {
		const prompt =
			`长期问题(用户原话):「${draft.question ?? draft.name}」\n` +
			`编辑的理解(用户已确认):${joinSegments(trackerSegments(draft)) || "(空)"}\n\n` +
			"据此输出收/不收标签 JSON。";
		const result = await complete(withTokenFloor(ctx.ai, 1024), { prompt, system: TAGS_SYSTEM, json: true });
		const parsed = parseJsonBlock(result.text);
		include = cleanStringList(parsed.include, 12, 40);
		exclude = cleanStringList(parsed.exclude, 12, 40);
		if (include.length === 0 && exclude.length === 0) {
			note = "编辑这轮没给出标签建议——可以手动添加,或直接下一步(标签不是必填)。";
		}
	}

	const updated = prependLog(
		{
			...draft,
			...(include.length ? { include } : {}),
			...(exclude.length ? { exclude } : {}),
			stage: "tags",
		},
		"向导:编辑起草了收/不收标签,等你修剪",
	);
	const trackers = config.trackers.map((t) => (t.key === trackerKey ? updated : t));
	await saveTrackers(ctx.store, ctx.email, trackers);
	return { status: 200, body: { tracker: updated, trackers, ...(note ? { note } : {}) } };
}

// ---------- 步骤 3:信源(B12:查询源保底 + 试抓 + 自动补足) ----------

/**
 * 平台模板清单(§7.3 第 1 层,保底):这类 feed 不需要「知道网站」,按模板
 * 填关键词就能构造出来且必然抓得通。模型在这层的任务是把理解翻译成好检索式。
 */
const QUERY_TEMPLATES = `1. 查询源(每次提议必须 ≥2 个):按模板把用户的意图翻译成检索式——同义词、布尔组合、中英文双查是你的主要工作:
   - Google News 检索(首选,一定抓得通):https://news.google.com/rss/search?q=<URL编码的关键词>&hl=en-US&gl=US&ceid=US:en(中文内容用 hl=zh-CN&gl=CN&ceid=CN:zh-Hans)
   - Hacker News 关键词:https://hnrss.org/newest?q=<关键词>&points=50
   - Reddit 子版:https://www.reddit.com/r/<子版名>/top/.rss?t=week
   - arXiv 分类:https://rss.arxiv.org/rss/<分类,如 cs.AI>
   - GitHub 发布:https://github.com/<owner>/<repo>/releases.atom
   - YouTube 频道:https://www.youtube.com/feeds/videos.xml?channel_id=<UC 开头的频道 id>
   - Substack:https://<名字>.substack.com/feed`;

function sourcesSystem(): string {
	return `你是「每日简报」的编辑,任务是为一份追踪定义提议信息源候选。每个候选都会被系统真实试抓,抓不通的不会展示给用户——所以宁可保守,绝不编造 URL。

只输出一个 JSON 对象:
{"candidates": [{"name": "简洁的源名称", "url": "feed URL", "category": "news|macro|blog|podcast|paper", "reason": "一句话推荐理由"}]}

候选最多 ${MAX_CANDIDATES} 个,只允许三类来源:
${QUERY_TEMPLATES}
2. 精选目录(主题相关就优先挑,URL 原样抄,不存在编造):
${catalogPromptLines()}
3. 你确知存在的具体站点 feed(某人博客、某公司官方 blog):可以提,但抓不通就浪费一个名额,不确定就别提。

规则:
- reason 用简体中文一句话,说清它对这个问题有什么用;
- 禁止提议「已有来源」「已拒绝来源」清单里的 URL;
- ${MAX_CANDIDATES} 个候选覆盖不同角度(查询源+目录源+具体源搭配,别全是同一模板的变体);
- category 按内容类型选:news=新闻 macro=宏观/经济 blog=博客/分析 podcast=播客 paper=论文。`;
}

function sourcesPrompt(draft: Tracker, adopted: string[], rejected: string[], excluded: string[]): string {
	const lines = [
		"追踪定义:",
		`- 问题(用户原话):「${draft.question ?? draft.name}」`,
		// R7 · 找源时最有分辨力的一行:知道他在做产品、怕平台改规则,才提得出
		// 定价页/权限文档/更新日志这类源;只知道话题就只会给一堆新闻源。
		...(draft.purpose ? [`- 用户在忙什么(据此选源类型):${draft.purpose}`] : []),
		`- 编辑的理解:${joinSegments(trackerSegments(draft)) || "(空)"}`,
		`- 收:${(draft.include ?? []).join("、") || "(未设)"};不收:${(draft.exclude ?? []).join("、") || "(未设)"}`,
	];
	if (adopted.length) lines.push(`\n已有来源(禁止重复提议):\n${adopted.map((u) => `- ${u}`).join("\n")}`);
	if (rejected.length) lines.push(`\n已拒绝来源(禁止重复提议):\n${rejected.map((u) => `- ${u}`).join("\n")}`);
	const extra = excluded.filter((u) => !adopted.includes(u) && !rejected.includes(u));
	if (extra.length) lines.push(`\n本轮已展示过(禁止重复提议):\n${extra.map((u) => `- ${u}`).join("\n")}`);
	return lines.join("\n") + "\n\n据此输出候选源 JSON。";
}

/** 试抓通过的候选,带最近三条真实标题——展示给用户的就是这个形状。 */
interface AliveCandidate {
	name: string;
	url: string;
	category: SourceConfig["category"];
	reason?: string;
	ok: true;
	total?: number;
	fresh?: number;
	latest?: { title: string; publishedAt: string | null }[];
}

async function probeCandidates(
	cands: WizardCandidate[],
	banned: Set<string>,
): Promise<{ alive: AliveCandidate[]; failed: { url: string; error: string }[] }> {
	const fresh = cands.filter((c) => !banned.has(c.url));
	const probes = await Promise.all(fresh.map((c) => probeFeed(c.url)));
	const alive: AliveCandidate[] = [];
	const failed: { url: string; error: string }[] = [];
	fresh.forEach((c, i) => {
		const p = probes[i];
		if (p.ok) {
			if (banned.has(p.url) || alive.some((a) => a.url === p.url)) return; // 发现后的最终 URL 撞已有/已展示
			alive.push({
				name: c.name,
				url: p.url,
				category: c.category,
				...(c.reason ? { reason: c.reason } : {}),
				ok: true,
				total: p.total,
				fresh: p.fresh,
				latest: p.latest?.slice(0, 3),
			});
		} else {
			failed.push({ url: c.url, error: p.error ?? "试抓失败" });
		}
	});
	return { alive, failed };
}

export async function wizardSources(ctx: WizardContext, bodyRaw: unknown): Promise<WizardResult> {
	const body = (bodyRaw ?? {}) as { trackerKey?: unknown; excludeUrls?: unknown };
	const trackerKey = typeof body.trackerKey === "string" ? body.trackerKey.trim() : "";
	if (!trackerKey) return bad("trackerKey required");
	const excludeUrls = cleanStringList(body.excludeUrls, 40, 500);

	const config = await loadConfig(ctx.store, ctx.email);
	// 注意:这里不要求草稿——档案页的「让编辑再找几个」(F3)也走这个端点,
	// 生效追踪器不动 stage,只有还在向导里的草稿才落 stage:"sources"。
	const tracker = config.trackers.find((t) => t.key === trackerKey);
	if (!tracker) return { status: 404, body: { error: "trackerKey 不存在" } };

	const advanceDraft = async (): Promise<{ tracker: Tracker; trackers: Tracker[] } | null> => {
		if (!tracker.stage || tracker.stage === "sources") return null;
		const updated = prependLog({ ...tracker, stage: "sources" }, "向导:进入选源,候选都经真实试抓");
		const trackers = config.trackers.map((t) => (t.key === trackerKey ? updated : t));
		await saveTrackers(ctx.store, ctx.email, trackers);
		return { tracker: updated, trackers };
	};

	if (resolveProvider(ctx.ai) === "mock") {
		const advanced = await advanceDraft();
		return {
			status: 200,
			body: {
				candidates: [],
				note: MOCK_NOTE + " 可以从来源库手动挑选来源。",
				...(advanced ?? {}),
			},
		};
	}

	const urlByKey = new Map(config.sources.map((s) => [s.key, s.url]));
	const adopted = (tracker.sourceKeys ?? []).map((k) => urlByKey.get(k)).filter((u): u is string => Boolean(u));
	const rejected = tracker.rejectedSourceUrls ?? [];
	const banned = new Set([...adopted, ...rejected, ...excludeUrls]);

	const cfg = withTokenFloor(ctx.ai, 2048);
	const system = sourcesSystem();
	const first = await complete(cfg, { prompt: sourcesPrompt(tracker, adopted, rejected, excludeUrls), system, json: true });
	const cands = cleanCandidates(parseJsonBlock(first.text).candidates);
	const { alive, failed } = await probeCandidates(cands, banned);

	// B12 · 自动补足:存活不足时带失败清单重调一次(仅一次,防循环),仍不足就如实展示
	if (alive.length < MIN_ALIVE) {
		for (const a of alive) banned.add(a.url);
		for (const c of cands) banned.add(c.url);
		const retryPrompt =
			sourcesPrompt(tracker, adopted, rejected, [...excludeUrls, ...cands.map((c) => c.url)]) +
			`\n\n上一轮以下候选试抓失败:\n${failed.map((f) => `- ${f.url}(${f.error})`).join("\n") || "(无)"}` +
			`\n请换别的再提议最多 ${MAX_RETRY_CANDIDATES} 个,优先用查询源模板(它们必然抓得通),别重复上面任何 URL。`;
		try {
			const second = await complete(cfg, { prompt: retryPrompt, system, json: true });
			const retryCands = cleanCandidates(parseJsonBlock(second.text).candidates, MAX_RETRY_CANDIDATES);
			const more = await probeCandidates(retryCands, banned);
			alive.push(...more.alive);
		} catch (err) {
			// 补足失败不毁掉首轮结果:有多少展示多少
			console.error("wizard/sources: retry round failed", err);
		}
	}

	const advanced = await advanceDraft();
	// 仪表:展示数只算真实出现在 UI 的候选(试抓通过的);采纳数在 /api/sources/add 记
	if (alive.length > 0) await bumpSourceMetrics(ctx.store, ctx.email, { shown: alive.length });
	const note =
		alive.length === 0
			? "这轮没有找到抓得通的候选源。换个说法「再找几个」,或从来源库手动挑选。"
			: alive.length < MIN_ALIVE
				? `这轮只找到 ${alive.length} 个抓得通的候选,不凑数——可以「再找几个」或从来源库补。`
				: undefined;
	return {
		status: 200,
		body: { candidates: alive, ...(note ? { note } : {}), ...(advanced ?? {}) },
	};
}

// ---------- 「对编辑说一句」(B14,替代工具循环) ----------

const REFINE_SYSTEM = `你是「每日简报」的编辑。用户对一份追踪定义说了一句话,你把它落实为定义的修改。你只能改四个字段:intent(编辑的理解,一段话,分号分句)、include(收什么标签)、exclude(不收什么标签)、sourceRules(某个来源上的局部只收/不收)。

只输出一个 JSON 对象,只包含需要修改的字段(没变的字段不要输出),外加一行说明:
{"intent": "...", "include": [...], "exclude": [...], "sourceRules": [{"sourceKey": "...", "include": [...], "exclude": [...]}], "note": "一句话:你改了什么"}

规则:
- 输出的字段是全量替换:比如往 include 加一个标签时,要带上原有的所有标签;
- sourceRules 的 sourceKey 只能用「当前来源」清单里已有的 key;用户没点名具体来源时用全局 include/exclude,不要用 sourceRules;
- 这句话落不进这四个字段时(比如要加来源、要改名),输出 {"note": "一句话说明为什么改不了、该去哪改"},不要硬改;
- note 用简体中文,≤40 字。`;

export async function wizardRefine(ctx: WizardContext, bodyRaw: unknown): Promise<WizardResult> {
	const body = (bodyRaw ?? {}) as { trackerKey?: unknown; text?: unknown };
	const trackerKey = typeof body.trackerKey === "string" ? body.trackerKey.trim() : "";
	const text = typeof body.text === "string" ? body.text.trim().slice(0, 500) : "";
	if (!trackerKey || !text) return bad("trackerKey and text required");

	const config = await loadConfig(ctx.store, ctx.email);
	const tracker = config.trackers.find((t) => t.key === trackerKey);
	if (!tracker) return { status: 404, body: { error: "trackerKey 不存在" } };
	if (resolveProvider(ctx.ai) === "mock") {
		// 前端在 mock 下走本地提案,不该到这里;真到了就明说
		return bad("AI 未接入(mock 模式),「对编辑说一句」暂不可用。");
	}

	const trackerSources =
		tracker.sourceMode === "selected"
			? (tracker.sourceKeys ?? [])
					.map((k) => config.sources.find((s) => s.key === k))
					.filter((s): s is SourceConfig => Boolean(s))
			: config.sources.filter((s) => s.enabled !== false);
	const sourceLines = trackerSources.map((s) => `- key=${s.key} ${s.name}`);
	const ruleLines = (tracker.sourceRules ?? []).map(
		(r) =>
			`- key=${r.sourceKey}:只收 ${(r.include ?? []).join("、") || "(无)"};不收 ${(r.exclude ?? []).join("、") || "(无)"}`,
	);
	const prompt =
		"定义现状:\n" +
		`- 问题(用户原话,不许改):「${tracker.question ?? tracker.name}」\n` +
		`- intent:${joinSegments(trackerSegments(tracker)) || "(空)"}\n` +
		`- include:${(tracker.include ?? []).join("、") || "(空)"}\n` +
		`- exclude:${(tracker.exclude ?? []).join("、") || "(空)"}\n` +
		`- sourceRules:\n${ruleLines.length ? ruleLines.join("\n") : "(无)"}\n` +
		`- 当前来源:\n${sourceLines.length ? sourceLines.join("\n") : "(无)"}\n\n` +
		`用户说:「${text}」\n\n据此输出修改 JSON。`;

	const result = await complete(withTokenFloor(ctx.ai, 1024), { prompt, system: REFINE_SYSTEM, json: true });
	const parsed = parseJsonBlock(result.text);
	const patch = cleanRefinePatch(parsed, new Set(trackerSources.map((s) => s.key)));
	const note =
		typeof parsed.note === "string" && parsed.note.trim()
			? parsed.note.trim().slice(0, 120)
			: Object.keys(patch).length
				? "编辑更新了定义"
				: "编辑没有给出可执行的修改";
	return { status: 200, body: { patch, note } };
}

/** refine 输出清洗:只认四个字段,sourceKey 越界的整条丢弃。导出为测试。 */
export function cleanRefinePatch(parsed: Record<string, unknown>, knownSourceKeys: Set<string>): Partial<Tracker> {
	const patch: Partial<Tracker> = {};
	if (typeof parsed.intent === "string" && parsed.intent.trim()) {
		patch.intent = parsed.intent.trim().slice(0, 400);
	}
	if (Array.isArray(parsed.include)) patch.include = cleanStringList(parsed.include, 12, 40);
	if (Array.isArray(parsed.exclude)) patch.exclude = cleanStringList(parsed.exclude, 12, 40);
	if (Array.isArray(parsed.sourceRules)) {
		const rules: TrackerSourceRule[] = [];
		for (const raw of parsed.sourceRules as Record<string, unknown>[]) {
			const sourceKey = typeof raw?.sourceKey === "string" ? raw.sourceKey.trim().slice(0, 64) : "";
			if (!sourceKey || !knownSourceKeys.has(sourceKey) || rules.some((r) => r.sourceKey === sourceKey)) continue;
			const include = cleanStringList(raw.include, 12, 40);
			const exclude = cleanStringList(raw.exclude, 12, 40);
			if (include.length || exclude.length) {
				rules.push({ sourceKey, ...(include.length ? { include } : {}), ...(exclude.length ? { exclude } : {}) });
			}
		}
		patch.sourceRules = rules;
	}
	return patch;
}
