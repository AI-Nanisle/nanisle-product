// B8 · 生产生成入口(docs/02-技术方案.md §8.1)。EventBridge Scheduler(定时
// 全量)与 Worker 立即生成(Function URL 签名转调)都打到这里:
//
//   {"mode":"all"}  全量:Query 白名单 → 过滤有生效追踪器的人 → 并集去重抓取
//                   (每个 feed 只抓一次)→ 按各自源切出人均候选池 → 每人一次
//                   编辑调用(失败只跳过该人)→ 各写 BRIEF#<date>
//   {"email":"…"}   单用户(立即生成):只抓其启用源,putBrief 原子自增 genCount
//
// 打包:主仓 infra/ 的 NodejsFunction 用 esbuild 把这里连同 src/shared/* 一起
// 打进 Lambda。凭证来自执行角色(运行时注入 AWS_ACCESS_KEY_ID/SECRET/SESSION_TOKEN),
// 所以 store-dynamo(aws4fetch)在这里照常工作,和 Worker 共用同一份实现。

import { Buffer } from "node:buffer";
import {
	OFF_AXIS_MISS_LIMIT,
	activeTrackers,
	assembleBrief,
	briefDate,
	buildEditorialPrompt,
	fetchAllSources,
	fnv1a,
	mockEditorial,
	parseEditorialJson,
} from "../src/shared/pipeline-core";
import type { FetchResult, SourceConfig, Tracker } from "../src/shared/pipeline-core";
import { DEFAULT_FILTERS } from "../src/shared/default-sources";
import { AiError, complete, resolveProvider } from "../src/shared/ai";
import type { AiConfig } from "../src/shared/ai";
import { buildFeedbackEcho, feedbackPromptBlock, loadFeedbackDigest } from "../src/shared/feedback";
import type { FeedbackDigest } from "../src/shared/feedback";
import { dynamoStore } from "../src/shared/store-dynamo";
import type { Store, UserConfig } from "../src/shared/store";
import type { EditorialResult } from "../src/shared/pipeline-core";

export interface GenerateEvent {
	mode?: string;
	email?: string;
	/** Function URL 调用时 payload 在 HTTP event 的 body 里(JSON 字符串)。 */
	body?: string;
	isBase64Encoded?: boolean;
}

interface Payload {
	mode?: string;
	email?: string;
}

function parsePayload(event: GenerateEvent): Payload {
	if (typeof event.body === "string") {
		const raw = event.isBase64Encoded ? Buffer.from(event.body, "base64").toString("utf8") : event.body;
		try {
			return JSON.parse(raw) as Payload;
		} catch {
			return {};
		}
	}
	return { mode: event.mode, email: event.email };
}

function response(statusCode: number, body: Record<string, unknown>) {
	return {
		statusCode,
		headers: { "content-type": "application/json" },
		body: JSON.stringify(body),
	};
}

function envAiConfig(): AiConfig {
	return {
		provider: process.env.AI_PROVIDER,
		model: process.env.AI_MODEL,
		// 编辑 JSON 需要空间;没显式配置时给足,别让 1024 默认值截断整期
		maxOutputTokens: process.env.AI_MAX_OUTPUT_TOKENS ?? "4096",
		deepseekApiKey: process.env.DEEPSEEK_API_KEY,
		anthropicApiKey: process.env.ANTHROPIC_API_KEY,
		gatewayUrl: process.env.AI_GATEWAY_URL,
		gatewayKey: process.env.AI_GATEWAY_KEY,
	};
}

function envStore(): Store {
	const table = process.env.DDB_TABLE;
	if (!table) throw new Error("DDB_TABLE is not set");
	return dynamoStore({
		table,
		region: process.env.AWS_REGION ?? "us-east-1",
		accessKeyId: process.env.AWS_ACCESS_KEY_ID ?? "",
		secretAccessKey: process.env.AWS_SECRET_ACCESS_KEY ?? "",
		sessionToken: process.env.AWS_SESSION_TOKEN,
	});
}

/** 一次编辑调用:候选 + 追踪器定义 + 近期反馈 → 编辑结果(反捏造护栏在 parse 里)。 */
async function runEditorial(
	cfg: AiConfig,
	fetched: FetchResult,
	trackers: Tracker[],
	digest: FeedbackDigest,
	offAxis: boolean,
): Promise<EditorialResult> {
	if (resolveProvider(cfg) === "mock") return mockEditorial(fetched.candidates, trackers);
	const { system, user } = buildEditorialPrompt(
		fetched.candidates,
		trackers,
		feedbackPromptBlock(digest),
		offAxis,
	);
	const result = await complete(cfg, { prompt: user, system, json: true });
	return parseEditorialJson(result.text, trackers);
}

/**
 * X2 · 轴外位的自动降频。看上一期的轴外位有没有被点开:点了就清零,没点就
 * 累加;连续 OFF_AXIS_MISS_LIMIT 期没人点就自己关掉,并在今天这期交代一句。
 *
 * 用计数器而不是「回看 10 期简报」:计数器是 O(1) 的,而且反馈窗口只有 7 天,
 * 回看 10 期会漏掉更早的点击。重复生成同一天不计数——那不是新的一期。
 */
function updateOffAxis(
	config: UserConfig,
	prevBrief: { date: string; offAxis?: { id: string } } | null,
	clicks: Map<string, number>,
	today: string,
): { enabled: boolean; note?: string; prefs: UserConfig["prefs"] } {
	const prefs = { ...(config.prefs ?? {}) };
	if (prefs.offAxis === false) return { enabled: false, prefs };
	if (prevBrief && prevBrief.date !== today && prevBrief.offAxis) {
		const clicked = (clicks.get(prevBrief.offAxis.id) ?? 0) > 0;
		prefs.offAxisMisses = clicked ? 0 : (prefs.offAxisMisses ?? 0) + 1;
	}
	if ((prefs.offAxisMisses ?? 0) >= OFF_AXIS_MISS_LIMIT) {
		prefs.offAxis = false;
		return {
			enabled: false,
			prefs,
			note: `给你的「轴外推荐」连续 ${OFF_AXIS_MISS_LIMIT} 期一条没点开,先停了——想再要,去配置页打开。`,
		};
	}
	return { enabled: true, prefs };
}

interface UserRun {
	email: string;
	config: UserConfig;
}

/** 给一个用户出一期:候选池已按其源切好。返回入选条数。 */
async function produceBrief(
	store: Store,
	cfg: AiConfig,
	run: UserRun,
	fetched: FetchResult,
	date: string,
	bumpGenCount: boolean,
): Promise<{ picked: number; genCount: number }> {
	// R2 · 近 7 天反馈先读出来:它既进选材提示词,也是回响的原料。读失败会
	// 降级成空摘要(见 loadFeedbackDigest),不会让当天的简报生不出来。
	const digest = await loadFeedbackDigest(store, run.email, { log: (m) => console.log(`[${run.email}] ${m}`) });
	// X2 · 上一期的轴外位有没有被点开,决定今天还给不给
	const prevBrief = (await store.getBrief(run.email))?.brief ?? null;
	const off = updateOffAxis(run.config, prevBrief, digest.clicks, date);

	const editorial = await runEditorial(cfg, fetched, run.config.trackers, digest, off.enabled);
	const brief = await assembleBrief(editorial, fetched, {
		date,
		sourceCount: fetched.sourcesOk,
		trackers: run.config.trackers,
		// Lambda 没有子请求限额,HN 讨论区查询保留(§8.1)
		lookupDiscussions: true,
	});
	// R3 · 回响在简报成形之后算:它要比对「上一期 vs 这一期」的真实条数
	const echo = buildFeedbackEcho(digest, brief);
	if (echo) brief.feedbackEcho = echo;
	if (off.note) brief.offAxisNote = off.note;
	if (JSON.stringify(off.prefs) !== JSON.stringify(run.config.prefs ?? {})) {
		await store.putConfig(run.email, { ...run.config, prefs: off.prefs, updatedAt: new Date().toISOString() });
	}
	const genCount = await store.putBrief(run.email, brief, bumpGenCount);
	const picked = brief.sections.reduce((n, s) => n + s.items.length, 0);
	return { picked, genCount };
}

// ---------- 单用户模式(立即生成) ----------

async function generateOne(store: Store, cfg: AiConfig, email: string, date: string) {
	const config = await store.getConfig(email);
	if (!config) return response(422, { error: "该用户还没有配置。先在配置页建一个追踪器。" });
	if (activeTrackers(config.trackers).length === 0) {
		return response(422, { error: "没有生效的追踪器,先在配置页建一个。" });
	}
	const fetched = await fetchAllSources(config.sources, DEFAULT_FILTERS, (m) => console.log(`[${email}] ${m}`));
	if (fetched.candidates.length === 0) {
		return response(422, { error: "没有抓到任何时间窗内的候选内容", sourceErrors: fetched.sourceErrors });
	}
	const { picked, genCount } = await produceBrief(store, cfg, { email, config }, fetched, date, true);
	return response(200, {
		ok: true,
		date,
		provider: resolveProvider(cfg),
		picked,
		scanned: fetched.scanned,
		sourceErrors: fetched.sourceErrors,
		genCount,
	});
}

// ---------- 全量模式(每日定时) ----------

/** 并集去重后的一个 feed:抓一次,结果按用户各自的源身份(key/name)回切。 */
interface UnionEntry {
	union: SourceConfig;
	perUser: Map<string, SourceConfig>;
}

async function generateAll(store: Store, cfg: AiConfig, date: string) {
	const emails = await store.listWhitelist();
	const runs: UserRun[] = [];
	for (const email of emails) {
		const config = await store.getConfig(email);
		if (!config) continue; // 在名单里但还没登录过——没有配置就没有简报
		if (activeTrackers(config.trackers).length === 0) continue;
		if (config.sources.every((s) => s.enabled === false)) continue;
		runs.push({ email, config });
	}
	console.log(`[all] whitelist=${emails.length} eligible=${runs.length}`);
	if (runs.length === 0) return response(200, { ok: true, date, users: 0, results: [] });

	// 全体用户源库按 URL 并集去重:每个 feed 只抓一次(§8.1)。union key 取
	// fnv1a(url) 保持确定性;max_items 取各家配置的最大值,谁也不因合并少抓。
	const byUrl = new Map<string, UnionEntry>();
	for (const run of runs) {
		for (const s of run.config.sources) {
			if (s.enabled === false) continue;
			let entry = byUrl.get(s.url);
			if (!entry) {
				entry = { union: { ...s, key: fnv1a(s.url), enabled: undefined }, perUser: new Map() };
				byUrl.set(s.url, entry);
			}
			const cap = s.max_items ?? DEFAULT_FILTERS.max_items_per_feed;
			const unionCap = entry.union.max_items ?? DEFAULT_FILTERS.max_items_per_feed;
			if (cap > unionCap) entry.union.max_items = cap;
			entry.perUser.set(run.email, s);
		}
	}
	const unionSources = [...byUrl.values()].map((e) => e.union);
	const fetched = await fetchAllSources(unionSources, DEFAULT_FILTERS, (m) => console.log(m));

	const byUnionKey = new Map([...byUrl.values()].map((e) => [e.union.key, e]));
	const errorByUnionName = new Map(fetched.sourceErrors.map((e) => [e.name, e.error]));

	const results: Record<string, unknown>[] = [];
	for (const run of runs) {
		try {
			// 按该用户的源身份回切候选池与问责数据(sourceKey/name 换回用户自己的)
			const remap = <T extends { sourceKey?: string; source: string }>(items: T[]): T[] => {
				const out: T[] = [];
				for (const item of items) {
					const entry = item.sourceKey ? byUnionKey.get(item.sourceKey) : undefined;
					const own = entry?.perUser.get(run.email);
					if (own) out.push({ ...item, sourceKey: own.key, source: own.name });
				}
				return out;
			};
			const candidates = remap(fetched.candidates);
			// ruleDropped 没有 sourceKey,按 source 名匹配用户的源(问责区展示用)
			const ownNames = new Set(
				run.config.sources.filter((s) => s.enabled !== false).map((s) => byUrl.get(s.url)?.union.name),
			);
			const ruleDropped = fetched.ruleDropped.filter((d) => ownNames.has(d.source));
			const sourceErrors = run.config.sources
				.filter((s) => s.enabled !== false)
				.flatMap((s) => {
					const unionName = byUrl.get(s.url)?.union.name;
					const error = unionName ? errorByUnionName.get(unionName) : undefined;
					return error ? [{ name: s.name, error }] : [];
				});
			const userFetched: FetchResult = {
				candidates,
				ruleDropped,
				scanned: candidates.length + ruleDropped.length,
				sourcesOk: run.config.sources.filter((s) => s.enabled !== false).length - sourceErrors.length,
				sourceErrors,
			};
			if (candidates.length === 0) {
				console.log(`[all] ${run.email}: no candidates today, skipped`);
				results.push({ email: run.email, ok: false, error: "no candidates" });
				continue;
			}
			const { picked } = await produceBrief(store, cfg, run, userFetched, date, false);
			console.log(`[all] ${run.email}: ok picked=${picked} scanned=${userFetched.scanned}`);
			results.push({ email: run.email, ok: true, picked });
		} catch (err) {
			// 失败隔离(§8.1):一个用户的编辑调用失败不拖累其他用户
			console.error(`[all] ${run.email}: FAILED`, err);
			results.push({ email: run.email, ok: false, error: err instanceof Error ? err.message : String(err) });
		}
	}
	const okCount = results.filter((r) => r.ok).length;
	console.log(`[all] done: ${okCount}/${runs.length} ok`);
	return response(200, { ok: true, date, users: runs.length, generated: okCount, results });
}

// ---------- 入口 ----------

export async function handler(event: GenerateEvent) {
	const payload = parsePayload(event);
	console.log("generate invoked:", JSON.stringify(payload));

	if (process.env.AI_DISABLED === "1") {
		return response(503, { error: "AI is temporarily disabled (AI_DISABLED=1)." });
	}

	let store: Store;
	try {
		store = envStore();
	} catch (err) {
		return response(500, { error: err instanceof Error ? err.message : String(err) });
	}
	const cfg = envAiConfig();
	const date = briefDate(process.env.BRIEF_TZ ?? "America/New_York");

	try {
		if (payload.mode === "all") return await generateAll(store, cfg, date);
		if (payload.email) return await generateOne(store, cfg, payload.email, date);
		return response(400, { error: 'payload must be {"mode":"all"} or {"email":"..."}' });
	} catch (err) {
		if (err instanceof AiError) return response(err.status, { error: err.message });
		if (err instanceof SyntaxError) {
			return response(502, { error: "模型返回的编辑结果不是合法 JSON,请重试。" });
		}
		console.error("generate: unhandled", err);
		return response(500, { error: "generate failed, see CloudWatch logs" });
	}
}
