// 与主站共享的登录态手递（主站侧实现：nanisle 仓 web/lib/sso.ts）。
// 主站给已登录用户签一个短时 token 跳到 /auth/sso，这里验签后种下本域的
// 会话 cookie（同一套签名格式，只是有效期更长）。
//
// token/会话格式：base64url(payload JSON) + "." + base64url(HMAC-SHA256(前半段))
// payload：{ email: string, exp: number }，exp 为 epoch 秒。

const enc = new TextEncoder();

export interface SsoPayload {
	email: string;
	exp: number;
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
	const body = b64url(enc.encode(JSON.stringify(payload)));
	const mac = await hmac(secret, body);
	return `${body}.${b64url(mac)}`;
}

/** 验签 + 查有效期。任何一步不对都返回 null，不区分原因（别给攻击者反馈）。 */
export async function verifyToken(secret: string, token: string): Promise<SsoPayload | null> {
	const dot = token.indexOf(".");
	if (dot <= 0) return null;
	const body = token.slice(0, dot);
	const mac = token.slice(dot + 1);
	const expect = b64url(await hmac(secret, body));
	if (!(await safeEqual(expect, mac))) return null;
	try {
		const payload = JSON.parse(fromB64url(body)) as SsoPayload;
		if (typeof payload.email !== "string" || typeof payload.exp !== "number") return null;
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
