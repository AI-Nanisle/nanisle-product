// 订阅模式的邮件门铃(docs/05 §3.5;从 001 的 E1 物理复制改模板,自包含原则)。三件事收在这一个文件里:
//
//   1. 退订 token:HMAC 签名的「邮箱 + 用途」,Lambda 生成、Worker 验证,
//      Worker 自签自验,EMAIL_UNSUB_SECRET。专用密钥,不复用 NANISLE_SSO_SECRET——
//      那是登录信物,泄漏面不该扩大到 AWS 侧;这把钥匙最坏后果只是被人退订。
//   2. 邮件模板:频道 · 标题 · 时长 · 判决一句话 + 「打开总结」按钮 + 页脚退订。
//      **不放原视频链接、不放要点**——邮件只当门铃不当报纸(001 决策 1 的立场),
//      详细笔记几千字更不该进邮件,消费必须发生在网页上。
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

export interface WatchEmailInput {
	channelTitle?: string;
	title: string;
	/** 秒;没有就不显示。 */
	durationSec?: number;
	worth: "yes" | "no" | "partial";
	reason: string;
	/** 回站地址(带 ?open=<contentKey>,直达这条的详细笔记)。 */
	openUrl: string;
	unsubUrl: string;
}

function esc(s: string): string {
	return s.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/"/g, "&quot;");
}

const WORTH_LABEL = { yes: "值得看", no: "可以跳过", partial: "部分值得" } as const;

function fmtDuration(sec?: number): string {
	if (!sec) return "";
	const m = Math.round(sec / 60);
	return m >= 60 ? `${Math.floor(m / 60)} 小时 ${m % 60} 分钟` : `${m} 分钟`;
}

export function renderWatchEmail(input: WatchEmailInput): { subject: string; html: string; text: string } {
	const who = input.channelTitle ? `${input.channelTitle} 更新了` : "你订阅的频道更新了";
	const dur = fmtDuration(input.durationSec);
	const subject = `${WORTH_LABEL[input.worth]} · ${input.title}`.slice(0, 120);
	const head = `${who}《${input.title}》${dur ? `(${dur})` : ""}`;
	const verdict = `${WORTH_LABEL[input.worth]}——${input.reason}`;
	const text = [head, "", verdict, "", `打开总结(详细笔记已替你写好):${input.openUrl}`, "", `不想收到这封邮件?退订:${input.unsubUrl}`].join("\n");
	const html = `<div style="margin:0 auto;max-width:520px;padding:32px 20px;font-family:-apple-system,'PingFang SC','Microsoft YaHei',sans-serif;color:#1a1a1a;">
	<p style="margin:0 0 20px;font-size:12px;letter-spacing:0.08em;color:#999;">长视频总结 · 订阅日报</p>
	<p style="margin:0 0 12px;font-size:15px;line-height:1.7;">${esc(head)}</p>
	<p style="margin:0 0 12px;font-size:15px;line-height:1.7;"><strong>${esc(WORTH_LABEL[input.worth])}</strong>——${esc(input.reason)}</p>
	<p style="margin:28px 0;">
		<a href="${esc(input.openUrl)}" style="display:inline-block;padding:10px 22px;background:#1a1a1a;color:#fff;text-decoration:none;font-size:14px;border-radius:4px;">打开总结 →</a>
	</p>
	<p style="margin:32px 0 0;border-top:1px solid #eee;padding-top:12px;font-size:12px;color:#999;">
		不想收到这封邮件?<a href="${esc(input.unsubUrl)}" style="color:#999;">一键退订</a>,网页「我的订阅」里也随时能重新打开。
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
	const name = b64url(new TextEncoder().encode("长视频总结")).replace(/-/g, "+").replace(/_/g, "/");
	return `=?UTF-8?B?${name}?= <${address}>`;
}

/**
 * 发一封订阅提醒。抛错交给调用方决定死活——complete 端点只记日志不中断
 * (邮件是锦上添花,结果已经安全落库)。
 */
export async function sendWatchEmail(
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
