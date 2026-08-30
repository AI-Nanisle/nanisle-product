// 002 watch-router · Worker 入口(docs/02 系统全景、docs/03 W 线)。
// 慢车道(W9–W11)已接线:submit 分流 → DynamoDB 任务 + SQS 投递 →
// 消费者经 /api/queue/* 回程 → 页面轮询 /api/task/:id。
// 快车道(W4–W6)仍是 mock:抽取链与真编辑调用落地前,文章/粘贴返回示例。

import { Hono } from "hono";
import { deleteCookie, getCookie, setCookie } from "hono/cookie";
import { resolveProvider } from "../shared/ai";
import { anchorKeyPoints } from "../shared/anchor";
import { identifyText, identifyUrl } from "../shared/content-id";
import { EditError, editContentWithSource } from "../shared/editor";
import { buildNotes } from "../shared/notes";
import { mockWatchResult, validateWatchResult } from "../shared/schema";
import type { ExtractPath } from "../shared/schema";
import { extractArticle, textToParagraphs } from "./extract";
import {
	CONTENT_CACHE_TTL_S,
	MAX_NOTE_ENTRIES,
	QUOTA_LIMITS,
	QuotaExceededError,
	TASK_TIMEOUT_MS,
	contentCacheKey,
	readCachedContent,
} from "../shared/store";
import type { CachedContent, TaskRecord, TaskStep } from "../shared/store";
import { aiConfig, aiConfigFor, awsConfigured, fastAiConfigFor } from "./env";
import type { AppEnv } from "./env";
import { computeTracked, mergeTracked } from "./interop";
import {
	SESSION_COOKIE,
	appUrl,
	loginUrl,
	safeEqual,
	sessionEmail,
	siteUrl,
	userAiGuard,
	userGuard,
} from "./guard";
import type { Guarded } from "./guard";
import { makeStore } from "./store";
import { notifySubscription, runScheduled, subsApp } from "./subs";
import { sendTask } from "./sqs";
import { AUDIENCE, signToken, verifyToken } from "./sso";

const app = new Hono<Guarded>();
// 订阅模式的路由(/api/subs*、/api/queue/candidates、/api/email/unsub)收在 subs.ts
app.route("/", subsApp);
const PRODUCT_MOUNT = "/products/watch-router/";
/** 文章正文达到这个字数才做逐章详细笔记(docs/05 §2.4)。 */
const NOTES_MIN_CHARS = 3000;

/** 配额按天归位的「今天」。跟 001 一样用美东——用户在美东,半夜换日别错时区。 */
function quotaDate(): string {
	return new Intl.DateTimeFormat("en-CA", { timeZone: "America/New_York" }).format(new Date());
}

/**
 * I3 · 交付时刻的用户级高亮:处理记录里有算过的直接用(用户级缓存,同一
 * 内容不重复花钱);没有才做一次 fast 档小调用。整个函数失败即降级——
 * 返回无高亮的原结果,顺带把处理记录落上(docs/02 T4/T7②)。
 */
async function withTracked(
	env: AppEnv,
	store: import("../shared/store").Store,
	email: string,
	contentKey: string,
	url: string,
	result: import("../shared/schema").WatchResult,
): Promise<import("../shared/schema").WatchResult> {
	try {
		const rec = await store.getReadRecord(email, contentKey);
		if (rec?.tracked) return mergeTracked(result, rec.tracked);
		const tracked = await computeTracked(env, fastAiConfigFor(env, email), email, result);
		await store.putReadRecord(email, {
			contentKey,
			url,
			title: result.meta.title,
			at: Date.now(),
			// null = 001 不可用/没有追踪器(下次再试);{} = 算过没命中(缓存住,别重算)
			...(tracked !== null ? { tracked } : {}),
		});
		return tracked ? mergeTracked(result, tracked) : result;
	} catch {
		return result;
	}
}

app.get("/api/health", async (c) => {
	let provider = "invalid";
	try {
		provider = resolveProvider(aiConfig(c.env));
	} catch {
		// leave "invalid" — misconfigured AI_PROVIDER shouldn't take health down
	}
	const email = await sessionEmail(c.env, getCookie(c, SESSION_COOKIE));
	return c.json({
		ok: true,
		provider,
		store: awsConfigured(c.env) ? "dynamo" : "memory",
		queueConfigured: Boolean(c.env.QUEUE_URL && awsConfigured(c.env)),
		email,
		site: siteUrl(c.env),
		loginUrl: loginUrl(c.env),
		ssoConfigured: Boolean(c.env.NANISLE_SSO_SECRET),
	});
});

// ---------- 登录(从 001 移植,landing 是收单首页而不是 config) ----------

const SESSION_TTL_S = 30 * 24 * 3600;

/** 会话 cookie 的作用域。种下和删除必须完全一致,所以只写一次。 */
function sessionCookieScope(env: AppEnv): { path: string; secure: boolean } {
	const url = new URL(appUrl(env));
	return {
		path: url.pathname.replace(/\/+$/, "") || "/",
		secure: url.protocol === "https:",
	};
}

app.get("/auth/sso", async (c) => {
	const secret = c.env.NANISLE_SSO_SECRET;
	// 没配共享密钥的实例本来就不做登录门禁,直接回收单首页。
	// 落点是 app 子路径:裸挂载根是主站的产品详情页,进不了应用(mount
	// 转发要求至少一段,web/lib/product-mounts.ts 有同款注释)。
	if (!secret) return c.redirect(appUrl(c.env, "app"), 302);
	// 只认主站签给**本产品**的手递票:aud 对不上(签给别的产品)或 typ 对不上
	// (拿会话 cookie 来冒充手递)都在这里被拒,文案不区分原因。
	const payload = await verifyToken(secret, c.req.query("token") ?? "", { aud: AUDIENCE, typ: "sso" });
	if (!payload) {
		// 不自动跳回主站重签:两边密钥配错时会陷入 302 死循环,这里停下来说清楚
		return c.html(
			`<!doctype html><meta charset="utf-8"><body style="font-family:sans-serif;max-width:28em;margin:15vh auto;line-height:1.9">` +
				`<p>登录链接无效或已过期。</p>` +
				`<p><a href="${loginUrl(c.env)}">回南屿重新打开产品 →</a></p></body>`,
			401,
		);
	}
	// 内测准入:验签通过还要在白名单里才发会话(docs/02 T7)。
	const { store } = makeStore(c.env);
	if (!(await store.isWhitelisted(payload.email))) {
		return c.html(
			`<!doctype html><meta charset="utf-8"><body style="font-family:sans-serif;max-width:28em;margin:15vh auto;line-height:1.9">` +
				`<p>002 长视频总结还在内测中,你的账号(${payload.email})暂未开通。</p>` +
				`<p>想试用可以联系站长;<a href="${siteUrl(c.env)}">回南屿首页 →</a></p></body>`,
			403,
		);
	}
	const session = await signToken(secret, {
		email: payload.email,
		exp: Math.floor(Date.now() / 1000) + SESSION_TTL_S,
		// 会话只对本产品有效,且与手递票不同类——两者不能互相顶用(sso.ts)
		aud: AUDIENCE,
		typ: "session",
	});
	const scope = sessionCookieScope(c.env);
	setCookie(c, SESSION_COOKIE, session, {
		path: scope.path,
		httpOnly: true,
		sameSite: "Lax",
		secure: scope.secure,
		maxAge: SESSION_TTL_S,
	});
	return c.redirect(appUrl(c.env, "app"), 302);
});

app.get("/auth/logout", (c) => {
	const scope = sessionCookieScope(c.env);
	deleteCookie(c, SESSION_COOKIE, {
		path: scope.path,
		httpOnly: true,
		sameSite: "Lax",
		secure: scope.secure,
	});
	return c.redirect(siteUrl(c.env), 302);
});

// ---------- 收单与分流(W10) ----------

app.post("/api/submit", userAiGuard, async (c) => {
	let body: { url?: unknown; text?: unknown; force?: unknown };
	try {
		body = await c.req.json();
	} catch {
		return c.json({ error: 'Body must be JSON: {"url": "..."} or {"text": "..."}' }, 400);
	}
	const url = typeof body.url === "string" ? body.url.trim() : "";
	const text = typeof body.text === "string" ? body.text.trim() : "";
	// 重新生成:跳过缓存短路,整条管线重跑。照常先占额度——额度就是防滥用的闸。
	const force = body.force === true;
	if (!url && !text) {
		return c.json({ error: "给我一个链接,或直接把正文粘进来。" }, 400);
	}

	let cid;
	try {
		cid = url ? await identifyUrl(url) : await identifyText(text);
	} catch {
		return c.json({ error: "这不是一个有效的 http(s) 链接。" }, 400);
	}

	const email = c.get("email");
	const store = c.get("store");

	// 缓存命中:两条车道都短路,不占配额(内容级结果全站共享,docs/02 T6);
	// 新用户只花 I3 高亮小调用的钱——T4 两次调用拆分的意义所在
	const cached = force ? null : await readCachedContent(c.env.WATCH, cid.key);
	if (cached) {
		const merged = await withTracked(c.env, store, email, cid.key, url || cached.url || "", cached.result);
		return c.json({
			cached: true,
			lane: cid.lane,
			contentKey: cid.key,
			result: merged,
			resultAt: cached.cachedAt,
			...(cached.url ? { url: cached.url } : {}),
			...(cached.paragraphs ? { paragraphs: cached.paragraphs } : {}),
		});
	}

	if (cid.lane === "fast") {
		// F2 · 快车道 SSE:编辑调用几十秒到两分钟,主站域名经 CF 代理,
		// 100 秒无字节会被 524 掐断——必须边生成边推。事件序列:
		// phase(extracting→editing)→ delta(已生成字符数,1s 节流)→ result/error;
		// thinking 阶段没有 content 增量,10 秒一个 ping 兜底保活。
		const { readable, writable } = new TransformStream<Uint8Array, Uint8Array>();
		const writer = writable.getWriter();
		const enc = new TextEncoder();
		const send = (obj: unknown) => writer.write(enc.encode(`data: ${JSON.stringify(obj)}\n\n`)).catch(() => {});
		const env = c.env;
		const ai = aiConfigFor(env, email);
		const isMock = resolveProvider(ai) === "mock";

		c.executionCtx.waitUntil(
			(async () => {
				const ping = setInterval(() => void send({ type: "ping" }), 10_000);
				try {
					// W4:正文从哪来
					let title: string | undefined;
					let paragraphs: string[];
					let path: "article" | "paste";
					if (url) {
						await send({ type: "phase", phase: "extracting" });
						const ex = await extractArticle(url, env.JINA_KEY);
						if (!ex.ok) {
							await send({ type: "error", error: ex.error, needPaste: true });
							return;
						}
						title = ex.value.title;
						paragraphs = ex.value.paragraphs;
						path = "article";
					} else {
						paragraphs = textToParagraphs(text);
						path = "paste";
						if (paragraphs.length === 0) {
							await send({ type: "error", error: "正文是空的。" });
							return;
						}
					}

					// 先占位后干活(docs/02 T6):占位在编辑调用(花钱处)之前、
					// 免费的抽取之后;占位失败即止,模型报错不退还
					try {
						await store.reserveQuota(email, quotaDate());
					} catch (err) {
						if (err instanceof QuotaExceededError) {
							await send({ type: "error", error: err.message, quota: true });
							return;
						}
						throw err;
					}

					// W5:一次编辑调用(mock 模式内部返回示例);W6:锚定校验
					await send({ type: "phase", phase: "editing" });
					let chars = 0;
					let lastPush = 0;
					let result;
					let edited;
					try {
						edited = await editContentWithSource(ai, {
							title,
							paragraphs,
							path,
							onDelta: (d) => {
								chars += d.length;
								const now = Date.now();
								if (now - lastPush > 1000) {
									lastPush = now;
									void send({ type: "delta", chars });
								}
							},
						});
					} catch (err) {
						if (err instanceof EditError) {
							await send({ type: "error", error: `编辑没干好:${err.message}。可以重试(会占一次额度)。` });
							return;
						}
						throw err;
					}
					result = anchorKeyPoints(edited.result, paragraphs.join("\n"));
					// 详细笔记(docs/05 §2.4):只对长文启用——短文的笔记会比原文还长。
					// 逐章调用之间每章推一个 phase 事件,CF 代理的 100 秒无字节线靠它 + ping 兜底
					const totalChars = edited.paragraphs.reduce((s, p) => s + p.length, 0);
					if (totalChars >= NOTES_MIN_CHARS) {
						await send({ type: "phase", phase: "notes", done: 0, total: result.chapters.length });
						result = await buildNotes(ai, fastAiConfigFor(env, email), {
							kind: "text",
							source: edited.source,
							result,
							paragraphs: edited.paragraphs,
							onChapter: (done, total) => void send({ type: "phase", phase: "notes", done, total }),
						});
					}

					// 版本戳与缓存的 cachedAt 同值:想法按它对版本(mock 不缓存,戳只陪跑)
					const cachedAt = Date.now();
					// mock 结果不进缓存——占着 60 天的缓存位污染真结果
					if (!isMock) {
						await env.WATCH.put(
							contentCacheKey(cid.key),
							JSON.stringify({
								result,
								contentKey: cid.key,
								cachedAt,
								...(url ? { url } : {}),
								paragraphs,
							} satisfies CachedContent),
							{ expirationTtl: CONTENT_CACHE_TTL_S },
						);
					}
					// I3:交付前做用户级高亮(withTracked 内部顺带落处理记录)
					const merged = await withTracked(env, store, email, cid.key, url || "", result);
					await send({ type: "result", cached: false, lane: "fast", contentKey: cid.key, result: merged, resultAt: cachedAt, paragraphs, ...(url ? { url } : {}) });
				} catch (err) {
					console.error("fast lane failed", err);
					await send({ type: "error", error: "处理失败,请稍后重试。" });
				} finally {
					clearInterval(ping);
					await writer.close().catch(() => {});
				}
			})(),
		);

		return new Response(readable, {
			headers: { "content-type": "text/event-stream", "cache-control": "no-cache" },
		});
	}

	// 慢车道:先占位后干活
	try {
		await store.reserveQuota(email, quotaDate());
	} catch (err) {
		if (err instanceof QuotaExceededError) return c.json({ error: err.message }, 429);
		throw err;
	}

	// 慢车道:任务先落库再投递——顺序不能反,消费者回程时任务必须已存在
	const task: TaskRecord = {
		id: crypto.randomUUID(),
		email,
		url,
		contentKey: cid.key,
		platform: cid.platform,
		status: "pending",
		step: "queued",
		createdAt: Date.now(),
		updatedAt: Date.now(),
	};
	await store.createTask(task);

	if (awsConfigured(c.env) && c.env.QUEUE_URL) {
		await sendTask(c.env, {
			taskId: task.id,
			email: task.email,
			url: task.url,
			contentKey: task.contentKey,
			platform: task.platform,
		});
	} else {
		// mock 慢车道(docs/02 T5):跳过整条 AWS 链,直接完成一个示例任务,
		// fork 者零配置也能看完整的「排队 → 进度 → 结果」形态
		const result = mockWatchResult("subtitle");
		await c.env.WATCH.put(
			contentCacheKey(cid.key),
			JSON.stringify({ result, contentKey: cid.key, cachedAt: Date.now() } satisfies CachedContent),
			{ expirationTtl: CONTENT_CACHE_TTL_S },
		);
		await store.updateTask(task.id, { status: "done", step: "done", path: "subtitle" });
	}

	return c.json({ cached: false, lane: "slow", taskId: task.id });
});

// F7 · 配额读数:只读不占位,页眉常驻显示;上限由服务端下发,前端不硬编码
app.get("/api/usage", userGuard, async (c) => {
	const used = await c.get("store").getQuota(c.get("email"), quotaDate());
	return c.json({ used, limit: QUOTA_LIMITS.submit });
});

// ---------- N 线 · 记录与想法(2026-08-26 用户需求;哲学同 001 N 线) ----------

app.get("/api/history", userGuard, async (c) => {
	const items = await c.get("store").listReadRecords(c.get("email"));
	return c.json({
		items: items.map((r) => ({ contentKey: r.contentKey, url: r.url, title: r.title, at: r.at })),
	});
});

// 重开历史结果:结果本体在 60 天内容缓存里,过期就带 expired 标记回去
// (前端预填 URL 引导重新提交——比为「保存」把每份结果永久化便宜得多,
// 且重提交时若别人算过 = 缓存命中零成本)。高亮从处理记录的用户级缓存合并,零调用。
app.get("/api/result/:key", userGuard, async (c) => {
	const key = c.req.param("key");
	const store = c.get("store");
	const email = c.get("email");
	const rec = await store.getReadRecord(email, key);
	if (!rec) return c.json({ error: "没有这条记录。" }, 404);
	const note = await store.getNote(email, key);
	const cached = await readCachedContent(c.env.WATCH, key);
	if (!cached) {
		return c.json({
			expired: true,
			contentKey: key,
			url: rec.url,
			title: rec.title,
			...(note ? { note } : {}),
		});
	}
	const merged = rec.tracked ? mergeTracked(cached.result, rec.tracked) : cached.result;
	return c.json({
		contentKey: key,
		result: merged,
		resultAt: cached.cachedAt,
		url: cached.url ?? rec.url,
		...(cached.paragraphs ? { paragraphs: cached.paragraphs } : {}),
		...(note ? { note } : {}),
	});
});

app.get("/api/note/:key", userGuard, async (c) => {
	const note = await c.get("store").getNote(c.get("email"), c.req.param("key"));
	return c.json({ note: note ?? null });
});

/** 想法锚点:导读 | 要点序号 | 分段序号 | 整体。 */
const NOTE_TARGET_RE = /^(overview|general|kp:\d{1,3}|ch:\d{1,3})$/;

app.post("/api/note", userGuard, async (c) => {
	const body = await c.req
		.json<{ contentKey?: unknown; target?: unknown; text?: unknown; resultAt?: unknown }>()
		.catch(() => null);
	const key = typeof body?.contentKey === "string" ? body.contentKey : "";
	const target = typeof body?.target === "string" ? body.target : "";
	const text = typeof body?.text === "string" ? body.text.trim() : "";
	// 版本戳:客户端所见结果的 cachedAt;缺了也收(旧客户端),按存量规则沉底
	const resultAt = typeof body?.resultAt === "number" && Number.isFinite(body.resultAt) ? body.resultAt : undefined;
	if (!key || !NOTE_TARGET_RE.test(target) || !text) {
		return c.json({ error: "need { contentKey, target, text }" }, 400);
	}
	if (text.length > 2000) return c.json({ error: "一条想法最多 2000 字。" }, 413);
	const store = c.get("store");
	const email = c.get("email");
	const rec = await store.getReadRecord(email, key);
	if (!rec) return c.json({ error: "先处理过这条内容,才能在上面记想法。" }, 404);
	// 快照原则(001 N1):title/url 只在建账时抄一次,之后追加不动它
	const note = (await store.getNote(email, key)) ?? {
		contentKey: key,
		...(rec.url ? { url: rec.url } : {}),
		...(rec.title ? { title: rec.title } : {}),
		entries: [],
		updatedAt: 0,
	};
	if (note.entries.length >= MAX_NOTE_ENTRIES) {
		return c.json({ error: `这条内容的想法已满 ${MAX_NOTE_ENTRIES} 条。` }, 409);
	}
	const entry = { at: Date.now(), target, text, ...(resultAt !== undefined ? { resultAt } : {}) };
	note.entries.push(entry);
	note.updatedAt = entry.at;
	await store.putNote(email, note);
	return c.json({ ok: true, entry });
});

app.post("/api/note/delete", userGuard, async (c) => {
	const body = await c.req.json<{ contentKey?: unknown; at?: unknown }>().catch(() => null);
	const key = typeof body?.contentKey === "string" ? body.contentKey : "";
	const at = Number(body?.at);
	if (!key || !Number.isFinite(at)) return c.json({ error: "need { contentKey, at }" }, 400);
	const store = c.get("store");
	const email = c.get("email");
	const note = await store.getNote(email, key);
	if (!note) return c.json({ error: "没有这条记录。" }, 404);
	const next = note.entries.filter((e) => e.at !== at);
	if (next.length === note.entries.length) return c.json({ error: "没有这条想法。" }, 404);
	await store.putNote(email, { ...note, entries: next, updatedAt: Date.now() });
	return c.json({ ok: true });
});

// ---------- 任务轮询(W11) ----------

app.get("/api/task/:id", userGuard, async (c) => {
	const store = c.get("store");
	const task = await store.getTask(c.req.param("id"));
	// 不存在和不属于你,对外是同一个 404(别当成员探测的 oracle)
	if (!task || task.email !== c.get("email")) {
		return c.json({ error: "没有这个任务。" }, 404);
	}
	// 超时判定在读取时做(docs/02 T1):消费者挂了也能显式失败,绝不静默挂起
	if ((task.status === "pending" || task.status === "running") && Date.now() - task.updatedAt > TASK_TIMEOUT_MS) {
		await store.updateTask(task.id, {
			status: "failed",
			error: "处理超时(10 分钟没有新进展)。可以重试;YouTube/B站偶发抽风,或把 transcript 粘贴进来。",
		});
		return c.json({ status: "failed", step: task.step, error: "处理超时(10 分钟没有新进展)。可以重试;或把 transcript 粘贴进来。" });
	}
	if (task.status === "done") {
		const cached = await readCachedContent(c.env.WATCH, task.contentKey);
		if (!cached) {
			// 理论上到不了:complete 先写缓存再标 done。真到了就承认异常。
			return c.json({ status: "failed", error: "结果丢失,请重新提交。" });
		}
		// I3:首次交付算高亮并缓存进处理记录,之后的轮询/重开都走缓存
		const merged = await withTracked(c.env, store, c.get("email"), task.contentKey, task.url, cached.result);
		return c.json({
			status: "done",
			step: "done",
			path: task.path,
			url: task.url,
			contentKey: task.contentKey,
			result: merged,
			resultAt: cached.cachedAt,
			...(cached.paragraphs ? { paragraphs: cached.paragraphs } : {}),
		});
	}
	return c.json({ status: task.status, step: task.step, path: task.path, error: task.error });
});

// ---------- 消费者回程(W11;鉴权与用户门禁分离,docs/02 T1) ----------

const TASK_STEPS: TaskStep[] = ["queued", "downloading", "transcribing", "editing", "done"];
const EXTRACT_PATHS: ExtractPath[] = ["subtitle", "whisper", "article", "paste"];

async function consumerAuthed(c: { env: AppEnv; req: { header(name: string): string | undefined } }): Promise<boolean> {
	const token = c.env.CONSUMER_TOKEN;
	if (!token) return false; // 没配 = 回程端点整个关闭(mock 模式用不到它)
	return safeEqual(token, c.req.header("x-consumer-token") ?? "");
}

app.post("/api/queue/progress", async (c) => {
	if (!(await consumerAuthed(c))) return c.json({ error: "unauthorized" }, 401);
	const body = await c.req.json<{ taskId?: string; step?: string; path?: string }>().catch(() => null);
	if (!body?.taskId || !body.step || !TASK_STEPS.includes(body.step as TaskStep)) {
		return c.json({ error: "need { taskId, step: queued|downloading|transcribing|editing }" }, 400);
	}
	const { store } = makeStore(c.env);
	const task = await store.getTask(body.taskId);
	if (!task) return c.json({ error: "unknown task" }, 404);
	// 幂等:重投的旧消息对应的任务可能已完成——告诉消费者放弃,别把
	// done 打回 running(消费者据 done:true 直接跳过整条管线,不重复花钱)
	if (task.status === "done") return c.json({ ok: false, done: true });
	await store.updateTask(body.taskId, {
		status: "running",
		step: body.step as TaskStep,
		...(body.path && EXTRACT_PATHS.includes(body.path as ExtractPath) ? { path: body.path as ExtractPath } : {}),
	});
	return c.json({ ok: true });
});

app.post("/api/queue/complete", async (c) => {
	if (!(await consumerAuthed(c))) return c.json({ error: "unauthorized" }, 401);
	const body = await c.req
		.json<{ taskId?: string; result?: unknown; error?: string; path?: string; paragraphs?: unknown }>()
		.catch(() => null);
	if (!body?.taskId) return c.json({ error: "need { taskId, result | error }" }, 400);
	const { store } = makeStore(c.env);
	const task = await store.getTask(body.taskId);
	if (!task) return c.json({ error: "unknown task" }, 404);

	if (body.error) {
		await store.updateTask(body.taskId, { status: "failed", error: String(body.error).slice(0, 500) });
		return c.json({ ok: true });
	}

	const result = validateWatchResult(body.result);
	if (!result) return c.json({ error: "result does not match the WatchResult schema" }, 422);
	// TODO(W6):这里加 quote 锚定校验,配不上的要点标 anchored:false

	const path = body.path && EXTRACT_PATHS.includes(body.path as ExtractPath) ? (body.path as ExtractPath) : result.meta.path;
	// 转写段落(F4 原文区/将来跳转用):只收字符串数组,总量封顶,超了丢弃不报错
	let paragraphs: string[] | undefined;
	if (Array.isArray(body.paragraphs)) {
		const strings = body.paragraphs.filter((p): p is string => typeof p === "string");
		const total = strings.reduce((s, p) => s + p.length, 0);
		if (strings.length > 0 && strings.length <= 5000 && total <= 500_000) paragraphs = strings;
	}
	// 顺序不变量:先写内容缓存,再标 done——轮询看到 done 时结果一定已就位
	await c.env.WATCH.put(
		contentCacheKey(task.contentKey),
		JSON.stringify({
			result,
			contentKey: task.contentKey,
			cachedAt: Date.now(),
			url: task.url,
			...(paragraphs ? { paragraphs } : {}),
		} satisfies CachedContent),
		{ expirationTtl: CONTENT_CACHE_TTL_S },
	);
	await store.putReadRecord(task.email, {
		contentKey: task.contentKey,
		url: task.url,
		title: result.meta.title,
		at: Date.now(),
	});
	await store.updateTask(body.taskId, { status: "done", step: "done", path });
	// 订阅挑来的任务:结果落稳后发门铃邮件(docs/05 §3.5);失败只记日志,不影响上面已落的库
	if (task.origin === "subscription") {
		c.executionCtx.waitUntil(notifySubscription(c.env, store, task.email, task.contentKey, result));
	}
	return c.json({ ok: true });
});

// ---------- 兜底:静态资源(SPA)与 404 ----------

app.all("*", async (c) => {
	if (c.req.method === "GET" || c.req.method === "HEAD") {
		// Production assets live at unmounted paths (dist/client root) with SPA
		// fallback; the vite dev asset server is base-aware instead, so retry
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
	// 订阅模式的两条 cron(wrangler.jsonc triggers;本地 `wrangler dev --test-scheduled` 后
	// 打 /__scheduled?cron=0+0+*+*+* 触发)。分流逻辑在 subs.ts runScheduled。
	scheduled(event, env, ctx) {
		ctx.waitUntil(runScheduled(env, event.cron));
	},
} satisfies ExportedHandler<AppEnv>;
