// Worker 从环境里读的一切都收在这里。非密钥写在 wrangler.jsonc 的 vars,
// 密钥走 `wrangler secret put`(线上)或 .dev.vars(本地,已 gitignore)。
//
// 「不设某个 key 会怎样」全部写在字段注释里,别让 fork 的人靠试。
//
// 相对 import 带 `.ts` 后缀的理由见 guard.ts 顶部:guard.ts 要能被 node --test
// 直接 import,它这条依赖链上的文件就都得带后缀。

import { applyOwnerRoute, fastVariant, ownerRouteFromEnv } from "../shared/ai.ts";
import type { AiConfig, OwnerRoute } from "../shared/ai.ts";

export interface AppEnv {
	/** 静态前端。经主站 Service Binding 调进来时由 Worker 自己回落到它。 */
	ASSETS: Fetcher;
	/**
	 * 唯一的有主状态(docs/02 决策 T2):档案、周扫快照、候选、排除、报告、
	 * inflight、配额、日花费。建库是人工门,见 wrangler.jsonc 的注释。
	 */
	TEARDOWN_DB: D1Database;

	// --- AI 接缝(shared/ai.ts) ---
	/** "deepseek"(生产默认)| "mock" | "anthropic" | "gateway"。 */
	AI_PROVIDER?: string;
	/** 判断层的模型(节 1 发展史、节 2 源码 takeaway)。 */
	AI_MODEL?: string;
	/** 轻任务档覆盖(一句话拆档案、候选仓形态描述)。 */
	FAST_AI_PROVIDER?: string;
	FAST_AI_MODEL?: string;
	/** 单次调用的输出上限,托管实例的成本闸。 */
	AI_MAX_OUTPUT_TOKENS?: string;
	/** "1" 关掉所有花 token 的端点(总闸)。 */
	AI_DISABLED?: string;
	/**
	 * 一次 draft(一句话 → 档案)整趟的墙钟预算,毫秒。默认 45000。
	 *
	 * 为什么可配:draft 里叠了三层重试(dossier.ts 的 round × ai.ts 的 JSON 重试
	 * × deepseek 的空产出重试),最坏 8 个上游请求,串行下去会撞 CF 那条 100 秒线。
	 * 这个值就是「宁可少等,也要回一句能读懂的中文」的那条线。生产不用配;
	 * **测试把它调到几百毫秒,用来真的走一遍超时那条路**——没被跑过的超时
	 * 等于没有超时(信号没接通的话代码看起来一模一样)。
	 */
	DRAFT_BUDGET_MS?: string;
	/**
	 * 一趟周扫(发现层)整体的墙钟预算,毫秒。默认 75000。
	 *
	 * 为什么是 75 秒而不是更大:POST /api/scan 是**普通 JSON 响应**,跑完才
	 * 回一次字节,而这条链路上的边缘代理约 100 秒无字节就 524(docs/02 问题 1,
	 * 002 线上撞过)。发现层的正常耗时是 12 次 search + 5-8 次 REST + 1 次 flash
	 * ≈ 20-40 秒,75 秒留了足够余量,又离那条线有 25 秒。
	 *
	 * 预算到点不是抛错,是**提前收工出一份诚实的台账**:GithubClient 拿它当
	 * deadline,要睡过线的退避直接抛 RateBudgetError,collectRepos 记一条
	 * stopped 就停。跑不完和跑挂了是两件事,台账要分得出来。
	 *
	 * 阶段 8 的 cron 不受这条线约束(cron 触发器在「间隔 ≥ 1 小时」这一档有
	 * 15 分钟预算,而且没有浏览器在等),到时候另配一个更大的值。
	 */
	SCAN_BUDGET_MS?: string;
	/**
	 * **cron 那一趟**里,单个用户的周扫墙钟预算,毫秒。默认 300000(5 分钟)。
	 *
	 * 为什么和 SCAN_BUDGET_MS 差一个数量级:那 75 秒是被「100 秒无字节即 524」
	 * 逼出来的,而那条线是**边缘代理对 HTTP 响应**的规矩 —— cron 没有请求、没有
	 * 响应、没有浏览器在等,那条线在这里根本不适用。Workers 的定时触发器在
	 * 「间隔 >= 1 小时」这一档有 15 分钟 CPU 预算(docs/02 决策 T5),而这一趟
	 * 的时间几乎全花在等网络上,不吃 CPU 配额。
	 *
	 * 5 分钟这个数按实测挑的:匿名档 8 条检索词 x 2 路 = 16 次 search 要等 112 秒
	 * (阶段 4 落地记录),加门 1 的 8 次 REST 和一次 flash,3 分钟够跑完;留到
	 * 5 分钟是给退避的抖动。**配了 PAT 之后 search 是 30 次/分钟,根本用不到。**
	 * 用不满不花钱:它是上限不是等待。
	 */
	CRON_SCAN_BUDGET_MS?: string;
	/**
	 * **整趟 cron** 的墙钟预算,毫秒。默认 780000(13 分钟)。
	 *
	 * 15 分钟是运行时给的硬上限,这里留 2 分钟余量,是为了让「跑不完」变成一条
	 * 能写进日志的 notReached 计数,而不是一次被运行时掐断的调用 —— 后者不会告诉
	 * 你它掐在第几个用户,下周还是同样的顺序、同样的位置,而你无从知道有人一直
	 * 没被扫到(docs/02 决策 T5 的「用户数长到几百人」那一段说的就是这一天)。
	 */
	CRON_BUDGET_MS?: string;
	/**
	 * 一份深度报告整趟的墙钟预算,毫秒。默认 180000(3 分钟)。
	 *
	 * 为什么可以远大于 SCAN_BUDGET_MS 的 75 秒:深度报告走的是 **SSE**
	 * (docs/02 决策 T1),响应体一直在滴字节,那条「100 秒无字节即 524」的线
	 * 根本不适用 —— 挡住它的是 10 秒心跳,不是把活干得更快。这个预算挡的是
	 * 另一件事:上游卡住时别让一趟 $0.6 的调用无限期挂着(002 那条
	 * 「找信源无超时无重试」的教训)。
	 *
	 * **测试把它调到几百毫秒,好把超时那条路真的走一遍**——同 DRAFT_BUDGET_MS。
	 */
	REPORT_BUDGET_MS?: string;
	/**
	 * SSE 心跳的间隔,毫秒。默认 10000。**只给测试用,生产别配。**
	 *
	 * 为什么必须可配:这条心跳挡的是「thinking 阶段一个字节都不产出,CF 代理
	 * 100 秒后 524」,而验证它的唯一办法是数「这一趟到底发出了几个 ping」。
	 * 按 10 秒一发,一条像样的用例要跑 30 秒以上 —— 那样的用例没人会跑,
	 * 于是心跳这件事就永远处在「写了但从没被验证过」的状态,和没有心跳
	 * 在代码上长得一模一样(同 DRAFT_BUDGET_MS 的立场)。
	 */
	REPORT_PING_MS?: string;
	/**
	 * GitHub API 根地址。**只给测试用**——scan.test.ts 把它指到一个本地假
	 * 服务器,好把「限额头怎么读、退避怎么等、门 1 抓不通怎么算」这几条
	 * 真的跑一遍(没被跑过的退避和没有退避长得一模一样)。生产不配。
	 *
	 * 取值一律走 `githubApiBase()`,别直接读这个字段:配错了要响,不能静默
	 * 换掉整个数据源(见那个函数的注释)。
	 */
	GITHUB_API_BASE?: string;
	/** Secret. AI_PROVIDER=deepseek(生产默认)。不设 = 自动落回 mock。 */
	DEEPSEEK_API_KEY?: string;
	/** Secret. AI_PROVIDER=anthropic only. */
	ANTHROPIC_API_KEY?: string;
	/** Anthropic 兼容端点地址 — AI_PROVIDER=gateway only. */
	AI_GATEWAY_URL?: string;
	/** Secret. gateway 签发的虚拟 key。 */
	AI_GATEWAY_KEY?: string;

	// --- 站长专线(主仓 backend/docs/01):这几个账号改走另一套 provider,其余用户不受影响 ---
	/** Secret. 逗号分隔的邮箱;不设 = 没有专线。 */
	OWNER_AI_EMAILS?: string;
	OWNER_AI_PROVIDER?: string;
	OWNER_AI_MODEL?: string;
	OWNER_FAST_AI_MODEL?: string;
	OWNER_AI_MAX_OUTPUT_TOKENS?: string;
	/** Secret. 专线网关地址(不进仓,避免被定向扫描)。 */
	OWNER_AI_GATEWAY_URL?: string;
	/** Secret. 专线网关的 Bearer key。 */
	OWNER_AI_GATEWAY_KEY?: string;

	// --- 门禁与身份 ---
	/** Secret. 与主站共享的手递票密钥(sso.ts)。不设 = 不做登录门禁(本地 dev / fork)。 */
	NANISLE_SSO_SECRET?: string;
	/** Secret. 站长凭证(x-access-code)。不设 = 站长端点开放(本地 dev / fork)。 */
	ACCESS_CODE?: string;
	/**
	 * 本地 dev 专用:未配 NANISLE_SSO_SECRET 时(没有登录闸口)冒充哪个用户。
	 * 留空 = dev@local。生产实例永远别设:配了 SSO secret 时这个值不被读到。
	 */
	DEV_EMAIL?: string;

	// --- 外部数据源 ---
	/**
	 * Secret. GitHub 个人访问令牌。**可选**——不设走匿名档 60 次/小时,跑的
	 * 仍然是真网络真数据,只是配额低(docs/02 决策 T5)。设了提到 5000 次/小时。
	 * PAT 是账号级共享桶,不是按用户分的:周扫必须串行 + 按响应头退避。
	 */
	GITHUB_PAT?: string;

	// --- 门铃邮件(SigV4 直调 SES v2,不引入任何 AWS 侧计算) ---
	/** Secret. 退订 token 的 HMAC 密钥。不设 = 不发邮件,其余功能完整。 */
	EMAIL_UNSUB_SECRET?: string;
	/** Secret. 最小权限 IAM 用户,只有 ses:SendEmail。 */
	AWS_ACCESS_KEY_ID?: string;
	/** Secret. 同上。 */
	AWS_SECRET_ACCESS_KEY?: string;
	/** 发件地址(裸地址;显示名在代码里统一加)。 */
	EMAIL_FROM?: string;
	/** SES 所在 region(默认 us-east-1)。 */
	AWS_REGION?: string;

	// --- 站点地址 ---
	/** 主站根地址,登录跳转用(默认 https://nanisle.com)。 */
	NANISLE_URL?: string;
	/** 本产品的公开挂载点(无尾斜杠)。 */
	APP_URL?: string;
}

/** draft 整趟的墙钟预算(毫秒)。默认 45 秒;配了非法值也走默认,不半信半疑。 */
export function draftBudgetMs(env: AppEnv): number {
	const raw = Number.parseInt(env.DRAFT_BUDGET_MS ?? "", 10);
	return Number.isFinite(raw) && raw > 0 ? raw : 45_000;
}

/** 一趟周扫的墙钟预算(毫秒)。默认 75 秒;配了非法值也走默认,不半信半疑。 */
export function scanBudgetMs(env: AppEnv): number {
	const raw = Number.parseInt(env.SCAN_BUDGET_MS ?? "", 10);
	return Number.isFinite(raw) && raw > 0 ? raw : 75_000;
}

/**
 * GitHub API 根地址。没配 = undefined(客户端落回 api.github.com);
 * **配了但不合法 = 记一条错误日志然后当没配过**。
 *
 * 为什么值得一道校验(2026-09-01 阶段 4/5 评审):这不是 SSRF —— 它只能由 env
 * 注入,请求参数和用户数据够不着。但它是一个**配错就静默换掉整个数据源**的
 * 开关:写错一个字母,周扫会安安静静地从另一台服务器拿「GitHub 数据」,台账
 * 照常算、诚实声明照常印、页面上没有任何异样。docs/02 里那句「生产不配」是
 * 一行注释,注释拦不住手滑;这里让它至少响一声,并且退回真的 GitHub。
 *
 * 允许 http 只对 localhost / 127.0.0.1:测试的假 GitHub 就是一台本地 http
 * 服务器(scan.test.ts),要求 https 会把那条端到端的路整个测不了。除此之外
 * 一律必须是 https —— 明文去打一个远程 API 拿的东西不配当「真实数据」。
 */
export function githubApiBase(env: AppEnv): string | undefined {
	const raw = env.GITHUB_API_BASE?.trim();
	if (!raw) return undefined;
	let url: URL;
	try {
		url = new URL(raw);
	} catch {
		console.error(`env: GITHUB_API_BASE 不是一个合法的 URL(${raw}),已忽略,回落到 api.github.com`);
		return undefined;
	}
	const local = url.hostname === "localhost" || url.hostname === "127.0.0.1" || url.hostname === "[::1]";
	if (url.protocol === "https:" || (url.protocol === "http:" && local)) return raw;
	console.error(`env: GITHUB_API_BASE 必须是 https(本地测试服务器除外),拿到的是 ${raw},已忽略,回落到 api.github.com`);
	return undefined;
}

/** cron 里单个用户的周扫预算(毫秒)。默认 5 分钟;配了非法值也走默认。 */
export function cronScanBudgetMs(env: AppEnv): number {
	const raw = Number.parseInt(env.CRON_SCAN_BUDGET_MS ?? "", 10);
	return Number.isFinite(raw) && raw > 0 ? raw : 300_000;
}

/** 整趟 cron 的墙钟预算(毫秒)。默认 13 分钟;配了非法值也走默认。 */
export function cronBudgetMs(env: AppEnv): number {
	const raw = Number.parseInt(env.CRON_BUDGET_MS ?? "", 10);
	return Number.isFinite(raw) && raw > 0 ? raw : 780_000;
}

/** 一份深度报告整趟的墙钟预算(毫秒)。默认 180 秒;配了非法值也走默认。 */
export function reportBudgetMs(env: AppEnv): number {
	const raw = Number.parseInt(env.REPORT_BUDGET_MS ?? "", 10);
	return Number.isFinite(raw) && raw > 0 ? raw : 180_000;
}

/** SSE 心跳间隔(毫秒)。默认 10 秒;配了非法值也走默认。 */
export function reportPingMs(env: AppEnv): number {
	const raw = Number.parseInt(env.REPORT_PING_MS ?? "", 10);
	return Number.isFinite(raw) && raw > 0 ? raw : 10_000;
}

/**
 * 深度报告要打的**三个不同主机**的根地址,一次算清楚。
 *
 *   api.github.com            文件树 / commit / README(吃 API 额度)
 *   raw.githubusercontent.com 源码正文(不吃额度)
 *   github.com                releases.atom + 永久回链的宿主(不吃额度)
 *
 * 生产上三个都返回 undefined,让 GithubClient 用它自己的真实默认值 —— 这里
 * 只在**测试模式**(GITHUB_API_BASE 指到本地假服务器)下把三个根都指过去,
 * 各带一个前缀。前缀是 `/__raw` 和 `/__web`:它们不可能和 GitHub 的真实路径
 * 撞车(GitHub 没有以双下划线开头的顶层路径),假服务器一眼能分辨这一发是
 * 冲哪个主机去的。
 *
 * 为什么不给 raw / web 各开一个 env:多两个开关就多两处能配歪的地方,而它们
 * 只在测试里有意义,三者又必然同时切换。一个开关切一整套,比三个开关各切
 * 一半安全 —— 半套切换的症状是「文件树来自假服务器、源码正文来自真 GitHub」,
 * 而那种混合状态跑出来的报告看上去完全正常。
 */
export function githubBases(env: AppEnv): { apiBase?: string; contentBase?: string; webBase?: string } {
	const api = githubApiBase(env);
	if (!api) return {};
	const trimmed = api.replace(/\/+$/, "");
	return { apiBase: api, contentBase: `${trimmed}/__raw`, webBase: `${trimmed}/__web` };
}

/** AppEnv → 运行时无关的 AiConfig(shared/ai.ts 的入参)。 */
export function aiConfig(env: AppEnv, overrides?: Partial<AiConfig>): AiConfig {
	return {
		provider: env.AI_PROVIDER,
		model: env.AI_MODEL,
		maxOutputTokens: env.AI_MAX_OUTPUT_TOKENS,
		deepseekApiKey: env.DEEPSEEK_API_KEY,
		anthropicApiKey: env.ANTHROPIC_API_KEY,
		gatewayUrl: env.AI_GATEWAY_URL,
		gatewayKey: env.AI_GATEWAY_KEY,
		...overrides,
	};
}

/** 轻任务档的 AiConfig:一句话拆档案、候选仓的形态描述。 */
export function fastAiConfig(env: AppEnv, overrides?: Partial<AiConfig>): AiConfig {
	return {
		...fastVariant(aiConfig(env), { provider: env.FAST_AI_PROVIDER, model: env.FAST_AI_MODEL }),
		...overrides,
	};
}

/** 站长专线路由表(env → OwnerRoute);没配 OWNER_AI_EMAILS 时为 null。 */
export function ownerRoute(env: AppEnv): OwnerRoute | null {
	return ownerRouteFromEnv(env as unknown as Record<string, string | undefined>);
}

/**
 * 按账号取基础档配置:命中专线名单走专线(带 fallback),否则就是 aiConfig(env)。
 * 调用点显式传的 overrides 最后再盖一次——否则 OWNER_AI_MAX_OUTPUT_TOKENS 这类
 * 专线字段会把调用点故意压低的上限顶掉(002 蒸馏那次的 2048 就是这么被吃掉的)。
 */
export function aiConfigFor(env: AppEnv, email: string | undefined, overrides?: Partial<AiConfig>): AiConfig {
	const routed = applyOwnerRoute(email, aiConfig(env, overrides), ownerRoute(env));
	return overrides ? { ...routed, ...overrides } : routed;
}

/** 按账号取轻任务档配置。先 fastVariant 再路由:FAST_AI_MODEL 的 deepseek 型号不能带进专线。 */
export function fastAiConfigFor(env: AppEnv, email: string | undefined, overrides?: Partial<AiConfig>): AiConfig {
	const routed = applyOwnerRoute(email, fastAiConfig(env, overrides), ownerRoute(env), "fast");
	return overrides ? { ...routed, ...overrides } : routed;
}
