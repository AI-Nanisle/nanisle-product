// 与主站共享的登录态手递（主站侧实现：nanisle 仓 web/lib/sso.ts）。
// 主站给已登录用户签一个短时 token 跳到 /auth/sso，这里验签后种下本域的
// 会话 cookie。
//
// token/会话格式：base64url(payload JSON) + "." + base64url(HMAC-SHA256(前半段))
// payload：{ email, exp, aud, typ }，exp 为 epoch 秒。
//
// aud / typ 是凭证隔离，不是装饰（2026-08-30 评审 A1）：
//   aud  收方产品的 slug。所有产品共用同一把 NANISLE_SSO_SECRET，没有 aud
//        时本产品签出的会话 cookie 拿到别的产品照样有效——一个产品漏了凭证
//        等于全部产品都漏。
//   typ  "sso" 是主站签的 5 分钟一次性手递票，"session" 是本产品签的 30 天
//        会话。两者原来格式完全相同，意味着走在 URL query 里的手递票本身就
//        是一个合法会话 cookie（URL 会进 Cloudflare 日志和浏览器历史）。
//        分开之后，捡到手递票也换不成会话，捡到会话也当不了手递票。
//
// 三份实现必须逐字节一致（各自都有一份同向量的契约测试，见 sso.test.ts）：
//   nanisle 仓 web/lib/sso.ts（只签 sso 票）
//   products/001-daily-brief/src/worker/sso.ts
//   products/002-watch-router/src/worker/sso.ts
//
// 升级说明：加 aud/typ 之前签发的会话 cookie 会被拒（少这两个字段），
// 表现是回到未登录态，从主站点一次「打开产品」即可——不做兼容旧格式的过渡
// 期，因为「接受没有 aud 的旧 token」恰好就是这次要堵的那个洞。

const enc = new TextEncoder();

/** token 用途。手递票和会话是两类凭证，互相不能顶用。 */
export type SsoTokenType = "sso" | "session";

/** 本产品的 slug：签发和校验都用它做 aud。 */
export const AUDIENCE = "daily-brief";

export interface SsoPayload {
	email: string;
	exp: number;
	aud: string;
	typ: SsoTokenType;
}

function b64url(bytes: Uint8Array): string {
	let bin = "";
	for (const b of bytes) bin += String.fromCharCode(b);
	return btoa(bin).replaceAll("+", "-").replaceAll("/", "_").replace(/=+$/, "");
}

function fromB64url(s: string): string {
	const b64 = s.replaceAll("-", "+").replaceAll("_", "/");
	return atob(b64 + "=".repeat((4 - (b64.length % 4)) % 4));
}

/**
 * payload 的规范编码。字段顺序写死，三份实现才能对同一份 payload 产出同一个
 * 字节串，跨仓的固定向量测试才有意义。不要改成 `JSON.stringify(调用点的对象)`
 * ——那样顺序由调用点的书写顺序决定，某天有人换个赋值次序就静默换了一套 token。
 */
export function encodeSsoPayload(p: SsoPayload): string {
	return JSON.stringify({ email: p.email, exp: p.exp, aud: p.aud, typ: p.typ });
}

async function hmac(secret: string, data: string): Promise<Uint8Array> {
	const key = await crypto.subtle.importKey(
		"raw",
		enc.encode(secret),
		{ name: "HMAC", hash: "SHA-256" },
		false,
		["sign"],
	);
	return new Uint8Array(await crypto.subtle.sign("HMAC", key, enc.encode(data)));
}

export async function signToken(secret: string, payload: SsoPayload): Promise<string> {
	const body = b64url(enc.encode(encodeSsoPayload(payload)));
	const mac = await hmac(secret, body);
	return `${body}.${b64url(mac)}`;
}

/**
 * 验签 + 查有效期 + 查用途与收方。任何一步不对都返回 null，不区分原因
 * （别给攻击者反馈）。`expect` 没有默认值是刻意的：每个调用点都必须写明
 * 「我在验的是哪一类凭证」，漏写会是编译错误而不是一个悄悄放行的洞。
 */
export async function verifyToken(
	secret: string,
	token: string,
	expect: { aud: string; typ: SsoTokenType },
): Promise<SsoPayload | null> {
	const dot = token.indexOf(".");
	if (dot <= 0) return null;
	const body = token.slice(0, dot);
	const mac = token.slice(dot + 1);
	const expectMac = b64url(await hmac(secret, body));
	if (!(await safeEqual(expectMac, mac))) return null;
	try {
		const payload = JSON.parse(fromB64url(body)) as SsoPayload;
		if (typeof payload.email !== "string" || typeof payload.exp !== "number") return null;
		if (payload.aud !== expect.aud || payload.typ !== expect.typ) return null;
		if (payload.exp * 1000 < Date.now()) return null;
		return payload;
	} catch {
		return null;
	}
}

// Compare via SHA-256 digests so the comparison is constant-time and
// length-independent (a plain === would leak match length via timing).
export async function safeEqual(a: string, b: string): Promise<boolean> {
	const [da, db] = await Promise.all([
		crypto.subtle.digest("SHA-256", enc.encode(a)),
		crypto.subtle.digest("SHA-256", enc.encode(b)),
	]);
	const va = new Uint8Array(da);
	const vb = new Uint8Array(db);
	let diff = 0;
	for (let i = 0; i < va.length; i++) diff |= va[i] ^ vb[i];
	return diff === 0;
}
