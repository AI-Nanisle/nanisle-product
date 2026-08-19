// E1 · 邮件推送(docs/04-邮件推送方案.md)。三件事收在这一个文件里:
//
//   1. 退订 token:HMAC 签名的「邮箱 + 用途」,Lambda 生成、Worker 验证,
//      两边共享 EMAIL_UNSUB_SECRET。专用密钥,不复用 NANISLE_SSO_SECRET——
//      那是登录信物,泄漏面不该扩大到 AWS 侧;这把钥匙最坏后果只是被人退订。
//   2. 邮件模板:三句话 + 回站按钮 + 页脚退订。**不放任何条目链接**——
//      邮件只当门铃不当报纸(01-产品方案决策 1),消费必须发生在网页上。
//   3. SES 发送:aws4fetch 签名直调 SES v2 HTTP API,和 store-dynamo 同一套
//      打法,Worker / Lambda 都能跑,零新增依赖。
//
// 全部用 WebCrypto(globalThis.crypto):Node 22 和 Workers 运行时都原生有。

import { AwsClient } from "aws4fetch";

// ---------- 退订 token ----------

const UNSUB_PURPOSE = "unsub:";

function b64url(bytes: Uint8Array): string {
	let bin = "";
	for (const b of bytes) bin += String.fromCharCode(b);
	return btoa(bin).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
}

function b64urlDecode(s: string): Uint8Array | null {
	try {
		const bin = atob(s.replace(/-/g, "+").replace(/_/g, "/"));
		return Uint8Array.from(bin, (c) => c.charCodeAt(0));
	} catch {
		return null;
	}
}

async function hmac(secret: string, message: string): Promise<Uint8Array> {
	const key = await crypto.subtle.importKey(
		"raw",
		new TextEncoder().encode(secret),
		{ name: "HMAC", hash: "SHA-256" },
		false,
		["sign"],
	);
	return new Uint8Array(await crypto.subtle.sign("HMAC", key, new TextEncoder().encode(message)));
}

/** 退订链接里带的 token:base64url(邮箱) + "." + base64url(HMAC)。无过期——退订权不该过期。 */
export async function unsubToken(secret: string, email: string): Promise<string> {
	const sig = await hmac(secret, UNSUB_PURPOSE + email);
	return `${b64url(new TextEncoder().encode(email))}.${b64url(sig)}`;
}

/** 验签通过返回邮箱,否则 null。常数时间比较,防逐字节试探。 */
export async function verifyUnsubToken(secret: string, token: string): Promise<string | null> {
	const dot = token.indexOf(".");
	if (dot <= 0) return null;
	const emailBytes = b64urlDecode(token.slice(0, dot));
	const givenSig = b64urlDecode(token.slice(dot + 1));
	if (!emailBytes || !givenSig) return null;
	const email = new TextDecoder().decode(emailBytes);
	const wantSig = await hmac(secret, UNSUB_PURPOSE + email);
	if (givenSig.length !== wantSig.length) return null;
	let diff = 0;
	for (let i = 0; i < wantSig.length; i++) diff |= wantSig[i] ^ givenSig[i];
	return diff === 0 ? email : null;
}

// ---------- 邮件模板 ----------

export interface BriefEmailInput {
	/** YYYY-MM-DD(刊的日期)。 */
	date: string;
	/** 今日三句话(assembleBrief 保证非空,这里再兜一层空数组防御)。 */
	tldr: string[];
	/** 回站地址(产品挂载点,不带任何条目路径)。 */
	appUrl: string;
	/** 一键退订地址(带 token)。 */
	unsubUrl: string;
}

function esc(s: string): string {
	return s.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/"/g, "&quot;");
}

/** "2026-08-19" → "8月19日"。邮件主题用,解析失败就原样返回。 */
function cnDate(date: string): string {
	const m = /^\d{4}-(\d{2})-(\d{2})$/.exec(date);
	return m ? `${Number(m[1])}月${Number(m[2])}日` : date;
}

export function renderBriefEmail(input: BriefEmailInput): { subject: string; html: string; text: string } {
	const subject = `南屿简报 · ${cnDate(input.date)}`;
	const lines = input.tldr.length ? input.tldr : ["今天的简报已经出刊。"];
	const text = [...lines, "", `打开今日简报:${input.appUrl}`, "", `不想收到这封邮件?退订:${input.unsubUrl}`].join("\n");
	// 内联样式的极简 HTML:目标 5 秒读完。桌面/手机客户端都认的老实布局,不引模板引擎。
	const html = `<div style="margin:0 auto;max-width:520px;padding:32px 20px;font-family:-apple-system,'PingFang SC','Microsoft YaHei',sans-serif;color:#1a1a1a;">
	<p style="margin:0 0 20px;font-size:12px;letter-spacing:0.08em;color:#999;">南屿简报 · ${esc(cnDate(input.date))}</p>
	${lines.map((l) => `<p style="margin:0 0 12px;font-size:15px;line-height:1.7;">${esc(l)}</p>`).join("\n\t")}
	<p style="margin:28px 0;">
		<a href="${esc(input.appUrl)}" style="display:inline-block;padding:10px 22px;background:#1a1a1a;color:#fff;text-decoration:none;font-size:14px;border-radius:4px;">打开今日简报 →</a>
	</p>
	<p style="margin:32px 0 0;border-top:1px solid #eee;padding-top:12px;font-size:12px;color:#999;">
		不想收到这封邮件?<a href="${esc(input.unsubUrl)}" style="color:#999;">一键退订</a>,网页配置页也随时能重新打开。
	</p>
</div>`;
	return { subject, html, text };
}

// ---------- SES 发送 ----------

export interface SesOptions {
	region: string;
	accessKeyId: string;
	secretAccessKey: string;
	sessionToken?: string;
	/** 裸发件地址(brief@nanisle.com)。显示名在这里统一加,免得各调用点自己拼编码。 */
	from: string;
}

/** 显示名带中文,按 RFC 2047 B-encoding 包一层——SES 不收裸 UTF-8 显示名。 */
function fromHeader(address: string): string {
	const name = b64url(new TextEncoder().encode("南屿简报")).replace(/-/g, "+").replace(/_/g, "/");
	return `=?UTF-8?B?${name}?= <${address}>`;
}

/**
 * 发一封简报提醒。抛错交给调用方决定死活——Lambda 侧只记日志不中断
 * (邮件是锦上添花,刊已经安全落库)。
 */
export async function sendBriefEmail(
	ses: SesOptions,
	to: string,
	mail: { subject: string; html: string; text: string },
	unsubUrl: string,
): Promise<void> {
	const aws = new AwsClient({
		accessKeyId: ses.accessKeyId,
		secretAccessKey: ses.secretAccessKey,
		...(ses.sessionToken ? { sessionToken: ses.sessionToken } : {}),
		region: ses.region,
		service: "ses",
	});
	const res = await aws.fetch(`https://email.${ses.region}.amazonaws.com/v2/email/outbound-emails`, {
		method: "POST",
		headers: { "content-type": "application/json" },
		body: JSON.stringify({
			FromEmailAddress: fromHeader(ses.from),
			Destination: { ToAddresses: [to] },
			Content: {
				Simple: {
					Subject: { Data: mail.subject, Charset: "UTF-8" },
					Body: {
						Html: { Data: mail.html, Charset: "UTF-8" },
						Text: { Data: mail.text, Charset: "UTF-8" },
					},
					// Gmail 2024 起对群发信的硬要求:头部一键退订。顺便让 Gmail
					// 在邮件顶部原生显示「退订」按钮,降低被标垃圾的概率。
					Headers: [
						{ Name: "List-Unsubscribe", Value: `<${unsubUrl}>` },
						{ Name: "List-Unsubscribe-Post", Value: "List-Unsubscribe=One-Click" },
					],
				},
			},
		}),
	});
	if (!res.ok) {
		const detail = (await res.json().catch(() => ({}))) as { message?: string };
		throw new Error(`SES send failed (HTTP ${res.status})${detail.message ? ` — ${detail.message}` : ""}`);
	}
}
