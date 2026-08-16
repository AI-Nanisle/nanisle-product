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
import type { Brief, BriefItem, BriefLink, BriefSection, DroppedItem, SectionKey } from "./types";

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

export interface FocusEntry {
	name: string;
	detail?: string;
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
	sections: Record<SectionKey, EditorialPick[]>;
	notableDrops: { id: string; reason: string }[];
	droppedSummary: string;
}

export const QUOTAS: Record<SectionKey, number> = { headlines: 3, ammo: 3, learn: 2 };
export const SECTION_TITLES: Record<SectionKey, string> = {
	headlines: "今日大事",
	ammo: "项目弹药",
	learn: "教我新东西",
};

export function mockEditorial(candidates: Candidate[]): EditorialResult {
	const byCat = (cats: string[], n: number) =>
		candidates.filter((c) => cats.includes(c.category)).slice(0, n);
	const pick = (c: Candidate): EditorialPick => ({
		id: c.id,
		whyClick: `[mock] ${c.excerpt.slice(0, 120) || c.title}…(设 AI_PROVIDER=anthropic 或 gateway 获得真实编辑)`,
	});
	const sections: Record<SectionKey, EditorialPick[]> = {
		headlines: byCat(["news", "macro"], QUOTAS.headlines).map(pick),
		ammo: byCat(["blog"], QUOTAS.ammo).map((c) => ({ ...pick(c), relatesTo: "[mock] 示例关联" })),
		learn: byCat(["podcast", "paper"], QUOTAS.learn).map(pick),
	};
	return {
		sections,
		notableDrops: [],
		droppedSummary: `[mock] 无 AI 模式:按类别取了前几条,其余 ${candidates.length} 条候选未经编辑筛选。`,
	};
}

export function buildEditorialPrompt(
	candidates: Candidate[],
	focus: FocusEntry[],
): { system: string; user: string } {
	const system = `你是一份个人每日简报的编辑。简报的哲学:它是当天信息的路由器,不是内容的终点。每条入选内容的任务是帮读者在 10 秒内决定"点进原文还是划过",绝不替读者把原文读完。

硬规则:
1. whyClick 只回答"为什么值得点进去花 10 分钟",1-2 句;禁止复述原文内容梗概。
2. 你写的每个字都必须有 excerpt 依据。excerpt 里没有的事实、数字、结论,一个都不许出现。
3. caveat 字段:只有当 excerpt 里作者自己表达了限定、存疑、反方观点时才填,原样保留其怀疑;没有就省略。禁止自己编一个平衡观点。
4. 每个分区宁缺毋滥:没有够格的候选就少选,不许凑数。
5. 同一事件被多个源报道时,选最好的一篇为主,其余放进 merged。
6. related 用于"拓展阅读":只能引用候选列表里的其他 id,不许出现任何列表外的链接或 id。
7. ammo 区(项目弹药)的每条必须写 relatesTo:具体到关注点清单里的哪一条、什么关系。写不出具体关系就不选。
8. 输出简体中文。只输出 JSON,不要任何其他文字。`;

	const focusText = focus.map((f) => `- ${f.name}${f.detail ? `:${f.detail}` : ""}`).join("\n");
	const candidateText = JSON.stringify(
		candidates.map((c) => ({
			id: c.id,
			source: c.source,
			category: c.category,
			title: c.title,
			publishedAt: c.publishedAt,
			excerpt: c.excerpt.slice(0, 800),
		})),
	);

	const user = `读者的当前关注点清单:
${focusText}

分区与配额:
- headlines(今日大事):当天真正重要的行业事件、宏观数据发布,最多 ${QUOTAS.headlines} 条
- ammo(项目弹药):与关注点清单直接相关、看完能行动的内容,最多 ${QUOTAS.ammo} 条
- learn(教我新东西):论文、深度内容,允许与当下关注无关但必须说清"新在哪",最多 ${QUOTAS.learn} 条

今天的候选(共 ${candidates.length} 条):
${candidateText}

返回这个结构的 JSON:
{
  "sections": {
    "headlines": [{"id": "...", "whyClick": "...", "caveat": "可选", "merged": ["同事件其他报道的id"], "related": ["拓展阅读的候选id"]}],
    "ammo": [{"id": "...", "whyClick": "...", "relatesTo": "关注点名:具体关系", "related": []}],
    "learn": [{"id": "...", "whyClick": "...", "caveat": "可选"}]
  },
  "notableDrops": [{"id": "...", "reason": "值得说明的落选原因,只列 3-8 条最可惜的"}],
  "droppedSummary": "一句话:今天筛掉的主要是什么"
}`;
	return { system, user };
}

export function parseEditorialJson(raw: string): EditorialResult {
	const cleaned = raw.replace(/^```(?:json)?\s*/i, "").replace(/\s*```\s*$/, "");
	const parsed = JSON.parse(cleaned) as EditorialResult;
	parsed.notableDrops ??= [];
	parsed.droppedSummary ??= "";
	for (const key of Object.keys(QUOTAS) as SectionKey[]) {
		parsed.sections[key] = (parsed.sections[key] ?? []).slice(0, QUOTAS[key]);
	}
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

	for (const key of ["headlines", "ammo", "learn"] as SectionKey[]) {
		const items: BriefItem[] = [];
		for (const pick of editorial.sections[key] ?? []) {
			const cand = byId.get(pick.id);
			if (!cand || usedIds.has(pick.id)) continue; // unknown/duplicate id from the model — drop, never invent
			usedIds.add(pick.id);
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
		sections.push({ key, title: SECTION_TITLES[key], items });
	}

	const dropReasons = new Map(editorial.notableDrops.map((d) => [d.id, d.reason]));
	const unselected: DroppedItem[] = fetched.candidates
		.filter((c) => !usedIds.has(c.id))
		.map((c) => ({
			id: c.id,
			title: c.title,
			url: c.url,
			source: c.source,
			reason: dropReasons.get(c.id) ?? "未过入选线(每区配额有限)",
		}));
	const filteredItems = [...unselected, ...fetched.ruleDropped].slice(0, 100);

	return {
		date: opts.date,
		generatedAt: new Date().toISOString(),
		sections,
		filteredOut: {
			scanned: fetched.scanned,
			dropped: fetched.scanned - usedIds.size,
			summary: editorial.droppedSummary || `扫描 ${fetched.scanned} 条,入选 ${usedIds.size} 条。`,
			items: filteredItems,
		},
		sourceCount: opts.sourceCount,
	};
}
