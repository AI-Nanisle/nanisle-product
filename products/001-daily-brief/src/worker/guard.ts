// B4 · 门禁(docs/02-技术方案.md §5.2、docs/05 开放使用):两道门。
//
//   userGuard   一切个人数据端点:有效会话即可。会话未配置时(本地 dev /
//               fork)回落为固定用户 dev@local——零配置规矩保留。
//   userAiGuard 花 token 的端点变体:AI_DISABLED 总闸 + userGuard。
//               按 IP 的日额度不在这里——它只该拦花 token 的动作,落在
//               index.ts 的额度占位处(与按账号额度同点检查)。
//   adminGuard  站长凭证(x-access-code):手动触发全量生成。
//
// 2026-08-24 白名单准入退役(docs/05):注册全开放,准入闸撤掉;原 WHITELIST
// 集合改当定时刊的订阅名单用,由 putConfig 自动维护(store-dynamo.ts)。
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

/**
 * 主站根地址(无尾斜杠)。显式配置优先;没配就取产品挂载点的 origin——
 * 本地 dev 的 APP_URL 是 http://localhost:3000/products/daily-brief,
 * 于是登录闸口和页眉导航都留在本机,不会莫名跳去线上。
 */
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

/** 未登录 401 时引导去的地址:主站的登录闸口,登录后会自动带 token 跳回来。 */
export function loginUrl(env: AppEnv): string {
	return siteUrl(env, "api/launch/daily-brief");
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
	// 没有登录闸口的实例(本地 dev / fork):默认 dev@local,DEV_EMAIL 可覆盖成
	// 自己的邮箱——本地连线上 DynamoDB 调真数据时用。这条回落只在
	// NANISLE_SSO_SECRET 未配置时生效,托管实例身份只认会话 cookie。
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
