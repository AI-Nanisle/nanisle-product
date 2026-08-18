// B4 · 门禁(docs/02-技术方案.md §5.2):从单用户时代的三道门改成两道。
//
//   userGuard   一切个人数据端点:有效会话 + 邮箱在白名单。会话未配置时
//               (本地 dev / fork)回落为固定用户 dev@local——零配置规矩保留。
//               白名单在 /auth/sso 之外每个请求再查一次:被移出名单的人,
//               30 天会话没过期时也要立即失效。
//   userAiGuard 花 token 的端点变体:AI_DISABLED 总闸 + userGuard。
//   adminGuard  站长凭证(x-access-code):手动触发全量生成。白名单增删
//               走主仓 infra/ 的脚本,不开 API。
//
// 旧的 accessGuard / ownerGuard / aiGuard 已退役:配置不再是站长的,
// 是每个用户自己的,userGuard 按会话邮箱天然隔离。

import { createMiddleware } from "hono/factory";
import { getCookie } from "hono/cookie";
import { safeEqual, verifyToken } from "./sso";
import { DEV_USER } from "../shared/store";
import type { Store } from "../shared/store";
import { makeStore } from "./store-kv";
import type { AppEnv } from "./env";

export { safeEqual } from "./sso";

/** 会话 cookie 名:/auth/sso 验签通过后种下,API 凭它认人。 */
export const SESSION_COOKIE = "nanisle_session";

/** userGuard 通过后挂在请求上下文里的东西:当前用户 + 该请求用的 store。 */
export type Guarded = {
	Bindings: AppEnv;
	Variables: {
		email: string;
		store: Store;
		storeMode: "dynamo" | "kv";
	};
};

/** 未登录 401 时引导去的地址:主站的登录闸口,登录后会自动带 token 跳回来。 */
export function loginUrl(env: AppEnv): string {
	const base = (env.NANISLE_URL ?? "https://nanisle.com").replace(/\/+$/, "");
	return `${base}/api/launch/daily-brief`;
}

/** Canonical browser URL for the product mounted below nanisle.com. */
export function appUrl(env: AppEnv, path = ""): string {
	const base = (env.APP_URL ?? "https://nanisle.com/products/daily-brief").replace(/\/+$/, "");
	const suffix = path.replace(/^\/+/, "");
	return suffix ? `${base}/${suffix}` : base;
}

/**
 * 从请求里解出会话邮箱(不做白名单判断)。/go 这类无门禁端点也用它:
 * 有会话就认人,没有就匿名。
 */
export async function sessionEmail(env: AppEnv, cookie: string | undefined): Promise<string | null> {
	if (!env.NANISLE_SSO_SECRET) return DEV_USER;
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
		if (email !== DEV_USER && !(await store.isWhitelisted(email))) {
			// 403(不是 401):登录是有效的,拦下的是准入——前端两种态的文案不同
			return c.json({ error: "产品内测中,你的账号还不在名单里。想试用请联系站长开通。" }, 403);
		}
		c.set("email", email);
		await next();
	});
}

/** 个人数据端点的门:简报读写、反馈、配置、日期列表。 */
export const userGuard = makeUserGuard(false);

/** 花 token 的端点的门:立即生成、向导、对编辑说一句。多一道 AI_DISABLED 总闸。 */
export const userAiGuard = makeUserGuard(true);

/**
 * 站长端点的门:只认 x-access-code。ACCESS_CODE 没配置就开放(本地 dev /
 * fork;托管实例必须设置)。
 */
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
