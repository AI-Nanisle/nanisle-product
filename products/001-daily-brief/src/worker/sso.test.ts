// SSO token 的跨仓契约测试 + 凭证隔离的回归测试。跑法:
//   node --experimental-strip-types --test src/worker/sso.test.ts
//
// 两件事:
//
// 1) **跨仓编码契约**。同一套 token 原语有三份拷贝——主站(nanisle 仓
//    web/lib/sso.ts)签手递票,001 和 002 各签发并校验自己的会话。三份都是
//    手抄的,而 verifyToken 的设计是「任何一步不对都返回 null,不区分原因」:
//    某天有人改了 payload 的字段或顺序,线上表现是全站静默登录失败,日志里
//    一个字都没有。所以三边各放一份**同向量**的测试把编码钉死。
//
// 2) **凭证隔离**(2026-08-30 评审 A1)。加 aud/typ 之前,所有产品共用一把
//    NANISLE_SSO_SECRET 且 payload 完全同构,后果是:001 的会话 cookie 拿到
//    002 直接有效;而主站走 URL query 传的 5 分钟手递票本身就是一个合法会话
//    cookie(URL 会进 Cloudflare 日志和浏览器历史)。下面四条「拒」的用例
//    就是这两个洞的回归。
//
// 对应文件(VECTOR_* 三份必须逐字节相同):
//   nanisle 仓 web/lib/sso.test.ts
//   products/002-watch-router/src/worker/sso.test.ts

import assert from "node:assert/strict";
import { Buffer } from "node:buffer";
import { describe, it } from "node:test";
import { AUDIENCE, encodeSsoPayload, signToken, verifyToken } from "./sso.ts";

// ---- 跨仓固定向量:改了它就等于换了一套线上凭证,三仓要同批部署 ----
const VECTOR_SECRET = "nanisle-sso-contract-v1";
const VECTOR_PAYLOAD = {
	email: "contract@example.com",
	exp: 4102444800,
	aud: "contract",
	typ: "sso",
} as const;
const VECTOR_TOKEN =
	"eyJlbWFpbCI6ImNvbnRyYWN0QGV4YW1wbGUuY29tIiwiZXhwIjo0MTAyNDQ0ODAwLCJhdWQiOiJjb250cmFjdCIsInR5cCI6InNzbyJ9.-jt7Qp4_9r-wHKbM8iXPruzf2xrNon8IiSU-oZRX5gs";

const SECRET = "shared-secret";
const soon = () => Math.floor(Date.now() / 1000) + 300;
const asSession = { aud: AUDIENCE, typ: "session" } as const;
const asSso = { aud: AUDIENCE, typ: "sso" } as const;
/** 同一把密钥下的另一个产品:aud 隔离要挡住的就是它。 */
const OTHER_AUDIENCE = "watch-router";

describe("sso 契约", () => {
	it("规范编码的字段顺序是 email, exp, aud, typ", () => {
		assert.equal(
			encodeSsoPayload(VECTOR_PAYLOAD),
			'{"email":"contract@example.com","exp":4102444800,"aud":"contract","typ":"sso"}',
		);
	});

	it("固定向量签出的 token 与主站、另一个产品逐字节一致", async () => {
		assert.equal(await signToken(VECTOR_SECRET, VECTOR_PAYLOAD), VECTOR_TOKEN);
	});

	it("本产品的 AUDIENCE 就是它的挂载 slug", () => {
		assert.equal(AUDIENCE, "daily-brief");
	});
});

describe("verifyToken 放行", () => {
	it("接受本产品签的会话", async () => {
		const t = await signToken(SECRET, { email: "a@b.c", exp: soon(), ...asSession });
		assert.equal((await verifyToken(SECRET, t, asSession))?.email, "a@b.c");
	});

	it("接受主站签给本产品的手递票", async () => {
		const t = await signToken(SECRET, { email: "a@b.c", exp: soon(), ...asSso });
		assert.equal((await verifyToken(SECRET, t, asSso))?.email, "a@b.c");
	});
});

describe("verifyToken 拒绝", () => {
	// A1 洞一:别的产品的会话 cookie 被当成本产品的会话
	it("拒绝另一个产品签的会话(aud 不符)", async () => {
		const t = await signToken(SECRET, {
			email: "a@b.c",
			exp: soon(),
			aud: OTHER_AUDIENCE,
			typ: "session",
		});
		assert.equal(await verifyToken(SECRET, t, asSession), null);
	});

	// A1 洞二:URL query 里捡到的 5 分钟手递票被当成会话 cookie 使用
	it("拒绝拿手递票当会话(typ 不符)", async () => {
		const t = await signToken(SECRET, { email: "a@b.c", exp: soon(), ...asSso });
		assert.equal(await verifyToken(SECRET, t, asSession), null);
	});

	it("拒绝拿会话当手递票(typ 不符)", async () => {
		const t = await signToken(SECRET, { email: "a@b.c", exp: soon(), ...asSession });
		assert.equal(await verifyToken(SECRET, t, asSso), null);
	});

	// 升级前签发的会话没有 aud/typ:一律作废,不做兼容——「接受没有 aud 的
	// 旧 token」正好就是这次要堵的洞。用户从主站点一次「打开产品」即恢复。
	it("拒绝加 aud/typ 之前的旧格式 token", async () => {
		const legacy = await signToken(SECRET, {
			email: "a@b.c",
			exp: soon(),
		} as unknown as Parameters<typeof signToken>[1]);
		assert.equal(await verifyToken(SECRET, legacy, asSession), null);
	});

	it("拒绝换过密钥的 token", async () => {
		const t = await signToken("other-secret", { email: "a@b.c", exp: soon(), ...asSession });
		assert.equal(await verifyToken(SECRET, t, asSession), null);
	});

	it("拒绝过期的 token", async () => {
		const t = await signToken(SECRET, {
			email: "a@b.c",
			exp: Math.floor(Date.now() / 1000) - 1,
			...asSession,
		});
		assert.equal(await verifyToken(SECRET, t, asSession), null);
	});

	// 改 payload 必然改签名,所以这条其实是在验「签名覆盖了 aud」
	it("拒绝被改过 aud 的 token", async () => {
		const t = await signToken(SECRET, { email: "a@b.c", exp: soon(), ...asSession });
		const [body, mac] = t.split(".");
		const tampered = JSON.parse(Buffer.from(body, "base64url").toString("utf8"));
		tampered.aud = OTHER_AUDIENCE;
		const forged = `${Buffer.from(JSON.stringify(tampered), "utf8").toString("base64url")}.${mac}`;
		assert.equal(await verifyToken(SECRET, forged, asSession), null);
	});

	it("拒绝畸形输入", async () => {
		for (const bad of ["", ".", "no-dot", "a.b"]) {
			assert.equal(await verifyToken(SECRET, bad, asSession), null, bad);
		}
	});
});
