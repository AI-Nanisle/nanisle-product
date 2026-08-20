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
	SEEN_WINDOW_DAYS,
	activeTrackers,
	applyHealth,
	assembleBrief,
	briefDate,
	buildEditorialPrompt,
	dropSeenCandidates,
	fetchAllSources,
	enrichBrief,
	fnv1a,
	mockEditorial,
	parseEditorialJson,
	seenItemIds,
} from "../src/shared/pipeline-core";
import type { FetchResult, SourceConfig, Tracker } from "../src/shared/pipeline-core";
import { DEFAULT_FILTERS } from "../src/shared/default-sources";
import { AiError, complete, resolveProvider } from "../src/shared/ai";
import type { AiConfig } from "../src/shared/ai";
import { buildFeedbackEcho, feedbackPromptBlock, loadFeedbackDigest } from "../src/shared/feedback";
import type { FeedbackDigest } from "../src/shared/feedback";
import { applyThreads, stripTransient, threadsPromptBlock } from "../src/shared/threads";
import {
	MAX_PROPOSALS_PER_WEEK,
	WEEKLY_WINDOW_DAYS,
	applyProposal,
	computeWeeklyMetrics,
	isCooled,
	isoWeek,
	makeProposals,
	makeSourceAddProposal,
	queryFeedDomains,
} from "../src/shared/weekly";
// probeFeed 只依赖全局 fetch,放在 worker/ 只是历史路径,Lambda 直接用
import { probeFeed } from "../src/worker/feeds";
import { fetchArticleTextNode, resolvePickedGoogleUrls } from "./extract";
import { MAX_CHANGELOG } from "../src/shared/pipeline-core";
import { dynamoStore } from "../src/shared/store-dynamo";
import { renderBriefEmail, sendBriefEmail, unsubToken } from "../src/shared/email";
import type { Store, UserConfig } from "../src/shared/store";
import type { Brief } from "../src/shared/types";
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
		// 编辑 JSON 需要空间,V4 的思考也占同一份输出预算——默认给足,别让截断毁整期
		maxOutputTokens: process.env.AI_MAX_OUTPUT_TOKENS ?? "16384",
		deepseekApiKey: process.env.DEEPSEEK_API_KEY,
		anthropicApiKey: process.env.ANTHROPIC_API_KEY,
		anthropicAuthToken: process.env.ANTHROPIC_AUTH_TOKEN,
		gatewayUrl: process.env.AI_GATEWAY_URL,
		gatewayKey: process.env.AI_GATEWAY_KEY,
	};
}

/**
 * 成稿(enrich)的换模开关:ENRICH_AI_PROVIDER / ENRICH_AI_MODEL 只覆盖成稿
 * 这一段——读者读到的散文全在这里,是换更好模型收益最大的一段;选材 JSON
 * 留给便宜模型。没设就跟主配置走,一切照旧。
 */
function envEnrichAiConfig(base: AiConfig): AiConfig {
	const provider = process.env.ENRICH_AI_PROVIDER;
	const model = process.env.ENRICH_AI_MODEL;
	if (!provider && !model) return base;
	return {
		...base,
		...(provider ? { provider } : {}),
		...(model ? { model } : {}),
		...(process.env.ENRICH_AI_MAX_OUTPUT_TOKENS ? { maxOutputTokens: process.env.ENRICH_AI_MAX_OUTPUT_TOKENS } : {}),
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
	threadsByTracker: Map<string, string>,
): Promise<EditorialResult> {
	if (resolveProvider(cfg) === "mock") return mockEditorial(fetched.candidates, trackers);
	const { system, user } = buildEditorialPrompt(
		fetched.candidates,
		trackers,
		feedbackPromptBlock(digest),
		offAxis,
		threadsByTracker,
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
	/** 成稿段的 AI 配置(ENRICH_* 开关,没设时就是 cfg 本身)。 */
	enrichCfg: AiConfig,
	run: UserRun,
	fetched: FetchResult,
	date: string,
	bumpGenCount: boolean,
	/** H1 · 本轮抓取结果,**已换算成该用户自己的源 key**(全量模式抓的是并集)。 */
	healthByKey: Map<string, { ok: boolean; error?: string }>,
): Promise<{ picked: number; genCount: number; brief: Brief }> {
	// 近期已入选的绝不重复推荐:类目窗口放宽后(blog/podcast 看 7 天),同一篇
	// 长文会连续几天出现在候选池里,这道闸在编辑看到候选之前就把它挡掉。
	// 读取失败只是少了防重复,不该挡当天的简报。
	try {
		const cutoff = new Date(Date.now() - SEEN_WINDOW_DAYS * 86_400_000).toISOString().slice(0, 10);
		const dates = (await store.listBriefDates(run.email)).filter((d) => d >= cutoff && d !== date);
		const prior: Brief[] = [];
		for (const d of dates) {
			const stored = await store.getBrief(run.email, d);
			if (stored) prior.push(stored.brief);
		}
		const dropped = dropSeenCandidates(fetched, seenItemIds(prior));
		if (dropped > 0) console.log(`[${run.email}] [seen] ${dropped} 条近期已入选,不重复推荐`);
	} catch (err) {
		console.log(`[${run.email}] [seen] 读取往期失败,本期不做防重复: ${err}`);
	}

	// R2 · 近 7 天反馈先读出来:它既进选材提示词,也是回响的原料。读失败会
	// 降级成空摘要(见 loadFeedbackDigest),不会让当天的简报生不出来。
	const digest = await loadFeedbackDigest(store, run.email, { log: (m) => console.log(`[${run.email}] ${m}`) });
	// X2 · 上一期的轴外位有没有被点开,决定今天还给不给
	const prevBrief = (await store.getBrief(run.email))?.brief ?? null;
	const off = updateOffAxis(run.config, prevBrief, digest.clicks, date);

	// T3 · 线索台账读出来塞进**本来就要发的那一次**编辑调用,不额外加调用
	const threads = await store.listThreads(run.email);
	const threadsByTracker = new Map<string, string>();
	for (const t of activeTrackers(run.config.trackers)) {
		const block = threadsPromptBlock(
			threads.filter((th) => th.trackerKey === t.key),
			date,
		);
		if (block) threadsByTracker.set(t.key, block);
	}

	const editorial = await runEditorial(cfg, fetched, run.config.trackers, digest, off.enabled, threadsByTracker);
	// 入选条目里的 Google News 跳转链换成原文 URL(id 不变):阅读页、成稿、
	// HN 讨论、每周域名统计从此都落在真实页面上。解析失败保留跳转链,照常降级。
	const pickedIds = new Set([
		...Object.values(editorial.sections).flat().flatMap((p) => [p.id, ...(p.merged ?? [])]),
		...(editorial.offAxis ? [editorial.offAxis.id] : []),
	]);
	await resolvePickedGoogleUrls(fetched.candidates, pickedIds, (m) => console.log(`[${run.email}] ${m}`));
	const brief = await assembleBrief(editorial, fetched, {
		date,
		sourceCount: fetched.sourcesOk,
		trackers: run.config.trackers,
		// Lambda 没有子请求限额,HN 讨论区查询保留(§8.1)
		lookupDiscussions: true,
	});
	// R3 · 回响在简报成形之后算:它要比对「上一期 vs 这一期」的真实条数
	// 第二段 · 成稿:只对已入选的条目取全文,写实质与判断。选材阶段每条只看
	// 800 字,写不出深度;这一次调用才是简报从「标题改写」变成有内容的地方。
	// 正文抽取用 readability(Node 侧注入),成稿模型走 ENRICH_* 开关。
	if (resolveProvider(enrichCfg) !== "mock") {
		await enrichBrief(brief, fetched, run.config.trackers, (system, user) =>
			complete(enrichCfg, { prompt: user, system, json: true }).then((r) => {
				console.log(`[${run.email}] [enrich] via ${r.provider}/${r.model}`);
				return r.text;
			}),
			(m) => console.log(`[${run.email}] ${m}`),
			fetchArticleTextNode,
		);
	}

	// T4/T5 · 并进台账(注记由代码算),再把临时字段抹掉才落库
	const { changed } = applyThreads(brief, threads, date);
	stripTransient(brief);
	for (const thread of changed) await store.putThread(run.email, thread);
	if (changed.length) console.log(`[${run.email}] threads: ${changed.length} updated`);

	const echo = buildFeedbackEcho(digest, brief);
	if (echo) brief.feedbackEcho = echo;
	if (off.note) brief.offAxisNote = off.note;

	// H1 + X2 的配置写回合成一次 putConfig:整存整取的配置写两遍会互相覆盖
	const sources = applyHealth(run.config.sources, healthByKey);
	const prefsChanged = JSON.stringify(off.prefs) !== JSON.stringify(run.config.prefs ?? {});
	const sourcesChanged = JSON.stringify(sources) !== JSON.stringify(run.config.sources);
	if (prefsChanged || sourcesChanged) {
		await store.putConfig(run.email, {
			...run.config,
			sources,
			prefs: off.prefs,
			updatedAt: new Date().toISOString(),
		});
	}
	const genCount = await store.putBrief(run.email, brief, bumpGenCount);
	const picked = brief.sections.reduce((n, s) => n + s.items.length, 0);
	return { picked, genCount, brief };
}

// ---------- E1 · 邮件推送(docs/04) ----------

/** 发信所需的环境齐不齐。没配齐(比如纯 infra 联调部署)就整体静默跳过。 */
function emailEnv(): { from: string; secret: string; appUrl: string } | null {
	const from = process.env.EMAIL_FROM;
	const secret = process.env.EMAIL_UNSUB_SECRET;
	if (!from || !secret) return null;
	return {
		from,
		secret,
		appUrl: (process.env.APP_URL ?? "https://nanisle.com/products/daily-brief").replace(/\/+$/, ""),
	};
}

/**
 * 给一个用户发当日提醒。只在定时全量模式调用——「立即生成」的人就在页面上,
 * 发邮件是打扰。失败只抛给调用方记日志,绝不影响简报落库(刊已经安全)。
 */
async function pushBriefEmail(email: string, brief: Brief): Promise<boolean> {
	const env = emailEnv();
	if (!env) return false;
	const unsubUrl = `${env.appUrl}/api/email/unsub?token=${encodeURIComponent(await unsubToken(env.secret, email))}`;
	const mail = renderBriefEmail({ date: brief.date, tldr: brief.tldr ?? [], appUrl: env.appUrl, unsubUrl });
	await sendBriefEmail(
		{
			region: process.env.AWS_REGION ?? "us-east-1",
			accessKeyId: process.env.AWS_ACCESS_KEY_ID ?? "",
			secretAccessKey: process.env.AWS_SECRET_ACCESS_KEY ?? "",
			sessionToken: process.env.AWS_SESSION_TOKEN,
			from: env.from,
		},
		email,
		mail,
		unsubUrl,
	);
	return true;
}

// ---------- 单用户模式(立即生成) ----------

async function generateOne(store: Store, cfg: AiConfig, enrichCfg: AiConfig, email: string, date: string) {
	const config = await store.getConfig(email);
	if (!config) return response(422, { error: "该用户还没有配置。先在配置页建一个追踪器。" });
	if (activeTrackers(config.trackers).length === 0) {
		return response(422, { error: "没有生效的追踪器,先在配置页建一个。" });
	}
	const fetched = await fetchAllSources(config.sources, DEFAULT_FILTERS, (m) => console.log(`[${email}] ${m}`));
	if (fetched.candidates.length === 0) {
		return response(422, { error: "没有抓到任何时间窗内的候选内容", sourceErrors: fetched.sourceErrors });
	}
	// 单用户模式抓的就是他自己的源,status 的 key 直接可用
	const health = new Map(fetched.sourceStatus.map((s) => [s.key, { ok: s.ok, error: s.error }]));
	const { picked, genCount } = await produceBrief(store, cfg, enrichCfg, { email, config }, fetched, date, true, health);
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

async function generateAll(store: Store, cfg: AiConfig, enrichCfg: AiConfig, date: string) {
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
			// H1 · 并集 key → 该用户自己的源 key,健康才落得对人头上
			const health = new Map<string, { ok: boolean; error?: string }>();
			for (const st of fetched.sourceStatus) {
				const own = byUnionKey.get(st.key)?.perUser.get(run.email);
				if (own) health.set(own.key, { ok: st.ok, error: st.error });
			}
			const userFetched: FetchResult = {
				candidates,
				ruleDropped,
				scanned: candidates.length + ruleDropped.length,
				sourcesOk: run.config.sources.filter((s) => s.enabled !== false).length - sourceErrors.length,
				sourceErrors,
				sourceStatus: [...health].map(([key, st]) => ({ key, ...st })),
			};
			if (candidates.length === 0) {
				// 一条候选都没有也要把健康写回去——「全挂了」正是最该被记下的一天
				const healed = applyHealth(run.config.sources, health);
				if (JSON.stringify(healed) !== JSON.stringify(run.config.sources)) {
					await store.putConfig(run.email, { ...run.config, sources: healed, updatedAt: new Date().toISOString() });
				}
				console.log(`[all] ${run.email}: no candidates today, skipped`);
				results.push({ email: run.email, ok: false, error: "no candidates" });
				continue;
			}
			const { picked, brief } = await produceBrief(store, cfg, enrichCfg, run, userFetched, date, false, health);
			console.log(`[all] ${run.email}: ok picked=${picked} scanned=${userFetched.scanned}`);
			// E1 · 刊已落库,再发提醒邮件。缺省为开(prefs.emailPush !== false);
			// 发信失败只记日志——邮件是门铃,门铃坏了不能把刊也砸了。
			let emailed = false;
			if (run.config.prefs?.emailPush !== false) {
				try {
					emailed = await pushBriefEmail(run.email, brief);
				} catch (err) {
					console.error(`[all] ${run.email}: email FAILED`, err);
				}
			}
			results.push({ email: run.email, ok: true, picked, emailed });
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

// ---------- S1–S4 · 周自评(每周一 07:30) ----------

/**
 * 一个人的一周:先把到期的提案落地(冷却期满 = 沉默即同意),再算指标,
 * 越线才生成新提案。顺序不能反——先落地再算,新一周的数才反映改动后的状态。
 */
async function runWeeklyForUser(store: Store, email: string, now: Date): Promise<Record<string, unknown>> {
	const config = await store.getConfig(email);
	if (!config) return { email, ok: false, error: "no config" };

	// 1. 冷却期满的提案自动生效(S4)。沉默即同意,但每一条都留了 7 天否决窗口。
	const proposals = await store.listProposals(email);
	let working = config;
	const applied: string[] = [];
	for (const p of proposals) {
		if (p.status !== "pending" || !isCooled(p, now)) continue;
		const result = applyProposal(working, p);
		if (result) {
			working = result.config;
			if (result.log) {
				working = {
					...working,
					trackers: working.trackers.map((t) =>
						t.key === result.log!.trackerKey
							? {
									...t,
									changelog: [{ at: now.toISOString(), text: result.log!.text }, ...(t.changelog ?? [])].slice(
										0,
										MAX_CHANGELOG,
									),
								}
							: t,
					),
				};
			}
			applied.push(p.summary);
		}
		await store.putProposal(email, { ...p, status: "applied", decidedAt: now.toISOString() });
	}

	// 2. 指标(S2):纯计算,零 LLM
	const dates = await store.listBriefDates(email);
	const cutoff = new Date(now.getTime() - WEEKLY_WINDOW_DAYS * 86_400_000).toISOString().slice(0, 10);
	const briefs = [];
	for (const date of dates.filter((d) => d >= cutoff).slice(0, 40)) {
		const stored = await store.getBrief(email, date);
		if (stored) briefs.push(stored.brief);
	}
	const events = await store.listEvents(email, new Date(now.getTime() - WEEKLY_WINDOW_DAYS * 86_400_000).toISOString());
	const metrics = computeWeeklyMetrics({ config: working, briefs, events, now });
	await store.putMetrics(email, metrics.week, metrics);

	// 3. 新提案(S3):同一周只生成一次
	const week = isoWeek(now);
	let created: string[] = [];
	if (working.prefs?.lastWeeklyAt !== week) {
		// 每个追踪器连续多少期零命中——和阅读侧 /api/metrics 同一个算法
		const noHitStreak = new Map<string, number>();
		for (const tracker of activeTrackers(working.trackers)) {
			let streak = 0;
			for (const brief of briefs) {
				const section = brief.sections.find((sec) => sec.key === tracker.key);
				if (!section) continue;
				if (section.items.length > 0) break;
				streak++;
			}
			noHitStreak.set(tracker.key, streak);
		}
		const wantedTitles: string[] = [];
		for (const ev of events) {
			if (!("kind" in ev) || ev.kind !== "want") continue;
			const brief = briefs.find((b) => b.date === ev.date);
			const dropped = brief?.filteredOut.items.find((d) => d.id === ev.itemId);
			if (dropped) wantedTitles.push(dropped.title);
		}
		let seq = 0;
		const fresh = makeProposals({
			config: working,
			metrics,
			noHitStreak,
			wantedTitles,
			now,
			idSeed: () => `${week}-${seq++}`,
		});
		// 已经挂着的同款提案不重复生成——否则每周都堆一遍,谁都不看了
		const pendingKeys = new Set(
			proposals.filter((p) => p.status === "pending").map((p) => JSON.stringify(p.patch)),
		);
		for (const p of fresh) {
			if (pendingKeys.has(JSON.stringify(p.patch))) continue;
			await store.putProposal(email, p);
			created.push(p.summary);
		}

		// 观察式发现(docs/02 §7.3 第 4 层):检索源反复带回同一个域名,说明那个
		// 站就是用户要的具体源。纯统计选出域名,真实试抓通过才成为提案——
		// 反捏造纪律和向导一致:没抓通的 URL 不会出现在用户面前。
		if (created.length < MAX_PROPOSALS_PER_WEEK) {
			for (const found of queryFeedDomains(working, briefs).slice(0, 2)) {
				if (created.length >= MAX_PROPOSALS_PER_WEEK) break;
				try {
					const probe = await probeFeed(found.domain);
					if (!probe.ok) continue;
					const proposal = makeSourceAddProposal(found, probe, working, metrics, now, `${week}-${seq++}`);
					if (!proposal || pendingKeys.has(JSON.stringify(proposal.patch))) continue;
					await store.putProposal(email, proposal);
					created.push(proposal.summary);
				} catch (err) {
					console.log(`[weekly] ${email}: probe ${found.domain} FAILED: ${err}`);
				}
			}
		}
		working = { ...working, prefs: { ...(working.prefs ?? {}), lastWeeklyAt: week } };
	}

	if (JSON.stringify(working) !== JSON.stringify(config)) {
		await store.putConfig(email, { ...working, updatedAt: now.toISOString() });
	}
	console.log(`[weekly] ${email}: applied=${applied.length} created=${created.length} briefs=${briefs.length}`);
	return { email, ok: true, week, applied, created, briefs: briefs.length };
}

async function generateWeekly(store: Store, now: Date) {
	const emails = await store.listWhitelist();
	const results: Record<string, unknown>[] = [];
	for (const email of emails) {
		try {
			results.push(await runWeeklyForUser(store, email, now));
		} catch (err) {
			console.error(`[weekly] ${email}: FAILED`, err);
			results.push({ email, ok: false, error: err instanceof Error ? err.message : String(err) });
		}
	}
	return response(200, { ok: true, mode: "weekly", week: isoWeek(now), users: emails.length, results });
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
	const enrichCfg = envEnrichAiConfig(cfg);
	const date = briefDate(process.env.BRIEF_TZ ?? "America/New_York");

	try {
		if (payload.mode === "weekly") return await generateWeekly(store, new Date());
		if (payload.mode === "all") return await generateAll(store, cfg, enrichCfg, date);
		if (payload.email) return await generateOne(store, cfg, enrichCfg, payload.email, date);
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
