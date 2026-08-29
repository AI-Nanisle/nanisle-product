// 订阅模式(docs/05 §3):订阅管理、每日挑选、候选回传、退订、订阅邮件。
//
// 分工(docs/05 §3.1):**发现**在消费者 Lambda(走住宅代理,三个平台一条路),
// **挑与记**在这里——状态只有 Worker 能写(docs/02 T1 不变量)。
//   cron 00:00 UTC(20:00 美东,DeepSeek 非高峰、避开 YouTube RSS 的 404 高发段)
//     → 每个订阅用户投一条 {kind:"discover"} 消息
//   消费者抓完 → POST /api/queue/candidates → 当场挑一条 → 投现有慢车道
//   cron 01:30 UTC 兜底:候选没回来的用户按已有候选挑;仍无则记「发现失败」
//   任务 done 时(index.ts 的 complete 端点)→ notifySubscription 发门铃邮件
//
// 本地/fork(没配 AWS):POST /api/subs/run 在 Worker 里直接抓 feed 跑同一套挑选,
// 零配置也能看完整形态;mock 慢车道会直接完成示例任务。

import { Hono } from "hono";
import { identifyUrl } from "../shared/content-id";
import {
	BROWSER_UA,
	biliArchiveUrl,
	channelIdFromHtml,
	parseBiliArchive,
	parseBiliCard,
	parsePodcastFeed,
	parseSubscriptionInput,
	parseYoutubeFeed,
	pickDaily,
	youtubeUploadsFeedUrl,
} from "../shared/discover";
import type { Candidate } from "../shared/discover";
import { renderWatchEmail, sendWatchEmail, unsubToken, verifyUnsubToken } from "../shared/email";
import { mockWatchResult } from "../shared/schema";
import type { WatchResult } from "../shared/schema";
import { CONTENT_CACHE_TTL_S, MAX_SUBSCRIPTIONS, contentCacheKey, subKeyOf } from "../shared/store";
import type { CachedContent, CandidateRecord, Store, SubPlatform, SubRecord, TaskRecord } from "../shared/store";
import { awsConfigured } from "./env";
import type { AppEnv } from "./env";
import { appUrl, safeEqual, userGuard } from "./guard";
import type { Guarded } from "./guard";
import { sendDiscover, sendTask } from "./sqs";
import { makeStore } from "./store";

/** 配额/订阅按天归位的「今天」(美东,同 index.ts quotaDate)。 */
export function subDate(d = new Date()): string {
	return new Intl.DateTimeFormat("en-CA", { timeZone: "America/New_York" }).format(d);
}

const PLATFORM_LABEL: Record<SubPlatform, string> = { youtube: "YouTube", bilibili: "B站", podcast: "播客" };

// ---------- 订阅输入解析(Worker 侧;拿不到的交给用户换一种粘法) ----------

async function resolveSubscription(raw: string): Promise<{ sub: Omit<SubRecord, "addedAt"> } | { error: string }> {
	const parsed = parseSubscriptionInput(raw);
	if (!parsed) return { error: "认不出这个地址。支持:YouTube 频道链接(/channel/UC… 或 /@名字)、B站空间链接(space.bilibili.com/数字)、播客 RSS 地址。" };
	const headers = { "user-agent": BROWSER_UA };
	if (parsed.platform === "youtube") {
		let channelId = parsed.channelId;
		if (!channelId && parsed.handle) {
			const res = await fetch(`https://www.youtube.com/@${parsed.handle}`, { headers }).catch(() => null);
			channelId = res?.ok ? (channelIdFromHtml(await res.text()) ?? undefined) : undefined;
			if (!channelId) return { error: "没能从 @名字 解析出频道 ID(YouTube 拦了这次请求)。换成频道主页里「分享 → 复制频道 ID」得到的 /channel/UC… 链接再试。" };
		}
		const feed = await fetch(youtubeUploadsFeedUrl(channelId!), { headers }).catch(() => null);
		const title = feed?.ok ? parseYoutubeFeed(await feed.text()).channelTitle : undefined;
		return { sub: { platform: "youtube", id: channelId!, ...(title ? { title } : {}) } };
	}
	if (parsed.platform === "bilibili") {
		let mid = parsed.mid;
		if (!mid && parsed.shortUrl) {
			const res = await fetch(parsed.shortUrl, { headers, redirect: "manual" }).catch(() => null);
			const loc = res?.headers.get("location") ?? "";
			mid = loc.match(/space\.bilibili\.com\/(\d+)/)?.[1];
			if (!mid) return { error: "这个 b23.tv 短链没有指向 UP 主空间。打开 UP 主主页,复制 space.bilibili.com/数字 这种链接再试。" };
		}
		const card = await fetch(`https://api.bilibili.com/x/web-interface/card?mid=${mid}`, { headers }).catch(() => null);
		const info = card?.ok ? parseBiliCard(await card.json().catch(() => null)) : null;
		return { sub: { platform: "bilibili", id: mid!, ...(info?.name ? { title: info.name } : {}) } };
	}
	const res = await fetch(parsed.feedUrl, { headers }).catch(() => null);
	if (!res?.ok) return { error: "这个地址打不开。播客请粘 RSS 订阅地址(播客主页通常有「RSS」按钮)。" };
	const feed = parsePodcastFeed(await res.text());
	if (feed.items.length === 0) return { error: "这个地址不像播客 RSS(没有带音频的条目)。" };
	return { sub: { platform: "podcast", id: parsed.feedUrl, ...(feed.channelTitle ? { title: feed.channelTitle } : {}) } };
}

// ---------- 发现(Worker 内联版:本地/fork 用;线上由消费者经代理做) ----------

export async function discoverInline(subs: SubRecord[]): Promise<{ items: CandidateRecord[]; sources: Record<string, string> }> {
	const headers = { "user-agent": BROWSER_UA };
	const items: CandidateRecord[] = [];
	const sources: Record<string, string> = {};
	for (const sub of subs) {
		const key = subKeyOf(sub.platform, sub.id);
		try {
			let found: Candidate[] = [];
			if (sub.platform === "youtube") {
				const res = await fetch(youtubeUploadsFeedUrl(sub.id), { headers });
				if (!res.ok) throw new Error(`rss ${res.status}`);
				found = parseYoutubeFeed(await res.text()).items;
			} else if (sub.platform === "bilibili") {
				const res = await fetch(await biliArchiveUrl(sub.id), { headers });
				if (!res.ok) throw new Error(`archive ${res.status}`);
				const parsed = parseBiliArchive(await res.json());
				if (parsed.error) throw new Error(parsed.error);
				found = parsed.items;
			} else {
				const res = await fetch(sub.id, { headers });
				if (!res.ok) throw new Error(`rss ${res.status}`);
				found = parsePodcastFeed(await res.text()).items;
			}
			items.push(...found.map((c) => ({ ...c, subKey: key })));
			sources[key] = `ok:${found.length}`;
		} catch (err) {
			sources[key] = `error:${(err as Error).message.slice(0, 120)}`;
		}
	}
	return { items, sources };
}

// ---------- 挑选 + 投递(幂等:当天已有 SUBRUN 就不再动) ----------

async function contentKeyFor(c: CandidateRecord): Promise<{ key: string; platform: string }> {
	const cid = await identifyUrl(c.url);
	// 播客 enclosure 没有音频扩展名时 identifyUrl 会当文章;订阅来的一律按音频走慢车道
	if (c.platform === "podcast" && cid.lane !== "slow") {
		const digest = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(c.url));
		const hex = [...new Uint8Array(digest)].map((b) => b.toString(16).padStart(2, "0")).join("");
		return { key: `audio:${hex}`, platform: "podcast" };
	}
	return { key: cid.key, platform: cid.platform };
}

export async function pickForUser(env: AppEnv, store: Store, email: string, date: string, opts?: { sweep?: boolean }): Promise<string> {
	if (await store.getSubRun(email, date)) return "already_ran";
	const cand = await store.getCandidates(email, date);
	if (!cand) {
		if (!opts?.sweep) return "no_candidates_yet";
		await store.putSubRun(email, { date, picked: null, reason: "发现步骤没有回传候选(消费者失败或超时)", at: Date.now() });
		return "no_candidates";
	}
	const subs = await store.listSubscriptions(email);
	const reads = await store.listReadRecords(email);
	const seenKeys = new Set(reads.map((r) => r.contentKey));
	// pickDaily 按 `${platform}:${id}` 判已处理;这里把处理记录的 contentKey 翻译成同一口径
	const seen = new Set<string>();
	for (const c of cand.items) {
		const { key } = await contentKeyFor(c);
		if (seenKeys.has(key)) seen.add(`${c.platform}:${c.id}`);
	}
	const lastPicked = new Map(subs.map((s) => [subKeyOf(s.platform, s.id), s.lastPickedAt ?? 0]));
	const outcome = pickDaily({ candidates: cand.items, seen, lastPicked, subKeyOf: (c) => (c as CandidateRecord).subKey });
	if (!outcome.picked) {
		const why = Object.entries(outcome.reasons)
			.map(([k, v]) => `${k}=${v}`)
			.join(" ");
		await store.putSubRun(email, { date, picked: null, reason: `无可用候选(共 ${outcome.considered} 条:${why || "空"})`, at: Date.now() });
		return "nothing_to_pick";
	}
	const picked = outcome.picked as CandidateRecord;
	const { key, platform } = await contentKeyFor(picked);
	const sub = subs.find((s) => subKeyOf(s.platform, s.id) === picked.subKey);
	if (sub) await store.putSubscription(email, { ...sub, lastPickedAt: Date.now() });

	// 缓存命中(别人订阅了同一条):不跑管线,直接落记录 + 发邮件
	const cached = await env.WATCH.get<CachedContent>(contentCacheKey(key), "json");
	if (cached) {
		await store.putReadRecord(email, { contentKey: key, url: picked.url, title: cached.result.meta.title ?? picked.title, at: Date.now() });
		await store.putSubRun(email, { date, picked, reason: "缓存命中,直接交付", contentKey: key, at: Date.now() });
		await notifySubscription(env, store, email, key, cached.result, picked);
		return "cached";
	}

	const task: TaskRecord = {
		id: crypto.randomUUID(),
		email,
		url: picked.url,
		contentKey: key,
		platform,
		status: "pending",
		step: "queued",
		origin: "subscription",
		createdAt: Date.now(),
		updatedAt: Date.now(),
	};
	await store.createTask(task);
	if (awsConfigured(env) && env.QUEUE_URL) {
		await sendTask(env, { taskId: task.id, url: task.url, contentKey: task.contentKey, platform: task.platform, email, title: picked.title });
	} else {
		// mock 慢车道:直接完成示例任务(docs/02 T5),邮件走 console
		const result = mockWatchResult("subtitle");
		await env.WATCH.put(
			contentCacheKey(key),
			JSON.stringify({ result, contentKey: key, cachedAt: Date.now(), url: picked.url } satisfies CachedContent),
			{ expirationTtl: CONTENT_CACHE_TTL_S },
		);
		await store.putReadRecord(email, { contentKey: key, url: picked.url, title: picked.title, at: Date.now() });
		await store.updateTask(task.id, { status: "done", step: "done", path: "subtitle" });
		await notifySubscription(env, store, email, key, result, picked);
	}
	await store.putSubRun(email, { date, picked, reason: `挑中(候选 ${outcome.considered} 条)`, taskId: task.id, contentKey: key, at: Date.now() });
	return "queued";
}

// ---------- 邮件门铃(docs/05 §3.5) ----------

/** 任务完成时由 complete 端点调用;也用于缓存命中直达。失败只记日志。 */
export async function notifySubscription(
	env: AppEnv,
	store: Store,
	email: string,
	contentKey: string,
	result: WatchResult,
	picked?: CandidateRecord | null,
): Promise<void> {
	try {
		const prefs = await store.getPrefs(email);
		if (prefs.emailPush === false) return;
		if (!picked) {
			// complete 端点只知道 task;从最近两天的 SUBRUN 里找回候选信息(频道名/时长)
			for (const d of [subDate(), subDate(new Date(Date.now() - 86_400_000))]) {
				const run = await store.getSubRun(email, d);
				if (run?.contentKey === contentKey) {
					picked = run.picked;
					break;
				}
			}
		}
		const durationSec = picked?.durationSec ?? result.chapters[result.chapters.length - 1]?.end;
		// 标题以订阅挑选时 RSS 给的为准:裸音频链接经 yt-dlp 只能得到一串 id(线上首封邮件主题是 UUID,实测)
		const title = picked?.title ?? result.meta.title ?? contentKey;
		if (picked?.title && picked.title !== result.meta.title) {
			const rec = await store.getReadRecord(email, contentKey);
			if (rec) await store.putReadRecord(email, { ...rec, title: picked.title });
		}
		const secret = env.EMAIL_UNSUB_SECRET;
		if (!secret || !env.AWS_ACCESS_KEY_ID || !env.AWS_SECRET_ACCESS_KEY) {
			console.log(`[subscription] email skipped (EMAIL_UNSUB_SECRET/AWS not configured): ${email} ← ${result.meta.title ?? contentKey}`);
			return;
		}
		const token = await unsubToken(secret, email);
		const mail = renderWatchEmail({
			channelTitle: picked?.channelTitle,
			title,
			durationSec,
			worth: result.verdict.worth,
			reason: result.verdict.reason,
			openUrl: `${appUrl(env, "app")}?open=${encodeURIComponent(contentKey)}`,
			unsubUrl: `${appUrl(env, "api/email/unsub")}?token=${token}`,
		});
		await sendWatchEmail(
			{
				region: env.AWS_REGION ?? "us-east-1",
				accessKeyId: env.AWS_ACCESS_KEY_ID,
				secretAccessKey: env.AWS_SECRET_ACCESS_KEY,
				from: env.EMAIL_FROM ?? "watch@nanisle.com",
			},
			email,
			mail,
			`${appUrl(env, "api/email/unsub")}?token=${token}`,
		);
		console.log(`[subscription] email sent: ${email} ← ${mail.subject}`);
	} catch (err) {
		console.error("[subscription] email failed:", (err as Error).message);
	}
}

// ---------- 定时任务 ----------

export async function runScheduled(env: AppEnv, cron: string): Promise<void> {
	const { store } = makeStore(env);
	const date = subDate();
	const subscribers = await store.listSubscribers();
	const sweep = cron !== DISCOVER_CRON;
	console.log(`[subscription] cron ${cron} ${sweep ? "sweep" : "discover"} date=${date} subscribers=${subscribers.length}`);
	for (const email of subscribers) {
		try {
			if (sweep) {
				const r = await pickForUser(env, store, email, date, { sweep: true });
				console.log(`[subscription] sweep ${email}: ${r}`);
				continue;
			}
			const subs = await store.listSubscriptions(email);
			if (subs.length === 0) continue;
			if (awsConfigured(env) && env.QUEUE_URL) {
				await sendDiscover(env, { kind: "discover", email, date, subs: subs.map((s) => ({ platform: s.platform, id: s.id, title: s.title })) });
			} else {
				const found = await discoverInline(subs);
				await store.putCandidates(email, { date, items: found.items, sources: found.sources, at: Date.now() });
				await pickForUser(env, store, email, date);
			}
		} catch (err) {
			console.error(`[subscription] ${email} failed:`, (err as Error).message);
		}
	}
}

/** wrangler.jsonc triggers.crons 的两条:发现 / 兜底(UTC)。 */
export const DISCOVER_CRON = "0 0 * * *";
export const SWEEP_CRON = "30 1 * * *";

// ---------- 路由 ----------

export const subsApp = new Hono<Guarded>();

subsApp.get("/api/subs", userGuard, async (c) => {
	const email = c.get("email");
	const store = c.get("store");
	const [subs, prefs, run] = await Promise.all([store.listSubscriptions(email), store.getPrefs(email), store.getSubRun(email, subDate())]);
	return c.json({
		items: subs.map((s) => ({ ...s, label: PLATFORM_LABEL[s.platform] })),
		limit: MAX_SUBSCRIPTIONS,
		emailPush: prefs.emailPush !== false,
		today: run ? { picked: run.picked ? { title: run.picked.title, channelTitle: run.picked.channelTitle } : null, reason: run.reason, contentKey: run.contentKey } : null,
	});
});

subsApp.post("/api/subs", userGuard, async (c) => {
	const body = await c.req.json<{ input?: unknown }>().catch(() => null);
	const input = typeof body?.input === "string" ? body.input.trim() : "";
	if (!input) return c.json({ error: "粘一个频道 / UP 主 / 播客 RSS 地址。" }, 400);
	const email = c.get("email");
	const store = c.get("store");
	const existing = await store.listSubscriptions(email);
	if (existing.length >= MAX_SUBSCRIPTIONS) return c.json({ error: `最多订阅 ${MAX_SUBSCRIPTIONS} 个——每天只挑一条,再多也轮不过来。` }, 409);
	const r = await resolveSubscription(input);
	if ("error" in r) return c.json({ error: r.error }, 422);
	if (existing.some((s) => s.platform === r.sub.platform && s.id === r.sub.id)) return c.json({ error: "已经订阅过了。" }, 409);
	const sub: SubRecord = { ...r.sub, addedAt: Date.now() };
	await store.putSubscription(email, sub);
	return c.json({ ok: true, sub: { ...sub, label: PLATFORM_LABEL[sub.platform] } });
});

subsApp.post("/api/subs/delete", userGuard, async (c) => {
	const body = await c.req.json<{ platform?: unknown; id?: unknown }>().catch(() => null);
	const platform = body?.platform as SubPlatform;
	const id = typeof body?.id === "string" ? body.id : "";
	if (!["youtube", "bilibili", "podcast"].includes(platform) || !id) return c.json({ error: "need { platform, id }" }, 400);
	await c.get("store").deleteSubscription(c.get("email"), platform, id);
	return c.json({ ok: true });
});

subsApp.post("/api/subs/prefs", userGuard, async (c) => {
	const body = await c.req.json<{ emailPush?: unknown }>().catch(() => null);
	const store = c.get("store");
	const email = c.get("email");
	const prefs = await store.getPrefs(email);
	await store.putPrefs(email, { ...prefs, emailPush: body?.emailPush !== false });
	return c.json({ ok: true, emailPush: body?.emailPush !== false });
});

/** 本地/fork 与运营手动触发:对当前用户立刻跑一轮「发现 → 挑一条」。线上也走 Worker 内联抓取(不经代理),只作调试。 */
subsApp.post("/api/subs/run", userGuard, async (c) => {
	const email = c.get("email");
	const store = c.get("store");
	const date = subDate();
	const subs = await store.listSubscriptions(email);
	if (subs.length === 0) return c.json({ error: "还没有订阅。" }, 400);
	const found = await discoverInline(subs);
	await store.putCandidates(email, { date, items: found.items, sources: found.sources, at: Date.now() });
	const r = await pickForUser(c.env, store, email, date);
	const run = await store.getSubRun(email, date);
	return c.json({ ok: true, outcome: r, sources: found.sources, run });
});

/** 消费者回传候选(x-consumer-token 鉴权,同 /api/queue/*)。回传即挑选。 */
subsApp.post("/api/queue/candidates", async (c) => {
	const token = c.env.CONSUMER_TOKEN;
	if (!token || !safeEqual(token, c.req.header("x-consumer-token") ?? "")) return c.json({ error: "unauthorized" }, 401);
	const body = await c.req.json<{ email?: string; date?: string; items?: unknown; sources?: Record<string, string> }>().catch(() => null);
	if (!body?.email || !body.date || !Array.isArray(body.items)) return c.json({ error: "need { email, date, items[] }" }, 400);
	const items = (body.items as CandidateRecord[]).filter((i) => i && typeof i.url === "string" && typeof i.title === "string" && typeof i.publishedAt === "number").slice(0, 300);
	const { store } = makeStore(c.env);
	await store.putCandidates(body.email, { date: body.date, items, sources: body.sources ?? {}, at: Date.now() });
	const outcome = await pickForUser(c.env, store, body.email, body.date);
	return c.json({ ok: true, outcome });
});

// 一键退订(001 E1 同款):免登录,HMAC token 认身份;GET 给人看,POST 给 Gmail 一键退订
async function unsubscribe(c: { env: AppEnv; req: { query(name: string): string | undefined } }): Promise<{ ok: boolean; status: 200 | 400 | 503 }> {
	const secret = c.env.EMAIL_UNSUB_SECRET;
	if (!secret) return { ok: false, status: 503 };
	const email = await verifyUnsubToken(secret, c.req.query("token") ?? "");
	if (!email) return { ok: false, status: 400 };
	const { store } = makeStore(c.env);
	const prefs = await store.getPrefs(email);
	await store.putPrefs(email, { ...prefs, emailPush: false });
	return { ok: true, status: 200 };
}

subsApp.get("/api/email/unsub", async (c) => {
	const result = await unsubscribe(c);
	const body = result.ok
		? "<p>已退订订阅日报的邮件提醒。</p><p>每天挑的那条照常在「我的记录」里;想恢复提醒,去「我的订阅」重新打开即可。</p>"
		: result.status === 503
			? "<p>退订功能未启用。</p>"
			: "<p>退订链接无效或已损坏。</p><p>你也可以登录后在「我的订阅」里关闭邮件提醒。</p>";
	return c.html(
		`<!doctype html><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>长视频总结</title>
<div style="max-width:480px;margin:80px auto;padding:0 20px;font-family:-apple-system,'PingFang SC','Microsoft YaHei',sans-serif;color:#1a1a1a;line-height:1.8;">
<p style="font-size:12px;letter-spacing:0.08em;color:#999;">长视频总结</p>${body}
<p><a href="${appUrl(c.env, "app")}" style="color:#1a1a1a;">打开长视频总结 →</a></p></div>`,
		result.status,
	);
});

subsApp.post("/api/email/unsub", async (c) => {
	const result = await unsubscribe(c);
	return c.json({ ok: result.ok }, result.status);
});
