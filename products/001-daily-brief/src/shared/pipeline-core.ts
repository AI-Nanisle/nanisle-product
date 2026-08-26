/**
 * Generation core, shared between the worker (POST /api/generate — the
 * one-click / scheduled path) and the CLI (pipeline/generate.ts). Everything
 * here runs in both runtimes: global fetch, no Node APIs.
 *
 * Anti-fabrication by construction: the model only ever returns candidate
 * ids plus text derived from fetched excerpts. Every URL in the brief comes
 * from a feed or the HN API — none are model-generated.
 */

import { XMLParser } from "fast-xml-parser";
import type { Brief, BriefItem, BriefLink, BriefSection, DroppedItem } from "./types";
import { normalizeThreadKey } from "./threads.ts";
import { countAiTells, normalizeCnStyle } from "./style.ts";

export const USER_AGENT =
	"nanisle-001-daily-brief/0.1 (+https://github.com/AI-Nanisle/nanisle-product)";

// ---------- config types ----------

export type SourceCategory = "news" | "macro" | "blog" | "podcast" | "paper";
export const SOURCE_CATEGORIES: SourceCategory[] = ["news", "macro", "blog", "podcast", "paper"];

/**
 * H1 · 一个源的抓取健康。用户永远不会来报告「我的 feed 挂了」——他只会觉得
 * 简报变差,然后不来了。所以坏掉必须是产品自己看得见、说得出的状态。
 */
export interface SourceHealth {
	/** 最近一次抓通的时间(ISO)。从没抓通过就没有这个字段。 */
	lastOkAt?: string;
	/** 连续失败次数;抓通一次即清零。到 UNHEALTHY_FAILURES 就在来源库标红。 */
	consecutiveFailures: number;
	/** 最近一次失败原因,原样留着给自愈和用户看。 */
	lastError?: string;
}

/** 连续失败到几次算「坏了」——一次超时是常态,三次是模式。 */
export const UNHEALTHY_FAILURES = 3;

export interface SourceConfig {
	/** Stable id (hash of the feed URL when created via the UI). */
	key: string;
	name: string;
	url: string;
	category: SourceCategory;
	/** Default true; the UI toggle sets false to pause a source without losing it. */
	enabled?: boolean;
	lang?: string;
	max_items?: number;
	/** H1 · 抓取健康,由每次生成回写。 */
	health?: SourceHealth;
}

export function isUnhealthy(s: SourceConfig): boolean {
	return (s.health?.consecutiveFailures ?? 0) >= UNHEALTHY_FAILURES;
}

export interface Filters {
	max_age_hours: number;
	max_items_per_feed: number;
	noise_keywords: string[];
	/**
	 * 按类目放宽的新鲜度窗口(小时)。周更的博客/播客在 30 小时窗口里几乎永远
	 * 是零贡献——一篇三天前的深度长文该和当天新闻同台竞争。没列的类目用
	 * max_age_hours。放宽的重复风险由「近期已入选」过滤挡(dropSeenCandidates)。
	 */
	category_max_age_hours?: Partial<Record<SourceCategory, number>>;
}

/** Legacy shape (v1 关注点). Kept only so stored configs migrate cleanly. */
export interface FocusEntry {
	name: string;
	detail?: string;
}

export interface TrackerSourceRule {
	/** Source this local rule belongs to. */
	sourceKey: string;
	/** Positive criteria that apply only inside this source. */
	include?: string[];
	/** Hard exclusions that apply only inside this source. */
	exclude?: string[];
}

/**
 * One clause of 「编辑的理解」. The user corrects a clause at a time — that is
 * the whole point of showing the understanding instead of hiding it in a
 * prompt — so each clause carries its own "the user rewrote this" mark.
 */
export interface IntentSegment {
	text: string;
	/** True once the user rewrote this clause; the dossier renders it in accent. */
	edited?: boolean;
}

/** A line of a tracker's 变更记录 — newest first, capped by cleanTrackers. */
export interface TrackerLogEntry {
	/** ISO timestamp; the dossier renders MM-DD. */
	at: string;
	text: string;
}

/**
 * V1 · 「编辑的理解」的一份历史快照。变更记录只留一句话日志,重写后旧理解的
 * 全文就没了——用户想「回到上一版」时无从回起(siyang 反馈 #2)。每次整体
 * 重写(向导继续对话、答用途、「对编辑说一句」改 intent、回滚本身)前,把
 * 当前的 segments 原样存一份,新在前,capped MAX_INTENT_VERSIONS。
 */
export interface IntentVersion {
	/** ISO timestamp of when this version was *replaced*(即快照时刻). */
	at: string;
	/** 一句话:这版是在什么动作之前存下的。 */
	note?: string;
	segments: IntentSegment[];
}

/**
 * A tracker is one long-term question the brief keeps watching — the unit the
 * whole product revolves around (万物追踪-style). The definition fields below
 * are the *visible, correctable* version of "what the editor thinks you
 * want": the user edits the criteria, not the results.
 */
export interface Tracker {
	/** Stable id — sections, feedback and quotas key on it. */
	key: string;
	/** Short display name; becomes the section title in the brief. */
	name: string;
	/** The long-term question in the user's own words. */
	question?: string;
	/**
	 * R7 · 读者拿这份追踪干什么(向导步骤 1 追问出来的)。问法是口语的「你现在
	 * 主要在忙这块的什么」,存的却是选材最需要的那一维:**什么变化会改变他的
	 * 动作**。它必须同时进「找源」和「选材」两处提示词——只显示不进提示词,
	 * 它就只是个装饰字段。空 = 读者选了「就是想跟上」,合法,不追问也不减分。
	 */
	purpose?: string;
	/**
	 * R8 · 模型按这份追踪的话题生成的追问选项(不含退出口,那个服务端追加)。
	 * 只在向导期间有用;答完追问就删掉,不留在生效的定义里。
	 */
	purposeOptions?: string[];
	/** When that question was last written down (ISO) — dated in the dossier. */
	askedAt?: string;
	/** One-line restatement of the intent (AI-drafted later; hand-edited now). */
	intent?: string;
	/**
	 * `intent` split into separately correctable clauses. `intent` stays the
	 * joined string, so the editorial prompt and the chat agent never need to
	 * know this field exists.
	 */
	intentSegments?: IntentSegment[];
	/** Newest-first audit trail of definition edits — the dossier's 变更记录. */
	changelog?: TrackerLogEntry[];
	/** V1 · 理解被整体重写前的历史快照(新在前),档案/向导里可查看、可回滚。 */
	intentVersions?: IntentVersion[];
	/**
	 * V2 · 向导里用户说过的话(第一句 = 原话,含后续所有补充),服务端持久化。
	 * 以前只存在前端内存里:刷新后再「继续对话」,编辑只看得到第一句,之前
	 * 聊过的几轮全忘了(siyang 反馈 #2 的另一半)。只在向导期间有意义,
	 * 草稿生效(stage 删除)时由 cleanTrackers 一并丢弃。
	 */
	wizardMessages?: string[];
	/** Legacy/global positive criteria. New UI prefers per-source rules. */
	include?: string[];
	/** Legacy/global negative criteria. New UI prefers per-source rules. */
	exclude?: string[];
	/** Whether this tracker watches the whole pool or only reviewed sources. */
	sourceMode?: "all" | "selected";
	/** Reviewed sources when sourceMode=selected. */
	sourceKeys?: string[];
	/** Source-scoped refinements: the same topic may be useful in one source and noise in another. */
	sourceRules?: TrackerSourceRule[];
	/** Verified candidates the user explicitly rejected for this tracker. */
	rejectedSourceUrls?: string[];
	/** Max items per issue for this tracker (1–3). */
	quota: number;
	/** Default true; false pauses the tracker without losing its definition. */
	enabled?: boolean;
	/**
	 * 向导草稿标记:有 stage 的追踪器还在三步向导里(刷新/换设备可续),
	 * 不参与生成;「完成」时删掉该字段,追踪器才生效(docs/02 §7.1)。
	 */
	stage?: "understanding" | "tags" | "sources";
}

/**
 * R8 · 追问「你在忙什么」。问法固定(它与话题无关),**选项由模型按这份追踪
 * 的话题现生成**——写死的选项必然是照着某一类话题写的,换个题目就成了废话,
 * 还反过来告诉用户「这个产品只服务那类人」。
 *
 * 放在 shared 而不是 worker:前端在草稿还没答过时也要能渲染它——追问的显示
 * 条件必须是「草稿有没有 purpose」这个事实,不能是一次响应里的瞬时状态,
 * 否则刷新一次追问就永远消失了(线上踩过)。
 */
export const PURPOSE_QUESTION = "你现在主要在忙这块的什么?——这决定了我该给你挑哪一类";

/**
 * 退出口:**服务端追加,不交给模型**。模型哪次忘了生成它,用户就只能从三个
 * 不贴自己的选项里硬挑一个、或者干脆跳过——护栏不能依赖模型的自觉。
 */
export const PURPOSE_OPT_OUT = "就是想跟上,不为具体的事";

/** 模型给不出合格选项时的兜底(通用到任何话题都不算离谱)。 */
export const PURPOSE_OPTIONS_FALLBACK = ["要据此做决定", "要动手做点什么", "只是想搞明白"];

/** 每份追踪的追问选项:模型生成的 3 个 + 永远在的退出口。 */
export function purposeOptions(generated?: string[]): string[] {
	const base = generated?.length ? generated.slice(0, 3) : PURPOSE_OPTIONS_FALLBACK;
	return [...base.filter((o) => o !== PURPOSE_OPT_OUT), PURPOSE_OPT_OUT];
}

/** 每期条数的三个档位——配置页下拉给的就是这三个,不是连续值。 */
export const QUOTA_OPTIONS = [3, 5, 7] as const;

/**
 * 把任意历史值收敛到档位上:缺省/非法给最小档,其余就近归位(平手取小)。
 * 旧配置里的 1/2 条会变成 3——这是有意的放宽,不是数据损坏。
 */
export function normalizeQuota(raw?: number): number {
	if (typeof raw !== "number" || !Number.isFinite(raw)) return QUOTA_OPTIONS[0];
	let best: number = QUOTA_OPTIONS[0];
	for (const opt of QUOTA_OPTIONS) if (Math.abs(opt - raw) < Math.abs(best - raw)) best = opt;
	return best;
}
/** The whole issue stays bounded no matter how many trackers exist. */
export const TOTAL_ITEM_CAP = 10;
/**
 * X1 · 破茧的第一道约束:一期里同一个来源最多几条。和抓取层的
 * `max_items_per_feed` 不是一回事——那个管「从这个 feed 取几条进候选池」,
 * 这个管「最后见报几条」。提示词里说了一遍,`assembleBrief` 里再强制一遍:
 * 能用代码挡住的不变量,不靠叮嘱模型。
 */
export const MAX_ITEMS_PER_SOURCE = 3;
/** 变更记录 is a recent-history strip, not an archive. */
export const MAX_CHANGELOG = 20;
/** How many clauses the editor's understanding may hold. */
export const MAX_INTENT_SEGMENTS = 8;
/** V1 · 理解的历史快照留几份——回滚是近期后悔药,不是无限档案。 */
export const MAX_INTENT_VERSIONS = 10;

/**
 * Clauses of the editor's understanding. Falls back to splitting a legacy
 * one-line `intent` (also what happens after the chat agent rewrites it),
 * so the dossier always has something to underline.
 */
export function trackerSegments(t: Tracker): IntentSegment[] {
	if (t.intentSegments?.length) return t.intentSegments;
	return (t.intent ?? "")
		.split(/[;；]+/)
		.map((s) => s.replace(/[。.]+$/, "").trim())
		.filter(Boolean)
		.slice(0, MAX_INTENT_SEGMENTS)
		.map((text) => ({ text }));
}

/**
 * V1 · 重写理解前把当前版本压进历史,返回新的 intentVersions(不改原对象)。
 * 服务端(向导重写)和客户端(refine 落库、回滚)共用同一套规则:
 * 当前理解为空不记(没东西可回);与最近一份快照逐字相同也不记(防止
 * 反复重写把 10 个名额刷成同一版)。
 */
export function pushIntentVersion(t: Tracker, note: string, at = new Date().toISOString()): IntentVersion[] {
	const current = trackerSegments(t);
	const prev = t.intentVersions ?? [];
	if (current.length === 0) return prev;
	const latest = prev[0];
	if (latest && JSON.stringify(latest.segments) === JSON.stringify(current)) return prev;
	return [{ at, note, segments: current }, ...prev].slice(0, MAX_INTENT_VERSIONS);
}

/** The single-line form the editorial prompt consumes. */
export function joinSegments(segments: IntentSegment[]): string {
	return segments
		.map((s) => s.text.trim())
		.filter(Boolean)
		.join(";");
}

export function focusEntryToTracker(f: FocusEntry): Tracker {
	return { key: fnv1a(`focus:${f.name}`), name: f.name, question: f.detail ?? "", quota: 3 };
}

export interface Candidate {
	id: string;
	sourceKey: string;
	source: string;
	category: SourceCategory;
	title: string;
	url: string;
	publishedAt: string;
	excerpt: string;
	/**
	 * 真实出版方(Google News 检索源的 `<source>` 标签)。sourceKey/source 仍是
	 * 用户配置的那个源——配额、健康、指标都记在它头上;publisher 只管展示,
	 * 读者该看到「SiliconANGLE」而不是检索管道的名字。
	 */
	publisher?: string;
}

// ---------- small utils ----------

export function fnv1a(input: string): string {
	let hash = 0x811c9dc5;
	for (let i = 0; i < input.length; i++) {
		hash ^= input.charCodeAt(i);
		hash = Math.imul(hash, 0x01000193);
	}
	return (hash >>> 0).toString(16).padStart(8, "0");
}

export function stripHtml(html: string): string {
	return html
		.replace(/<script[\s\S]*?<\/script>/gi, " ")
		.replace(/<style[\s\S]*?<\/style>/gi, " ")
		.replace(/<[^>]+>/g, " ")
		.replace(/&nbsp;/g, " ")
		.replace(/&lt;/g, "<")
		.replace(/&gt;/g, ">")
		.replace(/&quot;/g, '"')
		.replace(/&#39;|&apos;/g, "'")
		.replace(/&#x([0-9a-f]+);/gi, (_, h: string) => String.fromCodePoint(Number.parseInt(h, 16)))
		.replace(/&#(\d+);/g, (_, d: string) => String.fromCodePoint(Number(d)))
		.replace(/&amp;/g, "&")
		.replace(/\s+/g, " ")
		.trim();
}

export function briefDate(tz: string): string {
	// sv-SE locale formats as YYYY-MM-DD.
	return new Intl.DateTimeFormat("sv-SE", { timeZone: tz }).format(new Date());
}

function asArray<T>(v: T | T[] | undefined): T[] {
	if (v === undefined || v === null) return [];
	return Array.isArray(v) ? v : [v];
}

function text(v: unknown): string {
	if (typeof v === "string") return v;
	if (typeof v === "number") return String(v);
	if (v && typeof v === "object" && "#text" in (v as Record<string, unknown>)) {
		return text((v as Record<string, unknown>)["#text"]);
	}
	return "";
}

// ---------- feed fetch & parse ----------

export interface RawEntry {
	title: string;
	url: string;
	publishedAt: Date | null;
	excerpt: string;
	/** RSS `<source>`(Google News 检索源会带真实出版方名),没有则缺省。 */
	sourceName?: string;
}

export interface ParsedFeed {
	/** Feed 自报的标题(rss channel title / atom feed title);解析不到为空串。 */
	title: string;
	entries: RawEntry[];
}

export function parseFeedMeta(xml: string): ParsedFeed {
	const parser = new XMLParser({ ignoreAttributes: false, attributeNamePrefix: "@_" });
	const doc = parser.parse(xml) as Record<string, any>;
	const title = stripHtml(text(doc?.rss?.channel?.title) || text(doc?.feed?.title)).slice(0, 100);
	const entries: RawEntry[] = [];

	const rssItems = asArray(doc?.rss?.channel?.item);
	for (const item of rssItems) {
		const dateStr = text(item.pubDate) || text(item["dc:date"]) || "";
		const body = text(item["content:encoded"]) || text(item.description) || "";
		const sourceName = stripHtml(text(item.source)).slice(0, 60);
		entries.push({
			title: stripHtml(text(item.title)),
			url: text(item.link).trim() || text(item.guid).trim(),
			publishedAt: dateStr ? new Date(dateStr) : null,
			excerpt: stripHtml(body),
			...(sourceName ? { sourceName } : {}),
		});
	}

	const atomEntries = asArray(doc?.feed?.entry);
	for (const entry of atomEntries) {
		const links = asArray(entry.link);
		const alt =
			links.find((l: any) => l?.["@_rel"] === "alternate" || l?.["@_rel"] === undefined) ??
			links[0];
		const dateStr = text(entry.published) || text(entry.updated) || "";
		const body = text(entry.content) || text(entry.summary) || "";
		entries.push({
			title: stripHtml(text(entry.title)),
			url: typeof alt === "object" ? (alt?.["@_href"] ?? "") : text(alt),
			publishedAt: dateStr ? new Date(dateStr) : null,
			excerpt: stripHtml(body),
		});
	}

	return { title, entries: entries.filter((e) => e.title && e.url) };
}

export function parseFeed(xml: string): RawEntry[] {
	return parseFeedMeta(xml).entries;
}

/**
 * 查询源:按关键词/分类构造的检索型 feed(docs/02 §7.3 第 1 层)。边界:GitHub
 * releases、YouTube 频道这类构造出来的「具体实体 feed」不算——仪表要区分的是
 * 检索侦察兵 vs 确定的源,供观察式发现(第 4 层)判断何时把前者升级成后者。
 */
export function isQueryFeedUrl(url: string): boolean {
	let u: URL;
	try {
		u = new URL(url);
	} catch {
		return false;
	}
	const host = u.hostname.toLowerCase();
	if (host === "news.google.com" && u.pathname.startsWith("/rss/search")) return true;
	if ((host === "hnrss.org" || host.endsWith(".hnrss.org")) && u.searchParams.has("q")) return true;
	if ((host === "reddit.com" || host.endsWith(".reddit.com")) && u.pathname.endsWith(".rss")) return true;
	if (host === "rss.arxiv.org") return true;
	return false;
}

/**
 * Google News 检索源给的是 news.google.com/rss/articles/CBMi… 跳转链,不解开的
 * 代价是三连:成稿抓不到正文、同一事件和直连源撞不上去重、点击归因落在中转页。
 * 旧式链接(CBMi 前缀)的 path 段就是 base64url 包着的原文 URL,纯解码即可;
 * 新式(AU_yqL 前缀)要打 Google 内部接口才解得开,不值得——解不开返回 null,
 * 调用方保留原链,其余机制照常降级。
 */
export function decodeGoogleNewsUrl(url: string): string | null {
	let u: URL;
	try {
		u = new URL(url);
	} catch {
		return null;
	}
	if (u.hostname !== "news.google.com") return null;
	const seg = /\/(?:rss\/)?articles\/([^/?#]+)/.exec(u.pathname)?.[1];
	if (!seg?.startsWith("CBMi")) return null;
	try {
		const b64 = seg.replace(/-/g, "+").replace(/_/g, "/");
		// atob 在 Workers 和 Node 16+ 都是全局的,这里不引 node:buffer 保持运行时无关
		const bytes = atob(b64);
		// 解出的字节流是 length-prefixed protobuf,直接按可打印 URL 捞,取最长的
		// 非 google 域名链接(流里有时还嵌着 AMP 变体)。
		const matches = bytes.match(/https?:\/\/[\x21-\x7e]+/g) ?? [];
		const candidates = matches
			.map((m) => m.replace(/[\x00-\x20"'<>\\]+$/g, ""))
			.filter((m) => {
				try {
					return !new URL(m).hostname.endsWith("google.com");
				} catch {
					return false;
				}
			})
			.sort((a, b) => b.length - a.length);
		return candidates[0] ?? null;
	} catch {
		return null;
	}
}

/** Google News 的标题格式是「Title - Publisher」;知道出版方名就把尾巴剥掉。 */
export function stripPublisherSuffix(title: string, publisher?: string): string {
	if (!publisher) return title;
	const suffix = ` - ${publisher}`;
	return title.endsWith(suffix) ? title.slice(0, -suffix.length).trimEnd() : title;
}

export async function fetchFeed(url: string, timeoutMs = 20_000): Promise<RawEntry[]> {
	const res = await fetch(url, {
		headers: {
			"user-agent": USER_AGENT,
			accept: "application/rss+xml, application/atom+xml, application/xml, text/xml, */*",
		},
		signal: AbortSignal.timeout(timeoutMs),
		redirect: "follow",
	});
	if (!res.ok) throw new Error(`HTTP ${res.status}`);
	return parseFeed(await res.text());
}

export interface FetchResult {
	candidates: Candidate[];
	ruleDropped: DroppedItem[];
	scanned: number;
	sourcesOk: number;
	sourceErrors: { name: string; error: string }[];
	/** H1 · 按源 key 记的本轮抓取结果,回写健康状态用(按 key 而非 name:全量
	 * 生成里源是并集去重抓的,名字可能重复,key 才是身份)。 */
	sourceStatus: { key: string; ok: boolean; error?: string }[];
	/** H6 · 本轮因连续失败被跳过的源名(不抓、不计健康,见 fetchAllSources)。 */
	skippedUnhealthy?: string[];
}

/**
 * H1 · 把一轮抓取结果回写进源库。返回新数组(不原地改),调用方负责落库。
 * `statusByKey` 的 key 是**本次抓取用的** key——全量生成里那是并集 key,所以
 * 调用方要先换算回该用户自己的源 key。
 */
export function applyHealth(
	sources: SourceConfig[],
	statusByKey: Map<string, { ok: boolean; error?: string }>,
	now = new Date().toISOString(),
): SourceConfig[] {
	return sources.map((s) => {
		const st = statusByKey.get(s.key);
		if (!st) return s; // 停用的源没抓,健康状态保持原样
		const prev = s.health;
		const health: SourceHealth = st.ok
			? { lastOkAt: now, consecutiveFailures: 0 }
			: {
					...(prev?.lastOkAt ? { lastOkAt: prev.lastOkAt } : {}),
					consecutiveFailures: (prev?.consecutiveFailures ?? 0) + 1,
					...(st.error ? { lastError: st.error.slice(0, 300) } : {}),
				};
		return { ...s, health };
	});
}

export async function fetchAllSources(
	sources: SourceConfig[],
	filters: Filters,
	log: (msg: string) => void = () => {},
): Promise<FetchResult> {
	// H6 · 连续失败 ≥3 的源直接不抓(miniflux 的纪律):它九成还是挂的,每天
	// 白花一次抓取预算。跳过时不写 sourceStatus,健康计数原地不动;复活的路
	// 有两条——周自评对坏源真实试抓一轮(通了清零,见 lambda 的 weekly),
	// 或用户在来源库「让编辑修一下」换掉它。
	const active = sources.filter((s) => s.enabled !== false && !isUnhealthy(s));
	const skippedUnhealthy = sources.filter((s) => s.enabled !== false && isUnhealthy(s)).map((s) => s.name);
	if (skippedUnhealthy.length > 0) {
		log(`[fetch] ${skippedUnhealthy.length} 个源连续失败中,本轮跳过:${skippedUnhealthy.join("、")}`);
	}
	const now = Date.now();
	const noise = filters.noise_keywords.map((k) => k.toLowerCase());
	const candidates: Candidate[] = [];
	const ruleDropped: DroppedItem[] = [];
	const sourceErrors: { name: string; error: string }[] = [];
	const sourceStatus: { key: string; ok: boolean; error?: string }[] = [];
	let scanned = 0;
	let sourcesOk = 0;

	const results = await Promise.allSettled(
		active.map(async (source) => ({ source, entries: await fetchFeed(source.url) })),
	);
	for (const [i, result] of results.entries()) {
		if (result.status === "rejected") {
			log(`[fetch] FAILED ${active[i].name}: ${result.reason}`);
			sourceErrors.push({ name: active[i].name, error: String(result.reason) });
			sourceStatus.push({ key: active[i].key, ok: false, error: String(result.reason) });
			continue;
		}
		const { source, entries } = result.value;
		sourcesOk++;
		sourceStatus.push({ key: source.key, ok: true });

		// 类目窗口:news/macro 讲时效,blog/podcast/paper 讲密度——周更长文在
		// 30 小时窗里永远是零贡献,放宽到几天;重复入选由 dropSeenCandidates 挡
		const maxAgeMs = (filters.category_max_age_hours?.[source.category] ?? filters.max_age_hours) * 3600_000;
		const fresh = entries
			.filter((e) => e.publishedAt && now - e.publishedAt.getTime() <= maxAgeMs)
			.sort((a, b) => b.publishedAt!.getTime() - a.publishedAt!.getTime());
		// "scanned" counts today's window only — feeds carry old entries and
		// counting them would inflate the accountability numbers on the page.
		scanned += fresh.length;

		const cap = source.max_items ?? filters.max_items_per_feed;
		let kept = 0;
		for (const entry of fresh) {
			// Google News 跳转链解成原文 URL:id 因此按真实 URL 算,和直连源天然
			// 去重;成稿抓正文、点击归因、HN 讨论查询也都落在真实页面上。
			const url = decodeGoogleNewsUrl(entry.url) ?? entry.url;
			const title = stripPublisherSuffix(entry.title, entry.sourceName);
			const id = fnv1a(url);
			const lowerTitle = title.toLowerCase();
			const hit = noise.find((k) => lowerTitle.includes(k));
			if (hit) {
				ruleDropped.push({ id, title, url, source: source.name, reason: `规则过滤:命中「${hit}」` });
				continue;
			}
			if (kept >= cap) {
				ruleDropped.push({ id, title, url, source: source.name, reason: "规则过滤:超出单源条数上限" });
				continue;
			}
			kept++;
			candidates.push({
				id,
				sourceKey: source.key,
				source: source.name,
				category: source.category,
				title,
				url,
				publishedAt: entry.publishedAt!.toISOString(),
				// 存足量正文:选材阶段仍只送 800 字(见 buildEditorialPrompt),但成稿
				// 阶段要拿全文写实质与判断——在这里砍到 1200,后面再想深也无米下锅。
				excerpt: entry.excerpt.slice(0, ENRICH_TEXT_CAP),
				...(entry.sourceName ? { publisher: entry.sourceName } : {}),
			});
		}
		log(`[fetch] ${source.name}: ${entries.length} entries, ${fresh.length} fresh, ${kept} kept`);
	}

	const seen = new Set<string>();
	const deduped = candidates.filter((c) => (seen.has(c.id) ? false : (seen.add(c.id), true)));
	return {
		candidates: deduped,
		ruleDropped,
		scanned,
		sourcesOk,
		sourceErrors,
		sourceStatus,
		...(skippedUnhealthy.length > 0 ? { skippedUnhealthy } : {}),
	};
}

// ---------- 近期已入选过滤(类目窗口放宽后的防重复) ----------

/**
 * 「已推荐过」回看几天。要 ≥ 类目窗口的最大值(7 天):窗口放宽让一篇周更长文
 * 能连续几天当候选,一旦入选就必须在整个窗口期内挡住它,否则明天原样再来。
 */
export const SEEN_WINDOW_DAYS = 7;

/**
 * 往期简报里「读者已经看到过」的条目 id:正选、轴外位、同事件合并报道。
 * id 就是 fnv1a(url),合并报道只有链接也能重建出 id。
 */
export function seenItemIds(briefs: Brief[]): Set<string> {
	const seen = new Set<string>();
	for (const brief of briefs) {
		for (const section of brief.sections) {
			for (const item of section.items) {
				seen.add(item.id);
				for (const m of item.mergedFrom ?? []) seen.add(fnv1a(m.url));
			}
		}
		if (brief.offAxis) seen.add(brief.offAxis.id);
	}
	return seen;
}

/**
 * 把已推荐过的候选移进规则过滤区——昨天推荐过的内容今天绝不再上,这是硬规则,
 * 不进提示词碰运气。挪进 ruleDropped 而不是悄悄扔掉:问责区要能看到这个理由。
 */
export function dropSeenCandidates(fetched: FetchResult, seen: Set<string>): number {
	if (seen.size === 0) return 0;
	const kept: Candidate[] = [];
	let dropped = 0;
	for (const c of fetched.candidates) {
		if (seen.has(c.id)) {
			dropped++;
			fetched.ruleDropped.push({
				id: c.id,
				title: c.title,
				url: c.url,
				source: c.source,
				reason: "规则过滤:近期已入选过,不重复推荐",
			});
		} else {
			kept.push(c);
		}
	}
	fetched.candidates = kept;
	return dropped;
}

// ---------- 同事件归簇(选材前的语义去重) ----------
//
// 同一事件被多个源报道时,让它们各占一个候选位有两重浪费:编辑提示词按条数
// 花 token,选材时还可能「三个源转发同一条新闻占了三个坑」。提示词第 6 条
// 让模型自己合并,但那是碰运气;这里在模型看到候选之前先按标题相似度把机械
// 转载并成一簇,只送主报道进提示词,选中后再把同簇其余报道并回 merged。

/**
 * 标题相似度阈值(词元 Jaccard)。取保守值:漏合并的代价只是编辑多看一条
 * (提示词第 6 条还能兜),错合并会把两件事捏成一件、且用户无从发现。
 */
export const SAME_STORY_SIM = 0.5;

/** 标题 → 词元集合:ASCII 按词切,CJK 按二字组——中文标题没有空格可切。 */
export function titleTokens(title: string): Set<string> {
	const lower = title.toLowerCase();
	const tokens = new Set<string>();
	for (const m of lower.matchAll(/[a-z0-9][a-z0-9.+#-]*/g)) {
		if (m[0].length >= 2) tokens.add(m[0]);
	}
	const cjk = lower.match(/[一-鿿぀-ヿ]/g) ?? [];
	for (let i = 0; i < cjk.length - 1; i++) tokens.add(cjk[i] + cjk[i + 1]);
	return tokens;
}

function jaccard(a: Set<string>, b: Set<string>): number {
	if (a.size === 0 || b.size === 0) return 0;
	let inter = 0;
	for (const t of a) if (b.has(t)) inter++;
	return inter / (a.size + b.size - inter);
}

export interface StoryClusters {
	/** 每簇一条主报道(未归簇的候选原样在内),保持原候选顺序。 */
	primaries: Candidate[];
	/** 主报道 id → 同簇其余报道的 id(选中后并进 EditorialPick.merged)。 */
	mergedByPrimary: Map<string, string[]>;
}

/**
 * 贪心归簇:逐条和已有簇的主报道比标题相似度。主报道优先直连源(publisher
 * 字段只有检索源条目才带),同级取正文更长的——成稿阶段有米下锅。O(n·簇数),
 * 候选池按 30 源 × 10 条封顶,量级无虞。
 */
export function clusterSameStory(candidates: Candidate[]): StoryClusters {
	const clusters: { primary: Candidate; tokens: Set<string>; dups: Candidate[] }[] = [];
	for (const c of candidates) {
		const tokens = titleTokens(c.title);
		const hit = clusters.find((cl) => jaccard(cl.tokens, tokens) >= SAME_STORY_SIM);
		if (!hit) {
			clusters.push({ primary: c, tokens, dups: [] });
			continue;
		}
		const better =
			Number(!c.publisher) - Number(!hit.primary.publisher) || c.excerpt.length - hit.primary.excerpt.length;
		if (better > 0) {
			hit.dups.push(hit.primary);
			hit.primary = c;
			hit.tokens = tokens;
		} else {
			hit.dups.push(c);
		}
	}
	const primaryIds = new Set(clusters.map((cl) => cl.primary.id));
	const mergedByPrimary = new Map<string, string[]>();
	for (const cl of clusters) {
		if (cl.dups.length > 0) mergedByPrimary.set(cl.primary.id, cl.dups.map((d) => d.id));
	}
	return { primaries: candidates.filter((c) => primaryIds.has(c.id)), mergedByPrimary };
}

/**
 * 把预归簇的同事件报道并进编辑结果。这些 id 编辑没见过(没进提示词),
 * 这里补进 merged,assembleBrief 照常把它们渲染成「同事件其他报道」链,
 * seenItemIds 也照常把它们记进「已推荐过」。返回并入条数(日志用)。
 */
export function applySameStoryMerges(editorial: EditorialResult, mergedByPrimary: Map<string, string[]>): number {
	if (mergedByPrimary.size === 0) return 0;
	let n = 0;
	for (const picks of Object.values(editorial.sections)) {
		for (const pick of picks) {
			const dups = mergedByPrimary.get(pick.id);
			if (!dups?.length) continue;
			pick.merged = [...new Set([...(pick.merged ?? []), ...dups])];
			n += dups.length;
		}
	}
	return n;
}

// ---------- editorial ----------

export interface EditorialPick {
	id: string;
	whyClick: string;
	caveat?: string;
	relatesTo?: string;
	merged?: string[];
	related?: string[];
	/** T3 · 归到哪条线索:命中已有线索用它的 key,否则给一个新 key。 */
	threadKey?: string;
	/** T3 · 新线索的标题(只在 threadKey 是新的时才有意义)。 */
	threadTitle?: string;
}

export interface EditorialResult {
	/** Tracker key → picks, in tracker order. */
	sections: Record<string, EditorialPick[]>;
	/** X2 · 轴外位:不属于任何追踪器、但编辑认为读者该看见的一条。 */
	offAxis?: { id: string; whyClick: string; reason: string } | null;
	notableDrops: { id: string; reason: string }[];
	droppedSummary: string;
	/** E1 · 今日三句话(邮件推送正文)。模型可能漏给,parse 只做清洗不兜底。 */
	tldr?: string[];
}

/** X2 · 连续多少期没人点轴外位就自动停掉——用点击率判死刑,不靠主观判断。 */
export const OFF_AXIS_MISS_LIMIT = 10;

export function activeTrackers(trackers: Tracker[]): Tracker[] {
	// 向导草稿(带 stage)不参与生成:定义还没确认完,不该按半成品选材
	return trackers.filter((t) => t.enabled !== false && !t.stage);
}

/**
 * No-AI stand-in: match each tracker's definition with dumb keyword search so
 * the tracker → section shape is fully demoable before a real editor exists.
 * A candidate goes to the first tracker (list order) that claims it.
 */
export function mockEditorial(candidates: Candidate[], trackers: Tracker[]): EditorialResult {
	const used = new Set<string>();
	const sections: Record<string, EditorialPick[]> = {};
	for (const t of activeTrackers(trackers)) {
		const include = (t.include ?? []).map((k) => k.toLowerCase()).filter(Boolean);
		const exclude = (t.exclude ?? []).map((k) => k.toLowerCase()).filter(Boolean);
		const matches = candidates.filter((c) => {
			if (used.has(c.id)) return false;
			if (t.sourceMode === "selected" && !(t.sourceKeys ?? []).includes(c.sourceKey)) return false;
			const hay = `${c.title} ${c.excerpt}`.toLowerCase();
			const sourceRule = t.sourceRules?.find((rule) => rule.sourceKey === c.sourceKey);
			const localInclude = (sourceRule?.include ?? []).map((k) => k.toLowerCase()).filter(Boolean);
			const localExclude = (sourceRule?.exclude ?? []).map((k) => k.toLowerCase()).filter(Boolean);
			if ([...exclude, ...localExclude].some((k) => hay.includes(k))) return false;
			if (localInclude.length > 0) return localInclude.some((k) => hay.includes(k));
			if (include.length > 0) return include.some((k) => hay.includes(k));
			// Definition-less trackers fall back to category heuristics so the
			// built-ins still fill up out of the box.
			if (t.key === "headlines") return c.category === "news" || c.category === "macro";
			if (t.key === "learn") return c.category === "podcast" || c.category === "paper";
			return c.category === "blog";
		});
		sections[t.key] = matches.slice(0, normalizeQuota(t.quota)).map((c) => {
			used.add(c.id);
			return {
				id: c.id,
				whyClick: `[mock] ${c.excerpt.slice(0, 120) || c.title}…(设 AI_PROVIDER=anthropic 或 gateway 获得真实编辑)`,
				...(include.length > 0 ? { relatesTo: `[mock] 命中关键词` } : {}),
			};
		});
	}
	return {
		sections,
		notableDrops: [],
		droppedSummary: `[mock] 无 AI 模式:按追踪器定义做了关键词粗配,其余 ${candidates.length - used.size} 条候选未经编辑筛选。`,
	};
}

/**
 * 文风硬规则,选材和成稿两段共用。禁用清单参照 GB/T 15834(引号规范)与
 * stop-slop-zh / shuorenhua 两套开源去 AI 味规则集,收敛到最伤阅读的十几条——
 * 词表太长模型反而记不住。写进提示词是第一道,style.ts 的确定性规整是兜底。
 */
export const STYLE_RULES = `文风(硬性,违反即不合格):
- 基准语气:像同事在群里转发链接时顺口说的那句话。直接、具体、不端着,砍掉一切套话。
- 禁用破折号(——、—)和感叹号。要停顿用逗号,要解释另起一句。
- 引号只在直接引用原文措辞时用,用中文弯引号“”。普通名词、概念、产品名一律不加引号。
- 禁用词:凸显、赋能、闭环、或将、迎来、重磅、里程碑、革命性、值得关注、值得注意的是、不容小觑、综上所述、本质上、不难发现、拭目以待、未来可期、深度剖析。
- 禁用句式:“不是X,而是Y”式转折;三个短语连排;首先/其次/最后式机械分点;把标题换个说法复述一遍。
- 动词优先:写“改了”不写“进行了优化”。有数字给数字,有名字点名字,能具体绝不概括。
- 长短句交替,一句话只说一件事,别每句都塞满数据和从句。`;

export function buildEditorialPrompt(
	candidates: Candidate[],
	trackers: Tracker[],
	/** R2 · 近 7 天反馈段(feedbackPromptBlock 的产物)。空串 = 没有反馈可用。 */
	feedbackBlock = "",
	/** X2 · 是否要轴外位(读者可关,连续没人点也会自动关)。 */
	offAxis = false,
	/** T3 · 追踪器 key → 该追踪器的活跃线索清单(threadsPromptBlock 的产物)。 */
	threadsByTracker: Map<string, string> = new Map(),
	/** R9 · 长期口味画像段(tastePromptBlock 的产物)。空串 = 还没有画像。 */
	tasteBlock = "",
): { system: string; user: string } {
	const system = `你是一份个人每日简报的编辑。简报的哲学:它是当天信息的路由器,不是内容的终点。每条入选内容的任务是帮读者在 10 秒内决定"点进原文还是划过",绝不替读者把原文读完。

读者维护了一组「追踪器」——每个追踪器是一个长期问题,带显式的选材定义(收什么/不收什么/优先信源)。你的任务是把今天的候选分给各追踪器,严格按定义选材。

硬规则:
1. whyClick 只回答"为什么值得点进去花 10 分钟",1-2 句;禁止复述原文内容梗概。
2. 你写的每个字都必须有 excerpt 依据。excerpt 里没有的事实、数字、结论,一个都不许出现。
3. caveat 字段:只有当 excerpt 里作者自己表达了限定、存疑、反方观点时才填,原样保留其怀疑;没有就省略。禁止自己编一个平衡观点。
4. 「够格」的门槛是**符合追踪器定义、今天值得读**,不是必须惊艳。配额是读者自己定的信息量预期:还有符合定义的候选时优先把配额用满,相对弱的排在后面即可,不要在明明有相关候选时只交一半配额。真正无关、命中排除项、或只能靠硬扯才沾边的才不选;全都不合格就返回空数组,空着是正常结果,页面会显示「今天没有新内容」。
5. 追踪器的「不收」列表是硬性排除——命中就绝对不选,这是读者明确拒绝过的内容。
6. 同一事件被多个源报道时,选最好的一篇为主,其余放进 merged。
7. related 用于"拓展阅读":只能引用候选列表里的其他 id,不许出现任何列表外的链接或 id。
8. 每条写 relatesTo:一小句说明它和这个追踪器的问题是什么关系;内置追踪器(headlines/learn)可省略。
9. 全刊总条数不超过 ${TOTAL_ITEM_CAP} 条:如果各追踪器合计超了,砍掉相对最弱的,把它们放进 notableDrops 并注明。
10. 同一个来源在全刊最多 ${MAX_ITEMS_PER_SOURCE} 条:超了就换别的来源的候选,实在没有就少给几条。读者订的是一份简报,不是某一个站的转发。
11. 输出简体中文。只输出 JSON,不要任何其他文字。${
		feedbackBlock
			? `
12. 用户消息里带了「读者近期反馈」段:那是读者亲口说的,权重高于你的猜测。四类信号方向不同,别混为一谈——「没用」下调同类;「已知道」只提高新鲜度要求、绝不下调那个话题;「有用/多找这种」加权同源同话题;「读者说缺了什么」是选材的空洞,优先补。反馈不能推翻追踪器的「不收」硬排除。`
			: ""
	}${
		/* 台账从第一期就要开始记,所以这条规则永远在:没有已有线索时,模型
		   给的就全是新线索 key —— 那正是台账的起点。 */ `
13. 线索归并:读者的追踪器下面列了「进行中的线索」。每条选中项都要给 threadKey——**接得上已有线索就用它的 key**(哪怕角度不同,只要是同一件事的后续),接不上才给一个新 key(小写英文 + 短横线,≤40 字符)并配 threadTitle(≤20 字,说的是这件事本身,不是这一篇文章的标题)。宁可多归到已有线索,也别把同一件事拆成三条新线索——读者要看的是一件事怎么发展的。
   判据要严:只有**同一件事的不同阶段或侧面**才算一条线索(同一家公司的同一个产品线、同一个技术路线的后续工作、同一场争论的新发言)。仅仅「都属于 agent」「都用了多智能体」**不算**——那是话题相同,不是同一件事。说不清「这两条讲的是同一件事的什么关系」就新建线索。宁可线索多而干净,也不要一条线索里塞着互不相干的三件事——那样时间线读起来就是一堆噪音。
   ⚠️ 线索清单**只用于归类,不是「已报道过」的排除清单**:一条内容属于某条已有线索,恰恰说明它是读者正在追的事情的新进展,该选就选。绝不要因为「这条线索已经存在」就跳过它的新证据——那会让越被关注的话题越收不到东西。`
	}${
		offAxis
			? `
14. 轴外位(offAxis):在所有追踪器之外,再挑 **1 条不属于任何追踪器**的候选——读者没定义过、也不会主动去找,但你判断他该看见的。reason 写清「为什么我觉得你该看见」,别写成又一条摘要。宁缺毋滥:没有真正够格的就给 null。它不占各追踪器的配额,也不受第 9 条总数限制。`
			: ""
	}${
		tasteBlock
			? `
15. 用户消息里带了「读者的长期口味画像」段:它是过去几个月反馈的蒸馏,比单日反馈稳,但只是背景校准——与追踪器定义或「读者近期反馈」冲突时,以后两者为准;它同样不能推翻「不收」硬排除。`
			: ""
	}

${STYLE_RULES}`;

	const trackerText = activeTrackers(trackers)
		.map((t) => {
			const lines = [`- key=${t.key} 「${t.name}」(每期最多 ${normalizeQuota(t.quota)} 条)`];
			if (t.question) lines.push(`  问题原话:${t.question}`);
			// R7 · 读者拿它干什么。同一个话题,做产品的人和看投资的人该收到的
			// 是完全不同的两批内容——这一行就是那个分岔口。
			if (t.purpose) lines.push(`  读者在忙什么(选材时按这个取舍):${t.purpose}`);
			if (t.intent) lines.push(`  意图:${t.intent}`);
			if (t.include?.length) lines.push(`  全局收:${t.include.join("、")}`);
			if (t.exclude?.length) lines.push(`  全局不收(硬排除):${t.exclude.join("、")}`);
			if (t.sourceMode === "selected") {
				lines.push(`  已确认信源 key:${(t.sourceKeys ?? []).join(", ") || "(尚未确认任何来源)"}`);
			} else {
				lines.push("  信源范围:全部已启用来源");
			}
			const threadBlock = threadsByTracker.get(t.key);
			if (threadBlock) lines.push(`  进行中的线索(能接上就接,别另起炉灶):
${threadBlock}`);
			for (const rule of t.sourceRules ?? []) {
				const parts = [];
				if (rule.include?.length) parts.push(`只收:${rule.include.join("、")}`);
				if (rule.exclude?.length) parts.push(`不收:${rule.exclude.join("、")}`);
				if (parts.length) lines.push(`  来源 ${rule.sourceKey} 的局部规则:${parts.join(";")}`);
			}
			return lines.join("\n");
		})
		.join("\n");
	const candidateText = JSON.stringify(
		candidates.map((c) => ({
			id: c.id,
			source: c.source,
			sourceKey: c.sourceKey,
			category: c.category,
			title: c.title,
			publishedAt: c.publishedAt,
			excerpt: c.excerpt.slice(0, 800),
		})),
	);

	const user = `读者的追踪器(sections 的 key 必须逐一对应这里的 key):
${trackerText}
${tasteBlock ? `\n${tasteBlock}\n` : ""}${feedbackBlock ? `\n${feedbackBlock}\n` : ""}
今天的候选(共 ${candidates.length} 条):
${candidateText}

返回这个结构的 JSON(sections 里每个追踪器 key 都要出现,没有合格候选就给空数组):
{
  "sections": {
    "<追踪器key>": [{"id": "...", "whyClick": "...", "relatesTo": "和该追踪器问题的关系(一小句)", "threadKey": "接上的线索key或新key", "threadTitle": "仅新线索需要", "caveat": "可选", "merged": ["同事件其他报道的id"], "related": ["拓展阅读的候选id"]}]
  },
  ${offAxis ? `"offAxis": {"id": "...", "whyClick": "...", "reason": "为什么我觉得你该看见(和任何追踪器都无关)"} 或 null,\n  ` : ""}"notableDrops": [{"id": "...", "reason": "值得说明的落选原因,只列 3-8 条最可惜的"}],
  "droppedSummary": "一句话:今天筛掉的主要是什么",
  "tldr": ["恰好 3 句,每句 ≤40 字:写「今天这期为什么值得点开」,只概括已入选内容,不复述标题,不出现链接"]
}`;
	return { system, user };
}

export function parseEditorialJson(raw: string, trackers: Tracker[]): EditorialResult {
	const cleaned = raw.replace(/^```(?:json)?\s*/i, "").replace(/\s*```\s*$/, "");
	const parsed = JSON.parse(cleaned) as EditorialResult;
	parsed.notableDrops ??= [];
	parsed.droppedSummary ??= "";
	// Keep only known trackers, clamp per-tracker quotas; unknown keys from the
	// model are dropped, never invented into sections.
	let tells = 0;
	const clean = (s: string | undefined): string | undefined => {
		if (typeof s !== "string" || !s) return undefined;
		tells += countAiTells(s);
		return normalizeCnStyle(s);
	};
	const sections: Record<string, EditorialPick[]> = {};
	for (const t of activeTrackers(trackers)) {
		sections[t.key] = (parsed.sections?.[t.key] ?? [])
			.slice(0, normalizeQuota(t.quota))
			.map((p) => ({
				...p,
				whyClick: clean(p.whyClick) ?? "",
				...(p.caveat ? { caveat: clean(p.caveat) } : {}),
				...(p.relatesTo ? { relatesTo: clean(p.relatesTo) } : {}),
			}));
	}
	parsed.sections = sections;
	parsed.notableDrops = parsed.notableDrops.map((d) => ({ ...d, reason: clean(d.reason) ?? "" }));
	parsed.droppedSummary = clean(parsed.droppedSummary) ?? "";
	// 「今天为什么是空的」是这个产品最常被问的问题,把答案留在日志里:
	// 是模型一条没选(选材太严),还是候选池里本来就没有(源的问题)。
	const picked = Object.entries(sections).map(([k, v]) => `${k}=${v.length}`).join(" ");
	console.log(`[editorial] ${picked} offAxis=${parsed.offAxis ? "1" : "0"} drops=${parsed.notableDrops.length}`);
	// X2 · 轴外位同样吃反捏造护栏:id 不在候选里就整条丢掉,绝不臆造
	const off = parsed.offAxis;
	parsed.offAxis =
		off && typeof off.id === "string" && typeof off.whyClick === "string"
			? { id: off.id, whyClick: clean(off.whyClick) ?? "", reason: clean(typeof off.reason === "string" ? off.reason : "") ?? "" }
			: null;
	// E1 · 三句话只做清洗(去空、截长、最多 3 句);格式不对就整个丢掉,
	// 兜底拼接在 assembleBrief 里——那里才拿得到最终入选的条目。
	parsed.tldr = Array.isArray(parsed.tldr)
		? parsed.tldr
				.filter((s): s is string => typeof s === "string" && s.trim().length > 0)
				.map((s) => (clean(s.trim()) ?? "").slice(0, 60))
				.slice(0, 3)
		: undefined;
	if (!parsed.tldr?.length) parsed.tldr = undefined;
	// 换模对照的可比数字:规整前模型原文里有多少处 AI 腔(破折号/直角引号/套话)
	if (tells > 0) console.log(`[style] editorial AI 腔命中 ${tells} 处,标点已规整`);
	return parsed;
}

// ---------- assembly ----------

export async function findHnDiscussion(url: string): Promise<string | undefined> {
	try {
		const api = `https://hn.algolia.com/api/v1/search?query=${encodeURIComponent(url)}&restrictSearchableAttributes=url&hitsPerPage=3`;
		const res = await fetch(api, {
			headers: { "user-agent": USER_AGENT },
			signal: AbortSignal.timeout(8000),
		});
		if (!res.ok) return undefined;
		const data = (await res.json()) as { hits: { objectID: string; url?: string; points?: number }[] };
		const hit = data.hits.find((h) => h.url === url && (h.points ?? 0) >= 5);
		return hit ? `https://news.ycombinator.com/item?id=${hit.objectID}` : undefined;
	} catch {
		return undefined;
	}
}

export interface AssembleOptions {
	date: string;
	sourceCount: number;
	trackers: Tracker[];
	/** HN lookups cost one subrequest per item — callers can turn them off. */
	lookupDiscussions?: boolean;
}

export async function assembleBrief(
	editorial: EditorialResult,
	fetched: FetchResult,
	opts: AssembleOptions,
): Promise<Brief> {
	const byId = new Map(fetched.candidates.map((c) => [c.id, c]));
	const usedIds = new Set<string>();
	const sections: BriefSection[] = [];
	// "超出额度" drops carry their own reason so the accountability section can
	// tell "not good enough" apart from "good but the issue was full".
	const overflowDrops = new Map<string, string>();
	// X1 · 单源占比上限,在代码里强制一遍(提示词只是先礼后兵)
	const perSource = new Map<string, number>();
	let total = 0;

	for (const t of activeTrackers(opts.trackers)) {
		const items: BriefItem[] = [];
		for (const pick of editorial.sections[t.key] ?? []) {
			const cand = byId.get(pick.id);
			if (!cand || usedIds.has(pick.id)) continue; // unknown/duplicate id from the model — drop, never invent
			if (total >= TOTAL_ITEM_CAP) {
				usedIds.add(pick.id);
				overflowDrops.set(pick.id, `入选了但超出今日额度(全刊 ≤${TOTAL_ITEM_CAP} 条)`);
				continue;
			}
			const fromSource = perSource.get(cand.sourceKey) ?? 0;
			if (fromSource >= MAX_ITEMS_PER_SOURCE) {
				usedIds.add(pick.id);
				overflowDrops.set(pick.id, `入选了但同源已满(单源每期 ≤${MAX_ITEMS_PER_SOURCE} 条,防一家独大)`);
				continue;
			}
			perSource.set(cand.sourceKey, fromSource + 1);
			usedIds.add(pick.id);
			total++;
			const mergedFrom: BriefLink[] = [];
			for (const mid of pick.merged ?? []) {
				const m = byId.get(mid);
				if (m && !usedIds.has(mid)) {
					usedIds.add(mid);
					mergedFrom.push({ label: `${m.publisher ?? m.source} · ${m.title}`, url: m.url });
				}
			}
			const extras: BriefLink[] = [];
			for (const rid of (pick.related ?? []).slice(0, 2)) {
				const r = byId.get(rid);
				if (r && rid !== pick.id) extras.push({ label: `相关 · ${r.title}`, url: r.url });
			}
			items.push({
				id: cand.id,
				title: cand.title,
				whyClick: pick.whyClick,
				url: cand.url,
				// 展示真实出版方(检索源条目);配额、健康、指标仍按 sourceKey 记
				source: cand.publisher ?? cand.source,
				sourceKey: cand.sourceKey,
				publishedAt: cand.publishedAt,
				discussionUrl: opts.lookupDiscussions === false ? undefined : await findHnDiscussion(cand.url),
				...(extras.length ? { extras } : {}),
				...(pick.caveat ? { caveat: pick.caveat } : {}),
				...(pick.relatesTo ? { relatesTo: pick.relatesTo } : {}),
				...(mergedFrom.length ? { mergedFrom } : {}),
				// T3 · key 归一后再落:模型给的新 key 什么字符都可能有
				...(pick.threadKey ? { threadKey: normalizeThreadKey(pick.threadKey, cand.id) } : {}),
				...(pick.threadTitle ? { threadTitle: pick.threadTitle.slice(0, 80) } : {}),
			});
		}
		// Empty sections stay in: "the radar swept and found nothing" is part
		// of the product's accountability, not something to hide.
		sections.push({ key: t.key, title: t.name, items });
	}

	// X2 · 轴外位:各追踪器都挑完之后再放,单独一格。它不占 TOTAL_ITEM_CAP
	// (那是「读者要的内容」的额度),但同样吃单源上限和「id 必须真实存在」。
	let offAxis: BriefItem | undefined;
	const offPick = editorial.offAxis;
	if (offPick) {
		const cand = byId.get(offPick.id);
		if (cand && !usedIds.has(offPick.id) && (perSource.get(cand.sourceKey) ?? 0) < MAX_ITEMS_PER_SOURCE) {
			usedIds.add(cand.id);
			offAxis = {
				id: cand.id,
				title: cand.title,
				whyClick: offPick.whyClick,
				url: cand.url,
				source: cand.publisher ?? cand.source,
				sourceKey: cand.sourceKey,
				publishedAt: cand.publishedAt,
				discussionUrl: undefined,
				...(offPick.reason ? { relatesTo: offPick.reason } : {}),
			};
		}
	}

	const dropReasons = new Map(editorial.notableDrops.map((d) => [d.id, d.reason]));
	const pickedIds = new Set(sections.flatMap((s) => s.items.map((i) => i.id)));
	const unselected: DroppedItem[] = fetched.candidates
		.filter((c) => !pickedIds.has(c.id) && !usedIds.has(c.id))
		.map((c) => ({
			id: c.id,
			title: c.title,
			url: c.url,
			source: c.source,
			reason: dropReasons.get(c.id) ?? "未过入选线(各追踪器配额有限)",
		}));
	const overflow: DroppedItem[] = [...overflowDrops].map(([id, reason]) => {
		const c = byId.get(id)!;
		return { id, title: c.title, url: c.url, source: c.source, reason };
	});
	const filteredItems = [...overflow, ...unselected, ...fetched.ruleDropped].slice(0, 100);

	// E1 · 三句话:编辑给了就用;漏给时从各版块首条机械拼(《标题》:whyClick
	// 前 30 字)。兜底文案生硬没关系,邮件的任务只是把人叫回网页。
	let tldr = editorial.tldr;
	if (!tldr?.length) {
		tldr = sections
			.filter((s) => s.items.length > 0)
			.slice(0, 3)
			.map((s) => `《${s.items[0].title.slice(0, 24)}》:${s.items[0].whyClick.slice(0, 30)}`);
	}

	return {
		date: opts.date,
		generatedAt: new Date().toISOString(),
		...(tldr.length ? { tldr } : {}),
		sections,
		...(offAxis ? { offAxis } : {}),
		filteredOut: {
			scanned: fetched.scanned,
			dropped: Math.max(0, fetched.scanned - total),
			summary: editorial.droppedSummary || `扫描 ${fetched.scanned} 条,入选 ${total} 条。`,
			items: filteredItems,
		},
		sourceCount: opts.sourceCount,
	};
}

// ---------- 第二段:成稿(enrich) ----------
//
// 为什么要分两段(docs/03 §3.8):选材阶段每条只喂 800 字摘要,是为了让几十条
// 候选塞得进一次调用;但 800 字写不出深度——线上实测 Latent Space 那篇 RSS 里
// 有 9202 字正文,模型只读到 8.7% 就要写「为什么值得点」,写出来的必然是换个
// 说法重复标题。所以:**廉价 triage 全都做,昂贵抽取只对选中的做**。
//
// 这一段打破了 docs/02 §6.3「每人一次结构化调用」。代价是每人每天多一次调用
// (约 2.4 万 token 输入),换来的是简报从「标题改写」变成「有实质、有判断」。

/** 成稿阶段最多为几条抓原文/写稿——它只处理已入选的条目,天然是个位数。 */
export const MAX_ENRICH_ITEMS = 10;
/** feed 自带正文短于这个长度,才值得去抓原文网页(中文源大多是 teaser feed)。 */
export const TEASER_THRESHOLD = 1500;
/** 送进成稿提示词的单篇正文上限。 */
export const ENRICH_TEXT_CAP = 9000;
/**
 * 正文短于这个长度就**不送进成稿**。提示词里写了「正文为空就给空字符串」,
 * 但线上实测模型不遵守:一条只有标题和分数的 HN 条目,它照样写出了
 * 「具体细节未提供,但可推断研究使用了微观数据」——凭空推断,正是反捏造
 * 原则要挡的东西。能用代码挡住的不变量,不靠叮嘱模型。
 */
export const MIN_ENRICH_TEXT = 400;
/**
 * 导语兜底的下限:正文不足 MIN_ENRICH_TEXT 但至少有这么多字时,仍送成稿,
 * 走「仅基于导语」降档(付费墙源如 FT/Stratechery 常年落在这一档,原先整条
 * 只剩一句 whyClick,信息密度砍半)。再短就真的什么都没有,照旧跳过。
 */
export const TEASER_MIN_TEXT = 80;

/**
 * 抓原文正文。只在 feed 只给了导语时才调用(见 TEASER_THRESHOLD),失败一律
 * 静默退回 feed 摘要——**深度是加分项,不能因为某个站反爬就让整期出不来**。
 */
export async function fetchArticleText(url: string, timeoutMs = 8000): Promise<string> {
	try {
		// 没解开的 Google News 新式跳转链是个 JS 壳页,stripHtml 出来的是导航噪音,
		// 混进成稿比拿不到正文更糟——直接放弃,让该条保持路由式文案。
		if (new URL(url).hostname === "news.google.com") return "";
		const res = await fetch(url, {
			headers: { "user-agent": USER_AGENT, accept: "text/html,application/xhtml+xml" },
			signal: AbortSignal.timeout(timeoutMs),
			redirect: "follow",
		});
		if (!res.ok) return "";
		const type = res.headers.get("content-type") ?? "";
		if (!type.includes("html")) return "";
		const html = await res.text();
		// 优先正文容器,退到 body:整页 stripHtml 会把导航和页脚也算进去,
		// 那些噪音会挤掉真正的论证段落。
		const pick =
			/<article[^>]*>([\s\S]*?)<\/article>/i.exec(html)?.[1] ??
			/<main[^>]*>([\s\S]*?)<\/main>/i.exec(html)?.[1] ??
			/<body[^>]*>([\s\S]*?)<\/body>/i.exec(html)?.[1] ??
			html;
		return stripHtml(pick).slice(0, ENRICH_TEXT_CAP);
	} catch {
		return "";
	}
}

export interface EnrichSource {
	id: string;
	title: string;
	url: string;
	source: string;
	/** 该条所属追踪器的问题与用途,take 要落在读者的处境上。 */
	trackerQuestion?: string;
	trackerPurpose?: string;
	/** 正文(feed 自带的或抓回来的)。 */
	text: string;
	/**
	 * 只拿到导语(付费墙或纯 teaser feed,全文抓取失败)。这类条目照样送成稿,
	 * 但提示词按降档规则写:短 substance、显式标注只基于导语,绝不靠标题补。
	 */
	teaserOnly?: boolean;
}

export interface EnrichPick {
	whyClick?: string;
	substance?: string;
	take?: string;
}

const ENRICH_SYSTEM = `你是一份个人每日简报的编辑。下面给你今天**已经选中**的条目正文。为每一条写三段话,目标是让读者能判断「这值不值得我花 10 分钟」——而不是「我已经不用看原文了」。

三个字段边界不同,别混着写:
1. whyClick(1 句,≤40 字):为什么这位读者该点进去。**只说对他意味着什么**,不要交代文章讲了什么——那是 substance 的活,两处重复是最常见的毛病。
2. substance(3-5 句,150-320 字,**宁长勿短**):这篇**究竟给出了什么**。要具体到能让读者不点开也知道结论是什么:
   - 有数字就把数字写全(多少、对比谁、在什么条件下测的);
   - 有做法就把机制讲清楚(分几步、每步干什么、关键设计是什么),别用「提出了一种方法」这种空壳;
   - 有反直觉的结论就把它单独说出来,并交代它成立的前提;
   - 涉及多方(公司/模型/数据集)时点名,别写「某厂商」。
   边界:交代**结论和机制**,不交代**论证过程**——读者仍然要靠原文判断这些结论可不可信、实验设计有没有问题。
3. take(1-2 句,≤120 字):**你的独立判断**。可以是它的适用边界、方法上的弱点、与读者追踪问题的冲突之处、什么条件下结论会反转、或者它在同类工作里的位置。

take 的硬边界(违反就是在编):
- 只许基于**正文里出现过的事实**做推论,例如「它只在 X 上测过,没覆盖你关心的 Y」;
- **绝对不许引入正文之外的事实、数字、他人观点**——你不知道的事就别提;
- 没有值得说的判断,就指出正文里最该被质疑的那一处;实在没有,take 给空字符串;
- 不许写「值得关注」「有待观察」「未来可期」这类正确的废话。

正文为空的条目:substance 和 take 都给空字符串,不许靠标题猜内容。
标了「⚠️ 只拿到导语」的条目按该条目下方的降档说明写,同样一个字都不许超出导语内容。
只输出 JSON,不要任何其他文字。

${STYLE_RULES}`;

export function buildEnrichPrompt(items: EnrichSource[]): { system: string; user: string } {
	const blocks = items.map((it) => {
		const lines = [`### id=${it.id}`, `标题:${it.title}`, `来源:${it.source}`];
		if (it.trackerQuestion) lines.push(`读者的长期问题:${it.trackerQuestion}`);
		if (it.trackerPurpose) lines.push(`读者在忙什么:${it.trackerPurpose}`);
		if (it.teaserOnly) {
			lines.push(
				`⚠️ 只拿到导语/开头 ${it.text.length} 字(全文抓取失败,大概率是付费墙)。降档规则:substance 压到 1-3 句、≤120 字,以「仅基于导语:」开头,只写导语里确有的信息;导语没有实质信息就给空字符串。take 没有把握就给空。`,
			);
		}
		lines.push(`正文(${it.text.length} 字):\n${it.text || "(拿不到正文)"}`);
		return lines.join("\n");
	});
	const user = `${blocks.join("\n\n---\n\n")}

返回这个结构的 JSON,每个 id 都要出现:
{"items": {"<id>": {"whyClick": "...", "substance": "...", "take": "..."}}}`;
	return { system: ENRICH_SYSTEM, user };
}

export function parseEnrichJson(raw: string): Record<string, EnrichPick> {
	const cleaned = raw.replace(/^```(?:json)?\s*/i, "").replace(/\s*```\s*$/, "");
	const parsed = JSON.parse(cleaned) as { items?: Record<string, EnrichPick> };
	const out: Record<string, EnrichPick> = {};
	let tells = 0;
	for (const [id, pick] of Object.entries(parsed.items ?? {})) {
		if (!pick || typeof pick !== "object") continue;
		const take = (str: unknown, cap: number) => {
			if (typeof str !== "string" || !str.trim()) return undefined;
			tells += countAiTells(str);
			return normalizeCnStyle(str.trim()).slice(0, cap);
		};
		const whyClick = take(pick.whyClick, 200);
		// substance 要 150-320 字,截断上限给够余量:提示词负责控长度,这里
		// 只防失控;卡在 400 会把最后一句话砍掉一半,比长一点难看得多。
		const substance = take(pick.substance, 900);
		const judgement = take(pick.take, 400);
		out[id] = {
			...(whyClick ? { whyClick } : {}),
			...(substance ? { substance } : {}),
			...(judgement ? { take: judgement } : {}),
		};
	}
	if (tells > 0) console.log(`[style] enrich AI 腔命中 ${tells} 处,标点已规整`);
	return out;
}

/** 把成稿结果写回简报。缺字段的条目保持第一段的产出,不留空。 */
export function applyEnrichment(brief: Brief, picks: Record<string, EnrichPick>): number {
	let n = 0;
	const all = [...brief.sections.flatMap((s) => s.items), ...(brief.offAxis ? [brief.offAxis] : [])];
	for (const item of all) {
		const pick = picks[item.id];
		if (!pick) continue;
		if (pick.whyClick) item.whyClick = pick.whyClick;
		if (pick.substance) item.substance = pick.substance;
		if (pick.take) item.take = pick.take;
		if (pick.substance || pick.take) n++;
	}
	return n;
}

/**
 * 收集成稿所需的正文:feed 里够长就直接用,只有 teaser feed 才去抓原文网页。
 * 抓取并发做,单条失败不影响其他条。
 */
export async function collectEnrichTexts(
	items: { id: string; url: string }[],
	excerptById: Map<string, string>,
	log: (msg: string) => void = () => {},
	/**
	 * 正文抽取的接缝:默认是 shared 里的正则版(哪个运行时都能跑);Node 侧
	 * (Lambda/CLI)注入 readability 版,抽得干净得多。签名只认 URL→纯文本。
	 */
	fetchText: (url: string) => Promise<string> = fetchArticleText,
): Promise<Map<string, string>> {
	const out = new Map<string, string>();
	const needFetch: { id: string; url: string }[] = [];
	for (const item of items.slice(0, MAX_ENRICH_ITEMS)) {
		const excerpt = excerptById.get(item.id) ?? "";
		if (excerpt.length >= TEASER_THRESHOLD) out.set(item.id, excerpt.slice(0, ENRICH_TEXT_CAP));
		else needFetch.push(item);
	}
	const fetched = await Promise.all(needFetch.map(async (it) => [it.id, await fetchText(it.url)] as const));
	for (const [id, text] of fetched) {
		const excerpt = excerptById.get(id) ?? "";
		// 抓回来的比 feed 摘要长才算数,否则 feed 那点导语还更干净
		out.set(id, text.length > excerpt.length ? text : excerpt);
	}
	log(`[enrich] ${out.size} 条正文,其中 ${needFetch.length} 条抓了原文网页`);
	return out;
}

/**
 * 成稿的完整编排:收正文 → 一次调用 → 写回简报。
 *
 * `call` 由调用方注入(Lambda 与 Worker 各自的 ai 配置),这样 pipeline-core
 * 不用认识 ai.ts。**整段包在 try 里**:成稿失败只是没有实质与判断,不该让
 * 已经选好的一期发不出去。
 */
export async function enrichBrief(
	brief: Brief,
	fetched: FetchResult,
	trackers: Tracker[],
	call: (system: string, user: string) => Promise<string>,
	log: (msg: string) => void = () => {},
	fetchText?: (url: string) => Promise<string>,
): Promise<number> {
	const byTracker = new Map(trackers.map((t) => [t.key, t]));
	const targets: EnrichSource[] = [];
	for (const section of brief.sections) {
		const tracker = byTracker.get(section.key);
		for (const item of section.items) {
			targets.push({
				id: item.id,
				title: item.title,
				url: item.url,
				source: item.source,
				...(tracker?.question ? { trackerQuestion: tracker.question } : {}),
				...(tracker?.purpose ? { trackerPurpose: tracker.purpose } : {}),
				text: "",
			});
		}
	}
	if (brief.offAxis) {
		targets.push({
			id: brief.offAxis.id,
			title: brief.offAxis.title,
			url: brief.offAxis.url,
			source: brief.offAxis.source,
			text: "",
		});
	}
	if (targets.length === 0) return 0;

	try {
		const excerptById = new Map(fetched.candidates.map((c) => [c.id, c.excerpt]));
		const texts = await collectEnrichTexts(targets, excerptById, log, fetchText);
		for (const t of targets) t.text = texts.get(t.id) ?? "";
		// 足量正文正常成稿;只有导语的(付费墙)降档成稿;连导语都没有的
		// 直接不送:让它保持第一段的路由式文案,也好过一段看起来像事实、
		// 实则靠标题猜出来的「实质」。
		const usable = targets.filter((t) => t.text.length >= MIN_ENRICH_TEXT);
		const teasers = targets.filter((t) => t.text.length >= TEASER_MIN_TEXT && t.text.length < MIN_ENRICH_TEXT);
		for (const t of teasers) t.teaserOnly = true;
		const sent = [...usable, ...teasers];
		const skipped = targets.length - sent.length;
		if (sent.length === 0) {
			log(`[enrich] 全部 ${targets.length} 条都拿不到正文,跳过成稿`);
			return 0;
		}
		const { system, user } = buildEnrichPrompt(sent);
		// 一次性故障重试一次再认输:成稿是整期一把梭,断流(2026-08-24 真实发生:
		// TypeError: terminated,整期只剩路由文案)或返回坏 JSON 都会废掉全部散文。
		// 空结果的重试在 ai.ts 里已有,这里补「调用炸掉/解析不了」这条路;连炸两次
		// 才走外层兜底,代价只是极少数坏日子里多一次调用。
		let parsed: ReturnType<typeof parseEnrichJson>;
		try {
			parsed = parseEnrichJson(await call(system, user));
		} catch (err) {
			log(`[enrich] 首次调用未成,重试一次:${err}`);
			parsed = parseEnrichJson(await call(system, user));
		}
		const n = applyEnrichment(brief, parsed);
		log(
			`[enrich] ${n}/${sent.length} 条写出了实质与判断` +
				`${teasers.length ? `,其中 ${teasers.length} 条只有导语走降档` : ""}` +
				`${skipped ? `,${skipped} 条因正文不足跳过` : ""}`,
		);
		return n;
	} catch (err) {
		log(`[enrich] FAILED, keeping the routing-only copy: ${err}`);
		return 0;
	}
}
