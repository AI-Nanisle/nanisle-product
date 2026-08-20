// S1–S6 · 每周自评与越线提案(docs/03-实施清单.md §3.7)。
//
// 为什么要这一层:在这之前,「简报质量」是玄学——变好变坏只能靠感觉吵架,
// 调不动也证明不了。这里把它变成五个能复算的数,并且**越线就提改法**,而不是
// 画个图给人看。
//
// 四条硬规矩,缺一条这套机制就会变成噪音源:
//   1. 指标**零 LLM**,全是纯计算。指标本身要是模型编的,拿它当依据就是循环论证。
//   2. **没有指标依据的提案不许生成**,这条在 makeProposals 里挡,不靠提示词。
//   3. 用户手写的 `question` 与 `edited:true` 的理解句是**不可改区**,
//      applyProposal 强制保留(有测试)。AI 可以演化定义,用户的原话是宪法。
//   4. 提案生效只加不减 = 慢性死亡。定义字段有硬上限,超限必须**替换**。

import type { Brief, FeedbackEvent } from "./types";
import type { SourceCategory, Tracker } from "./pipeline-core";
import { fnv1a, isQueryFeedUrl } from "./pipeline-core.ts";
import type { ClickEvent, UserConfig } from "./store";
import { isFeedbackEvent } from "./store.ts";

/** 指标窗口:4 周。再长就跟不上定义的变化,再短噪声压不住。 */
export const WEEKLY_WINDOW_DAYS = 28;
/** 每人每周最多几条提案——提案多了就没人看,和没有一样。 */
export const MAX_PROPOSALS_PER_WEEK = 3;
/** 冷却期:提案挂多少天后自动生效(期间随时可否决)。 */
export const PROPOSAL_COOLING_DAYS = 7;

/** S6 · 定义字段的硬上限。到顶时新提案必须替换最旧的,不许无限追加。 */
export const MAX_INCLUDE = 12;
export const MAX_EXCLUDE = 12;
export const MAX_RULES_PER_SOURCE = 6;

// ---------- ISO 周 ----------

/** YYYY-Www。周指标按它存,同一周重复跑不会生成两批提案。 */
export function isoWeek(date: Date): string {
	const d = new Date(Date.UTC(date.getUTCFullYear(), date.getUTCMonth(), date.getUTCDate()));
	// ISO：周四决定年份
	d.setUTCDate(d.getUTCDate() + 4 - (d.getUTCDay() || 7));
	const yearStart = new Date(Date.UTC(d.getUTCFullYear(), 0, 1));
	const week = Math.ceil(((d.getTime() - yearStart.getTime()) / 86_400_000 + 1) / 7);
	return `${d.getUTCFullYear()}-W${String(week).padStart(2, "0")}`;
}

function dayDiff(fromISO: string, toISO: string): number | null {
	const a = Date.parse(fromISO);
	const b = Date.parse(toISO);
	if (Number.isNaN(a) || Number.isNaN(b)) return null;
	return (b - a) / 86_400_000;
}

function median(nums: number[]): number | null {
	if (nums.length === 0) return null;
	const sorted = [...nums].sort((x, y) => x - y);
	const mid = Math.floor(sorted.length / 2);
	return sorted.length % 2 ? sorted[mid] : (sorted[mid - 1] + sorted[mid]) / 2;
}

// ---------- S2 · 五个指标 ----------

export interface SourceStat {
	key: string;
	name: string;
	/** 窗口内入选条数。 */
	selected: number;
	/** 窗口内被筛掉的条数(问责区里出现过)。 */
	dropped: number;
	/** 窗口内被点开的条数。 */
	clicks: number;
	/** 最近一次入选的日期;从没入选过为 null。 */
	lastSelected: string | null;
}

export interface WeeklyMetrics {
	week: string;
	computedAt: string;
	window: { days: number; briefs: number; from: string | null; to: string | null };
	/** 指标一:每源贡献率。 */
	sources: SourceStat[];
	/** 指标二:反馈消化率——被否掉的来源,占比是否真的降了。 */
	digestion: { source: string; beforeShare: number; afterShare: number; improved: boolean }[];
	/** 指标三:原文发布 → 进简报的中位天数(老简报没有 publishedAt,跳过)。 */
	lagDays: number | null;
	/** 指标四:误杀率 = 「已筛掉」里被点 want 的比例。 */
	falseKill: { wanted: number; dropped: number; rate: number };
	/** 指标五:阅读留存。 */
	retention: { activeDays: number; clicks: number; clicksPerDay: number };
}

export interface WeeklyInput {
	config: UserConfig;
	/** 窗口内的简报,**新的在前**。 */
	briefs: Brief[];
	events: (FeedbackEvent | ClickEvent)[];
	now: Date;
}

export function computeWeeklyMetrics({ config, briefs, events, now }: WeeklyInput): WeeklyMetrics {
	const todayISO = now.toISOString();
	const feedback = events.filter(isFeedbackEvent);
	const clicks = events.filter((e): e is ClickEvent => !isFeedbackEvent(e));
	const clickedItems = new Set(clicks.map((c) => c.itemId));

	// —— 指标一:每源贡献率
	const stats = new Map<string, SourceStat>(
		config.sources.map((s) => [s.key, { key: s.key, name: s.name, selected: 0, dropped: 0, clicks: 0, lastSelected: null }]),
	);
	const byName = new Map(config.sources.map((s) => [s.name, s.key]));
	const bump = (key: string | undefined, field: "selected" | "dropped", date: string, itemId?: string) => {
		if (!key) return;
		const stat = stats.get(key);
		if (!stat) return;
		stat[field]++;
		if (field === "selected") {
			if (!stat.lastSelected || date > stat.lastSelected) stat.lastSelected = date;
			if (itemId && clickedItems.has(itemId)) stat.clicks++;
		}
	};

	const lags: number[] = [];
	let droppedTotal = 0;
	for (const brief of briefs) {
		for (const section of brief.sections) {
			for (const item of section.items) {
				bump(item.sourceKey ?? byName.get(item.source), "selected", brief.date, item.id);
				// —— 指标三:时效滞后
				if (item.publishedAt) {
					const d = dayDiff(item.publishedAt, `${brief.date}T12:00:00Z`);
					if (d !== null && d >= 0 && d < 60) lags.push(d);
				}
			}
		}
		for (const d of brief.filteredOut.items) {
			droppedTotal++;
			bump(byName.get(d.source), "dropped", brief.date);
		}
	}

	// —— 指标二:反馈消化率。窗口一分为二,比被否掉的来源前后占比
	const half = new Date(now.getTime() - (WEEKLY_WINDOW_DAYS / 2) * 86_400_000).toISOString().slice(0, 10);
	const share = (fn: (b: Brief) => boolean, source: string): number => {
		let total = 0;
		let hit = 0;
		for (const brief of briefs.filter(fn)) {
			for (const section of brief.sections) {
				for (const item of section.items) {
					total++;
					if (item.source === source) hit++;
				}
			}
		}
		return total > 0 ? hit / total : 0;
	};
	const negatives = new Set<string>();
	for (const ev of feedback) {
		if (ev.kind !== "down" && ev.kind !== "known") continue;
		const brief = briefs.find((b) => b.date === ev.date);
		const item = brief?.sections.flatMap((s) => s.items).find((i) => i.id === ev.itemId);
		if (item) negatives.add(item.source);
	}
	const digestion = [...negatives].map((source) => {
		const beforeShare = share((b) => b.date < half, source);
		const afterShare = share((b) => b.date >= half, source);
		return { source, beforeShare, afterShare, improved: afterShare < beforeShare };
	});

	// —— 指标四:误杀率
	const wanted = feedback.filter((f) => f.kind === "want").length;

	// —— 指标五:阅读留存
	const activeDays = new Set(events.map((e) => e.at.slice(0, 10))).size;

	return {
		week: isoWeek(now),
		computedAt: todayISO,
		window: {
			days: WEEKLY_WINDOW_DAYS,
			briefs: briefs.length,
			from: briefs.at(-1)?.date ?? null,
			to: briefs[0]?.date ?? null,
		},
		sources: [...stats.values()],
		digestion,
		lagDays: median(lags),
		falseKill: { wanted, dropped: droppedTotal, rate: droppedTotal > 0 ? wanted / droppedTotal : 0 },
		retention: {
			activeDays,
			clicks: clicks.length,
			clicksPerDay: activeDays > 0 ? clicks.length / activeDays : 0,
		},
	};
}

// ---------- S3 · 提案 ----------

export type ProposalPatch =
	| { type: "source-disable"; sourceKey: string }
	| {
			/** 观察式发现(docs/02 §7.3 第 4 层):检索源反复命中的域名升级成直连源。 */
			type: "source-add";
			name: string;
			url: string;
			category: SourceCategory;
			/** 证据来自哪个追踪器;sourceMode=selected 时新源要同时挂进它的 sourceKeys。 */
			trackerKey?: string;
	  }
	| { type: "tracker-source-mode-all"; trackerKey: string }
	| { type: "tracker-exclude-remove"; trackerKey: string; term: string };

export interface Proposal {
	id: string;
	createdAt: string;
	week: string;
	targetName: string;
	/** 一句人话:要改什么。 */
	summary: string;
	/** **依据哪个指标的哪个数**。没有它的提案不许存在(makeProposals 保证)。 */
	evidence: string;
	patch: ProposalPatch;
	status: "pending" | "applied" | "dismissed";
	decidedAt?: string;
}

/** 提案挂到期了没(冷却期满 = 自动生效)。 */
export function isCooled(p: Proposal, now: Date): boolean {
	const d = dayDiff(p.createdAt, now.toISOString());
	return d !== null && d >= PROPOSAL_COOLING_DAYS;
}

export interface ProposalContext {
	config: UserConfig;
	metrics: WeeklyMetrics;
	/** 追踪器 key → 连续多少期零命中(阅读侧已有的算法,调用方传进来)。 */
	noHitStreak: Map<string, number>;
	/** 窗口内被点 want 的条目标题,用来找该删哪个 exclude 标签。 */
	wantedTitles: string[];
	now: Date;
	idSeed: () => string;
}

/**
 * 指标越线 → 提案。**每条提案都必须带 evidence**,这是这套机制的信任基础:
 * 一条说不出依据的「AI 建议」,和随口一说没有区别,用户第二次就不看了。
 */
export function makeProposals(ctx: ProposalContext): Proposal[] {
	const { config, metrics, noHitStreak, wantedTitles, now } = ctx;
	const out: Proposal[] = [];
	const week = isoWeek(now);
	const base = { createdAt: now.toISOString(), week, status: "pending" as const };

	// 越线一:某个源三周零入选 —— 它在占着抓取预算,却一条都没进过简报
	for (const stat of metrics.sources) {
		if (out.length >= MAX_PROPOSALS_PER_WEEK) break;
		const source = config.sources.find((s) => s.key === stat.key);
		if (!source || source.enabled === false) continue;
		const idle = stat.lastSelected ? dayDiff(`${stat.lastSelected}T00:00:00Z`, now.toISOString()) : null;
		const neverSelected = stat.selected === 0 && metrics.window.briefs >= 14;
		if (!neverSelected && (idle === null || idle < 21)) continue;
		out.push({
			...base,
			id: `p-${ctx.idSeed()}`,
			targetName: source.name,
			summary: `停用来源「${source.name}」`,
			evidence: `近 ${metrics.window.briefs} 期里它入选 ${stat.selected} 条、被筛掉 ${stat.dropped} 条${
				stat.lastSelected ? `,最近一次入选是 ${stat.lastSelected}` : ",一次都没入选过"
			}。`,
			patch: { type: "source-disable", sourceKey: source.key },
		});
	}

	// 越线二:追踪器长期零命中,而且它把自己锁死在几个指定源上
	for (const [trackerKey, streak] of noHitStreak) {
		if (out.length >= MAX_PROPOSALS_PER_WEEK) break;
		if (streak < 7) continue;
		const tracker = config.trackers.find((t) => t.key === trackerKey);
		if (!tracker || tracker.sourceMode !== "selected") continue;
		out.push({
			...base,
			id: `p-${ctx.idSeed()}`,
			targetName: tracker.name,
			summary: `把「${tracker.name}」的取材范围放宽到全部来源`,
			evidence: `它连续 ${streak} 期零命中,而目前只从 ${(tracker.sourceKeys ?? []).length} 个指定源取材。`,
			patch: { type: "tracker-source-mode-all", trackerKey },
		});
	}

	// 越线三:误杀率过高 —— 找出把想要的东西挡掉的那个「不收」标签
	if (out.length < MAX_PROPOSALS_PER_WEEK && metrics.falseKill.rate > 0.05 && metrics.falseKill.wanted >= 2) {
		for (const tracker of config.trackers) {
			const culprit = (tracker.exclude ?? []).find((term) =>
				wantedTitles.some((title) => title.toLowerCase().includes(term.toLowerCase())),
			);
			if (!culprit) continue;
			out.push({
				...base,
				id: `p-${ctx.idSeed()}`,
				targetName: tracker.name,
				summary: `从「${tracker.name}」的不收清单里删掉「${culprit}」`,
				evidence: `近 ${metrics.window.briefs} 期你从「已筛掉」里捞回了 ${metrics.falseKill.wanted} 条(误杀率 ${(
					metrics.falseKill.rate * 100
				).toFixed(1)}%),其中有标题命中这个词。`,
				patch: { type: "tracker-exclude-remove", trackerKey: tracker.key, term: culprit },
			});
			break;
		}
	}

	return out.slice(0, MAX_PROPOSALS_PER_WEEK);
}

// ---------- S3+ · 观察式发现:检索源反复命中的域名 → 直连源提案 ----------

/** 聚合器/平台域名:它们是管道不是出版方,不值得建议「直接订阅」。 */
const AGGREGATOR_HOSTS = new Set([
	"news.google.com",
	"news.ycombinator.com",
	"reddit.com",
	"arxiv.org",
	"youtube.com",
	"github.com",
	"medium.com",
	"substack.com",
]);

function isAggregatorHost(host: string): boolean {
	const h = host.replace(/^www\./, "");
	return AGGREGATOR_HOSTS.has(h) || [...AGGREGATOR_HOSTS].some((a) => h.endsWith(`.${a}`));
}

export interface QueryFeedDomain {
	/** 归一后的域名(去 www)。 */
	domain: string;
	/** 窗口内经检索源入选的条数。 */
	count: number;
	/** 出现最多的追踪器——新源该挂进谁的 sourceKeys。 */
	trackerKey: string;
	/** 最近一条的标题,进提案的证据行。 */
	sample: string;
}

/**
 * docs/02 §7.3 第 4 层:检索源是免费的侦察兵,它反复带回同一个域名,说明那个
 * 站就是用户想要的具体源。这里只做纯统计;试抓(能不能订阅)是调用方的活。
 */
export function queryFeedDomains(config: UserConfig, briefs: Brief[], minCount = 3): QueryFeedDomain[] {
	const queryKeys = new Set(config.sources.filter((s) => isQueryFeedUrl(s.url)).map((s) => s.key));
	if (queryKeys.size === 0) return [];
	const ownedHosts = new Set(
		config.sources
			.map((s) => {
				try {
					return new URL(s.url).hostname.replace(/^www\./, "");
				} catch {
					return "";
				}
			})
			.filter(Boolean),
	);
	const byDomain = new Map<string, { count: number; trackers: Map<string, number>; sample: string }>();
	for (const brief of briefs) {
		for (const section of brief.sections) {
			for (const item of section.items) {
				if (!item.sourceKey || !queryKeys.has(item.sourceKey)) continue;
				let host: string;
				try {
					host = new URL(item.url).hostname.replace(/^www\./, "");
				} catch {
					continue;
				}
				if (!host || isAggregatorHost(host) || ownedHosts.has(host)) continue;
				const entry = byDomain.get(host) ?? { count: 0, trackers: new Map(), sample: item.title };
				entry.count++;
				entry.trackers.set(section.key, (entry.trackers.get(section.key) ?? 0) + 1);
				if (!entry.sample) entry.sample = item.title;
				byDomain.set(host, entry);
			}
		}
	}
	return [...byDomain.entries()]
		.filter(([, e]) => e.count >= minCount)
		.map(([domain, e]) => ({
			domain,
			count: e.count,
			trackerKey: [...e.trackers.entries()].sort((a, b) => b[1] - a[1])[0][0],
			sample: e.sample,
		}))
		.sort((a, b) => b.count - a.count);
}

/**
 * 试抓通过后把域名升级成 source-add 提案。和 makeProposals 同一条纪律:
 * evidence 里全是可复算的数字,没有依据的提案不许存在。
 */
export function makeSourceAddProposal(
	found: QueryFeedDomain,
	probe: { url: string; title?: string; fresh?: number; total?: number },
	config: UserConfig,
	metrics: WeeklyMetrics,
	now: Date,
	id: string,
): Proposal | null {
	if (config.sources.some((s) => s.url === probe.url)) return null;
	const tracker = config.trackers.find((t) => t.key === found.trackerKey);
	const name = (probe.title || found.domain).slice(0, 60);
	return {
		id: `p-${id}`,
		createdAt: now.toISOString(),
		week: isoWeek(now),
		status: "pending",
		targetName: name,
		summary: `把 ${found.domain} 升级成直连来源「${name}」`,
		evidence: `近 ${metrics.window.briefs} 期里有 ${found.count} 条入选内容经检索源来自它(如《${found.sample.slice(0, 40)}》),它有可直接订阅的 feed(${probe.total ?? "?"} 条,窗口内 ${probe.fresh ?? "?"} 条)。`,
		patch: {
			type: "source-add",
			name,
			url: probe.url,
			category: "news",
			...(tracker ? { trackerKey: tracker.key } : {}),
		},
	};
}

// ---------- S4/S5/S6 · 生效 ----------

/**
 * S5 · 不可改区:用户手写的 `question` 和他亲手改过(edited:true)的理解句,
 * 提案永远碰不到。做法同 B11——不信任「逻辑上不会改到」,直接按位置盖回去。
 */
export function preserveImmutable(before: Tracker[], after: Tracker[]): Tracker[] {
	const byKey = new Map(before.map((t) => [t.key, t]));
	return after.map((t) => {
		const prev = byKey.get(t.key);
		if (!prev) return t;
		const segments = t.intentSegments?.map((seg, i) => {
			const old = prev.intentSegments?.[i];
			return old?.edited ? { text: old.text, edited: true } : seg;
		});
		return {
			...t,
			...(prev.question !== undefined ? { question: prev.question } : {}),
			...(segments ? { intentSegments: segments } : {}),
		};
	});
}

/** S6 · 到顶就替换最旧的,不许无限追加——只加不减的定义几个月后没人读得懂。 */
export function capList(list: string[], add: string[], max: number): string[] {
	const merged = [...list.filter((x) => !add.includes(x)), ...add];
	return merged.length <= max ? merged : merged.slice(merged.length - max);
}

/** 与 worker/config.ts 的 MAX_SOURCES 同值;不直接 import 是因为那边 import 本模块。 */
const MAX_SOURCES_CAP = 30;

/** 把一条提案落到配置上。返回新配置 + 给 changelog 的一行话(没改动则返回 null)。 */
export function applyProposal(config: UserConfig, p: Proposal): { config: UserConfig; log?: { trackerKey: string; text: string } } | null {
	const patch = p.patch;
	if (patch.type === "source-disable") {
		const sources = config.sources.map((s) => (s.key === patch.sourceKey ? { ...s, enabled: false } : s));
		if (JSON.stringify(sources) === JSON.stringify(config.sources)) return null;
		return { config: { ...config, sources } };
	}
	if (patch.type === "source-add") {
		if (config.sources.some((s) => s.url === patch.url)) return null;
		if (config.sources.length >= MAX_SOURCES_CAP) return null;
		const key = fnv1a(patch.url);
		const sources = [...config.sources, { key, name: patch.name, url: patch.url, category: patch.category }];
		// 证据来自 selected 模式的追踪器时,新源要挂进它的 sourceKeys,否则加了也选不上
		const trackers = patch.trackerKey
			? config.trackers.map((t) =>
					t.key === patch.trackerKey && t.sourceMode === "selected"
						? { ...t, sourceKeys: [...new Set([...(t.sourceKeys ?? []), key])] }
						: t,
				)
			: config.trackers;
		return {
			config: { ...config, sources, trackers },
			...(patch.trackerKey
				? { log: { trackerKey: patch.trackerKey, text: `编辑按每周自评加了直连来源「${patch.name}」(依据:${p.evidence})` } }
				: {}),
		};
	}

	const trackers = config.trackers.map((t) => {
		if (t.key !== patch.trackerKey) return t;
		if (patch.type === "tracker-source-mode-all") return { ...t, sourceMode: "all" as const };
		if (patch.type === "tracker-exclude-remove") {
			const exclude = (t.exclude ?? []).filter((x) => x !== patch.term);
			return { ...t, ...(exclude.length ? { exclude } : { exclude: undefined }) };
		}
		return t;
	});
	if (JSON.stringify(trackers) === JSON.stringify(config.trackers)) return null;
	// S5 · 不管上面改了什么,不可改区一律盖回去
	const safe = preserveImmutable(config.trackers, trackers);
	return {
		config: { ...config, trackers: safe },
		log: { trackerKey: patch.trackerKey, text: `编辑按每周自评改了定义:${p.summary}(依据:${p.evidence})` },
	};
}
