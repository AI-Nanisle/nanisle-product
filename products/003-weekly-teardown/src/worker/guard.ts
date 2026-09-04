// 门禁与地址 helper。
//
//   userGuard      一切个人数据端点:有效会话(未配 SSO 时回落 dev@local)
//   userAiGuard    花 token 的端点变体:多一道 AI_DISABLED 总闸
//   reserveOrDeny  三道闸的占位入口(账号次数 / IP 次数 / 全局花费)
//   adminGuard     站长凭证(x-access-code)
//
// 003 不做内测白名单(沿用 001 退役白名单之后的形态):登录有效即可用,
// 挡滥用的活儿全交给下面那三道闸,而不是交给一份要手工维护的名单。
//
// 本文件(以及它拉进来的 env.ts)的相对 import 带 `.ts` 后缀,和其余 worker
// 文件的无后缀写法不一样。这不是笔误:`npm test` 用的是 node 的 --test,而 node
// 的 ESM 解析器不会替你补后缀,无后缀的 import 它一律 ERR_MODULE_NOT_FOUND。
// 加了后缀这条链就能被 guard.test.ts 直接 import 进来——spendsOffOurAccount
// 是一句布尔表达式管着一天 $3 的保险丝,它出错的形状是「闸门静默失效」,
// 必须有测试钉着。tsconfig 开了 allowImportingTsExtensions + noEmit,vite 和
// wrangler 的打包器也认这种写法,两边都不用改配置。

import { createMiddleware } from "hono/factory";
import { getCookie } from "hono/cookie";
import type { Context } from "hono";
import { AUDIENCE, safeEqual, verifyToken } from "./sso.ts";
import {
	DAILY_SPEND_CAP_USD,
	IP_QUOTA_LIMITS,
	QUOTA_LIMITS,
	ipQuotaSubject,
	refundQuota,
	reserveQuota,
	reserveSpend,
	todayUtc,
} from "../shared/store.ts";
import type { QuotaKind } from "../shared/store.ts";
import { ownerRoute } from "./env.ts";
import type { AppEnv } from "./env.ts";

export { safeEqual } from "./sso.ts";

/** 会话 cookie 名:/auth/sso 验签通过后种下,API 凭它认人。 */
export const SESSION_COOKIE = "nanisle_teardown_session";

/** 没有登录闸口的实例(本地 dev / fork)默认冒充的用户。 */
export const DEV_USER = "dev@local";

/** 主站根地址(无尾斜杠)。显式配置优先;没配就取产品挂载点的 origin。 */
export function siteUrl(env: AppEnv, path = ""): string {
	let base = env.NANISLE_URL?.trim().replace(/\/+$/, "");
	if (!base) {
		try {
			base = new URL(appUrl(env)).origin;
		} catch {
			base = "https://nanisle.com";
		}
	}
	const suffix = path.replace(/^\/+/, "");
	return suffix ? `${base}/${suffix}` : base;
}

/** 未登录时引导去的地址:主站的登录闸口,登录后自动带手递票跳回来。 */
export function loginUrl(env: AppEnv): string {
	return siteUrl(env, `api/launch/${AUDIENCE}`);
}

/** 本产品在浏览器里的规范地址(挂在主站路径下)。 */
export function appUrl(env: AppEnv, path = ""): string {
	const base = (env.APP_URL ?? "https://nanisle.com/products/weekly-teardown").replace(/\/+$/, "");
	const suffix = path.replace(/^\/+/, "");
	return suffix ? `${base}/${suffix}` : base;
}

/** 从会话 cookie 解出邮箱(不做准入判断)。 */
export async function sessionEmail(env: AppEnv, cookie: string | undefined): Promise<string | null> {
	// 没有登录闸口的实例(本地 dev / fork):默认 dev@local,DEV_EMAIL 可覆盖。
	// 这条回落只在 NANISLE_SSO_SECRET 未配置时生效,托管实例身份只认会话 cookie。
	if (!env.NANISLE_SSO_SECRET) return env.DEV_EMAIL?.trim() || DEV_USER;
	if (!cookie) return null;
	// 只认本产品签的会话:aud 挡住别的产品的 cookie,typ 挡住 URL 里捡到的手递票
	const payload = await verifyToken(env.NANISLE_SSO_SECRET, cookie, { aud: AUDIENCE, typ: "session" });
	return payload?.email ?? null;
}

/** userGuard 通过后挂在请求上下文里的东西。 */
export type Guarded = {
	Bindings: AppEnv;
	Variables: {
		email: string;
	};
};

function makeUserGuard(requireAiEnabled: boolean) {
	return createMiddleware<Guarded>(async (c, next) => {
		if (requireAiEnabled && c.env.AI_DISABLED === "1") {
			return c.json({ error: "这个实例暂时关掉了所有花 token 的功能。" }, 503);
		}
		const email = await sessionEmail(c.env, getCookie(c, SESSION_COOKIE));
		if (!email) {
			// 401 带 loginUrl:前端据此把人送回主站登录,而不是自己猜地址
			return c.json({ error: "请先登录南屿账号。", loginUrl: loginUrl(c.env) }, 401);
		}
		c.set("email", email);
		await next();
	});
}

/** 个人数据端点的门:档案读写、周扫结果、报告读取。 */
export const userGuard = makeUserGuard(false);

/** 花 token 的端点的门:多一道 AI_DISABLED 总闸(实例级急停)。 */
export const userAiGuard = makeUserGuard(true);

// ---------------------------------------------------------------------------
// 三道闸(docs/02 决策 T6)
// ---------------------------------------------------------------------------

/**
 * 客户端出口 IP。cf-connecting-ip 由 Cloudflare 边缘写入,经主站 Service
 * Binding 转调时原始请求头原样传递,用户伪造不了。取不到时(理论上只有
 * 本地 dev)归入 "unknown" 桶——本地没有并发对手,共享一个桶无妨。
 */
export function clientIp(c: Context<Guarded>): string {
	return c.req.header("cf-connecting-ip")?.trim() || "unknown";
}

/**
 * 这一趟调用的钱**落不落在我们自己的 API 账上**——花费闸的豁免判据。
 *
 * 判的不是「这个人是不是站长」(2026-09-01 评审)。原来这里叫 isOwnerEmail,
 * 只查邮箱在不在 OWNER_AI_EMAILS,而豁免的理由写的是「专线走的是另一套
 * provider,成本不落在这个账上」——两者在下面这个配置下会分叉,分叉的方向
 * 还恰好是最坏的那个:配了 OWNER_AI_EMAILS 却没配 OWNER_AI_GATEWAY_URL 时,
 * ownerRouteFromEnv 拼出来的 cfg 是**空对象**,applyOwnerRoute 拿空对象盖到
 * base 上等于没盖,调用照样走 DEEPSEEK_API_KEY——站长每份深度报告都在烧我们
 * 自己的钱,而 $3 保险丝对他 100% 不生效。站长又恰恰是调试期跑报告最密集的
 * 那个人(docs/02 决策 T6 自己承认「会把 $3 打满」)。
 *
 * 所以判据挂在配置的**实质内容**上:名单命中,**且**路由表里真有一个能把
 * 账单挪走的字段。按 ai.ts 的真实字段,只有两种情况算数——
 *
 *   - `cfg.gatewayUrl`(OWNER_AI_GATEWAY_URL):站长自己那台订阅网关,钱在他
 *     的 Claude 订阅上,不在我们的 key 上。这是专线的正经形态。
 *   - `cfg.provider === "mock"`:压根不出网,零成本。
 *
 * `model` / `maxOutputTokens` 这些**不算数**:它们只换型号和长度,换不掉
 * 付钱的那个账号。`provider` 设成 deepseek / anthropic 同理——那两档用的正是
 * 我们自己的 key。gateway 档没有 OWNER_AI_GATEWAY_URL 时会回落到公共的
 * AI_GATEWAY_URL,那也是这个部署自己的网关,一样是我们的钱。
 *
 * **补不上的那半个洞(已知,留给阶段 7)**:专线配好了但网关当时挂了,
 * complete() 会拿 fallback(= base 配置)重试一次(ai.ts 的 shouldFallBack),
 * 钱同样落回 DeepSeek 账上,而这一趟在这里已经被放过了。占位必须发生在调用
 * 之前(否则 10 个并发会一起看到「今天才花了 $0.1」),这一层看不见后面会不会
 * 回落,结构上补不了。真要堵,得在 ai.ts 的回落分支被触发后补记一笔
 * daily_spend(闸不拦但账要有)——等阶段 7 真有 AI 调用点了再做。
 */
export function spendsOffOurAccount(env: AppEnv, email: string): boolean {
	const route = ownerRoute(env);
	if (!route?.emails.includes(email.trim().toLowerCase())) return false;
	if ((route.cfg.provider ?? "").trim().toLowerCase() === "mock") return true;
	return Boolean(route.cfg.gatewayUrl?.trim());
}

const GEN_LIMIT_MSG = `今天的深度报告额度用完了(每个账号每天 ${QUOTA_LIMITS.gen} 份)。明天自动恢复。`;
const AI_LIMIT_MSG = `今天的编辑调用额度用完了(每个账号每天 ${QUOTA_LIMITS.ai} 次)。明天自动恢复。`;
/** 同一出口 IP 下所有账号合计。正常单人到不了这里(账号额度先满)。 */
const IP_LIMIT_MSG = "同一网络今天的额度已经用完了(多账号合计)。明天自动恢复;误伤请联系站长。";
/** docs/02 决策 T6 指定的文案,一个字都别改——把成本上限印在产品脸上是产品的一部分。 */
const SPEND_LIMIT_MSG = "今天的预算用完了,明天再来。";

/** 距离 UTC 下一个零点还有多少秒。三道闸都按 UTC 日跨天(store.ts 的 todayUtc)。 */
function secondsToUtcMidnight(at: number = Date.now()): number {
	return Math.max(1, Math.ceil((86_400_000 - (at % 86_400_000)) / 1000));
}

/**
 * 三道闸一次性占位。**返回 Response = 已经被拦下,路由必须原样 return 它**;
 * 返回 null 才是放行。
 *
 * 顺序是账号 → IP → 全局花费,后面的闸拦下时把前面已占的位**退还**:
 * 那几步之间一个 token 都没花,不该占掉用户明天还想用的次数。注意这条退还
 * 只适用于「被闸拦下」,模型报错不退(store.ts reserveQuota 的规矩 3)。
 *
 * **钱不落在我们账上的调用不计入全局花费闸**(docs/02 决策 T6):站长走专线
 * 调试时会反复跑深度报告,一天几次就能把 $3 打满,那样这道闸就变成了「站长
 * 自己的开发阻塞器」。注意豁免的是**「这笔钱不从我们的 key 里出」**这件事,
 * 不是「这个人是站长」——判据见 spendsOffOurAccount,配了名单却没配网关的
 * 站长照样过闸,因为他花的确实是我们的钱。账号和 IP 的次数闸对谁都照计——
 * 它们防的是滥用形状,与钱从哪出无关(站长每天仍然只有 gen: 2,已知,
 * 站长另有拍板)。
 *
 * estUsd 只对花钱的动作有意义;传 0(默认)= 不过花费闸,给编辑侧那种
 * ~$0.002 的调用用:每笔都去占位只会让 daily_spend 变成一张高频写入表,
 * 而它拦不住任何东西(要 1500 次 flash 调用才凑够 $3,ai 30 次/天的闸先满)。
 */
export async function reserveOrDeny(c: Context<Guarded>, kind: QuotaKind, estUsd = 0): Promise<Response | null> {
	const db = c.env.TEARDOWN_DB;
	const email = c.get("email");
	const day = todayUtc();
	const ip = ipQuotaSubject(clientIp(c));
	const retryAfter = String(secondsToUtcMidnight());

	// 第一道:账号次数。先占位后干活——占完位才去调模型(store.ts 有完整论证)。
	const account = await reserveQuota(db, email, kind, QUOTA_LIMITS[kind], day);
	if (!account.ok) {
		return c.json({ error: kind === "gen" ? GEN_LIMIT_MSG : AI_LIMIT_MSG, scope: "account" }, 429, {
			"retry-after": retryAfter,
		});
	}

	// 第二道:按出口 IP 合计,挡开小号(登录是开放的,账号额度挡不住)。
	const perIp = await reserveQuota(db, ip, kind, IP_QUOTA_LIMITS[kind], day);
	if (!perIp.ok) {
		await refundQuota(db, email, kind, day).catch((e) => console.error("reserveOrDeny: refund account failed", e));
		return c.json({ error: IP_LIMIT_MSG, scope: "ip" }, 429, { "retry-after": retryAfter });
	}

	// 第三道:全局预算保险丝。钱不落在我们账上的那些调用不计入(理由见函数头)。
	if (estUsd > 0 && !spendsOffOurAccount(c.env, email)) {
		const spend = await reserveSpend(db, estUsd, DAILY_SPEND_CAP_USD, day);
		if (!spend.ok) {
			await Promise.all([
				refundQuota(db, email, kind, day).catch((e) => console.error("reserveOrDeny: refund account failed", e)),
				refundQuota(db, ip, kind, day).catch((e) => console.error("reserveOrDeny: refund ip failed", e)),
			]);
			return c.json({ error: SPEND_LIMIT_MSG, scope: "global" }, 429, { "retry-after": retryAfter });
		}
	}
	return null;
}

/**
 * 站长端点的门:只认 x-access-code。ACCESS_CODE 没配置就开放——本地 dev 和
 * fork 首跑要能直接打 /api/__spike,而那些实例上没有任何值钱的东西。
 * 逗号分隔允许给不同的人不同的码、各自独立轮换。
 */
export const adminGuard = createMiddleware<{ Bindings: AppEnv }>(async (c, next) => {
	const codes = (c.env.ACCESS_CODE ?? "")
		.split(",")
		.map((s) => s.trim())
		.filter(Boolean);
	if (codes.length > 0) {
		const given = c.req.header("x-access-code") ?? "";
		let ok = false;
		// 逐个比而不是 includes:safeEqual 是常数时间的,短路会把时间信息漏回去
		for (const code of codes) {
			if (await safeEqual(code, given)) ok = true;
		}
		if (!ok) return c.json({ error: "这个操作需要站长访问码。" }, 401);
	}
	await next();
});
