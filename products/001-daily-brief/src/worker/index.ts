import { Hono } from "hono";
import { setCookie } from "hono/cookie";
import { AiError, complete, resolveProvider } from "./ai";
import { SESSION_COOKIE, accessGuard, aiGuard, appUrl, loginUrl, ownerGuard, safeEqual } from "./guard";
import { signToken, verifyToken } from "./sso";
import type { AppEnv } from "./env";
import type { Brief, FeedbackEvent, FeedbackKind } from "../shared/types";
import { SAMPLE_BRIEF } from "./sample-brief";
import {
	assembleBrief,
	briefDate,
	buildEditorialPrompt,
	fetchAllSources,
	fnv1a,
	mockEditorial,
	parseEditorialJson,
} from "../shared/pipeline-core";
import type { SourceConfig } from "../shared/pipeline-core";
import { DEFAULT_FILTERS } from "../shared/default-sources";
import { MAX_SOURCES, cleanFocus, cleanSources, getFocus, getSources, saveFocus, saveSources } from "./config";
import { probeFeed } from "./feeds";
import { chatStream, parseChatBody } from "./chat";

const app = new Hono<{ Bindings: AppEnv }>();
const PRODUCT_MOUNT = "/products/daily-brief/";

const DATE_RE = /^\d{4}-\d{2}-\d{2}$/;

async function loadBrief(env: AppEnv, date?: string): Promise<Brief | null> {
	let key: string | null = null;
	if (date) {
		if (!DATE_RE.test(date)) return null;
		key = `brief:${date}`;
	} else {
		const latest = await env.BRIEFS.get("brief:latest");
		if (latest && DATE_RE.test(latest)) key = `brief:${latest}`;
	}
	if (!key) return null;
	const raw = await env.BRIEFS.get(key);
	return raw ? (JSON.parse(raw) as Brief) : null;
}

app.get("/api/health", (c) => {
	let provider = "invalid";
	try {
		provider = resolveProvider(c.env);
	} catch {
		// leave "invalid" — misconfigured AI_PROVIDER shouldn't take health down
	}
	return c.json({
		ok: true,
		provider,
		accessCodeRequired: Boolean(c.env.ACCESS_CODE),
		ssoConfigured: Boolean(c.env.NANISLE_SSO_SECRET),
		ingestConfigured: Boolean(c.env.INGEST_TOKEN),
	});
});

// 主站登录手递的落点（主站侧：nanisle 仓 web/app/api/launch/[slug]/route.ts）。
// 验证主站签的短时 token，换成本域的长会话 cookie，然后回首页。
// 会话本身就是签名 token，无服务端状态，30 天后自然过期、重走一遍手递即可。
const SESSION_TTL_S = 30 * 24 * 3600;

app.get("/auth/sso", async (c) => {
	const secret = c.env.NANISLE_SSO_SECRET;
	// 没配共享密钥的实例本来就不做登录门禁，直接回配置页
	if (!secret) return c.redirect(appUrl(c.env, "config"), 302);
	const payload = await verifyToken(secret, c.req.query("token") ?? "");
	if (!payload) {
		// 不自动跳回主站重签：两边密钥配错时会陷入 302 死循环，这里停下来说清楚
		return c.html(
			`<!doctype html><meta charset="utf-8"><body style="font-family:sans-serif;max-width:28em;margin:15vh auto;line-height:1.9">` +
				`<p>登录链接无效或已过期。</p>` +
				`<p><a href="${loginUrl(c.env)}">回南屿重新打开产品 →</a></p></body>`,
			401,
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
		// 本地 wrangler dev 走 http，Secure cookie 种不上，按协议区分
		secure: new URL(appUrl(c.env)).protocol === "https:",
		maxAge: SESSION_TTL_S,
	});
	return c.redirect(appUrl(c.env, "config"), 302);
});

// The brief itself is personal content (it mirrors the owner's focus list),
// so reads share the same access code as writes on hosted instances.
app.get("/api/brief", accessGuard, async (c) => {
	const date = c.req.query("date");
	if (date && !DATE_RE.test(date)) {
		return c.json({ error: "date must be YYYY-MM-DD" }, 400);
	}
	const brief = await loadBrief(c.env, date);
	if (brief) return c.json(brief);
	// Empty KV and no explicit date → built-in sample, so mock mode demos
	// the full UI with zero setup.
	if (!date) return c.json(SAMPLE_BRIEF);
	return c.json({ error: "No brief for that date" }, 404);
});

app.get("/api/dates", accessGuard, async (c) => {
	const list = await c.env.BRIEFS.list({ prefix: "brief:", limit: 100 });
	const dates = list.keys
		.map((k) => k.name.slice("brief:".length))
		.filter((d) => DATE_RE.test(d))
		.sort()
		.reverse();
	return c.json({ dates });
});

// The pipeline pushes the finished daily brief here. Guarded by a dedicated
// token (not ACCESS_CODE): the machine that generates and the humans that
// read should hold different credentials, rotated independently.
app.post("/api/ingest", async (c) => {
	if (!c.env.INGEST_TOKEN) {
		return c.json({ error: "Ingest is not configured on this instance." }, 403);
	}
	const given = c.req.header("x-ingest-token") ?? "";
	if (!(await safeEqual(c.env.INGEST_TOKEN, given))) {
		return c.json({ error: "Missing or incorrect ingest token." }, 401);
	}
	let brief: Brief;
	try {
		brief = await c.req.json<Brief>();
	} catch {
		return c.json({ error: "Body must be a brief JSON." }, 400);
	}
	if (!brief || !DATE_RE.test(brief.date ?? "") || !Array.isArray(brief.sections)) {
		return c.json({ error: "Brief must have date (YYYY-MM-DD) and sections[]." }, 400);
	}
	await c.env.BRIEFS.put(`brief:${brief.date}`, JSON.stringify(brief));
	// Never move "latest" backwards when re-ingesting an old day.
	const latest = await c.env.BRIEFS.get("brief:latest");
	if (!latest || brief.date >= latest) {
		await c.env.BRIEFS.put("brief:latest", brief.date);
	}
	return c.json({ ok: true, date: brief.date });
});

const FEEDBACK_KINDS: FeedbackKind[] = ["up", "down", "text", "want"];

app.post("/api/feedback", accessGuard, async (c) => {
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
		return c.json({ error: "kind must be up | down | text | want" }, 400);
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
	// One KV key per event — no read-modify-write races, and the pipeline can
	// collect recent events with a prefix list.
	await c.env.BRIEFS.put(`fb:${date}:${itemId}:${crypto.randomUUID()}`, JSON.stringify(event), {
		// Feedback older than 90 days has already served its purpose.
		expirationTtl: 90 * 24 * 3600,
	});
	return c.json({ ok: true });
});

// Every outbound link in the UI goes through here: click-through is the
// zero-effort implicit signal the ranking will feed on (v2+). Then 302 to
// the real URL. Unguarded: a plain <a> can't carry headers, and the redirect
// map only exposes URLs that are public anyway.
app.get("/go/:date/:id", async (c) => {
	const { date, id } = c.req.param();
	if (!DATE_RE.test(date)) return c.json({ error: "Bad date" }, 400);
	const brief = (await loadBrief(c.env, date)) ?? (SAMPLE_BRIEF.date === date ? SAMPLE_BRIEF : null);
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

	if (!brief.sample) {
		await c.env.BRIEFS.put(
			`click:${date}:${id}:${crypto.randomUUID()}`,
			JSON.stringify({ at: new Date().toISOString() }),
			{ expirationTtl: 90 * 24 * 3600 },
		);
	}
	return c.redirect(url, 302);
});

// ---------- config: sources & focus (the web UI is the source of truth) ----------

app.get("/api/sources", accessGuard, async (c) => {
	const stored = await c.env.BRIEFS.get("config:sources");
	return c.json({ sources: await getSources(c.env), customized: Boolean(stored) });
});

app.put("/api/sources", ownerGuard, async (c) => {
	let body: { sources?: unknown };
	try {
		body = await c.req.json();
	} catch {
		return c.json({ error: "Body must be JSON: {\"sources\": [...]}" }, 400);
	}
	const cleaned = cleanSources(body.sources);
	if ("error" in cleaned) return c.json({ error: cleaned.error }, 400);
	await saveSources(c.env, cleaned.sources);
	return c.json({ ok: true, count: cleaned.sources.length });
});

// Verified add: probe (with feed discovery) first, persist only what parsed.
// Used by the config panel's manual add and the chat proposal cards' 添加 button.
app.post("/api/sources/add", ownerGuard, async (c) => {
	let body: { sources?: unknown };
	try {
		body = await c.req.json();
	} catch {
		return c.json({ error: "Body must be JSON: {\"sources\": [...]}" }, 400);
	}
	if (!Array.isArray(body.sources) || body.sources.length === 0 || body.sources.length > 8) {
		return c.json({ error: "sources must be a non-empty array (max 8)" }, 400);
	}
	const current = await getSources(c.env);
	const added: SourceConfig[] = [];
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
		if (current.some((x) => x.key === key || x.url === probe.url)) {
			failed.push({ name, url: probe.url, error: "已在配置里" });
			continue;
		}
		if (current.length >= MAX_SOURCES) {
			failed.push({ name, url: probe.url, error: `源数量已达上限 ${MAX_SOURCES}` });
			continue;
		}
		const source: SourceConfig = { key, name, url: probe.url, category };
		current.push(source);
		added.push(source);
	}
	if (added.length > 0) await saveSources(c.env, current);
	return c.json({ ok: true, added, failed, sources: current });
});

// Try one feed and preview what it currently returns — the review step
// before a source earns its place in the list.
app.post("/api/sources/test", ownerGuard, async (c) => {
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

app.get("/api/focus", accessGuard, async (c) => {
	return c.json({ focus: await getFocus(c.env) });
});

app.put("/api/focus", ownerGuard, async (c) => {
	let body: { focus?: unknown };
	try {
		body = await c.req.json();
	} catch {
		return c.json({ error: "Body must be JSON: {\"focus\": [...]}" }, 400);
	}
	const cleaned = cleanFocus(body.focus);
	if ("error" in cleaned) return c.json({ error: cleaned.error }, 400);
	await saveFocus(c.env, cleaned.focus);
	return c.json({ ok: true, count: cleaned.focus.length });
});

// ---------- config chat agent ----------

// One request = one visible turn: the LLM runs a tool loop against the config
// in KV and the response streams NDJSON events (text / tool / proposal /
// config / done). Costs tokens → aiGuard (owner code + kill switch).
app.post("/api/chat", aiGuard, async (c) => {
	let body: unknown;
	try {
		body = await c.req.json();
	} catch {
		return c.json({ error: "Body must be JSON: {\"messages\": [...]}" }, 400);
	}
	const parsed = parseChatBody(body);
	if ("error" in parsed) return c.json({ error: parsed.error }, 400);
	return new Response(chatStream(c.env, parsed.messages), {
		headers: {
			"content-type": "application/x-ndjson; charset=utf-8",
			"cache-control": "no-store",
		},
	});
});

// ---------- one-click / scheduled generation ----------

app.post("/api/generate", aiGuard, async (c) => {
	const sources = await getSources(c.env);
	const focus = await getFocus(c.env);
	const fetched = await fetchAllSources(sources, DEFAULT_FILTERS, (m) => console.log(m));
	if (fetched.candidates.length === 0) {
		return c.json(
			{ error: "没有抓到任何时间窗内的候选内容", sourceErrors: fetched.sourceErrors },
			422,
		);
	}

	let provider = "mock";
	try {
		provider = resolveProvider(c.env);
	} catch (err) {
		if (err instanceof AiError) return c.json({ error: err.message }, 500);
		throw err;
	}

	let editorial;
	if (provider === "mock") {
		editorial = mockEditorial(fetched.candidates);
	} else {
		const { system, user } = buildEditorialPrompt(fetched.candidates, focus);
		// The editorial JSON needs room; never let the default 1024 cap truncate it.
		const cap = Number.parseInt(c.env.AI_MAX_OUTPUT_TOKENS ?? "", 10);
		const genEnv: AppEnv = {
			...c.env,
			AI_MAX_OUTPUT_TOKENS: String(Number.isFinite(cap) && cap >= 2048 ? cap : 4096),
		};
		try {
			const result = await complete(genEnv, { prompt: user, system });
			editorial = parseEditorialJson(result.text);
		} catch (err) {
			if (err instanceof AiError) return c.json({ error: err.message }, err.status as 500);
			if (err instanceof SyntaxError) return c.json({ error: "模型返回的编辑结果不是合法 JSON,请重试。" }, 502);
			console.error("generate: upstream error", err);
			return c.json({ error: "上游 AI 错误,请稍后重试。" }, 502);
		}
	}

	const brief = await assembleBrief(editorial, fetched, {
		date: briefDate(c.env.BRIEF_TZ ?? "America/New_York"),
		sourceCount: fetched.sourcesOk,
	});
	await c.env.BRIEFS.put(`brief:${brief.date}`, JSON.stringify(brief));
	const latest = await c.env.BRIEFS.get("brief:latest");
	if (!latest || brief.date >= latest) {
		await c.env.BRIEFS.put("brief:latest", brief.date);
	}

	const picked = brief.sections.reduce((n, s) => n + s.items.length, 0);
	return c.json({
		ok: true,
		date: brief.date,
		provider,
		picked,
		scanned: fetched.scanned,
		sourceErrors: fetched.sourceErrors,
	});
});

app.notFound((c) => {
	const path = new URL(c.req.url).pathname;
	const dynamicPrefix = /^\/(?:api|auth|go)(?:\/|$)/;
	if ((c.req.method === "GET" || c.req.method === "HEAD") && !dynamicPrefix.test(path)) {
		return c.env.ASSETS.fetch(c.req.raw);
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
