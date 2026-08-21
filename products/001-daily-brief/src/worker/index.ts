// 产品 Worker 的路由层(docs/02-技术方案.md §2、§5)。职责边界:管「人访问
// 产品」——门禁、配置读写、阅读、埋点、把重活转调给 AWS 侧的 generate Lambda。
// 一切个人数据经 Store 接缝按会话邮箱隔离;生成的重活不在这里跑(§3)。

import { Hono } from "hono";
import type { Context } from "hono";
import { deleteCookie, getCookie, setCookie } from "hono/cookie";
import { AiError, complete, resolveProvider } from "../shared/ai";
import {
	SESSION_COOKIE,
	adminGuard,
	appUrl,
	loginUrl,
	sessionEmail,
	siteUrl,
	userAiGuard,
	userGuard,
} from "./guard";
import type { Guarded } from "./guard";
import { signToken, verifyToken } from "./sso";
import { aiConfig } from "./env";
import type { AppEnv } from "./env";
import type { Brief, FeedbackEvent, FeedbackKind } from "../shared/types";
import { ISSUE_ITEM_ID } from "../shared/types";
import {
	activeTrackers,
	applyHealth,
	applySameStoryMerges,
	assembleBrief,
	clusterSameStory,
	enrichBrief,
	briefDate,
	buildEditorialPrompt,
	fetchAllSources,
	fnv1a,
	MAX_CHANGELOG,
	isQueryFeedUrl,
	isUnhealthy,
	mockEditorial,
	parseEditorialJson,
} from "../shared/pipeline-core";
import { TASTE_MAX_CHARS, maybeDistillTaste, tastePromptBlock } from "../shared/taste";
import type { SourceConfig, TrackerSourceRule } from "../shared/pipeline-core";
import { buildFeedbackEcho, feedbackPromptBlock, loadFeedbackDigest } from "../shared/feedback";
import { applyEventToNote } from "../shared/notes";
import { applyThreads, computeStage, sortThreadsForDisplay, stripTransient, threadsPromptBlock } from "../shared/threads";
import { PROPOSAL_COOLING_DAYS, applyProposal } from "../shared/weekly";
import { DEFAULT_FILTERS } from "../shared/default-sources";
import { clickEvent, lambdaClient } from "../shared/store-dynamo";
import {
	MAX_SOURCES,
	bumpSourceMetrics,
	cleanSources,
	cleanTrackers,
	loadConfig,
	saveSources,
	saveTrackers,
} from "./config";
import { awsConfigured, makeStore } from "./store-kv";
import { verifyUnsubToken } from "../shared/email";
import { DISCOVERY_MIN_CLICKS, DISCOVERY_WINDOW_DAYS, QUOTA_LIMITS, genStepWriter, offAxisEnabled } from "../shared/store";
import type { GenRun, Store } from "../shared/store";
import { probeFeed } from "./feeds";
import { wizardRefine, wizardSources, wizardTags, wizardUnderstand } from "./wizard";
import type { WizardContext, WizardResult } from "./wizard";

const app = new Hono<Guarded>();
const PRODUCT_MOUNT = "/products/daily-brief/";

const DATE_RE = /^\d{4}-\d{2}-\d{2}$/;

// 每日额度的两句文案(上限值本身在 shared/store.ts 的 QUOTA_LIMITS)。
// 两句都不带「失败」字样:这不是故障,是预期内的刹车(F7)。
const GEN_LIMIT_MSG = `今日立即生成次数已用完(${QUOTA_LIMITS.gen} 次/日)。明早定时生成照常;调参明天继续。`;
const AI_LIMIT_MSG = `今日编辑调用次数已用完(${QUOTA_LIMITS.ai} 次/日)。已经写好的定义照常生效,明早的简报不受影响。`;

app.get("/api/health", async (c) => {
	let provider = "invalid";
	try {
		provider = resolveProvider(aiConfig(c.env));
	} catch {
		// leave "invalid" — misconfigured AI_PROVIDER shouldn't take health down
	}
	// email 只回显调用方自己 cookie 里的身份(未登录 = null),不泄露别人的。
	// 配置页拿它和 store 一起显示「我这会儿在读写谁的、哪儿的数据」——
	// 本地 KV 和线上 DynamoDB 长得一模一样,不标出来就会把本地改动当成已上线。
	const email = await sessionEmail(c.env, getCookie(c, SESSION_COOKIE));
	return c.json({
		ok: true,
		provider,
		store: awsConfigured(c.env) ? "dynamo" : "kv",
		email,
		// 页眉(react-app/SiteChrome.tsx)用这两个拼主站导航和「登录」按钮:
		// 主站地址只有服务端知道(本地 dev 是 :3000,线上是 nanisle.com)。
		site: siteUrl(c.env),
		loginUrl: loginUrl(c.env),
		ssoConfigured: Boolean(c.env.NANISLE_SSO_SECRET),
		generateConfigured: Boolean(c.env.GENERATE_URL && awsConfigured(c.env)),
	});
});

// 主站登录手递的落点(主站侧:nanisle 仓 web/app/api/launch/[slug]/route.ts)。
// 验证主站签的短时 token,查白名单(§5.1:准入判断全在产品侧,主站只负责
// 「已登录就手递」),通过才换成本域的长会话 cookie。会话本身就是签名 token,
// 无服务端状态,30 天后自然过期、重走一遍手递即可。
const SESSION_TTL_S = 30 * 24 * 3600;

/**
 * 会话 cookie 的作用域。种下和删除必须完全一致,所以只写一次。
 * 本地 wrangler dev 走 http,Secure cookie 种不上,按协议区分。
 */
function sessionCookieScope(env: AppEnv): { path: string; secure: boolean } {
	const url = new URL(appUrl(env));
	return {
		path: url.pathname.replace(/\/+$/, "") || "/",
		secure: url.protocol === "https:",
	};
}

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
	const scope = sessionCookieScope(c.env);
	setCookie(c, SESSION_COOKIE, session, {
		path: scope.path,
		httpOnly: true,
		sameSite: "Lax",
		secure: scope.secure,
		maxAge: SESSION_TTL_S,
	});
	return c.redirect(appUrl(c.env, "config"), 302);
});

// 退出登录。主站那边的 better-auth 会话由页眉先同源 POST /api/auth/sign-out
// 清掉,这里只管本产品这一份——两边一起退,才不会出现「回主站还是登录态」
// 或者「产品里还能继续读」。清完把人送回南屿首页。
app.get("/auth/logout", (c) => {
	const scope = sessionCookieScope(c.env);
	// 删除必须和种下时同作用域(path/secure),否则浏览器留着旧 cookie 不放
	deleteCookie(c, SESSION_COOKIE, {
		path: scope.path,
		httpOnly: true,
		sameSite: "Lax",
		secure: scope.secure,
	});
	return c.redirect(siteUrl(c.env), 302);
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

/**
 * 今日额度读数(§8.3)。额度是产品的一部分,不是暗处的刹车——读者该在用完
 * 之前就看见还剩多少,而不是点下去才被 429 拦住。走 userGuard 不走 userAiGuard:
 * 看读数本身不花 token,AI 总闸关着时这一行也该照常显示。
 */
app.get("/api/usage", userGuard, async (c) => {
	const date = briefDate(c.env.BRIEF_TZ ?? "America/New_York");
	const used = await c.get("store").getQuota(c.get("email"), date);
	return c.json({
		date,
		gen: { used: used.gen, limit: QUOTA_LIMITS.gen },
		ai: { used: used.ai, limit: QUOTA_LIMITS.ai },
	});
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
	// R5 · 刊级反馈(「今天有什么本该知道却没出现」)用哨兵 itemId,它没有条目
	// 可指,所以必须自带内容——空的哨兵事件对选材毫无用处,不如不收。
	if (itemId === ISSUE_ITEM_ID && (kind !== "text" || typeof text !== "string" || !text.trim())) {
		return c.json({ error: "issue-level feedback must be kind=text with non-empty text" }, 400);
	}
	const event: FeedbackEvent = {
		date,
		itemId,
		kind: kind as FeedbackKind,
		...(typeof text === "string" && text.trim() ? { text: text.trim() } : {}),
		at: new Date().toISOString(),
	};
	const store = c.get("store");
	const email = c.get("email");
	await store.appendEvent(email, event);
	// N1 · 同一条反馈同时落想法台账:事件是写给选材模型的(90 天过期),台账是
	// 读者自己回溯用的(不过期,自带快照)。台账写坏了不拦反馈本身——事件已
	// 落地,选材照常;只有回看少一条,下一条反馈还有机会补账。
	try {
		const existing = await store.getNote(email, date, itemId);
		// 快照只在建账时抄;刊级反馈没有条目可查,别为它白读一次简报
		const brief =
			existing || itemId === ISSUE_ITEM_ID ? null : ((await store.getBrief(email, date))?.brief ?? null);
		await store.putNote(email, applyEventToNote(existing, event, brief));
	} catch (err) {
		console.error("feedback: note ledger write failed", err);
	}
	return c.json({ ok: true });
});

// N3 · 想法台账的读口:整页一次拉回(新账在前,MAX_NOTES_READ 封顶),搜索
// 和过滤都在前端做——几百条的量级不值得为它设计服务端分页与检索。
app.get("/api/notes", userGuard, async (c) => {
	return c.json({ notes: await c.get("store").listNotes(c.get("email")) });
});

// X2 · 轴外位开关 + E1 · 邮件提醒开关。护栏之二:读者随时能关(关掉就真的没有)。
// 轴外位手动打开时一并清零未点击计数——重新表态了,不该背着上一轮的账。
app.put("/api/prefs", userGuard, async (c) => {
	let body: { offAxis?: unknown; emailPush?: unknown };
	try {
		body = await c.req.json();
	} catch {
		return c.json({ error: "Body must be JSON." }, 400);
	}
	const hasOffAxis = body.offAxis !== undefined;
	const hasEmailPush = body.emailPush !== undefined;
	if (!hasOffAxis && !hasEmailPush) return c.json({ error: "nothing to update" }, 400);
	if (hasOffAxis && typeof body.offAxis !== "boolean") return c.json({ error: "offAxis must be a boolean" }, 400);
	if (hasEmailPush && typeof body.emailPush !== "boolean") return c.json({ error: "emailPush must be a boolean" }, 400);
	const store = c.get("store");
	const email = c.get("email");
	const config = await loadConfig(store, email);
	const prefs = {
		...(config.prefs ?? {}),
		...(hasOffAxis ? { offAxis: body.offAxis as boolean, ...(body.offAxis ? { offAxisMisses: 0 } : {}) } : {}),
		...(hasEmailPush ? { emailPush: body.emailPush as boolean } : {}),
	};
	await store.putConfig(email, { ...config, prefs, updatedAt: new Date().toISOString() });
	return c.json({ ok: true, prefs });
});

app.get("/api/prefs", userGuard, async (c) => {
	const config = await loadConfig(c.get("store"), c.get("email"));
	return c.json({ prefs: config.prefs ?? {} });
});

// R9 · 口味画像:编辑对读者长期口味的书面理解,读者可查看、可改写——
// 和追踪定义档案同一条信任链:选材依据必须是看得见、改得动的。
app.get("/api/taste", userGuard, async (c) => {
	const config = await loadConfig(c.get("store"), c.get("email"));
	return c.json({ taste: config.taste ?? null });
});

app.put("/api/taste", userGuard, async (c) => {
	let body: { summary?: unknown };
	try {
		body = await c.req.json();
	} catch {
		return c.json({ error: "Body must be JSON." }, 400);
	}
	if (typeof body.summary !== "string") return c.json({ error: "summary must be a string" }, 400);
	const summary = body.summary.trim().slice(0, TASTE_MAX_CHARS);
	const store = c.get("store");
	const email = c.get("email");
	const config = await loadConfig(store, email);
	// 清空 = 删掉画像,编辑从零重新攒;改过的画像带 edited 标记,重蒸馏时
	// 其中的明确偏好按纪律保留(shared/taste.ts)。
	const taste = summary
		? {
				summary,
				updatedAt: new Date().toISOString(),
				distilledFrom: config.taste?.distilledFrom ?? 0,
				edited: true,
			}
		: undefined;
	await store.putConfig(email, { ...config, taste, updatedAt: new Date().toISOString() });
	return c.json({ ok: true, taste: taste ?? null });
});

// E1 · 一键退订(docs/04)。免登录:邮件可能在手机上被点开,那里没有会话。
// 身份靠 HMAC token(Lambda 发信时签的),不靠 cookie;GET 给人看确认页,
// POST 给 Gmail 的原生一键退订(List-Unsubscribe-Post)。都是幂等的置 false。
async function unsubscribe(c: Context<Guarded>): Promise<{ ok: boolean; status: 200 | 400 | 503 }> {
	const secret = c.env.EMAIL_UNSUB_SECRET;
	if (!secret) return { ok: false, status: 503 };
	const email = await verifyUnsubToken(secret, c.req.query("token") ?? "");
	if (!email) return { ok: false, status: 400 };
	const { store } = makeStore(c.env);
	// 只动已有配置:没配置的人本来就收不到邮件(generateAll 会跳过),
	// 也别为一次退订点击凭空建出一份带默认源的配置。
	const config = await store.getConfig(email);
	if (config) {
		await store.putConfig(email, {
			...config,
			prefs: { ...(config.prefs ?? {}), emailPush: false },
			updatedAt: new Date().toISOString(),
		});
	}
	return { ok: true, status: 200 };
}

app.get("/api/email/unsub", async (c) => {
	const result = await unsubscribe(c);
	const body = result.ok
		? "<p>已退订每日邮件提醒。</p><p>简报照常每天生成,随时回网页看;想恢复提醒,去配置页重新打开即可。</p>"
		: result.status === 503
			? "<p>退订功能未启用。</p>"
			: "<p>退订链接无效或已损坏。</p><p>你也可以登录后在配置页关闭邮件提醒。</p>";
	return c.html(
		`<!doctype html><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>南屿简报</title>
<div style="max-width:480px;margin:80px auto;padding:0 20px;font-family:-apple-system,'PingFang SC','Microsoft YaHei',sans-serif;color:#1a1a1a;line-height:1.8;">
<p style="font-size:12px;letter-spacing:0.08em;color:#999;">南屿简报</p>${body}
<p><a href="${appUrl(c.env, "config")}" style="color:#1a1a1a;">前往配置页 →</a></p></div>`,
		result.status,
	);
});

// Gmail 的一键退订是服务端发的 POST,不渲染页面,只看状态码。
app.post("/api/email/unsub", async (c) => {
	const result = await unsubscribe(c);
	return c.json({ ok: result.ok }, result.status);
});

// R6 · 反馈导出:自己的数据自己拿得走(想喂给别的模型做整理就喂)。只导本人的,
// 走 userGuard;事件 TTL 90 天,所以这里能拿到的就是全部还活着的历史。
app.get("/api/export", userGuard, async (c) => {
	const days = Math.min(Math.max(Number.parseInt(c.req.query("days") ?? "90", 10) || 90, 1), 90);
	const email = c.get("email");
	const store = c.get("store");
	const digest = await loadFeedbackDigest(store, email, { days });
	return c.json({
		email,
		exportedAt: new Date().toISOString(),
		since: digest.since,
		notes: digest.notes,
		clicks: [...digest.clicks].map(([itemId, count]) => ({ itemId, count })),
	});
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

	// H4 · 带上域名:H5 的「你这个月点了 6 次 xxx.com」按它聚合
	await store.appendEvent(email ?? "anonymous", clickEvent(date, id, url));
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
	let body: { sources?: unknown; trackerKey?: unknown; rules?: unknown; origin?: unknown };
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
		const givenName = typeof s.name === "string" ? s.name.trim().slice(0, 100) : "";
		const url = typeof s.url === "string" ? s.url.trim() : "";
		const category = s.category as SourceConfig["category"];
		if (!url || url.length > 500 || !["news", "macro", "blog", "podcast", "paper"].includes(category)) {
			failed.push({ name: givenName || "?", url, error: "字段不完整" });
			continue;
		}
		const probe = await probeFeed(url);
		if (!probe.ok) {
			failed.push({ name: givenName || "?", url, error: probe.error ?? "试抓失败" });
			continue;
		}
		// 名称留空时回填 feed 自报标题,兜底用域名——用户不必先替源想好名字
		let name = givenName || (probe.title ?? "").trim().slice(0, 100);
		if (!name) {
			try {
				name = new URL(probe.url).hostname;
			} catch {
				name = probe.url.slice(0, 100);
			}
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
	// 仪表:只有 AI 候选卡的「加入」带 origin=candidate;手动/目录添加不算采纳
	if (body.origin === "candidate" && adopted.length > 0) {
		await bumpSourceMetrics(store, email, { adopted: adopted.length });
	}
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

// ---------- 找源仪表(docs/02 §7.3):三个数判断找源机制是否够用 ----------
// 候选采纳率来自 CONFIG 里的累计计数;无命中天数和查询源占比从近 14 期简报
// 现算——不加写路径,Lambda 生成端零改动,老简报缺 sourceKey 时按源名回退匹配。

/** 仪表窗口:近多少期简报。14 期 = 每次请求最多 14 次点查,偶发的仪表页读得起。 */
const METRICS_WINDOW = 14;

app.get("/api/metrics", userGuard, async (c) => {
	const store = c.get("store");
	const email = c.get("email");
	const config = await loadConfig(store, email);
	const dates = (await store.listBriefDates(email)).slice(0, METRICS_WINDOW);

	const urlByKey = new Map(config.sources.map((s) => [s.key, s.url]));
	const urlByName = new Map(config.sources.map((s) => [s.name, s.url]));
	const trackerStats = new Map(
		activeTrackers(config.trackers).map((t) => [
			t.key,
			{ key: t.key, name: t.name, briefs: 0, noHitStreak: 0, streakEnded: false, lastHitDate: null as string | null },
		]),
	);
	let totalItems = 0;
	let queryItems = 0;

	// dates 已是倒序(最新在前),无命中连续天数从最新一期往回数
	for (const date of dates) {
		const stored = await store.getBrief(email, date);
		if (!stored) continue;
		for (const section of stored.brief.sections) {
			for (const item of section.items) {
				totalItems++;
				const url = (item.sourceKey && urlByKey.get(item.sourceKey)) || urlByName.get(item.source);
				if (url && isQueryFeedUrl(url)) queryItems++;
			}
			const stat = trackerStats.get(section.key);
			if (!stat) continue;
			stat.briefs++;
			if (section.items.length > 0) {
				stat.streakEnded = true;
				if (!stat.lastHitDate) stat.lastHitDate = stored.brief.date;
			} else if (!stat.streakEnded) {
				stat.noHitStreak++;
			}
		}
	}

	return c.json({
		window: { briefs: dates.length, from: dates.at(-1) ?? null, to: dates[0] ?? null },
		candidates: config.metrics ?? { shown: 0, adopted: 0 },
		selection: { total: totalItems, query: queryItems },
		trackers: [...trackerStats.values()].map(({ streakEnded: _ignored, ...rest }) => rest),
		// H2 · 坏掉的源必须是个看得见的数,不能只躺在 config 里
		unhealthy: config.sources.filter((s) => s.enabled !== false && isUnhealthy(s)).length,
	});
});

// S4 · 提案的否决权。冷却期里随时能一键否掉,也能不等 7 天直接生效——
// 「沉默即同意」的前提是**开口就一定管用**,否则那只是强加。
app.get("/api/proposals", userGuard, async (c) => {
	const all = await c.get("store").listProposals(c.get("email"));
	const pending = all
		.filter((p) => p.status === "pending")
		.sort((a, b) => a.createdAt.localeCompare(b.createdAt));
	return c.json({ proposals: pending, coolingDays: PROPOSAL_COOLING_DAYS });
});

app.post("/api/proposals/:id", userGuard, async (c) => {
	const id = c.req.param("id");
	let body: { action?: unknown };
	try {
		body = await c.req.json();
	} catch {
		return c.json({ error: "Body must be JSON." }, 400);
	}
	const action = body.action === "apply" || body.action === "dismiss" ? body.action : null;
	if (!action) return c.json({ error: 'action must be "apply" or "dismiss"' }, 400);

	const store = c.get("store");
	const email = c.get("email");
	const proposal = (await store.listProposals(email)).find((p) => p.id === id);
	if (!proposal) return c.json({ error: "没有这条提案" }, 404);
	if (proposal.status !== "pending") return c.json({ error: "这条提案已经处理过了" }, 409);

	const now = new Date().toISOString();
	if (action === "dismiss") {
		await store.putProposal(email, { ...proposal, status: "dismissed", decidedAt: now });
		return c.json({ ok: true, status: "dismissed" });
	}

	const config = await loadConfig(store, email);
	const result = applyProposal(config, proposal);
	if (result) {
		const next = result.log
			? {
					...result.config,
					trackers: result.config.trackers.map((t) =>
						t.key === result.log!.trackerKey
							? {
									...t,
									changelog: [{ at: now, text: result.log!.text }, ...(t.changelog ?? [])].slice(0, MAX_CHANGELOG),
								}
							: t,
					),
				}
			: result.config;
		await store.putConfig(email, { ...next, updatedAt: now });
	}
	await store.putProposal(email, { ...proposal, status: "applied", decidedAt: now });
	return c.json({ ok: true, status: "applied", changed: Boolean(result) });
});

// T6 · 线索台账。追踪定义档案的「事态」节读它——这一节才让「追踪定义档案」
// 名副其实:看得见一个问题从第一次出现到今天是怎么走的。
app.get("/api/threads", userGuard, async (c) => {
	const trackerKey = c.req.query("tracker");
	const store = c.get("store");
	const threads = await store.listThreads(c.get("email"), trackerKey || undefined);
	const today = briefDate(c.env.BRIEF_TZ ?? "America/New_York");
	const live = threads.filter((t) => !t.archived);
	return c.json({
		threads: sortThreadsForDisplay(live, today).map((t) => ({ ...t, stage: computeStage(t, today) })),
		archived: threads.length - live.length,
	});
});

// H3 · 一键自愈:对连续失败的源重跑发现,给出可用的替代 URL 交用户确认。
// 不自动改配置——换源是语义变化(同一个站的不同栏目内容可能完全不同),
// 必须过人眼。能力全是现成的(probeFeed 的自动发现 + P0-3 的检索式退路),
// 缺的只是这个触发器:用户永远不会来报告「我的 feed 挂了」。
app.post("/api/sources/heal", userAiGuard, async (c) => {
	let body: { key?: unknown };
	try {
		body = await c.req.json();
	} catch {
		return c.json({ error: "Body must be JSON." }, 400);
	}
	const key = typeof body.key === "string" ? body.key.trim() : "";
	if (!key) return c.json({ error: "key required" }, 400);
	const config = await loadConfig(c.get("store"), c.get("email"));
	const source = config.sources.find((s) => s.key === key);
	if (!source) return c.json({ error: "没有这个源" }, 404);

	const tried: { url: string; error: string }[] = [];

	// 1. 原 URL 再试一次:很多失败是暂时的,先别急着换
	const again = await probeFeed(source.url);
	if (again.ok) {
		return c.json({ ok: true, verdict: "recovered", message: "原地址这次抓通了,大概率是上游临时故障。", probe: again });
	}
	tried.push({ url: source.url, error: again.error ?? "抓取失败" });

	// 2. 站点首页重跑 feed 自动发现:换栏目/换 CMS 最常见
	let origin = "";
	try {
		origin = new URL(source.url).origin;
	} catch {
		// URL 都不合法,直接走第 3 步
	}
	if (origin && origin !== source.url) {
		const rediscovered = await probeFeed(origin);
		if (rediscovered.ok && rediscovered.url !== source.url) {
			return c.json({
				ok: true,
				verdict: "rediscovered",
				message: "这个站换地址了,下面是重新发现的 feed——确认后替换。",
				candidate: { name: source.name, url: rediscovered.url, category: source.category },
				probe: rediscovered,
				tried,
			});
		}
		if (!rediscovered.ok) tried.push({ url: origin, error: rediscovered.error ?? "抓取失败" });
	}

	// 3. 退路:用源名做 Google News 检索源(P0-3 同款),至少不断供
	const host = origin ? new URL(origin).hostname.replace(/^www\./, "") : source.name;
	const zh = /[一-龥]/.test(source.name);
	const query = `site:${host} OR ${source.name}`;
	const fallback = `https://news.google.com/rss/search?q=${encodeURIComponent(query)}&hl=${zh ? "zh-CN&gl=CN&ceid=CN:zh-Hans" : "en-US&gl=US&ceid=US:en"}`;
	const probe = await probeFeed(fallback);
	return c.json({
		ok: probe.ok,
		verdict: probe.ok ? "fallback" : "dead",
		message: probe.ok
			? "原站抓不到了,这是一条按站名构造的检索源——内容会杂一些,但不断供。"
			: "原地址、站点发现、检索源三条路都不通。建议直接删掉这个源。",
		...(probe.ok ? { candidate: { name: `${source.name}(检索)`, url: probe.url, category: source.category } } : {}),
		probe,
		tried,
	});
});

// H5 · 从点击反向发现源。比模型凭空推荐可信一个量级:它说的是「你真的点过
// 这个站 6 次」,而数据早在 v1 的 /go 埋点里就攒着了。只提议,不自动加。
app.get("/api/sources/discovered", userGuard, async (c) => {
	const store = c.get("store");
	const email = c.get("email");
	const config = await loadConfig(store, email);
	const digest = await loadFeedbackDigest(store, email, { days: DISCOVERY_WINDOW_DAYS });

	const known = new Set<string>();
	for (const s of config.sources) {
		try {
			known.add(new URL(s.url).hostname.replace(/^www\./, "").toLowerCase());
		} catch {
			// 配置里混进了非法 URL,跳过即可
		}
	}
	// 查询源(Google News / HN / Reddit)的域名是聚合器自己,点击落在原文域名上,
	// 所以这里天然不会把已订的查询源重复提议出来。
	const byHost = new Map<string, number>();
	for (const ev of digest.clickEvents) {
		if (!ev.host || known.has(ev.host)) continue;
		byHost.set(ev.host, (byHost.get(ev.host) ?? 0) + 1);
	}
	const dismissed = new Set(config.prefs?.dismissedHosts ?? []);
	const candidates = [...byHost]
		.filter(([host, n]) => n >= DISCOVERY_MIN_CLICKS && !dismissed.has(host))
		.sort((a, b) => b[1] - a[1])
		.slice(0, 5)
		.map(([host, clicks]) => ({ host, clicks }));
	return c.json({ windowDays: DISCOVERY_WINDOW_DAYS, minClicks: DISCOVERY_MIN_CLICKS, candidates });
});

// 「不用管这个站」——记进 prefs,别再提议它
app.post("/api/sources/dismiss-host", userGuard, async (c) => {
	let body: { host?: unknown };
	try {
		body = await c.req.json();
	} catch {
		return c.json({ error: "Body must be JSON." }, 400);
	}
	const host = typeof body.host === "string" ? body.host.trim().toLowerCase().slice(0, 200) : "";
	if (!host) return c.json({ error: "host required" }, 400);
	const store = c.get("store");
	const email = c.get("email");
	const config = await loadConfig(store, email);
	const dismissedHosts = [...new Set([...(config.prefs?.dismissedHosts ?? []), host])].slice(-100);
	await store.putConfig(email, {
		...config,
		prefs: { ...(config.prefs ?? {}), dismissedHosts },
		updatedAt: new Date().toISOString(),
	});
	return c.json({ ok: true });
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
	const store = c.get("store");
	const email = c.get("email");
	// 额度先占位再调模型(§8.3)。四个编辑端点共用一个日计数器,按请求粗粒度
	// 计——wizard/sources 偶尔会重试第二次调用,不额外计一笔:这道闸防的是
	// 失控脚本,不是正常人的手速。占位放在解析 body 之后:格式错的请求不该扣额度。
	// 模型报错也不退还——token 已经花了,退还等于给「失败就疯狂重试」放行。
	const quota = await store.reserveQuota(email, briefDate(c.env.BRIEF_TZ ?? "America/New_York"), "ai");
	if (!quota.ok) return c.json({ error: AI_LIMIT_MSG }, 429);
	const ctx: WizardContext = { store, email, ai: aiConfig(c.env) };
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

/**
 * 一趟生成实测约 4-5 分钟(deepseek-v4-pro 选材 + 成稿两次大输入调用),
 * Lambda 自身的天花板是 15 分钟(infra/lib/daily-brief-stack.ts)。进度记录
 * 超过这个岁数还没收尾、也没见到新简报落库,就判这趟已死:status 报失败,
 * 并发闸放行下一次点火。判早了代价只是一句错话(简报落库后真相自己浮出来),
 * 判晚了是把人白白闸在门外,所以取实测的两倍多一点。
 */
const GEN_RUNNING_MAX_MS = 10 * 60_000;
/**
 * 转调在这个时间之内就断,基本是「请求根本没送进 Lambda」(URL 错、签名错、
 * 拒连),可以放心退额度;比它更晚才断的是边缘 ~100s 超时——Lambda 其实还在
 * 跑,简报稍后会自己落库,这时既不退钱也不判死,把收尾交给落库推断。
 */
const GEN_FAST_FAIL_MS = 15_000;

type GenOutcome = { status: number; body: Record<string, unknown> };

/**
 * 一趟生成的当前真相。进度记录没有 finishedAt 不一定是还在跑:waitUntil 可能
 * 在 Lambda 回话前就被回收,收尾记录永远写不上。所以拿简报落库时间对照——
 * generatedAt >= startedAt 即这趟已成;两头都没有且过了 GEN_RUNNING_MAX_MS,
 * 才判失败。POST 的并发闸和 GET status 都从这里读,别各自另写一套。
 */
async function resolveGenState(
	store: Store,
	email: string,
): Promise<{ state: "idle" | "running" | "done" | "failed"; run?: GenRun }> {
	const run = await store.getGenRun(email);
	if (!run) return { state: "idle" };
	if (run.finishedAt) return { state: run.ok ? "done" : "failed", run };
	const stored = await store.getBrief(email);
	if (stored && stored.generatedAt >= run.startedAt) return { state: "done", run };
	// 判死的时钟从最近一次进度写入起算,不是起跑:进度还在走就没死
	if (Date.now() - new Date(run.updatedAt ?? run.startedAt).getTime() > GEN_RUNNING_MAX_MS) {
		return {
			state: "failed",
			run: { ...run, error: "这次生成一直没有回音,多半已经失败,请再试一次。" },
		};
	}
	return { state: "running", run };
}

/** 生产路径:转调 Lambda 并等它回话(在 waitUntil 里跑)。null = 边缘断开但 Lambda 多半还在跑,别写收尾。 */
async function generateViaLambda(
	env: AppEnv,
	store: Store,
	email: string,
	today: string,
	startedAt: string,
): Promise<GenOutcome | null> {
	const t0 = Date.now();
	let res: Response;
	try {
		// runStartedAt = 进度记录的键:Lambda 每过一个分段就写回 GENRUN,
		// 前端轮询 status 才有「第 X/5 步」可显示
		res = await invokeGenerate(env, { email, runStartedAt: startedAt });
	} catch (err) {
		console.error("generate: lambda invoke failed", err);
		if (Date.now() - t0 > GEN_FAST_FAIL_MS) return null;
		// 快速失败 = 请求没送进 Lambda,一个 token 都没花,把刚占的额度退回去
		await store.refundQuota(email, today, "gen").catch((e) => console.error("generate: refund failed", e));
		return { status: 502, body: { error: "生成服务暂时不可用,请稍后重试。" } };
	}
	const body = (await res.json().catch(() => null)) as Record<string, unknown> | null;
	if (!res.ok || !body) {
		console.error("generate: lambda returned", res.status, JSON.stringify(body)?.slice(0, 500));
		// 边缘超时以 5xx 空壳响应的形态出现(没有 JSON 体):同上,Lambda 还在跑
		if (!body && res.status >= 500 && Date.now() - t0 > GEN_FAST_FAIL_MS) return null;
		// 422 是「没有生效的追踪器 / 今天没抓到候选」——Lambda 在这三种情况下
		// 都是**调模型之前**就返回的,零 token,退还。其余状态码一律不退:
		// 它跑过了,钱可能已经花在半截的管线上。
		if (res.status === 422) {
			await store.refundQuota(email, today, "gen").catch((e) => console.error("generate: refund failed", e));
		}
		const error = typeof body?.error === "string" ? body.error : "生成失败,请稍后重试。";
		return { status: 502, body: { error } };
	}
	return { status: 200, body };
}

/** 后台跑完一趟生成,把收尾写回进度记录(写不上也不要紧,resolveGenState 会用落库时间兜底)。 */
async function performGenerate(
	env: AppEnv,
	store: Store,
	email: string,
	today: string,
	startedAt: string,
): Promise<void> {
	let outcome: GenOutcome | null;
	try {
		outcome =
			env.GENERATE_URL && awsConfigured(env)
				? await generateViaLambda(env, store, email, today, startedAt)
				: await generateInline(env, store, email, today, startedAt);
	} catch (err) {
		console.error("generate: run failed", err);
		outcome = { status: 500, body: { error: "生成失败,请稍后重试。" } };
	}
	if (!outcome) return;
	const ok = outcome.status < 400 && outcome.body.ok === true;
	const b = outcome.body;
	await store
		.putGenRun(email, {
			startedAt,
			finishedAt: new Date().toISOString(),
			ok,
			...(ok
				? {
						result: {
							date: typeof b.date === "string" ? b.date : today,
							picked: typeof b.picked === "number" ? b.picked : 0,
							scanned: typeof b.scanned === "number" ? b.scanned : 0,
							...(Array.isArray(b.sourceErrors) && b.sourceErrors.length > 0
								? { sourceErrors: b.sourceErrors as { name: string; error: string }[] }
								: {}),
						},
					}
				: { error: typeof b.error === "string" ? b.error : `生成失败(HTTP ${outcome.status})。` }),
		})
		.catch((err) => console.error("generate: record finish failed", err));
}

app.post("/api/generate", userAiGuard, async (c) => {
	const env = c.env;
	const store = c.get("store");
	const email = c.get("email");
	const today = briefDate(env.BRIEF_TZ ?? "America/New_York");

	// 并发闸:同一人已有一趟在跑就不再点火(一趟 = 完整管线,全站最贵的动作),
	// 也不占额度。前端拿到 409 会转去盯已有那趟的进度。
	const existing = await resolveGenState(store, email);
	if (existing.state === "running") {
		return c.json(
			{ error: "已有一次生成正在进行。", running: true, startedAt: existing.run?.startedAt },
			409,
		);
	}

	// 限额:**先占位后干活**(§8.3)。原子自增 + 判上限在同一个 DynamoDB 条件
	// 写里。旧版是「读计数 → 转调 Lambda 等几分钟 → Lambda 结束时才自增」,
	// 那期间并发打进来的请求会全部读到同一个旧计数、全部通过检查,10 次/日的
	// 闸门在一次并发爆发面前形同虚设——而这是全站最贵的端点。
	const quota = await store.reserveQuota(email, today, "gen");
	if (!quota.ok) return c.json({ error: GEN_LIMIT_MSG }, 429);

	// 立即 202,活儿转后台(和下面 generate-all 同一个道理:一趟要几分钟,
	// 同步等待会先撞上边缘 ~100s 超时,响应没人收得到,还诱导重试翻倍计费)。
	// 进度先落库:刷新页面的人靠 GET /api/generate/status 把进度接回去,
	// 转圈不再是浏览器内存里一刷就没的幻觉。
	const startedAt = new Date().toISOString();
	await store.putGenRun(email, { startedAt });
	c.executionCtx.waitUntil(
		performGenerate(env, store, email, today, startedAt).catch((err) =>
			console.error("generate: background run failed", err),
		),
	);
	return c.json({ ok: true, startedAt, genUsed: quota.used }, 202);
});

// 进度查询(前端每几秒轮询一次)。走 userGuard 不走 userAiGuard:看进度不花
// token,和 /api/usage 一个道理。
app.get("/api/generate/status", userGuard, async (c) => {
	const { state, run } = await resolveGenState(c.get("store"), c.get("email"));
	return c.json({
		state,
		...(run?.startedAt ? { startedAt: run.startedAt } : {}),
		...(run?.progress ? { progress: run.progress } : {}),
		...(run?.result ? { result: run.result } : {}),
		...(run?.error ? { error: run.error } : {}),
	});
});

// dev / fork 回落:无 AWS 时在 Worker 里直跑(通常 mock 模式)。生成逻辑
// 的生产版本只在 pipeline/lambda.ts 维护,这里只为零配置演示保底。
async function generateInline(
	env: AppEnv,
	store: Store,
	email: string,
	today: string,
	startedAt: string,
): Promise<GenOutcome> {
	// 分段点与 Lambda 的 produceBrief 一一对应,前端看到的五步在两条路上一致
	const onStep = genStepWriter(store, email, startedAt, (m) => console.log(m));
	const config = await loadConfig(store, email);
	// 和 Lambda 的 generateOne 一样先挡一道:草稿追踪器(带 stage)不参与生成,
	// 只有草稿时直接说清楚,别产出一份空简报让人以为是选材失败
	if (activeTrackers(config.trackers).length === 0) {
		// 同 Lambda 路径:还没调过模型,额度退还
		await store.refundQuota(email, today, "gen").catch((e) => console.error("generate: refund failed", e));
		return { status: 422, body: { error: "没有生效的追踪器——向导走完三步、点「完成」之后才会参与生成。" } };
	}
	await onStep(1); // 抓取信息源
	const fetched = await fetchAllSources(config.sources, DEFAULT_FILTERS, (m) => console.log(m));
	if (fetched.candidates.length === 0) {
		await store.refundQuota(email, today, "gen").catch((e) => console.error("generate: refund failed", e));
		return {
			status: 422,
			body: { error: "没有抓到任何时间窗内的候选内容", sourceErrors: fetched.sourceErrors },
		};
	}

	const cfg = aiConfig(env);
	let provider = "mock";
	try {
		provider = resolveProvider(cfg);
	} catch (err) {
		if (err instanceof AiError) return { status: 500, body: { error: err.message } };
		throw err;
	}

	// R2/T3 · dev/fork 回落路径要和 Lambda 走同一套:反馈回路、线索台账、源健康
	// 一个都不能少。这条路是「fork 零配置跑通全流程」的保证,也是本地验证新
	// 生成逻辑的唯一入口——它和生产分叉,本地就永远测不到真正会上线的行为。
	await onStep(2); // 按追踪定义选材(含反馈摘要、口味画像等准备)
	const digest = await loadFeedbackDigest(store, email, { log: (m) => console.log(m) });
	const threads = await store.listThreads(email);
	const threadsByTracker = new Map<string, string>();
	for (const t of activeTrackers(config.trackers)) {
		const block = threadsPromptBlock(
			threads.filter((th) => th.trackerKey === t.key),
			today,
		);
		if (block) threadsByTracker.set(t.key, block);
	}

	// R9 · 口味画像(和 Lambda 同一套):攒够新反馈就重蒸馏,失败沿用旧的
	let taste = config.taste;
	if (provider !== "mock") {
		const fresh = await maybeDistillTaste(store, email, config, {
			call: (system, user) =>
				complete({ ...cfg, maxOutputTokens: "2048" }, { prompt: user, system, json: true }).then((r) => r.text),
			log: (m) => console.log(m),
		});
		if (fresh) taste = fresh;
	}

	// 同事件归簇(和 Lambda 同一套):主报道进提示词,其余选中后并回 merged
	const { primaries, mergedByPrimary } = clusterSameStory(fetched.candidates);

	let editorial;
	if (provider === "mock") {
		editorial = mockEditorial(primaries, config.trackers);
	} else {
		const { system, user } = buildEditorialPrompt(
			primaries,
			config.trackers,
			feedbackPromptBlock(digest),
			offAxisEnabled(config),
			threadsByTracker,
			tastePromptBlock(taste),
		);
		// The editorial JSON needs room; never let the default 1024 cap truncate it.
		const cap = Number.parseInt(env.AI_MAX_OUTPUT_TOKENS ?? "", 10);
		const genCfg = { ...cfg, maxOutputTokens: String(Number.isFinite(cap) && cap >= 2048 ? cap : 4096) };
		try {
			const result = await complete(genCfg, { prompt: user, system, json: true });
			editorial = parseEditorialJson(result.text, config.trackers);
		} catch (err) {
			if (err instanceof AiError) return { status: err.status, body: { error: err.message } };
			if (err instanceof SyntaxError) {
				return { status: 502, body: { error: "模型返回的编辑结果不是合法 JSON,请重试。" } };
			}
			console.error("generate: upstream error", err);
			return { status: 502, body: { error: "上游 AI 错误,请稍后重试。" } };
		}
	}
	applySameStoryMerges(editorial, mergedByPrimary);

	await onStep(3); // 解析原文链接(这条路没有 gn 还原,只有组装)
	const brief = await assembleBrief(editorial, fetched, {
		date: today,
		sourceCount: fetched.sourcesOk,
		trackers: config.trackers,
		// 免费档子请求预算留给抓取;讨论区链接是 Lambda 路径的事
		lookupDiscussions: false,
	});
	// 第二段 · 成稿(和 Lambda 同一套)。免费档子请求预算:抓原文最多 10 次,
	// 加上抓源本身仍在 50 以内;真超了 fetchArticleText 会静默失败退回摘要。
	await onStep(4); // 抓取原文并成稿
	if (provider !== "mock") {
		await enrichBrief(brief, fetched, config.trackers, (system, user) =>
			complete({ ...cfg, maxOutputTokens: "4096" }, { prompt: user, system, json: true }).then((r) => r.text),
			(m) => console.log(m),
		);
	}

	await onStep(5); // 写回台账与落库
	// T4/T5 · 并进台账(注记由代码算),临时字段抹掉才落库
	const { changed } = applyThreads(brief, threads, today);
	stripTransient(brief);
	for (const thread of changed) await store.putThread(email, thread);

	const echo = buildFeedbackEcho(digest, brief);
	if (echo) brief.feedbackEcho = echo;

	// H1 + R9 · 源健康与口味画像一并写回:整存整取的配置分两次写会互相覆盖
	const healed = applyHealth(config.sources, new Map(fetched.sourceStatus.map((st) => [st.key, st])));
	const tasteChanged = JSON.stringify(taste ?? null) !== JSON.stringify(config.taste ?? null);
	if (tasteChanged || JSON.stringify(healed) !== JSON.stringify(config.sources)) {
		await store.putConfig(email, {
			...config,
			sources: healed,
			...(taste ? { taste } : {}),
			updatedAt: new Date().toISOString(),
		});
	}

	await store.putBrief(email, brief);

	const picked = brief.sections.reduce((n, s) => n + s.items.length, 0);
	return {
		status: 200,
		body: {
			ok: true,
			date: brief.date,
			provider,
			picked,
			scanned: fetched.scanned,
			sourceErrors: fetched.sourceErrors,
		},
	};
}

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
