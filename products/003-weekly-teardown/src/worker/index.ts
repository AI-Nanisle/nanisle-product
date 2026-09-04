// 003 领域拆解 · Worker 入口(docs/02-技术方案.md)。
//
// 阶段 1 = 脚手架 + 主站登记 + SSO:
//   GET /api/health   provider / PAT / D1 是不是真的接上了
//   GET /auth/sso     主站登录手递的落点,验签后种会话 cookie
//   GET /api/__spike  阶段 0 的出口连通性实测(站长凭证保护)
// 阶段 3 = 关注档案(dossier.ts,四条路由,连门禁一起挂在那边):
//   POST /api/dossier/draft · GET/PUT/DELETE /api/dossier
// 阶段 7 = 深度报告(report.ts,三条路由,POST 那条是 SSE):
//   POST /api/report · GET /api/report/inflight · GET /api/report
//
// 其余业务路由(发现层、深度报告、cron、门铃邮件)在后面的阶段接进来,
// 这里刻意留空——不提前写没验证过的东西。

import { Hono } from "hono";
import { setCookie } from "hono/cookie";
// 相对 import 一律带 `.ts` 后缀(理由同 guard.ts 顶部:node --test 的 ESM 解析器
// 不补后缀)。这个文件原来是全仓唯一没带的地方——它一直没被任何测试 import,
// 所以没人踩到;2026-09-01 上线前终审给 /api/health 和 scheduled() 补测试时,
// 第一件事就是它整片解析不了。
import { resolveProvider } from "../shared/ai.ts";
import { SESSION_COOKIE, adminGuard, appUrl, loginUrl } from "./guard.ts";
import type { Guarded } from "./guard.ts";
import { aiConfig } from "./env.ts";
import type { AppEnv } from "./env.ts";
import { AUDIENCE, signToken, verifyToken } from "./sso.ts";
import { dossierRoutes } from "./dossier.ts";
import { scanRoutes } from "./scan.ts";
import { reportRoutes } from "./report.ts";
import { emailRoutes, runWeeklyCron } from "./cron.ts";
import type { DbHealth, HealthResponse } from "../shared/types.ts";

// 应用整体按 Guarded 定型(= Bindings + userGuard 挂上的 email 变量),而不是
// 只写 Bindings:子应用 dossierRoutes 里的 handler 要读 c.get("email"),
// 两边的 Env 必须是同一个,route() 才对得上。没有中间件的路由不受影响。
const app = new Hono<Guarded>();

/** 本产品在主站上的挂载点(带尾斜杠)。SSO 完成后落到它下面的 app。 */
const PRODUCT_MOUNT = "/products/weekly-teardown/";

/** 会话有效期。过期就回主站再点一次「打开产品」,无服务端状态。 */
const SESSION_TTL_S = 30 * 24 * 3600;

/**
 * 库到底能不能用。**真的跑一次查询**(2026-09-01 上线前终审的 C3)。
 *
 * 原来这里是 `hasDb: Boolean(c.env.TEARDOWN_DB)` —— 那只证明 wrangler.jsonc 里
 * 配了个 binding。**忘了跑 `wrangler d1 migrations apply --remote` 的话它照样
 * 回 true**,然后每一个真端点 500。而那恰恰是首次部署最可能踩的坑:一个只在
 * 「什么都没坏」时才说真话的健康检查,在最需要它的那一刻说了假话。
 *
 * 查询挑的是 `SELECT 1 FROM dossier LIMIT 1`:
 * - 只读、不带参数、命中主键扫描前就返回,比 `SELECT COUNT(*)` 便宜得多
 *   (健康检查会被监控每分钟打一次,不能是一次全表扫);
 * - 用 `dossier` 而不是随便一张表:它是这个产品第一张被写的表,迁移跑没跑过
 *   一问便知;
 * - 空库也算 ok —— **没有行不是坏**,`first()` 回 null 是正常结果。
 *
 * 「表不在」和「D1 这会儿不通」要分开:前者的处置是跑迁移,后者只能等。
 * D1 在表不存在时抛的是一个带 `no such table` 的错(SQLite 的原话),认这个串
 * 是有点脆,但认错了也只是把 no-tables 说成 error —— 两种都是「库不能用」,
 * 不会把坏的说成好的。
 */
async function probeDb(db: D1Database | undefined): Promise<DbHealth> {
	if (!db) return "no-binding";
	try {
		await db.prepare("SELECT 1 AS ok FROM dossier LIMIT 1").first();
		return "ok";
	} catch (err) {
		const msg = err instanceof Error ? err.message : String(err);
		if (/no such table/i.test(msg)) {
			console.error("/api/health: D1 接上了,但表不在 —— 迁移没跑过(wrangler d1 migrations apply)", err);
			return "no-tables";
		}
		console.error("/api/health: D1 查询失败", err);
		return "error";
	}
}

app.get("/api/health", async (c) => {
	let provider = "invalid";
	try {
		provider = resolveProvider(aiConfig(c.env));
	} catch {
		// 留 "invalid" —— AI_PROVIDER 配错不该把健康检查一起拖下水
	}
	const db = await probeDb(c.env.TEARDOWN_DB);
	// 显式标注成 HealthResponse:前端读的是同一个类型,少给一个字段这里就编译
	// 不过,而不是等到页面上安静地空着(types.ts HealthResponse 的注释)
	const body: HealthResponse = {
		ok: true,
		provider,
		// 这两个都是「可选但影响行为」的东西,健康检查里露出来才不会误判:
		// 没 PAT 是 60 次/小时的匿名档(仍是真数据),库不能用是压根跑不动。
		hasPat: Boolean(c.env.GITHUB_PAT),
		// **由真查询决定,不是 binding 存不存在**(见 probeDb)。
		hasDb: db === "ok",
		db,
	};
	return c.json(body);
});

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

// 主站登录手递的落点(主站侧:nanisle 仓 web/app/api/launch/[slug]/route.ts)。
// 验证主站签的 5 分钟短时票,通过才换成本域的 30 天会话 cookie。
app.get("/auth/sso", async (c) => {
	const secret = c.env.NANISLE_SSO_SECRET;
	// 没配共享密钥的实例本来就不做登录门禁,直接进应用。
	// 落点是 app 子路径:裸挂载根是主站的产品详情页,进不了应用(主站的
	// 转发要求「挂载 + 至少一段」,web/lib/product-mounts.ts 有同款注释)。
	// 两处 302 都走**相对**路径而不是 appUrl():APP_URL 的默认值是线上地址,
	// 本地 dev 没配它的话会把人从 localhost 甩到 nanisle.com 去。
	if (!secret) return c.redirect(`${PRODUCT_MOUNT}app`, 302);
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
	// 开放使用:登录有效就发会话,不设白名单(沿用 001 退役白名单后的形态)。
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
	return c.redirect(`${PRODUCT_MOUNT}app`, 302);
});

// 退出登录:清掉本产品这一份会话。删除必须和种下时同作用域(path/secure),
// 否则浏览器留着旧 cookie 不放。
app.get("/auth/logout", (c) => {
	const scope = sessionCookieScope(c.env);
	setCookie(c, SESSION_COOKIE, "", { path: scope.path, httpOnly: true, sameSite: "Lax", secure: scope.secure, maxAge: 0 });
	return c.redirect(appUrl(c.env), 302);
});

// ---------------------------------------------------------------------------
// 阶段 0 的出口连通性 spike(docs/02「阶段 0 展开 ①」)
// ---------------------------------------------------------------------------

/**
 * GitHub API **强制**要求 User-Agent,不设直接 403。
 * 这是「Worker 请求 GitHub 报 403」最常见的原因,别误判成出口 IP 被封——
 * 判断「CF 出口能不能用」之前先把这个变量消掉,否则整个 spike 的结论是假的。
 */
const UA = "nanisle-weekly-teardown";

interface SpikeProbe {
	url: string;
	/** HTTP 状态码;网络层就失败时为 0(fetch 抛异常,连状态码都没有)。 */
	status: number;
	ms: number;
	/** 同一个 URL 打两次(带 PAT / 不带)时用它区分,其余为 undefined。 */
	note?: string;
	/** status 为 0 时的失败原因;成功时不出现。 */
	error?: string;
}

/**
 * 单次探测的超时。没有它,上游黑洞丢包(不是拒连)时 Promise.all 里那一个
 * probe 永远不 settle,整个 /api/__spike 挂死到边缘超时——站长拿到 524 而不是
 * 一行 { status: 0, error: "timeout" },而阶段 0 的通过判据("HN Algolia 全部
 * 成功且 p95 < 2 秒")恰恰要靠这一行才量得出来。002 的每一处对外 fetch 都挂
 * 了 AbortSignal.timeout(extract.ts 15s/30s、interop.ts 8s、subs.ts 10s),
 * 这是 2026-08-25 用户反馈「找信源无超时无重试」之后立的规矩。
 */
const PROBE_TIMEOUT_MS = 10_000;

async function probe(url: string, headers: Record<string, string>, note?: string): Promise<SpikeProbe> {
	const t0 = Date.now();
	try {
		// 只读响应头就够:spike 量的是「通不通、多久」,不是内容。但 body 不消费
		// 会占着连接,所以显式丢弃。
		const res = await fetch(url, { headers, signal: AbortSignal.timeout(PROBE_TIMEOUT_MS) });
		await res.body?.cancel();
		return { url, status: res.status, ms: Date.now() - t0, note };
	} catch (err) {
		return { url, status: 0, ms: Date.now() - t0, note, error: err instanceof Error ? err.message : String(err) };
	}
}

/** ?n= 的默认与上限。默认 5 够看出量级,判据要的 20 得显式要。 */
const SPIKE_DEFAULT_N = 5;
const SPIKE_MAX_N = 20;

/**
 * 整个 spike 的墙钟预算。到点就停止取样,已经取到的照常出统计。
 * 没有它,n=20 撞上一个黑洞目标就是 20×10 秒 = 200 秒,站长拿到的是边缘的
 * 524 而不是数据——而 spike 的全部意义就是拿到数据。宁可少几个样本、
 * 在 samples 里如实写出来,也不要整个端点挂掉。
 */
const SPIKE_BUDGET_MS = 60_000;

interface SpikeTarget {
	url: string;
	headers: Record<string, string>;
	note?: string;
}

interface SpikeStats {
	url: string;
	note?: string;
	/** 实际取到的样本数。撞上墙钟预算时会小于请求的 n,不补齐、不伪造。 */
	samples: number;
	/** 其中 2xx 的次数。通过判据「HN Algolia 20/20 成功」看的就是它。 */
	ok: number;
	min: number;
	p50: number;
	p95: number;
	max: number;
	/** 每个状态码各出现几次(0 = 网络层就失败)。 */
	statuses: Record<string, number>;
	/** 去重后的失败原因;全成功时不出现。 */
	errors?: string[];
}

/**
 * 最近秩百分位。样本量只有 5-20 条,插值法的精度是假的——
 * p95 在 20 个样本上本来就等于「第 19 个」,直说比算出一个小数好。
 */
function percentile(sortedMs: number[], p: number): number {
	if (sortedMs.length === 0) return 0;
	const idx = Math.min(sortedMs.length - 1, Math.max(0, Math.ceil(p * sortedMs.length) - 1));
	return sortedMs[idx] ?? 0;
}

/**
 * 对一个目标连打 n 次,**串行**。串行有两个理由:一是并发打同一个主机会把
 * 排队时间算进延迟,量出来的 p95 是我们自己造成的;二是 GitHub 对短时间内的
 * 突发请求会直接限流,那样量的是限流不是延迟。
 * 到墙钟预算就提前收工,返回已有的样本。
 */
async function sampleTarget(t: SpikeTarget, n: number, deadline: number): Promise<SpikeStats> {
	const probes: SpikeProbe[] = [];
	for (let i = 0; i < n; i++) {
		if (Date.now() >= deadline) break;
		probes.push(await probe(t.url, t.headers, t.note));
	}
	// 百分位算在**全部**样本上,包括失败的那些(它们的 ms 是失败前耗掉的时间)。
	// 只统计成功样本会让「一半请求 10 秒超时、另一半 200ms」看起来像个健康目标。
	const sorted = probes.map((p) => p.ms).sort((a, b) => a - b);
	const statuses: Record<string, number> = {};
	for (const p of probes) statuses[String(p.status)] = (statuses[String(p.status)] ?? 0) + 1;
	const errors = [...new Set(probes.map((p) => p.error).filter((e): e is string => Boolean(e)))];
	return {
		url: t.url,
		note: t.note,
		samples: probes.length,
		ok: probes.filter((p) => p.status >= 200 && p.status < 300).length,
		min: sorted[0] ?? 0,
		p50: percentile(sorted, 0.5),
		p95: percentile(sorted, 0.95),
		max: sorted[sorted.length - 1] ?? 0,
		statuses,
		...(errors.length > 0 ? { errors } : {}),
	};
}

/**
 * 从 Cloudflare 出口对每个目标连打 n 次(?n=,默认 5、上限 20),回
 * min/p50/p95/max 和成功次数。用途是**在写代码之前**确认「美东住宅 IP 上量到
 * 的延迟」在 Workers 的全球共享出口上还成立——002 已经实测过「AWS IP 上
 * B 站一律 412」,同类风险必须先排掉再动手。
 *
 * 通过判据(docs/02):GitHub 带 PAT 无 403;HN Algolia 20/20 成功且 p95 < 2 秒。
 * **单次采样出不了 p95**,所以这个端点必须能重复打——判据本身就是按 20 次写的。
 * 不过就当周退回 skill 形态——这是刹车,不是热身。
 *
 * 并发限在「目标数」这一档(5 路),不是 n×目标数:20×5 = 100 个请求一起出去,
 * 量到的是我们自己把出口打满之后的延迟,而且大概率触发 GitHub 的突发限流。
 * 每个目标内部串行(sampleTarget),目标之间并行。
 *
 * 站长凭证保护:它会从我们的出口发请求,不该给匿名访客当代理用。
 */
app.get("/api/__spike", adminGuard, async (c) => {
	const raw = Number.parseInt(c.req.query("n") ?? "", 10);
	// 上限 20 不是保守,是 docs/02 判据里的那个 20;再多也只是烧时间
	const n = Number.isFinite(raw) ? Math.min(SPIKE_MAX_N, Math.max(1, raw)) : SPIKE_DEFAULT_N;
	const pat = c.env.GITHUB_PAT;
	const gh = { "user-agent": UA, accept: "application/vnd.github+json" };
	const targets: SpikeTarget[] = [
		{ url: "https://api.github.com/rate_limit", headers: gh, note: "no-pat" },
		{ url: "https://hn.algolia.com/api/v1/search?query=test", headers: { "user-agent": UA } },
		{ url: "https://raw.githubusercontent.com/cloudflare/workers-sdk/main/README.md", headers: { "user-agent": UA } },
		{ url: "https://github.com/cloudflare/workers-sdk/releases.atom", headers: { "user-agent": UA } },
	];
	// 没配 PAT 就只有匿名那一轮:少一行结果,而不是伪造一行
	if (pat) {
		targets.push({
			url: "https://api.github.com/rate_limit",
			headers: { ...gh, authorization: `Bearer ${pat}` },
			note: "with-pat",
		});
	}
	const deadline = Date.now() + SPIKE_BUDGET_MS;
	const results = await Promise.all(targets.map((t) => sampleTarget(t, n, deadline)));
	return c.json({ ua: UA, patConfigured: Boolean(pat), n, budgetMs: SPIKE_BUDGET_MS, results });
});

// ---------------------------------------------------------------------------
// 阶段 3 · 关注档案(dossier.ts)
// ---------------------------------------------------------------------------

// 挂在根上:路径在 dossier.ts 里写全(/api/dossier...)。**必须在下面那条
// `app.all("*")` 兜底之前挂**——Hono 按注册顺序匹配,挂在兜底后面的话
// 所有 /api/dossier 请求都会被兜底那条的 JSON 404 吃掉。
app.route("/", dossierRoutes);

// ---------------------------------------------------------------------------
// 阶段 4 · 发现层(scan.ts)
// ---------------------------------------------------------------------------

// 同上:必须在 `app.all("*")` 兜底之前挂。
app.route("/", scanRoutes);

// ---------------------------------------------------------------------------
// 阶段 7 · 深度报告两节 + SSE(report.ts)
// ---------------------------------------------------------------------------

// 同上:必须在 `app.all("*")` 兜底之前挂。
app.route("/", reportRoutes);

// ---------------------------------------------------------------------------
// 阶段 8 · 一键退订 + 阶段 9 · 订阅开关(cron.ts)
// ---------------------------------------------------------------------------

// 同上:必须在 `app.all("*")` 兜底之前挂。
//
// `/unsub` 不在 `/api/` 下面,是因为它是**给人点的页面**,不是给前端调的 JSON
// ——收信人可能在一台没登录过的手机上点它,拿到的应该是一句中文,不是一段
// {"ok":true}。wrangler.jsonc 的 run_worker_first 里有 /products/weekly-teardown/*,
// 所以带挂载前缀进来的这条路径会先进 Worker(而不是被 SPA fallback 吞掉),
// 再由下面的 unmountRequest 剥成 /unsub。
//
// 同一个子应用里还挂着 GET/PUT `/api/email`(阶段 9 的订阅开关)。它们放在一起
// 是有意的:**这三条路由是 `email_optout` 那张表的全部写入方**,凑在一个文件里,
// 「两处状态会不会分叉」这个问题一眼就能看完(答案是不会 —— 它们写的是同一行)。
// 区别只在门禁:/unsub 免登录(靠 HMAC token 认人,收信人可能在没登录的手机上点),
// /api/email 走 userGuard(它改的是当前登录账号自己的状态)。
app.route("/", emailRoutes);

// ---------- 兜底:静态资源(SPA)与 404 ----------

app.all("*", async (c) => {
	// 没匹配上的 API 路径回 JSON 404,不要落进 SPA fallback——否则前端拿到的是
	// 一整页 HTML,`res.json()` 抛一个跟真实原因毫无关系的解析错误。
	if (new URL(c.req.url).pathname.startsWith("/api/")) {
		return c.json({ error: "Not found" }, 404);
	}
	if (c.req.method === "GET" || c.req.method === "HEAD") {
		// 生产的资源在 dist/client 根下(不带挂载前缀)+ SPA fallback;而 vite
		// 的 dev 资源服务是 base-aware 的,路径带前缀。所以先按原路径问一次,
		// 拿不到再补上挂载前缀重试一次(实际只有 dev 会走到第二次)。
		const res = await c.env.ASSETS.fetch(c.req.raw);
		if (res.status !== 302 && res.status !== 404) return res;
		const url = new URL(c.req.url);
		url.pathname = `${PRODUCT_MOUNT.replace(/\/$/, "")}${url.pathname}`;
		return c.env.ASSETS.fetch(new Request(url, c.req.raw));
	}
	return c.json({ error: "Not found" }, 404);
});

/**
 * 同时接受 Worker 自己的根路径和 nanisle.com 上的公开挂载路径。
 *
 * 主站的 Service Binding 转发时已经把前缀剥掉了(web/custom-worker.ts),所以
 * 这一步在生产链路上是空转;它挡的是**直连 workers.dev 域**的场景——前端
 * 打包时 base 是 /products/weekly-teardown/,直连域上请求带着前缀进来,不剥
 * 就全部 404。wrangler.jsonc 的 run_worker_first 列了同一条前缀。
 */
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
	// 每周一 08:00 UTC 的周扫 + 门铃邮件(wrangler.jsonc triggers,编排在 cron.ts)。
	//
	// **必须 ctx.waitUntil 包起来**:scheduled() 一 return,运行时就可以随时收掉
	// 这次调用的执行上下文,而这一趟要跑几分钟。waitUntil 是唯一能说「我还没完」
	// 的方式(002 的 index.ts 同款写法)。
	//
	// 本地验:`wrangler dev --test-scheduled`,然后打
	// `/__scheduled?cron=0+8+*+*+1`(cron 表达式里的空格用 + 或 %20)。
	//
	// **必须挂 .catch**(2026-09-01 上线前终审的 A3):`runWeeklyCron` 现在自己
	// 把整趟包在 try 里、不再往外抛,所以这一条是最后一道兜底(比如它的收工
	// 日志那一行本身炸了)。没有它,一个未捕获的 rejection 在 `waitUntil` 里
	// 只会变成运行时的一条错误,而 **cron 触发器不重试** —— 这一周对所有人就
	// 这么过去了,而且没有一行日志说得清楚为什么。
	scheduled(event, env, ctx) {
		ctx.waitUntil(
			runWeeklyCron(env, { cron: event.cron }).catch((err) => {
				console.error(`[cron] ${event.cron} 整趟抛到了最外层(cron 不重试,这一周没人被扫到):`, err);
			}),
		);
	},
} satisfies ExportedHandler<AppEnv>;
