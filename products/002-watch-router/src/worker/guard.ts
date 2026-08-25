// 门禁(docs/02 T7 末段、docs/03 W3):002 与 001 同样只认南屿账号,
// 但 002 处于白名单内测——userGuard 在会话之外每请求复查白名单。
//
//   userGuard    一切个人数据端点:有效会话 + 白名单。会话未配置时(本地
//                dev / fork)回落固定用户 dev@local——零配置规矩保留。
//   userAiGuard  花 token 的端点变体:AI_DISABLED 总闸 + userGuard。
//   adminGuard   站长凭证(x-access-code)。
//
// 401(带 loginUrl,前端引导去主站登录)和 403(已登录但不在内测白名单)
// 是两个不同的态,文案不许串(docs/03 F 线会消费这两态)。

import { createMiddleware } from "hono/factory";
import { getCookie } from "hono/cookie";
import { safeEqual, verifyToken } from "./sso";
import { DEV_USER } from "../shared/store";
import type { Store } from "../shared/store";
import { makeStore } from "./store";
import type { StoreMode } from "./store";
import type { AppEnv } from "./env";

export { safeEqual } from "./sso";

/** 会话 cookie 名:/auth/sso 验签通过后种下,API 凭它认人。 */
export const SESSION_COOKIE = "nanisle_watch_session";

/** 已登录但不在内测白名单时的统一文案(403)。 */
export const BETA_MSG = "002 观影路由还在内测中,你的账号暂未开通。想试用可以联系站长。";

/** userGuard 通过后挂在请求上下文里的东西:当前用户 + 该请求用的 store。 */
export type Guarded = {
	Bindings: AppEnv;
	Variables: {
		email: string;
		store: Store;
		storeMode: StoreMode;
	};
};

/** 主站根地址(无尾斜杠)。显式配置优先;没配就取产品挂载点的 origin。 */
export function siteUrl(env: AppEnv, path = ""): string {
	const explicit = env.NANISLE_URL?.trim().replace(/\/+$/, "");
	let base = explicit;
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

/** 未登录 401 时引导去的地址:主站的登录闸口,登录后自动带 token 跳回来。 */
export function loginUrl(env: AppEnv): string {
	return siteUrl(env, "api/launch/watch-router");
}

/** Canonical browser URL for the product mounted below nanisle.com. */
export function appUrl(env: AppEnv, path = ""): string {
	const base = (env.APP_URL ?? "https://nanisle.com/products/watch-router").replace(/\/+$/, "");
	const suffix = path.replace(/^\/+/, "");
	return suffix ? `${base}/${suffix}` : base;
}

/** 从请求里解出会话邮箱(不做白名单判断)。 */
export async function sessionEmail(env: AppEnv, cookie: string | undefined): Promise<string | null> {
	// 没有登录闸口的实例(本地 dev / fork):默认 dev@local,DEV_EMAIL 可覆盖。
	// 这条回落只在 NANISLE_SSO_SECRET 未配置时生效,托管实例身份只认会话 cookie。
	if (!env.NANISLE_SSO_SECRET) return env.DEV_EMAIL?.trim() || DEV_USER;
	if (!cookie) return null;
	const payload = await verifyToken(env.NANISLE_SSO_SECRET, cookie);
	return payload?.email ?? null;
}

function makeUserGuard(requireAiEnabled: boolean) {
	return createMiddleware<Guarded>(async (c, next) => {
		const env = c.env;
		if (requireAiEnabled && env.AI_DISABLED === "1") {
			return c.json({ error: "AI is temporarily disabled on this instance." }, 503);
		}
		const { store, mode } = makeStore(env);
		c.set("store", store);
		c.set("storeMode", mode);

		const email = await sessionEmail(env, getCookie(c, SESSION_COOKIE));
		if (!email) {
			return c.json({ error: "请先登录南屿账号。", loginUrl: loginUrl(env) }, 401);
		}
		// 内测白名单每请求复查(docs/02 T7):会话 30 天,人可能中途被移出名单。
		if (!(await store.isWhitelisted(email))) {
			return c.json({ error: BETA_MSG }, 403);
		}
		c.set("email", email);
		await next();
	});
}

/** 个人数据端点的门:结果读取、任务轮询、处理记录。 */
export const userGuard = makeUserGuard(false);

/** 花 token 的端点的门:提交(快车道编辑调用 / 慢车道占额度)。多一道 AI_DISABLED 总闸。 */
export const userAiGuard = makeUserGuard(true);

/** 站长端点的门:只认 x-access-code。ACCESS_CODE 没配置就开放(本地 dev / fork)。 */
export const adminGuard = createMiddleware<{ Bindings: AppEnv }>(async (c, next) => {
	const codes = (c.env.ACCESS_CODE ?? "")
		.split(",")
		.map((s) => s.trim())
		.filter(Boolean);
	if (codes.length > 0) {
		const given = c.req.header("x-access-code") ?? "";
		let ok = false;
		for (const code of codes) {
			if (await safeEqual(code, given)) ok = true;
		}
		if (!ok) return c.json({ error: "这个操作需要站长访问码。" }, 401);
	}
	await next();
});
