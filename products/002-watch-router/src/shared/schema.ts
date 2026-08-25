// 输出契约(docs/02 T4):判决 + 总体要点 + 分段地图。内容级属性全站按
// 内容缓存;tracked 高亮是用户级属性,由第二次小调用回填进用户副本。
// W5 在这里补 prompt 组装与运行时校验;W6 的锚定校验消费 keyPoints[].quote。

/** 提取路径徽章:转写路径的时间戳精度和文字准确度都低一档,用户有权知道。 */
export type ExtractPath = "subtitle" | "whisper" | "article" | "paste";

export interface WatchVerdict {
	worth: "yes" | "no" | "partial";
	reason: string;
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
}

export interface WatchMeta {
	path: ExtractPath;
	truncated: boolean;
	/** 内容标题(来自源页面/字幕文件元数据,尽力而为)。 */
	title?: string;
}

export interface WatchResult {
	verdict: WatchVerdict;
	keyPoints: WatchKeyPoint[];
	chapters: WatchChapter[];
	meta: WatchMeta;
}

/**
 * 消费者交上来的 result 的运行时校验(W11 complete 端点用):模型输出经过
 * 消费者转手,schema 走样时要在入库前拦住,而不是让结果页渲染到一半崩。
 * 只校验结构与枚举,不校验语义;通过则收窄类型并丢弃未知字段。
 */
export function validateWatchResult(x: unknown): WatchResult | null {
	if (typeof x !== "object" || x === null) return null;
	const o = x as Record<string, unknown>;
	const v = o.verdict as Record<string, unknown> | undefined;
	if (!v || !["yes", "no", "partial"].includes(v.worth as string) || typeof v.reason !== "string") return null;
	if (!Array.isArray(o.keyPoints) || !Array.isArray(o.chapters)) return null;
	const meta = o.meta as Record<string, unknown> | undefined;
	if (!meta || !["subtitle", "whisper", "article", "paste"].includes(meta.path as string)) return null;

	const keyPoints: WatchKeyPoint[] = [];
	for (const kp of o.keyPoints as unknown[]) {
		const k = kp as Record<string, unknown>;
		if (typeof k?.point !== "string" || typeof k?.quote !== "string") return null;
		keyPoints.push({
			point: k.point,
			quote: k.quote,
			...(typeof k.start === "number" ? { start: k.start } : {}),
			...(typeof k.anchored === "boolean" ? { anchored: k.anchored } : {}),
		});
	}
	const chapters: WatchChapter[] = [];
	for (const ch of o.chapters as unknown[]) {
		const h = ch as Record<string, unknown>;
		if (typeof h?.start !== "number" || typeof h?.end !== "number" || typeof h?.gist !== "string") return null;
		if (!["core", "context", "low"].includes(h.value as string)) return null;
		chapters.push({
			start: h.start,
			end: h.end,
			gist: h.gist,
			value: h.value as WatchChapter["value"],
			...(typeof h.tracked === "string" ? { tracked: h.tracked } : {}),
		});
	}
	return {
		verdict: { worth: v.worth as WatchVerdict["worth"], reason: v.reason },
		keyPoints,
		chapters,
		meta: {
			path: meta.path as ExtractPath,
			truncated: meta.truncated === true,
			...(typeof meta.title === "string" ? { title: meta.title } : {}),
		},
	};
}

/** mock 模式的内置示例(docs/02 T5:fork 者零配置也能看到完整产品形态)。 */
export function mockWatchResult(path: ExtractPath = "article"): WatchResult {
	return {
		verdict: { worth: "partial", reason: "[mock] 前 20 分钟值得听,后半是重复案例。" },
		keyPoints: [
			{ point: "[mock] 示例要点:模型成本一年降了 10 倍,作者据此判断应用层竞争转向数据。", quote: "成本一年降了十倍", start: 312, anchored: true },
			{ point: "[mock] 示例要点:嘉宾团队用 20% 的抽样评测替代全量回归,发布周期从两周缩到三天。", quote: "两周缩到三天", start: 1210, anchored: true },
		],
		chapters: [
			{ start: 0, end: 180, gist: "[mock] 开场与嘉宾介绍", value: "low" },
			{ start: 180, end: 1500, gist: "[mock] 核心论点:成本下降如何改变竞争格局", value: "core" },
			{ start: 1500, end: 2400, gist: "[mock] 案例复盘与听众问答", value: "context" },
		],
		meta: { path, truncated: false, title: "[mock] 示例内容" },
	};
}
