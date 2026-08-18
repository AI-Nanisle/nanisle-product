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

export const USER_AGENT =
	"nanisle-001-daily-brief/0.1 (+https://github.com/AI-Nanisle/nanisle-product)";

// ---------- config types ----------

export type SourceCategory = "news" | "macro" | "blog" | "podcast" | "paper";
export const SOURCE_CATEGORIES: SourceCategory[] = ["news", "macro", "blog", "podcast", "paper"];

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
}

export interface Filters {
	max_age_hours: number;
	max_items_per_feed: number;
	noise_keywords: string[];
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
	/** Ships with the product (今日大事/教我新东西). Informational only. */
	builtin?: boolean;
	/**
	 * 向导草稿标记:有 stage 的追踪器还在三步向导里(刷新/换设备可续),
	 * 不参与生成;「完成」时删掉该字段,追踪器才生效(docs/02 §7.1)。
	 */
	stage?: "understanding" | "tags" | "sources";
}

export const MAX_TRACKER_QUOTA = 3;
/** The whole issue stays bounded no matter how many trackers exist. */
export const TOTAL_ITEM_CAP = 10;
/** 变更记录 is a recent-history strip, not an archive. */
export const MAX_CHANGELOG = 20;
/** How many clauses the editor's understanding may hold. */
export const MAX_INTENT_SEGMENTS = 8;

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

/** The single-line form the editorial prompt consumes. */
export function joinSegments(segments: IntentSegment[]): string {
	return segments
		.map((s) => s.text.trim())
		.filter(Boolean)
		.join(";");
}

export function focusEntryToTracker(f: FocusEntry): Tracker {
	return { key: fnv1a(`focus:${f.name}`), name: f.name, question: f.detail ?? "", quota: 2 };
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
}

export function parseFeed(xml: string): RawEntry[] {
	const parser = new XMLParser({ ignoreAttributes: false, attributeNamePrefix: "@_" });
	const doc = parser.parse(xml) as Record<string, any>;
	const entries: RawEntry[] = [];

	const rssItems = asArray(doc?.rss?.channel?.item);
	for (const item of rssItems) {
		const dateStr = text(item.pubDate) || text(item["dc:date"]) || "";
		const body = text(item["content:encoded"]) || text(item.description) || "";
		entries.push({
			title: stripHtml(text(item.title)),
			url: text(item.link).trim() || text(item.guid).trim(),
			publishedAt: dateStr ? new Date(dateStr) : null,
			excerpt: stripHtml(body),
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

	return entries.filter((e) => e.title && e.url);
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
}

export async function fetchAllSources(
	sources: SourceConfig[],
	filters: Filters,
	log: (msg: string) => void = () => {},
): Promise<FetchResult> {
	const active = sources.filter((s) => s.enabled !== false);
	const now = Date.now();
	const maxAgeMs = filters.max_age_hours * 3600_000;
	const noise = filters.noise_keywords.map((k) => k.toLowerCase());
	const candidates: Candidate[] = [];
	const ruleDropped: DroppedItem[] = [];
	const sourceErrors: { name: string; error: string }[] = [];
	let scanned = 0;
	let sourcesOk = 0;

	const results = await Promise.allSettled(
		active.map(async (source) => ({ source, entries: await fetchFeed(source.url) })),
	);
	for (const [i, result] of results.entries()) {
		if (result.status === "rejected") {
			log(`[fetch] FAILED ${active[i].name}: ${result.reason}`);
			sourceErrors.push({ name: active[i].name, error: String(result.reason) });
			continue;
		}
		const { source, entries } = result.value;
		sourcesOk++;

		const fresh = entries
			.filter((e) => e.publishedAt && now - e.publishedAt.getTime() <= maxAgeMs)
			.sort((a, b) => b.publishedAt!.getTime() - a.publishedAt!.getTime());
		// "scanned" counts today's window only — feeds carry old entries and
		// counting them would inflate the accountability numbers on the page.
		scanned += fresh.length;

		const cap = source.max_items ?? filters.max_items_per_feed;
		let kept = 0;
		for (const entry of fresh) {
			const id = fnv1a(entry.url);
			const lowerTitle = entry.title.toLowerCase();
			const hit = noise.find((k) => lowerTitle.includes(k));
			if (hit) {
				ruleDropped.push({ id, title: entry.title, url: entry.url, source: source.name, reason: `规则过滤:命中「${hit}」` });
				continue;
			}
			if (kept >= cap) {
				ruleDropped.push({ id, title: entry.title, url: entry.url, source: source.name, reason: "规则过滤:超出单源条数上限" });
				continue;
			}
			kept++;
			candidates.push({
				id,
				sourceKey: source.key,
				source: source.name,
				category: source.category,
				title: entry.title,
				url: entry.url,
				publishedAt: entry.publishedAt!.toISOString(),
				excerpt: entry.excerpt.slice(0, 1200),
			});
		}
		log(`[fetch] ${source.name}: ${entries.length} entries, ${fresh.length} fresh, ${kept} kept`);
	}

	const seen = new Set<string>();
	const deduped = candidates.filter((c) => (seen.has(c.id) ? false : (seen.add(c.id), true)));
	return { candidates: deduped, ruleDropped, scanned, sourcesOk, sourceErrors };
}

// ---------- editorial ----------

export interface EditorialPick {
	id: string;
	whyClick: string;
	caveat?: string;
	relatesTo?: string;
	merged?: string[];
	related?: string[];
}

export interface EditorialResult {
	/** Tracker key → picks, in tracker order. */
	sections: Record<string, EditorialPick[]>;
	notableDrops: { id: string; reason: string }[];
	droppedSummary: string;
}

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
		sections[t.key] = matches.slice(0, Math.min(t.quota, MAX_TRACKER_QUOTA)).map((c) => {
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

export function buildEditorialPrompt(
	candidates: Candidate[],
	trackers: Tracker[],
): { system: string; user: string } {
	const system = `你是一份个人每日简报的编辑。简报的哲学:它是当天信息的路由器,不是内容的终点。每条入选内容的任务是帮读者在 10 秒内决定"点进原文还是划过",绝不替读者把原文读完。

读者维护了一组「追踪器」——每个追踪器是一个长期问题,带显式的选材定义(收什么/不收什么/优先信源)。你的任务是把今天的候选分给各追踪器,严格按定义选材。

硬规则:
1. whyClick 只回答"为什么值得点进去花 10 分钟",1-2 句;禁止复述原文内容梗概。
2. 你写的每个字都必须有 excerpt 依据。excerpt 里没有的事实、数字、结论,一个都不许出现。
3. caveat 字段:只有当 excerpt 里作者自己表达了限定、存疑、反方观点时才填,原样保留其怀疑;没有就省略。禁止自己编一个平衡观点。
4. 每个追踪器宁缺毋滥:没有够格的候选就返回空数组,不许凑数。空着是正常结果,页面会显示「今天没有新内容」。
5. 追踪器的「不收」列表是硬性排除——命中就绝对不选,这是读者明确拒绝过的内容。
6. 同一事件被多个源报道时,选最好的一篇为主,其余放进 merged。
7. related 用于"拓展阅读":只能引用候选列表里的其他 id,不许出现任何列表外的链接或 id。
8. 每条写 relatesTo:一小句说明它和这个追踪器的问题是什么关系;内置追踪器(headlines/learn)可省略。
9. 全刊总条数不超过 ${TOTAL_ITEM_CAP} 条:如果各追踪器合计超了,砍掉相对最弱的,把它们放进 notableDrops 并注明。
10. 输出简体中文。只输出 JSON,不要任何其他文字。`;

	const trackerText = activeTrackers(trackers)
		.map((t) => {
			const lines = [`- key=${t.key} 「${t.name}」(每期最多 ${Math.min(t.quota, MAX_TRACKER_QUOTA)} 条)`];
			if (t.question) lines.push(`  问题原话:${t.question}`);
			if (t.intent) lines.push(`  意图:${t.intent}`);
			if (t.include?.length) lines.push(`  全局收:${t.include.join("、")}`);
			if (t.exclude?.length) lines.push(`  全局不收(硬排除):${t.exclude.join("、")}`);
			if (t.sourceMode === "selected") {
				lines.push(`  已确认信源 key:${(t.sourceKeys ?? []).join(", ") || "(尚未确认任何来源)"}`);
			} else {
				lines.push("  信源范围:全部已启用来源");
			}
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

今天的候选(共 ${candidates.length} 条):
${candidateText}

返回这个结构的 JSON(sections 里每个追踪器 key 都要出现,没有合格候选就给空数组):
{
  "sections": {
    "<追踪器key>": [{"id": "...", "whyClick": "...", "relatesTo": "和该追踪器问题的关系(一小句)", "caveat": "可选", "merged": ["同事件其他报道的id"], "related": ["拓展阅读的候选id"]}]
  },
  "notableDrops": [{"id": "...", "reason": "值得说明的落选原因,只列 3-8 条最可惜的"}],
  "droppedSummary": "一句话:今天筛掉的主要是什么"
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
	const sections: Record<string, EditorialPick[]> = {};
	for (const t of activeTrackers(trackers)) {
		sections[t.key] = (parsed.sections?.[t.key] ?? []).slice(0, Math.min(t.quota, MAX_TRACKER_QUOTA));
	}
	parsed.sections = sections;
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
			usedIds.add(pick.id);
			total++;
			const mergedFrom: BriefLink[] = [];
			for (const mid of pick.merged ?? []) {
				const m = byId.get(mid);
				if (m && !usedIds.has(mid)) {
					usedIds.add(mid);
					mergedFrom.push({ label: `${m.source} · ${m.title}`, url: m.url });
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
				source: cand.source,
				discussionUrl: opts.lookupDiscussions === false ? undefined : await findHnDiscussion(cand.url),
				...(extras.length ? { extras } : {}),
				...(pick.caveat ? { caveat: pick.caveat } : {}),
				...(pick.relatesTo ? { relatesTo: pick.relatesTo } : {}),
				...(mergedFrom.length ? { mergedFrom } : {}),
			});
		}
		// Empty sections stay in: "the radar swept and found nothing" is part
		// of the product's accountability, not something to hide.
		sections.push({ key: t.key, title: t.name, items });
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

	return {
		date: opts.date,
		generatedAt: new Date().toISOString(),
		sections,
		filteredOut: {
			scanned: fetched.scanned,
			dropped: Math.max(0, fetched.scanned - total),
			summary: editorial.droppedSummary || `扫描 ${fetched.scanned} 条,入选 ${total} 条。`,
			items: filteredItems,
		},
		sourceCount: opts.sourceCount,
	};
}
