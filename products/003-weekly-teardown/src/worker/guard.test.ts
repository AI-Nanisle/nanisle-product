// guard.ts 里唯一有分支的纯函数:spendsOffOurAccount(花费闸的豁免判据)。
//
// 单独一个文件、只测这一个函数,是因为 guard 的其余部分(userGuard / reserveOrDeny)
// 要一个 Hono Context 和一个 D1 才跑得起来,那属于端点级的验收;而这个判据是
// **一句布尔表达式管着一天 $3 的保险丝**,它出错的形状是「闸门静默失效」——
// 没有任何日志、没有任何 429,只有月底账单。所以它值得单独钉住。

import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { spendsOffOurAccount } from "./guard.ts";
import type { AppEnv } from "./env.ts";

/** 只填这个判据看得见的那几个字段;其余 AppEnv 字段与它无关。 */
const env = (over: Partial<AppEnv> = {}): AppEnv => ({ ...over }) as AppEnv;

const OWNER = "panghd0811@gmail.com";

describe("spendsOffOurAccount", () => {
	it("专线真配好了(有网关地址)才豁免", () => {
		const e = env({
			OWNER_AI_EMAILS: OWNER,
			OWNER_AI_PROVIDER: "gateway",
			OWNER_AI_GATEWAY_URL: "https://gw.example.com/v1/messages",
			OWNER_AI_GATEWAY_KEY: "k",
		});
		assert.equal(spendsOffOurAccount(e, OWNER), true);
		// 大小写和空格照 ownerRouteFromEnv 的规矩归一化
		assert.equal(spendsOffOurAccount(e, `  ${OWNER.toUpperCase()} `), true);
		// 名单外的人一律照计
		assert.equal(spendsOffOurAccount(e, "someone@else.com"), false);
	});

	it("**配了名单没配网关 = 照样过闸**(2026-09-01 评审的第 ② 条)", () => {
		// 这是原来那版 isOwnerEmail 会放行、而钱其实全落在 DEEPSEEK_API_KEY 上的
		// 那个配置:ownerRouteFromEnv 拼出来的 cfg 是空对象,applyOwnerRoute 拿空
		// 对象盖到 base 上等于没盖,调用照旧走自费 provider。
		assert.equal(spendsOffOurAccount(env({ OWNER_AI_EMAILS: OWNER }), OWNER), false);
	});

	it("只换型号 / 只换输出上限不算数 —— 换不掉付钱的那个账号", () => {
		const e = env({
			OWNER_AI_EMAILS: OWNER,
			OWNER_AI_MODEL: "claude-opus-5",
			OWNER_FAST_AI_MODEL: "claude-haiku-5",
			OWNER_AI_MAX_OUTPUT_TOKENS: "8192",
		});
		assert.equal(spendsOffOurAccount(e, OWNER), false);
	});

	it("专线 provider 设成 deepseek / anthropic 不算数(那两档用的正是我们自己的 key)", () => {
		for (const p of ["deepseek", "anthropic"]) {
			assert.equal(spendsOffOurAccount(env({ OWNER_AI_EMAILS: OWNER, OWNER_AI_PROVIDER: p }), OWNER), false, p);
		}
		// gateway 档没有 OWNER_AI_GATEWAY_URL 时会回落到公共的 AI_GATEWAY_URL,
		// 那也是这个部署自己的网关,一样是我们的钱
		assert.equal(
			spendsOffOurAccount(env({ OWNER_AI_EMAILS: OWNER, OWNER_AI_PROVIDER: "gateway" }), OWNER),
			false,
		);
	});

	it("mock 档豁免(压根不出网,零成本)", () => {
		assert.equal(spendsOffOurAccount(env({ OWNER_AI_EMAILS: OWNER, OWNER_AI_PROVIDER: "MOCK" }), OWNER), true);
	});

	it("没配 OWNER_AI_EMAILS 时对谁都不豁免(fork 零配置的默认形态)", () => {
		assert.equal(spendsOffOurAccount(env(), OWNER), false);
		assert.equal(spendsOffOurAccount(env({ OWNER_AI_GATEWAY_URL: "https://gw.example.com" }), OWNER), false);
	});
});
