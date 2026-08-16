import { Hono } from "hono";
import { AiError, complete, resolveProvider } from "./ai";
import { accessGuard, aiGuard, safeEqual } from "./guard";
import type { AppEnv } from "./env";
import type { Brief, FeedbackEvent, FeedbackKind } from "../shared/types";
import { SAMPLE_BRIEF } from "./sample-brief";
import {
	SOURCE_CATEGORIES,
	assembleBrief,
	briefDate,
	buildEditorialPrompt,
	fetchAllSources,
	fetchFeed,
	fnv1a,
	mockEditorial,
	parseEditorialJson,
} from "../shared/pipeline-core";
import type { FocusEntry, SourceConfig } from "../shared/pipeline-core";
import { DEFAULT_FILTERS, DEFAULT_FOCUS, DEFAULT_SOURCES } from "../shared/default-sources";

const app = new Hono<{ Bindings: AppEnv }>();

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
		ingestConfigured: Boolean(c.env.INGEST_TOKEN),
	});
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

async function getSources(env: AppEnv): Promise<SourceConfig[]> {
	const raw = await env.BRIEFS.get("config:sources");
	if (raw) return JSON.parse(raw) as SourceConfig[];
	return DEFAULT_SOURCES;
}

async function getFocus(env: AppEnv): Promise<FocusEntry[]> {
	const raw = await env.BRIEFS.get("config:focus");
	if (raw) return JSON.parse(raw) as FocusEntry[];
	return DEFAULT_FOCUS;
}

app.get("/api/sources", accessGuard, async (c) => {
	const stored = await c.env.BRIEFS.get("config:sources");
	return c.json({ sources: await getSources(c.env), customized: Boolean(stored) });
});

app.put("/api/sources", accessGuard, async (c) => {
	let body: { sources?: unknown };
	try {
		body = await c.req.json();
	} catch {
		return c.json({ error: "Body must be JSON: {\"sources\": [...]}" }, 400);
	}
	if (!Array.isArray(body.sources) || body.sources.length > 50) {
		return c.json({ error: "sources must be an array (max 50)" }, 400);
	}
	const cleaned: SourceConfig[] = [];
	for (const [i, s] of (body.sources as Record<string, unknown>[]).entries()) {
		const name = typeof s.name === "string" ? s.name.trim() : "";
		const url = typeof s.url === "string" ? s.url.trim() : "";
		const category = s.category as SourceConfig["category"];
		if (!name || name.length > 100) return c.json({ error: `source #${i + 1}: name required (≤100 chars)` }, 400);
		if (!/^https?:\/\/\S+$/.test(url) || url.length > 500) return c.json({ error: `source #${i + 1}: url must be http(s)` }, 400);
		if (!SOURCE_CATEGORIES.includes(category)) return c.json({ error: `source #${i + 1}: bad category` }, 400);
		const maxItems = typeof s.max_items === "number" && s.max_items >= 1 && s.max_items <= 50 ? Math.floor(s.max_items) : undefined;
		cleaned.push({
			key: typeof s.key === "string" && s.key ? s.key.slice(0, 64) : fnv1a(url),
			name,
			url,
			category,
			enabled: s.enabled === false ? false : undefined,
			...(maxItems ? { max_items: maxItems } : {}),
		});
	}
	await c.env.BRIEFS.put("config:sources", JSON.stringify(cleaned));
	return c.json({ ok: true, count: cleaned.length });
});

// Try one feed and preview what it currently returns — the review step
// before a source earns its place in the list.
app.post("/api/sources/test", accessGuard, async (c) => {
	let url: unknown;
	try {
		({ url } = await c.req.json<{ url?: unknown }>());
	} catch {
		return c.json({ error: "Body must be JSON: {\"url\": \"...\"}" }, 400);
	}
	if (typeof url !== "string" || !/^https?:\/\/\S+$/.test(url)) {
		return c.json({ error: "url must be http(s)" }, 400);
	}
	try {
		const entries = await fetchFeed(url, 15_000);
		const now = Date.now();
		const freshCount = entries.filter(
			(e) => e.publishedAt && now - e.publishedAt.getTime() <= DEFAULT_FILTERS.max_age_hours * 3600_000,
		).length;
		return c.json({
			ok: true,
			total: entries.length,
			fresh: freshCount,
			latest: entries.slice(0, 5).map((e) => ({
				title: e.title,
				publishedAt: e.publishedAt ? e.publishedAt.toISOString() : null,
			})),
		});
	} catch (err) {
		return c.json({ ok: false, error: String(err instanceof Error ? err.message : err) });
	}
});

app.get("/api/focus", accessGuard, async (c) => {
	return c.json({ focus: await getFocus(c.env) });
});

app.put("/api/focus", accessGuard, async (c) => {
	let body: { focus?: unknown };
	try {
		body = await c.req.json();
	} catch {
		return c.json({ error: "Body must be JSON: {\"focus\": [...]}" }, 400);
	}
	if (!Array.isArray(body.focus) || body.focus.length > 20) {
		return c.json({ error: "focus must be an array (max 20)" }, 400);
	}
	const cleaned: FocusEntry[] = [];
	for (const f of body.focus as Record<string, unknown>[]) {
		const name = typeof f.name === "string" ? f.name.trim() : "";
		if (!name || name.length > 100) return c.json({ error: "every focus entry needs a name (≤100 chars)" }, 400);
		const detail = typeof f.detail === "string" ? f.detail.trim().slice(0, 500) : undefined;
		cleaned.push({ name, ...(detail ? { detail } : {}) });
	}
	await c.env.BRIEFS.put("config:focus", JSON.stringify(cleaned));
	return c.json({ ok: true, count: cleaned.length });
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

app.notFound((c) => c.json({ error: "Not found" }, 404));

export default app;
