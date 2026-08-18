// 产品 Worker 的路由层(docs/02-技术方案.md §2、§5)。职责边界:管「人访问
// 产品」——门禁、配置读写、阅读、埋点、把重活转调给 AWS 侧的 generate Lambda。
// 一切个人数据经 Store 接缝按会话邮箱隔离;生成的重活不在这里跑(§3)。

import { Hono } from "hono";
import type { Context } from "hono";
import { getCookie, setCookie } from "hono/cookie";
import { AiError, complete, resolveProvider } from "../shared/ai";
import {
	SESSION_COOKIE,
	adminGuard,
	appUrl,
	loginUrl,
	sessionEmail,
	userAiGuard,
	userGuard,
} from "./guard";
import type { Guarded } from "./guard";
import { signToken, verifyToken } from "./sso";
import { aiConfig } from "./env";
import type { AppEnv } from "./env";
import type { Brief, FeedbackEvent, FeedbackKind } from "../shared/types";
import {
	assembleBrief,
	briefDate,
	buildEditorialPrompt,
	fetchAllSources,
	fnv1a,
	mockEditorial,
	parseEditorialJson,
} from "../shared/pipeline-core";
import type { SourceConfig, TrackerSourceRule } from "../shared/pipeline-core";
import { DEFAULT_FILTERS } from "../shared/default-sources";
import { lambdaClient } from "../shared/store-dynamo";
import { MAX_SOURCES, cleanSources, cleanTrackers, loadConfig, saveSources, saveTrackers } from "./config";
import { awsConfigured, makeStore } from "./store-kv";
import { probeFeed } from "./feeds";
import { wizardRefine, wizardSources, wizardTags, wizardUnderstand } from "./wizard";
import type { WizardContext, WizardResult } from "./wizard";

const app = new Hono<Guarded>();
const PRODUCT_MOUNT = "/products/daily-brief/";

const DATE_RE = /^\d{4}-\d{2}-\d{2}$/;

/** 立即生成限额:10 次/人/日(docs/02 §8.3)。 */
const GEN_LIMIT = 10;
const GEN_LIMIT_MSG = `今日立即生成次数已用完(${GEN_LIMIT} 次/日)。明早定时生成照常;调参明天继续。`;

app.get("/api/health", (c) => {
	let provider = "invalid";
	try {
		provider = resolveProvider(aiConfig(c.env));
	} catch {
		// leave "invalid" — misconfigured AI_PROVIDER shouldn't take health down
	}
	return c.json({
		ok: true,
		provider,
		store: awsConfigured(c.env) ? "dynamo" : "kv",
		ssoConfigured: Boolean(c.env.NANISLE_SSO_SECRET),
		generateConfigured: Boolean(c.env.GENERATE_URL && awsConfigured(c.env)),
	});
});

// 主站登录手递的落点(主站侧:nanisle 仓 web/app/api/launch/[slug]/route.ts)。
// 验证主站签的短时 token,查白名单(§5.1:准入判断全在产品侧,主站只负责
// 「已登录就手递」),通过才换成本域的长会话 cookie。会话本身就是签名 token,
// 无服务端状态,30 天后自然过期、重走一遍手递即可。
const SESSION_TTL_S = 30 * 24 * 3600;

app.get("/auth/sso", async (c) => {
	const secret = c.env.NANISLE_SSO_SECRET;
	// 没配共享密钥的实例本来就不做登录门禁,直接回配置页
	if (!secret) return c.redirect(appUrl(c.env, "config"), 302);
	const payload = await verifyToken(secret, c.req.query("token") ?? "");
	if (!payload) {
		// 不自动跳回主站重签:两边密钥配错时会陷入 302 死循环,这里停下来说清楚
		return c.html(
			`<!doctype html><meta charset="utf-8"><body style="font-family:sans-serif;max-width:28em;margin:15vh auto;line-height:1.9">` +
				`<p>登录链接无效或已过期。</p>` +
				`<p><a href="${loginUrl(c.env)}">回南屿重新打开产品 →</a></p></body>`,
			401,
		);
	}
	// 白名单准入:不在名单就停在说明页,不发会话(§5.1)。
	const { store } = makeStore(c.env);
	if (!(await store.isWhitelisted(payload.email))) {
		return c.html(
			`<!doctype html><meta charset="utf-8"><title>内测中 · 每日简报</title>` +
				`<body style="font-family:sans-serif;max-width:28em;margin:15vh auto;line-height:1.9">` +
				`<h1 style="font-size:1.2em">产品内测中</h1>` +
				`<p>每日简报目前按邀请开放。你已成功登录南屿账号(${payload.email}),但还不在内测名单里。</p>` +
				`<p>想试用请联系站长开通;开通后重新打开本页即可。</p>` +
				`<p><a href="${(c.env.NANISLE_URL ?? "https://nanisle.com").replace(/\/+$/, "")}">← 回南屿</a></p></body>`,
			403,
		);
	}
	const session = await signToken(secret, {
		email: payload.email,
		exp: Math.floor(Date.now() / 1000) + SESSION_TTL_S,
	});
	const cookiePath = new URL(appUrl(c.env)).pathname.replace(/\/+$/, "") || "/";
	setCookie(c, SESSION_COOKIE, session, {
		path: cookiePath,
		httpOnly: true,
		sameSite: "Lax",
		// 本地 wrangler dev 走 http,Secure cookie 种不上,按协议区分
		secure: new URL(appUrl(c.env)).protocol === "https:",
		maxAge: SESSION_TTL_S,
	});
	return c.redirect(appUrl(c.env, "config"), 302);
});

// ---------- 阅读 ----------

app.get("/api/brief", userGuard, async (c) => {
	const date = c.req.query("date");
	if (date && !DATE_RE.test(date)) {
		return c.json({ error: "date must be YYYY-MM-DD" }, 400);
	}
	const stored = await c.get("store").getBrief(c.get("email"), date);
	if (stored) return c.json(stored.brief);
	// 还没有任何一期:404 + noBrief 标记,前端据此渲染空态(区别于普通错误)
	if (!date) return c.json({ error: "No brief yet", noBrief: true }, 404);
	return c.json({ error: "No brief for that date" }, 404);
});

app.get("/api/dates", userGuard, async (c) => {
	return c.json({ dates: await c.get("store").listBriefDates(c.get("email")) });
});

const FEEDBACK_KINDS: FeedbackKind[] = ["up", "down", "known", "more", "text", "want"];

app.post("/api/feedback", userGuard, async (c) => {
	let body: { date?: unknown; itemId?: unknown; kind?: unknown; text?: unknown };
	try {
		body = await c.req.json();
	} catch {
		return c.json({ error: "Body must be JSON." }, 400);
	}
	const { date, itemId, kind, text } = body;
	if (typeof date !== "string" || !DATE_RE.test(date)) {
		return c.json({ error: "date must be YYYY-MM-DD" }, 400);
	}
	if (typeof itemId !== "string" || itemId.length === 0 || itemId.length > 64) {
		return c.json({ error: "itemId required" }, 400);
	}
	if (typeof kind !== "string" || !FEEDBACK_KINDS.includes(kind as FeedbackKind)) {
		return c.json({ error: "kind must be up | down | known | more | text | want" }, 400);
	}
	if (text !== undefined && (typeof text !== "string" || text.length > 2000)) {
		return c.json({ error: "text must be a string ≤2000 chars" }, 400);
	}
	const event: FeedbackEvent = {
		date,
		itemId,
		kind: kind as FeedbackKind,
		...(typeof text === "string" && text.trim() ? { text: text.trim() } : {}),
		at: new Date().toISOString(),
	};
	await c.get("store").appendEvent(c.get("email"), event);
	return c.json({ ok: true });
});

// Every outbound link in the UI goes through here: click-through is the
// zero-effort implicit signal the ranking will feed on (v2+). Then 302 to
// the real URL. Unguarded: a plain <a> can't carry headers — but same-site
// navigation carries the session cookie, so有会话就认人、没有记 anonymous(§5.2)。
app.get("/go/:date/:id", async (c) => {
	const { date, id } = c.req.param();
	if (!DATE_RE.test(date)) return c.json({ error: "Bad date" }, 400);
	const { store } = makeStore(c.env);
	const email = await sessionEmail(c.env, getCookie(c, SESSION_COOKIE));

	let brief: Brief | null = null;
	if (email) brief = (await store.getBrief(email, date))?.brief ?? null;
	if (!brief) return c.json({ error: "Unknown brief" }, 404);

	let url: string | undefined;
	for (const section of brief.sections) {
		for (const item of section.items) {
			if (item.id === id) url = item.url;
		}
	}
	if (!url) {
		for (const dropped of brief.filteredOut.items) {
			if (dropped.id === id) url = dropped.url;
		}
	}
	if (!url) return c.json({ error: "Unknown item" }, 404);

	await store.appendEvent(email ?? "anonymous", { date, itemId: id, at: new Date().toISOString() });
	return c.redirect(url, 302);
});

// ---------- config: sources & trackers (per user, the web UI is the source of truth) ----------

app.get("/api/sources", userGuard, async (c) => {
	const config = await loadConfig(c.get("store"), c.get("email"));
	return c.json({ sources: config.sources });
});

app.put("/api/sources", userGuard, async (c) => {
	let body: { sources?: unknown };
	try {
		body = await c.req.json();
	} catch {
		return c.json({ error: "Body must be JSON: {\"sources\": [...]}" }, 400);
	}
	const cleaned = cleanSources(body.sources);
	if ("error" in cleaned) return c.json({ error: cleaned.error }, 400);
	await saveSources(c.get("store"), c.get("email"), cleaned.sources);
	return c.json({ ok: true, count: cleaned.sources.length });
});

// Verified add: probe (with feed discovery) first, persist only what parsed.
// Used by the config panel's manual add and the proposal cards' 添加 button.
app.post("/api/sources/add", userGuard, async (c) => {
	let body: { sources?: unknown; trackerKey?: unknown; rules?: unknown };
	try {
		body = await c.req.json();
	} catch {
		return c.json({ error: "Body must be JSON: {\"sources\": [...]}" }, 400);
	}
	if (!Array.isArray(body.sources) || body.sources.length === 0 || body.sources.length > 8) {
		return c.json({ error: "sources must be a non-empty array (max 8)" }, 400);
	}
	const store = c.get("store");
	const email = c.get("email");
	const config = await loadConfig(store, email);
	const current = config.sources;
	const trackers = config.trackers;
	const trackerKey = typeof body.trackerKey === "string" ? body.trackerKey.trim() : "";
	const tracker = trackerKey ? trackers.find((item) => item.key === trackerKey) : undefined;
	if (trackerKey && !tracker) return c.json({ error: "trackerKey 不存在" }, 400);
	const rawRules = Array.isArray(body.rules) ? (body.rules as Record<string, unknown>[]) : [];
	const added: SourceConfig[] = [];
	const adopted: SourceConfig[] = [];
	const failed: { name: string; url: string; error: string }[] = [];
	for (const s of body.sources as Record<string, unknown>[]) {
		const name = typeof s.name === "string" ? s.name.trim().slice(0, 100) : "";
		const url = typeof s.url === "string" ? s.url.trim() : "";
		const category = s.category as SourceConfig["category"];
		if (!name || !url || url.length > 500 || !["news", "macro", "blog", "podcast", "paper"].includes(category)) {
			failed.push({ name: name || "?", url, error: "字段不完整" });
			continue;
		}
		const probe = await probeFeed(url);
		if (!probe.ok) {
			failed.push({ name, url, error: probe.error ?? "试抓失败" });
			continue;
		}
		const key = fnv1a(probe.url);
		let source = current.find((x) => x.key === key || x.url === probe.url);
		if (source && !tracker) {
			failed.push({ name, url: probe.url, error: "已在配置里" });
			continue;
		}
		if (!source && current.length >= MAX_SOURCES) {
			failed.push({ name, url: probe.url, error: `源数量已达上限 ${MAX_SOURCES}` });
			continue;
		}
		if (!source) {
			source = { key, name, url: probe.url, category };
			current.push(source);
			added.push(source);
		}
		adopted.push(source);
		if (tracker) {
			tracker.sourceMode = "selected";
			tracker.sourceKeys = [...new Set([...(tracker.sourceKeys ?? []), source.key])];
			tracker.rejectedSourceUrls = (tracker.rejectedSourceUrls ?? []).filter(
				(url) => url !== s.url && url !== probe.url,
			);
			const rawRule = rawRules.find((rule) => rule.url === s.url || rule.url === probe.url);
			const cleanList = (value: unknown) =>
				Array.isArray(value)
					? [...new Set(value.filter((item): item is string => typeof item === "string").map((item) => item.trim().slice(0, 40)).filter(Boolean))].slice(0, 12)
					: [];
			const include = cleanList(rawRule?.include);
			const exclude = cleanList(rawRule?.exclude);
			tracker.sourceRules = (tracker.sourceRules ?? []).filter((rule) => rule.sourceKey !== source.key);
			if (include.length || exclude.length) {
				const rule: TrackerSourceRule = {
					sourceKey: source.key,
					...(include.length ? { include } : {}),
					...(exclude.length ? { exclude } : {}),
				};
				tracker.sourceRules.push(rule);
			}
		}
	}
	if (added.length > 0) await saveSources(store, email, current);
	if (tracker && adopted.length > 0) await saveTrackers(store, email, trackers);
	return c.json({ ok: true, added, adopted, failed, sources: current, trackers });
});

// Try one feed and preview what it currently returns — the review step
// before a source earns its place in the list.
app.post("/api/sources/test", userGuard, async (c) => {
	let url: unknown;
	try {
		({ url } = await c.req.json<{ url?: unknown }>());
	} catch {
		return c.json({ error: "Body must be JSON: {\"url\": \"...\"}" }, 400);
	}
	if (typeof url !== "string" || url.trim().length === 0 || url.length > 500) {
		return c.json({ error: "url required" }, 400);
	}
	// probeFeed also runs feed discovery, so a homepage URL works here too.
	return c.json(await probeFeed(url, 15_000));
});

app.get("/api/trackers", userGuard, async (c) => {
	const config = await loadConfig(c.get("store"), c.get("email"));
	return c.json({ trackers: config.trackers });
});

app.put("/api/trackers", userGuard, async (c) => {
	let body: { trackers?: unknown };
	try {
		body = await c.req.json();
	} catch {
		return c.json({ error: "Body must be JSON: {\"trackers\": [...]}" }, 400);
	}
	const cleaned = cleanTrackers(body.trackers);
	if ("error" in cleaned) return c.json({ error: cleaned.error }, 400);
	await saveTrackers(c.get("store"), c.get("email"), cleaned.trackers);
	return c.json({ ok: true, count: cleaned.trackers.length });
});

// ---------- 三步向导与「对编辑说一句」(B11-B14,docs/02 §6.3、§7) ----------
// 旧的 /api/chat 工具循环已随 chat.ts 一起退役。

type WizardHandler = (ctx: WizardContext, body: unknown) => Promise<WizardResult>;

async function runWizard(c: Context<Guarded>, fn: WizardHandler) {
	let body: unknown;
	try {
		body = await c.req.json();
	} catch {
		return c.json({ error: "Body must be JSON." }, 400);
	}
	const ctx: WizardContext = { store: c.get("store"), email: c.get("email"), ai: aiConfig(c.env) };
	try {
		const result = await fn(ctx, body);
		return c.json(result.body, result.status);
	} catch (err) {
		if (err instanceof AiError) return c.json({ error: err.message }, err.status as 502);
		if (err instanceof SyntaxError) {
			return c.json({ error: "模型返回的结果不是合法 JSON,请重试。" }, 502);
		}
		console.error("wizard: upstream error", err);
		return c.json({ error: "上游 AI 错误,请稍后重试。" }, 502);
	}
}

app.post("/api/wizard/understand", userAiGuard, (c) => runWizard(c, wizardUnderstand));
app.post("/api/wizard/tags", userAiGuard, (c) => runWizard(c, wizardTags));
app.post("/api/wizard/sources", userAiGuard, (c) => runWizard(c, wizardSources));
app.post("/api/refine", userAiGuard, (c) => runWizard(c, wizardRefine));

// ---------- 立即生成(B9,docs/02 §8.2 的调参回路) ----------

/** IAM 签名转调 generate Lambda 的 Function URL(AWS_IAM 鉴权,公网扫不到裸端点)。 */
async function invokeGenerate(env: AppEnv, payload: Record<string, unknown>): Promise<Response> {
	const aws = lambdaClient({
		region: env.AWS_REGION ?? "us-east-1",
		accessKeyId: env.AWS_ACCESS_KEY_ID!,
		secretAccessKey: env.AWS_SECRET_ACCESS_KEY!,
	});
	return aws.fetch(env.GENERATE_URL!, {
		method: "POST",
		headers: { "content-type": "application/json" },
		body: JSON.stringify(payload),
	});
}

app.post("/api/generate", userAiGuard, async (c) => {
	const env = c.env;
	const store = c.get("store");
	const email = c.get("email");
	const today = briefDate(env.BRIEF_TZ ?? "America/New_York");

	// 限额先查(§8.3):Lambda 里 putBrief 原子自增,这里读到的是已用次数
	const current = await store.getBrief(email, today);
	if ((current?.genCount ?? 0) >= GEN_LIMIT) {
		return c.json({ error: GEN_LIMIT_MSG }, 429);
	}

	// 生产路径:转调 Lambda,同步等结果(30-60 秒;Worker 等子请求不计 CPU)
	if (env.GENERATE_URL && awsConfigured(env)) {
		let res: Response;
		try {
			res = await invokeGenerate(env, { email });
		} catch (err) {
			console.error("generate: lambda invoke failed", err);
			return c.json({ error: "生成服务暂时不可用,请稍后重试。" }, 502);
		}
		const body = (await res.json().catch(() => null)) as Record<string, unknown> | null;
		if (!res.ok || !body) {
			console.error("generate: lambda returned", res.status, JSON.stringify(body)?.slice(0, 500));
			const error = typeof body?.error === "string" ? body.error : "生成失败,请稍后重试。";
			return c.json({ error }, 502);
		}
		return c.json(body);
	}

	// dev / fork 回落:无 AWS 时在 Worker 里直跑(通常 mock 模式)。生成逻辑
	// 的生产版本只在 pipeline/lambda.ts 维护,这里只为零配置演示保底。
	const config = await loadConfig(store, email);
	const fetched = await fetchAllSources(config.sources, DEFAULT_FILTERS, (m) => console.log(m));
	if (fetched.candidates.length === 0) {
		return c.json(
			{ error: "没有抓到任何时间窗内的候选内容", sourceErrors: fetched.sourceErrors },
			422,
		);
	}

	const cfg = aiConfig(env);
	let provider = "mock";
	try {
		provider = resolveProvider(cfg);
	} catch (err) {
		if (err instanceof AiError) return c.json({ error: err.message }, 500);
		throw err;
	}

	let editorial;
	if (provider === "mock") {
		editorial = mockEditorial(fetched.candidates, config.trackers);
	} else {
		const { system, user } = buildEditorialPrompt(fetched.candidates, config.trackers);
		// The editorial JSON needs room; never let the default 1024 cap truncate it.
		const cap = Number.parseInt(env.AI_MAX_OUTPUT_TOKENS ?? "", 10);
		const genCfg = { ...cfg, maxOutputTokens: String(Number.isFinite(cap) && cap >= 2048 ? cap : 4096) };
		try {
			const result = await complete(genCfg, { prompt: user, system, json: true });
			editorial = parseEditorialJson(result.text, config.trackers);
		} catch (err) {
			if (err instanceof AiError) return c.json({ error: err.message }, err.status as 500);
			if (err instanceof SyntaxError) return c.json({ error: "模型返回的编辑结果不是合法 JSON,请重试。" }, 502);
			console.error("generate: upstream error", err);
			return c.json({ error: "上游 AI 错误,请稍后重试。" }, 502);
		}
	}

	const brief = await assembleBrief(editorial, fetched, {
		date: today,
		sourceCount: fetched.sourcesOk,
		trackers: config.trackers,
		// 免费档子请求预算留给抓取;讨论区链接是 Lambda 路径的事
		lookupDiscussions: false,
	});
	const genCount = await store.putBrief(email, brief, true);

	const picked = brief.sections.reduce((n, s) => n + s.items.length, 0);
	return c.json({
		ok: true,
		date: brief.date,
		provider,
		picked,
		scanned: fetched.scanned,
		sourceErrors: fetched.sourceErrors,
		genCount,
	});
});

// 手动触发全量生成(站长凭证;白名单增删走主仓 infra/ 的脚本,不开 API)。
// 全量生成是分钟级任务(每用户一次 LLM 调用,串行):同步等待会先撞上边缘
// ~100s 超时,Lambda 却继续跑完、产出没人读的响应,还诱导重试翻倍计费。
// 所以后台触发、立即 202;结果看 CloudWatch(Lambda 日志)。waitUntil 若被
// 提前回收也无妨——Lambda 收到请求后自己会跑完,丢的只是这行日志。
app.post("/api/admin/generate-all", adminGuard, async (c) => {
	if (!(c.env.GENERATE_URL && awsConfigured(c.env))) {
		return c.json({ error: "此实例未配置 generate Lambda(GENERATE_URL / AWS 凭证)。" }, 501);
	}
	c.executionCtx.waitUntil(
		invokeGenerate(c.env, { mode: "all" })
			.then(async (res) =>
				console.log("generate-all:", res.status, await res.text().catch(() => "")),
			)
			.catch((err) => console.error("generate-all: lambda invoke failed", err)),
	);
	return c.json({ accepted: true, note: "已在后台触发全量生成,结果见 Lambda 日志。" }, 202);
});

app.notFound(async (c) => {
	const path = new URL(c.req.url).pathname;
	const dynamicPrefix = /^\/(?:api|auth|go)(?:\/|$)/;
	if ((c.req.method === "GET" || c.req.method === "HEAD") && !dynamicPrefix.test(path)) {
		// Production assets live at unmounted paths (dist/client root) with SPA
		// fallback, so the unmounted URL is the primary. The vite dev asset
		// server is base-aware instead — it 302/404s unmounted paths — so retry
		// with the mount prefix before giving up (dev-only in practice).
		const res = await c.env.ASSETS.fetch(c.req.raw);
		if (res.status !== 302 && res.status !== 404) return res;
		const url = new URL(c.req.url);
		url.pathname = `${PRODUCT_MOUNT.replace(/\/$/, "")}${url.pathname}`;
		return c.env.ASSETS.fetch(new Request(url, c.req.raw));
	}
	return c.json({ error: "Not found" }, 404);
});

/** Accept both the Worker's native root paths and the public nanisle.com mount. */
function unmountRequest(request: Request): Request {
	const url = new URL(request.url);
	if (!url.pathname.startsWith(PRODUCT_MOUNT)) return request;
	url.pathname = `/${url.pathname.slice(PRODUCT_MOUNT.length)}`;
	return new Request(url, request);
}

export default {
	fetch(request, env, ctx) {
		return app.fetch(unmountRequest(request), env, ctx);
	},
} satisfies ExportedHandler<AppEnv>;
