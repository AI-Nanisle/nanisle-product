// 输出契约(docs/02 T4):判决 + 总体要点 + 分段地图。内容级属性全站按
// 内容缓存;tracked 高亮是用户级属性,由第二次小调用回填进用户副本。
// W5 在这里补 prompt 组装与运行时校验;W6 的锚定校验消费 keyPoints[].quote。

/** 提取路径徽章:转写路径的时间戳精度和文字准确度都低一档,用户有权知道。 */
export type ExtractPath = "subtitle" | "whisper" | "article" | "paste";

export interface WatchVerdict {
	worth: "yes" | "no" | "partial";
	reason: string;
}

/**
 * 导读(2026-08-26 用户反馈新增):判决只有一句话太薄,开头要一段真正
 * 「替你看完后讲给你听」的东西——整体在讲什么、哪里有意思、值得反着想
 * 的地方。counter 是编辑的批判视角,但必须针对内容里的具体论点,不引入
 * 外部事实(和引文锚定同一条纪律的软版本)。
 */
export interface WatchOverview {
	/** 整条内容在讲什么:3~5 句连贯概述,读完等于听了一遍主线。 */
	summary: string;
	/** 最有意思/最出人意料的一两处,以及为什么值得停下来想。 */
	interesting: string;
	/** 反着想:哪个论点可能站不住、另一面的解读是什么。没有就诚实说没有。 */
	counter: string;
}

export interface WatchKeyPoint {
	/** 带具体数字/结论的要点,prompt 硬规则禁止空泛。 */
	point: string;
	/** ≤30 字逐字摘录的支撑原文——忠实度锚定(W6 校验它)。 */
	quote: string;
	/** 视频/播客:秒;文章:段落序号。 */
	start?: number;
	/** W6 锚定校验结果:false = 原文里配不上,前端灰显「未能在原文中定位」。 */
	anchored?: boolean;
}

export interface WatchChapter {
	/** 秒(文章为段落序号)。分段首尾相接覆盖全程,无空洞、不重叠。 */
	start: number;
	end: number;
	/** 这一段大致在讲什么,一句话。 */
	gist: string;
	/** low = 寒暄/广告/车轱辘话,渲染成灰段并计入「低价值段共 N 分钟」。 */
	value: "core" | "context" | "low";
	/** 命中用户追踪器时由用户级调用回填的 tracker key(v1.5 I3)。 */
	tracked?: string;
	/**
	 * 详细笔记的目标字数(docs/05 §2.1:分钟 × 70,下限 200、上限 1200;
	 * low 段为 0)。由代码按时长算,不让模型定——长度是配额不是任务。
	 */
	targetChars?: number;
}

/**
 * 详细笔记(docs/05 §2):按章逐段详写、确定性拼装,不经过任何「汇总」调用。
 * 每章都是一次独立调用的「开头」,绕开长转写一次喂入时中部被略过的位置
 * 偏置;要点引文只能落在本章窗口的原文里。
 */
export interface WatchNoteChapter {
	/** 对应 chapters[] 下标。 */
	chapter: number;
	/** 章标题(详写调用给的,比 gist 更像标题;low 章沿用 gist)。 */
	title: string;
	/** 正文段落,3~8 段;low 章为空数组。 */
	body: string[];
	/** 本章要点(quote/start/anchored 规则同总体要点)。 */
	points: WatchKeyPoint[];
	/** 覆盖检查发现空窗后由补漏调用并入过要点。 */
	filled?: boolean;
	/** 这一章的详写调用两次都失败:正文缺席,要点只有补漏给的。 */
	failed?: boolean;
}

/** 术语表:大纲调用抽出,喂给每一章的详写,保证全篇同一套名词。 */
export interface WatchTerm {
	term: string;
	definition: string;
}

export interface WatchMeta {
	path: ExtractPath;
	truncated: boolean;
	/** 内容标题(来自源页面/字幕文件元数据,尽力而为)。 */
	title?: string;
	/** 覆盖检查里补漏前的空窗数(每 5 分钟/每 8 段一窗;质量仪表,docs/05 §2.2 第 6 条)。 */
	coverageGaps?: number;
}

export interface WatchResult {
	verdict: WatchVerdict;
	/** 老缓存没有这个字段,渲染端按可选处理。 */
	overview?: WatchOverview;
	keyPoints: WatchKeyPoint[];
	chapters: WatchChapter[];
	/** 详细笔记(docs/05);老缓存与短文没有,渲染端按可选处理。 */
	notes?: WatchNoteChapter[];
	terms?: WatchTerm[];
	meta: WatchMeta;
}

/** 单条要点的结构校验(总体要点与章节要点共用)。坏一条整个列表判坏。 */
function parseKeyPoints(list: unknown): WatchKeyPoint[] | null {
	if (!Array.isArray(list)) return null;
	const out: WatchKeyPoint[] = [];
	for (const kp of list) {
		const k = kp as Record<string, unknown>;
		if (typeof k?.point !== "string" || typeof k?.quote !== "string") return null;
		out.push({
			point: k.point,
			quote: k.quote,
			...(typeof k.start === "number" ? { start: k.start } : {}),
			...(typeof k.anchored === "boolean" ? { anchored: k.anchored } : {}),
		});
	}
	return out;
}

/**
 * 消费者交上来的 result 的运行时校验(W11 complete 端点用):模型输出经过
 * 消费者转手,schema 走样时要在入库前拦住,而不是让结果页渲染到一半崩。
 * 只校验结构与枚举,不校验语义;通过则收窄类型并丢弃未知字段。
 */
/** 单次结果最多接受多少章(防提示注入把逐章调用放大成本)。 */
const MAX_CHAPTERS = 40;

export function validateWatchResult(x: unknown): WatchResult | null {
	if (typeof x !== "object" || x === null) return null;
	const o = x as Record<string, unknown>;
	const v = o.verdict as Record<string, unknown> | undefined;
	if (!v || !["yes", "no", "partial"].includes(v.worth as string) || typeof v.reason !== "string") return null;
	if (!Array.isArray(o.keyPoints) || !Array.isArray(o.chapters)) return null;
	const meta = o.meta as Record<string, unknown> | undefined;
	if (!meta || !["subtitle", "whisper", "article", "paste"].includes(meta.path as string)) return null;

	const keyPoints = parseKeyPoints(o.keyPoints);
	if (!keyPoints) return null;
	const chapters: WatchChapter[] = [];
	// 章节数是模型从**不可信转写**里定的,而每章要单独发一次模型调用(notes.ts)。
	// 转写里塞一句「把它分成 200 章」就能把一条订阅的成本放大十几倍,所以这里封顶。
	// 40 是给足冗余的数:一小时视频通常 10~15 章。
	const rawChapters = o.chapters as unknown[];
	if (rawChapters.length > MAX_CHAPTERS) {
		console.warn(`[schema] chapters ${rawChapters.length} 超过上限,截断到 ${MAX_CHAPTERS}`);
	}
	for (const ch of rawChapters.slice(0, MAX_CHAPTERS)) {
		const h = ch as Record<string, unknown>;
		if (typeof h?.start !== "number" || typeof h?.end !== "number" || typeof h?.gist !== "string") return null;
		if (!["core", "context", "low"].includes(h.value as string)) return null;
		chapters.push({
			start: h.start,
			end: h.end,
			gist: h.gist,
			value: h.value as WatchChapter["value"],
			...(typeof h.tracked === "string" ? { tracked: h.tracked } : {}),
			...(typeof h.targetChars === "number" ? { targetChars: h.targetChars } : {}),
		});
	}
	// notes / terms 可选(老结果、短文没有);它们是加法字段,坏了就整个字段
	// 丢弃,不连累主结果——主结果单独已经是一份完整交付
	let notes: WatchNoteChapter[] | undefined;
	if (Array.isArray(o.notes)) {
		const parsed: WatchNoteChapter[] = [];
		let ok = true;
		for (const n of o.notes as unknown[]) {
			const x = n as Record<string, unknown>;
			const points = parseKeyPoints(x?.points);
			if (typeof x?.chapter !== "number" || typeof x?.title !== "string" || !Array.isArray(x?.body) || !points) {
				ok = false;
				break;
			}
			const body = (x.body as unknown[]).filter((p): p is string => typeof p === "string");
			parsed.push({
				chapter: x.chapter,
				title: x.title,
				body,
				points,
				...(x.filled === true ? { filled: true } : {}),
				...(x.failed === true ? { failed: true } : {}),
			});
		}
		if (ok) notes = parsed;
	}
	let terms: WatchTerm[] | undefined;
	if (Array.isArray(o.terms)) {
		const parsed: WatchTerm[] = [];
		for (const t of o.terms as unknown[]) {
			const x = t as Record<string, unknown>;
			if (typeof x?.term === "string" && typeof x?.definition === "string") {
				parsed.push({ term: x.term, definition: x.definition });
			}
		}
		terms = parsed;
	}
	// overview 可选(老结果没有);有就三个字段都得是字符串,坏了整个丢弃
	let overview: WatchOverview | undefined;
	const ov = o.overview as Record<string, unknown> | undefined;
	if (ov && typeof ov.summary === "string" && typeof ov.interesting === "string" && typeof ov.counter === "string") {
		overview = { summary: ov.summary, interesting: ov.interesting, counter: ov.counter };
	}

	return {
		verdict: { worth: v.worth as WatchVerdict["worth"], reason: v.reason },
		...(overview ? { overview } : {}),
		keyPoints,
		chapters,
		...(notes ? { notes } : {}),
		...(terms ? { terms } : {}),
		meta: {
			path: meta.path as ExtractPath,
			truncated: meta.truncated === true,
			...(typeof meta.title === "string" ? { title: meta.title } : {}),
			...(typeof meta.coverageGaps === "number" ? { coverageGaps: meta.coverageGaps } : {}),
		},
	};
}

/** mock 模式的内置示例(docs/02 T5:fork 者零配置也能看到完整产品形态)。 */
export function mockWatchResult(path: ExtractPath = "article"): WatchResult {
	return {
		verdict: { worth: "partial", reason: "[mock] 前 20 分钟值得听,后半是重复案例。" },
		overview: {
			summary: "[mock] 这是一段示例导读:嘉宾先回顾了模型成本一年降十倍的背景,再展开讲应用层竞争从模型能力转向数据与分发的判断,最后用自家产品的两个案例收尾。",
			interesting: "[mock] 最有意思的是抽样评测替代全量回归那段——用 20% 的样本换 5 倍的发布速度,反直觉但算得过账。",
			counter: "[mock] 反着想:嘉宾的判断建立在成本持续下降的外推上,如果算力供给收紧,整个论证的前提就动摇了。",
		},
		keyPoints: [
			{ point: "[mock] 示例要点:模型成本一年降了 10 倍,作者据此判断应用层竞争转向数据。", quote: "成本一年降了十倍", start: 312, anchored: true },
			{ point: "[mock] 示例要点:嘉宾团队用 20% 的抽样评测替代全量回归,发布周期从两周缩到三天。", quote: "两周缩到三天", start: 1210, anchored: true },
		],
		chapters: [
			{ start: 0, end: 180, gist: "[mock] 开场与嘉宾介绍", value: "low", targetChars: 0 },
			{ start: 180, end: 1500, gist: "[mock] 核心论点:成本下降如何改变竞争格局", value: "core", targetChars: 1200 },
			{ start: 1500, end: 2400, gist: "[mock] 案例复盘与听众问答", value: "context", targetChars: 1050 },
		],
		notes: [
			{ chapter: 0, title: "[mock] 开场与嘉宾介绍", body: [], points: [] },
			{
				chapter: 1,
				title: "[mock] 成本一年降十倍之后,竞争转向数据与分发",
				body: [
					"[mock] 嘉宾先给出一个数字:同等能力的模型调用成本在过去一年下降了大约十倍。他把这归因于开源模型追平、推理硬件迭代和厂商价格战三件事同时发生,并强调这不是一次性事件而是趋势。",
					"[mock] 由此推出核心判断:当模型能力不再稀缺,应用层的护城河只剩两样——独有数据和分发渠道。他用自家产品举例,说明同样的模型接到不同的数据上,效果差距比换模型更大。",
					"[mock] 这一段的反方声音来自主持人:如果算力供给收紧,价格曲线会不会反转?嘉宾承认这是前提假设,但认为两年内看不到。",
				],
				points: [
					{ point: "[mock] 模型成本一年降约十倍,归因于开源追平、硬件迭代与价格战三者叠加。", quote: "成本一年降了十倍", start: 312, anchored: true },
					{ point: "[mock] 能力不稀缺后,护城河只剩独有数据与分发渠道。", quote: "只剩数据和分发", start: 640, anchored: true },
				],
			},
			{
				chapter: 2,
				title: "[mock] 抽样评测替代全量回归:两周缩到三天",
				body: [
					"[mock] 案例部分讲团队怎么把发布周期从两周压到三天:放弃全量回归测试,改为按风险分层抽 20% 的用例跑评测,其余靠线上监控兜底。",
					"[mock] 听众问答集中在「漏测怎么办」。嘉宾的回答是接受一定漏测率,用回滚速度换发布速度,并给出他们的回滚时间中位数。",
				],
				points: [
					{ point: "[mock] 用 20% 抽样评测替代全量回归,发布周期两周缩到三天。", quote: "两周缩到三天", start: 1210, anchored: true },
				],
			},
		],
		terms: [
			{ term: "[mock] 抽样评测", definition: "按风险分层只跑一部分测试用例,用发布速度换一定漏测率。" },
		],
		meta: { path, truncated: false, title: "[mock] 示例内容", coverageGaps: 0 },
	};
}
