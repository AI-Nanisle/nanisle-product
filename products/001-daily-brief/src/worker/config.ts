// Config validation + per-user persistence, shared by the REST handlers
// (PUT /api/sources, PUT /api/trackers) and the chat agent's tools — one set
// of rules, two entrances. 存取一律经 Store 按会话邮箱隔离(docs/02 §4)。

import {
	MAX_CHANGELOG,
	MAX_INTENT_SEGMENTS,
	MAX_INTENT_VERSIONS,
	SOURCE_CATEGORIES,
	fnv1a,
	joinSegments,
	normalizeQuota,
} from "../shared/pipeline-core.ts";
import { MAX_EXCLUDE, MAX_RULES_PER_SOURCE } from "../shared/weekly.ts";
import type {
	IntentSegment,
	IntentVersion,
	SourceConfig,
	Tracker,
	TrackerLogEntry,
	TrackerSourceRule,
} from "../shared/pipeline-core";
import { DEFAULT_SOURCES } from "../shared/default-sources.ts";
import type { SourceFunnelMetrics, Store, UserConfig } from "../shared/store";

// ≤30 源/人:docs/02 §8.3 的上限,DynamoDB 条目尺寸账和 Worker 免费档
// 子请求预算(dev 回落路径一次请求抓全部源)都是按它算的。
export const MAX_SOURCES = 30;
export const MAX_TRACKERS = 12;

/**
 * 读某人的配置;CONFIG 条目不存在时现场种一条并落库。种子里只有默认源库的
 * 深拷贝,追踪器一条不给:新用户第一眼是空的配置页(向导直接开问),追踪
 * 什么由他自己定义。种子逻辑放在读路径而不是登录回调上,fork 本地零配置也
 * 能自然触发。深拷贝是必须的:调用方会原地 push/改字段,不能把模块级默认
 * 数组交出去。
 */
export async function loadConfig(store: Store, email: string): Promise<UserConfig> {
	const existing = await store.getConfig(email);
	if (existing) return existing;
	const seeded: UserConfig = {
		trackers: [],
		sources: structuredClone(DEFAULT_SOURCES),
		updatedAt: new Date().toISOString(),
	};
	await store.putConfig(email, seeded);
	return seeded;
}

export async function saveSources(store: Store, email: string, sources: SourceConfig[]): Promise<void> {
	const config = await loadConfig(store, email);
	await store.putConfig(email, { ...config, sources, updatedAt: new Date().toISOString() });
}

export async function saveTrackers(store: Store, email: string, trackers: Tracker[]): Promise<void> {
	const config = await loadConfig(store, email);
	await store.putConfig(email, { ...config, trackers, updatedAt: new Date().toISOString() });
}

/** 找源漏斗计数自增(docs/02 §7.3 仪表)。读改写,单用户编辑场景够用。 */
export async function bumpSourceMetrics(
	store: Store,
	email: string,
	delta: Partial<SourceFunnelMetrics>,
): Promise<void> {
	const config = await loadConfig(store, email);
	const prev = config.metrics ?? { shown: 0, adopted: 0 };
	const metrics: SourceFunnelMetrics = {
		shown: prev.shown + (delta.shown ?? 0),
		adopted: prev.adopted + (delta.adopted ?? 0),
	};
	await store.putConfig(email, { ...config, metrics, updatedAt: new Date().toISOString() });
}

export function cleanSources(raw: unknown): { sources: SourceConfig[] } | { error: string } {
	if (!Array.isArray(raw) || raw.length > MAX_SOURCES) {
		return { error: `sources must be an array (max ${MAX_SOURCES})` };
	}
	const cleaned: SourceConfig[] = [];
	for (const [i, s] of (raw as Record<string, unknown>[]).entries()) {
		const name = typeof s.name === "string" ? s.name.trim() : "";
		const url = typeof s.url === "string" ? s.url.trim() : "";
		const category = s.category as SourceConfig["category"];
		if (!name || name.length > 100) return { error: `source #${i + 1}: name required (≤100 chars)` };
		if (!/^https?:\/\/\S+$/.test(url) || url.length > 500) return { error: `source #${i + 1}: url must be http(s)` };
		if (!SOURCE_CATEGORIES.includes(category)) return { error: `source #${i + 1}: bad category` };
		const maxItems =
			typeof s.max_items === "number" && s.max_items >= 1 && s.max_items <= 50 ? Math.floor(s.max_items) : undefined;
		// H1 · health 是生成侧写的运行状态,不是用户可编辑的字段——但也不能在
		// 用户改一次源库时被抹掉,所以原样带过来(只做形状校验)。
		const rawHealth = s.health as Record<string, unknown> | undefined;
		const health =
			rawHealth && typeof rawHealth.consecutiveFailures === "number"
				? {
						consecutiveFailures: Math.max(0, Math.floor(rawHealth.consecutiveFailures)),
						...(typeof rawHealth.lastOkAt === "string" ? { lastOkAt: rawHealth.lastOkAt.slice(0, 40) } : {}),
						...(typeof rawHealth.lastError === "string" ? { lastError: rawHealth.lastError.slice(0, 300) } : {}),
					}
				: undefined;
		cleaned.push({
			key: typeof s.key === "string" && s.key ? s.key.slice(0, 64) : fnv1a(url),
			name,
			url,
			category,
			enabled: s.enabled === false ? false : undefined,
			...(maxItems ? { max_items: maxItems } : {}),
			...(health ? { health } : {}),
		});
	}
	return { sources: cleaned };
}

/**
 * S6 · 「收/不收」的硬上限。只加不减的定义几个月后会变成谁也读不懂的补丁堆
 * ——自我修订机制最常见的败法。到顶时挤掉的是**最旧的**(尾部是新加的),
 * 所以每周自评的提案永远是替换而不是无限追加。
 */
function cleanKeywordList(raw: unknown, max = MAX_EXCLUDE): string[] | undefined {
	if (!Array.isArray(raw)) return undefined;
	const list = raw
		.filter((k): k is string => typeof k === "string")
		.map((k) => k.trim().slice(0, 40))
		.filter(Boolean)
		.slice(-max);
	return list.length > 0 ? list : undefined;
}

function cleanSegments(raw: unknown): IntentSegment[] | undefined {
	if (!Array.isArray(raw)) return undefined;
	const list: IntentSegment[] = [];
	for (const s of raw.slice(0, MAX_INTENT_SEGMENTS) as Record<string, unknown>[]) {
		const text = typeof s?.text === "string" ? s.text.trim().slice(0, 200) : "";
		if (text) list.push({ text, ...(s.edited === true ? { edited: true } : {}) });
	}
	return list.length > 0 ? list : undefined;
}

/** V1 · 理解的历史快照:形状校验 + 截长限量,和 changelog 一个信任级别。 */
function cleanIntentVersions(raw: unknown): IntentVersion[] | undefined {
	if (!Array.isArray(raw)) return undefined;
	const list: IntentVersion[] = [];
	for (const v of raw.slice(0, MAX_INTENT_VERSIONS) as Record<string, unknown>[]) {
		const at = typeof v?.at === "string" ? v.at.trim().slice(0, 40) : "";
		const note = typeof v?.note === "string" ? v.note.trim().slice(0, 80) : "";
		const segments = cleanSegments(v?.segments);
		if (at && segments) list.push({ at, ...(note ? { note } : {}), segments });
	}
	return list.length > 0 ? list : undefined;
}

/** Client-written history. Trusted enough to store, not enough to skip trimming. */
function cleanChangelog(raw: unknown): TrackerLogEntry[] | undefined {
	if (!Array.isArray(raw)) return undefined;
	const list: TrackerLogEntry[] = [];
	for (const e of raw.slice(0, MAX_CHANGELOG) as Record<string, unknown>[]) {
		const at = typeof e?.at === "string" ? e.at.trim().slice(0, 40) : "";
		const text = typeof e?.text === "string" ? e.text.trim().slice(0, 160) : "";
		if (at && text) list.push({ at, text });
	}
	return list.length > 0 ? list : undefined;
}

export function cleanTrackers(raw: unknown): { trackers: Tracker[] } | { error: string } {
	if (!Array.isArray(raw) || raw.length > MAX_TRACKERS) {
		return { error: `trackers must be an array (max ${MAX_TRACKERS})` };
	}
	const cleaned: Tracker[] = [];
	const seen = new Set<string>();
	for (const [i, t] of (raw as Record<string, unknown>[]).entries()) {
		const name = typeof t.name === "string" ? t.name.trim() : "";
		if (!name || name.length > 60) return { error: `tracker #${i + 1}: name required (≤60 chars)` };
		let key = typeof t.key === "string" && t.key.trim() ? t.key.trim().slice(0, 64) : fnv1a(`tracker:${name}:${i}`);
		if (seen.has(key)) key = fnv1a(`${key}:${i}`);
		seen.add(key);
		const quota = normalizeQuota(typeof t.quota === "number" ? Math.floor(t.quota) : undefined);
		const question = typeof t.question === "string" ? t.question.trim().slice(0, 500) : undefined;
		const askedAt = typeof t.askedAt === "string" ? t.askedAt.trim().slice(0, 40) : undefined;
		const purpose = typeof t.purpose === "string" ? t.purpose.trim().slice(0, 200) : undefined;
		// 向导期间才有的追问选项;答完 purpose 就没用了,顺手丢掉
		const purposeOptions =
			!purpose && Array.isArray(t.purposeOptions)
				? (t.purposeOptions as unknown[])
						.filter((o): o is string => typeof o === "string")
						.map((o) => o.trim().slice(0, 20))
						.filter(Boolean)
						.slice(0, 3)
				: undefined;
		const intentSegments = cleanSegments(t.intentSegments);
		const intentVersions = cleanIntentVersions(t.intentVersions);
		const stage =
			t.stage === "understanding" || t.stage === "tags" || t.stage === "sources" ? t.stage : undefined;
		// V2 · 向导对话只在草稿期间有意义;stage 一删(草稿生效)就一并丢弃
		const wizardMessages =
			stage && Array.isArray(t.wizardMessages)
				? (t.wizardMessages as unknown[])
						.filter((m): m is string => typeof m === "string")
						.map((m) => m.trim().slice(0, 1000))
						.filter(Boolean)
						.slice(0, 8)
				: undefined;
		// The chat agent only knows about `intent`; when it rewrites the line the
		// stale clauses are gone and the dossier re-splits from the new text.
		const intentRaw = typeof t.intent === "string" ? t.intent.trim().slice(0, 400) : undefined;
		const intent = intentRaw ?? (intentSegments ? joinSegments(intentSegments).slice(0, 400) : undefined);
		const changelog = cleanChangelog(t.changelog);
		const include = cleanKeywordList(t.include);
		const exclude = cleanKeywordList(t.exclude);
		const sourceKeys = Array.isArray(t.sourceKeys)
			? [...new Set((t.sourceKeys as unknown[]).filter((k): k is string => typeof k === "string"))].slice(0, MAX_SOURCES)
			: undefined;
		const sourceMode = t.sourceMode === "selected" || sourceKeys ? "selected" : "all";
		const sourceRules: TrackerSourceRule[] = [];
		if (Array.isArray(t.sourceRules)) {
			for (const rawRule of (t.sourceRules as Record<string, unknown>[]).slice(0, MAX_SOURCES)) {
				const sourceKey = typeof rawRule.sourceKey === "string" ? rawRule.sourceKey.trim().slice(0, 64) : "";
				if (!sourceKey || sourceRules.some((rule) => rule.sourceKey === sourceKey)) continue;
				// 局部规则更该收着:一个源上挂六条以上的收/不收,基本等于没规则
				const localInclude = cleanKeywordList(rawRule.include, MAX_RULES_PER_SOURCE);
				const localExclude = cleanKeywordList(rawRule.exclude, MAX_RULES_PER_SOURCE);
				if (localInclude || localExclude) {
					sourceRules.push({
						sourceKey,
						...(localInclude ? { include: localInclude } : {}),
						...(localExclude ? { exclude: localExclude } : {}),
					});
				}
			}
		}
		const rejectedSourceUrls = Array.isArray(t.rejectedSourceUrls)
			? [...new Set((t.rejectedSourceUrls as unknown[])
				.filter((url): url is string => typeof url === "string" && /^https?:\/\/\S+$/.test(url))
				.map((url) => url.slice(0, 500)))].slice(0, MAX_SOURCES)
			: [];
		cleaned.push({
			key,
			name,
			quota,
			...(question ? { question } : {}),
			...(purpose ? { purpose } : {}),
			...(purposeOptions?.length ? { purposeOptions } : {}),
			...(askedAt ? { askedAt } : {}),
			...(intent ? { intent } : {}),
			...(intentSegments ? { intentSegments } : {}),
			...(intentVersions ? { intentVersions } : {}),
			...(changelog ? { changelog } : {}),
			...(include ? { include } : {}),
			...(exclude ? { exclude } : {}),
			...(sourceMode === "selected" ? { sourceMode, sourceKeys: sourceKeys ?? [] } : {}),
			...(sourceRules.length ? { sourceRules } : {}),
			...(rejectedSourceUrls.length ? { rejectedSourceUrls } : {}),
			...(t.enabled === false ? { enabled: false } : {}),
			...(stage ? { stage } : {}),
			...(wizardMessages?.length ? { wizardMessages } : {}),
		});
	}
	return { trackers: cleaned };
}
