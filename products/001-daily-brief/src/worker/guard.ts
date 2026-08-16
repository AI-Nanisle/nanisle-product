import { createMiddleware } from "hono/factory";
import { getCookie } from "hono/cookie";
import { safeEqual, verifyToken } from "./sso";
import type { AppEnv } from "./env";

export { safeEqual } from "./sso";

/** 会话 cookie 名：/auth/sso 验签通过后种下，读接口凭它放行。 */
export const SESSION_COOKIE = "nanisle_session";

/** 未登录 401 时引导去的地址：主站的登录闸口，登录后会自动带 token 跳回来。 */
export function loginUrl(env: AppEnv): string {
	const base = (env.NANISLE_URL ?? "https://nanisle.com").replace(/\/+$/, "");
	return `${base}/api/launch/daily-brief`;
}

function parseCodes(env: AppEnv): string[] {
	return (env.ACCESS_CODE ?? "")
		.split(",")
		.map((s) => s.trim())
		.filter(Boolean);
}

async function codeOk(env: AppEnv, given: string | undefined): Promise<boolean> {
	let ok = false;
	for (const code of parseCodes(env)) {
		if (await safeEqual(code, given ?? "")) ok = true;
	}
	return ok;
}

async function sessionOk(env: AppEnv, cookie: string | undefined): Promise<boolean> {
	if (!env.NANISLE_SSO_SECRET || !cookie) return false;
	return (await verifyToken(env.NANISLE_SSO_SECRET, cookie)) !== null;
}

/**
 * 读端点的门（简报、日期列表、反馈、配置只读）：南屿登录会话 cookie 或
 * `x-access-code` 头，任一有效即放行。两套都没配置 → 完全开放（本地开发
 * 和 mock 演示）。401 会带上 loginUrl，前端锁屏靠它引导用户去主站登录。
 */
export const accessGuard = createMiddleware<{ Bindings: AppEnv }>(async (c, next) => {
	const env = c.env;
	const codesConfigured = parseCodes(env).length > 0;
	const ssoConfigured = Boolean(env.NANISLE_SSO_SECRET);
	if (!codesConfigured && !ssoConfigured) return next();
	if (ssoConfigured && (await sessionOk(env, getCookie(c, SESSION_COOKIE)))) return next();
	if (codesConfigured && (await codeOk(env, c.req.header("x-access-code")))) return next();
	return c.json(
		{
			error: "请先登录南屿账号，或提供访问码。",
			...(ssoConfigured ? { loginUrl: loginUrl(env) } : {}),
		},
		401,
	);
});

/**
 * 站长端点的门（改源、改关注点、试抓源）：只认访问码，不认登录会话——
 * 登录用户是读者，配置是站长的。ACCESS_CODE 没配置就开放（本地开发；
 * 托管实例只要设了 NANISLE_SSO_SECRET 就必须同时设 ACCESS_CODE）。
 */
export const ownerGuard = createMiddleware<{ Bindings: AppEnv }>(async (c, next) => {
	if (await ownerDenied(c.env, c.req.header("x-access-code"))) {
		return c.json({ error: "这个操作需要站长访问码。" }, 401);
	}
	await next();
});

/**
 * 花 token 的端点的门（/api/generate）：站长访问码之上再加一道 AI 总闸——
 * AI_DISABLED=1 → 503，出事故时翻开关重部署即可止血，其余功能照常。
 */
export const aiGuard = createMiddleware<{ Bindings: AppEnv }>(async (c, next) => {
	if (c.env.AI_DISABLED === "1") {
		return c.json({ error: "AI is temporarily disabled on this instance." }, 503);
	}
	if (await ownerDenied(c.env, c.req.header("x-access-code"))) {
		return c.json({ error: "这个操作需要站长访问码。" }, 401);
	}
	await next();
});

/** true = 配置了访问码且给的都不对。 */
async function ownerDenied(env: AppEnv, given: string | undefined): Promise<boolean> {
	const codes = parseCodes(env);
	if (codes.length === 0) return false;
	return !(await codeOk(env, given));
}
