// 阶段 8 · 门铃邮件(docs/01 决策 5)。**从 002 的 `src/shared/email.ts` 物理复制
// 过来再改模板**——本仓的自包含铁律:产品之间不 import,要复用就复制。所以退订
// token 那两个函数和 SES 那一段和 002 一字不差(改了要两边一起改,那是明知的代价),
// 中间的模板是 003 自己的。
//
// 三件事收在这一个文件里:
//
//   1. 退订 token:HMAC 签名的「邮箱 + 用途」,自签自验,专用密钥
//      EMAIL_UNSUB_SECRET。**不复用 NANISLE_SSO_SECRET**——那是登录信物,
//      它的泄漏面不该为了一个退订链接而扩大;这把钥匙最坏的后果只是被人退订。
//   2. 邮件模板:本周清单 + 与上周的差异 + 一个回网页的按钮。**只有这三样。**
//   3. SES 发送:aws4fetch 签名直调 SES v2 HTTP API(不引入任何 AWS 侧计算)。
//
// **为什么邮件里不放报告、不放要点**(001 决策 1 的立场原样复用,docs/01 决策 5
// 又确认了一遍):邮件当门铃不当报纸,消费必须发生在网页上。003 的报告里那些
// 带 commit sha 的行号链接、锚定引文的展开、申诉按钮,**在邮件客户端里全是死的**
// ——把它们塞进邮件不是「更方便」,是把一份能点开验证的东西降级成一段不能核对的
// 文字,而「每句话都能点回源码那一行」正是这个产品唯一的卖点。
//
// 全部用 WebCrypto(globalThis.crypto):Node 22 和 Workers 运行时都原生有。

import { AwsClient } from "aws4fetch";
import type { WeekDiff } from "./scan-diff.ts";

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
	for (let i = 0; i < wantSig.length; i++) diff |= wantSig[i]! ^ givenSig[i]!;
	return diff === 0 ? email : null;
}

// ---------- 邮件模板 ----------

/** 邮件里一行候选要的字段。**没有 takeaway、没有引文、没有报告**——见文件头。 */
export interface TeardownEmailCandidate {
	fullName: string;
	stars: number;
	archived: boolean;
	/** 唯一一处模型产出,且只是形态描述不是判断;没问出来时为 null。 */
	oneLiner: string | null;
	/** 申诉捞回来的:当初被排除的理由原文;算法挑的为 null。 */
	appealedFrom: string | null;
}

export interface TeardownEmailInput {
	/** 档案里的领域名,用来提醒「这封信是关于什么的」。 */
	domain: string;
	weekOf: string;
	/**
	 * 本周清单,**全部**。
	 *
	 * **不要在这里 slice(0, 5)。**`SCAN_PICK_LIMIT` 是「算法挑几个」,不是清单长度
	 * 上限:申诉(POST /api/scan/appeal)会把排除硬搬进清单,一周捞回三个就是 8 行。
	 * 截断的后果是用户自己捞回来的东西在邮件里安静消失,而页面上还在——
	 * types.ts SCAN_PICK_LIMIT 的注释点名提醒过这封邮件是第一个会踩的地方。
	 */
	candidates: TeardownEmailCandidate[];
	diff: WeekDiff;
	/** 台账里的提前收工原因;非 null = 这一周的清单是残缺的,**必须说**。 */
	stopped: string | null;
	/** 回网页的地址(第一屏)。 */
	openUrl: string;
	unsubUrl: string;
}

function esc(s: string): string {
	return s.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/"/g, "&quot;");
}

/** 千分位。`toLocaleString` 在不同运行时的 ICU 数据不一样,自己写死才两边一致。 */
function fmtStars(n: number): string {
	return String(Math.max(0, Math.round(n))).replace(/\B(?=(\d{3})+(?!\d))/g, ",");
}

const LICENSE_NONE = "没有许可证";
const licenseLabel = (v: string | null) => v ?? LICENSE_NONE;

/** 一行候选的纯文本形态。归档徽章、申诉徽记、一句话形态描述都在这里。 */
function candidateLines(c: TeardownEmailCandidate, i: number): string[] {
	const badge = c.archived ? "  [已归档]" : "";
	const out = [`${i + 1}. ${c.fullName}  ★${fmtStars(c.stars)}${badge}`];
	// 「你捞回来的」这一枚徽记必须进邮件:它是这份清单里唯一一处**用户自己的
	// 动作**留下的痕迹,漏了的话邮件和页面对不上,而没有任何东西会报错
	// (store.ts getWeeklyScan 的注释专门为这封邮件写过这一段)。
	if (c.appealedFrom) out.push(`   (你捞回来的;原本因为「${c.appealedFrom}」被排除)`);
	out.push(`   ${c.oneLiner ?? "(这一句形态描述没问出来,清单本身不受影响)"}`);
	return out;
}

/**
 * 复查报出来的那几行(阶段 9)。**排在最前面**:「你上周在看的那个项目死了」
 * 比「有个新项目进清单了」重要得多,而邮件是从上往下读的。
 *
 * 每一条都要回答「它还在不在这周的清单里」。原因是这两件事经常同时发生而且
 * **后者会掩盖前者**:一个仓归档之后会被规则层筛掉,于是它从清单里消失 ——
 * 只说「它不在清单里了」的话,读者会以为它只是排名掉下去了。
 */
function recheckLines(r: WeekDiff["recheck"]): { changes: string[]; note: string[] } {
	// checked 为 0 = 这一趟压根没做复查(第一周 / 没传 probe / 全退订)。
	// **那就一个字都不提** —— 说「复查了 0 个」是把「没做」说成「做了没发现」。
	if (r.checked === 0) return { changes: [], note: [] };

	const changes = r.changes.map((c) => {
		if (c.kind === "gone") {
			// 404/410/451。**不是「我没查成」**,是 GitHub 明确说这个仓不在了。
			return c.stillListed
				? `已经没了:${c.fullName} —— GitHub 现在返回 404(删库 / 改名 / 被下架)。它还印在上面那份清单里,因为清单是几十秒前扫的。`
				: `已经没了:${c.fullName} —— GitHub 现在返回 404(删库 / 改名 / 被下架),它同时也不在本周清单里了。`;
		}
		if (c.kind === "archived") {
			return c.stillListed
				? `转归档:${c.fullName} —— 作者按了归档,项目不再维护。`
				: `转归档:${c.fullName} —— 作者按了归档,所以它这周被规则筛掉、不在上面那份清单里了。你上周在看的就是它。`;
		}
		const from = licenseLabel(c.license?.from ?? null);
		const to = licenseLabel(c.license?.to ?? null);
		const tail = c.stillListed ? "" : ",而且它这周不在清单里了";
		return `换许可证:${c.fullName}(${from} → ${to})${tail}`;
	});

	// **诚实那一句永远都在**,哪怕一条变化都没有:读者要能分清「复查过了、都没事」
	// 和「这一周根本没复查成」。三个数就是 docs/01 那条「检索台账」的立场
	// 搬到邮件里 —— 全部由代码统计,模型不接触。
	const note = [`(复查了上一周清单上的 ${r.checked} 个仓:${r.changed} 个有变化,${r.unchecked} 个没查成。)`];
	if (r.unchecked > 0) {
		// **没查成 ≠ 出事了。**这一句是为了不让上面那个数字被读成坏消息 ——
		// 把 GitHub 挂了说成项目死了,和把项目死了瞒下来一样糟。
		note.push("没查成的不代表它们出事了,只代表这一次没问到 GitHub:");
		for (const u of r.unavailable) note.push(`  · ${u.fullName} —— ${u.why}`);
	}
	return { changes, note };
}

/** 差异那一节的纯文本行。第一周只说一句实话。 */
function diffLines(diff: WeekDiff): string[] {
	if (!diff.prevWeekOf) {
		// **不假装有增量**(docs/01 TL;DR 承认的代价:第一周注定看起来平庸)。
		return ["这是第一周,没有可比的上一周 —— 增量要到下周才有东西可看。"];
	}
	const recheck = recheckLines(diff.recheck);
	// 复查那几条排最前面(死讯优先),再是清单的进出与异动。
	const out: string[] = [...recheck.changes];
	// 措辞是「新进清单」不是「新项目」:一个上周排第 9 的仓这周挤进前 5 也算,
	// 而我们拿不出「它上周在 GitHub 上不存在」的证据(scan-diff.ts 有完整论证)。
	if (diff.appeared.length) out.push(`新进清单:${diff.appeared.join("、")}`);
	// 这一批是「上周清单 vs 本周清单」比出来的,只包含复查没给出答案的仓
	// (scan-diff.ts WeekDiff.archivedNow 的注释说明了为什么两个来源都要留)。
	if (diff.archivedNow.length) out.push(`转归档:${diff.archivedNow.join("、")}`);
	for (const l of diff.licenseChanged) {
		out.push(`换许可证:${l.fullName}(${licenseLabel(l.from)} → ${licenseLabel(l.to)})`);
	}
	for (const s of diff.starJumps) {
		out.push(`star 跃迁:${s.fullName}(${fmtStars(s.from)} → ${fmtStars(s.to)},+${fmtStars(s.delta)})`);
	}
	if (out.length === 0) {
		out.push("一条变化都没有:清单里的项目、归档状态、许可证、star 都没动过,上一周那几个仓也都还在。");
	}
	// 复查的账挂在最后:它是台账不是新闻,但**必须出现**,否则「复查静默失败」
	// 和「复查过了什么都没发现」在这封信里长得一模一样。
	return [...out, ...recheck.note];
}

/** 清单残缺的警示语。**stopped 非空时必须出现**,别让人以为看到的是全貌。 */
function stoppedLine(stopped: string): string {
	return `⚠️ 这一周的清单是残缺的:${stopped}。下面这几个是确实验证过的,但不是全貌。`;
}

const EMPTY_LIST =
	"这一周一个候选都没有 —— 检索捞回来的仓全被规则筛掉了(归档 / 停更 / 没有许可证 / 太小)。网页上那份排除清单会逐条说明是哪一条规则、筛掉了谁。";

export function renderTeardownEmail(input: TeardownEmailInput): { subject: string; html: string; text: string } {
	const n = input.candidates.length;
	// 主题里就把「残缺」说出来:一封标题写着「5 个候选」的信,点开才发现只跑了
	// 一半,读者对后面每一封的信任都会打折。
	const subject = `领域拆解 · ${input.weekOf} · ${n === 0 ? "这一周没有候选" : `${n} 个候选`}${input.stopped ? "(清单残缺)" : ""}`
		.replace(/[\r\n]+/g, " ")
		.slice(0, 120);

	const diffTitle = input.diff.prevWeekOf ? `与上一次(${input.diff.prevWeekOf})比` : "与上一周比";
	const dLines = diffLines(input.diff);

	const text = [
		`你的领域:${input.domain}`,
		"",
		...(input.stopped ? [stoppedLine(input.stopped), ""] : []),
		`—— 本周清单(${input.weekOf}) ——`,
		"",
		...(n === 0 ? [EMPTY_LIST] : input.candidates.flatMap((c, i) => candidateLines(c, i))),
		"",
		`—— ${diffTitle} ——`,
		"",
		...dLines,
		"",
		// 唯一的行动:回网页。深度拆解在那边跑,不在这里。
		"打开网页看完整清单和每一条排除理由,挑一个跑深度拆解:",
		input.openUrl,
		"",
		`不想收到这封邮件?退订:${input.unsubUrl}`,
	].join("\n");

	const li = input.candidates
		.map((c) => {
			const badge = c.archived
				? ' <span style="display:inline-block;padding:1px 6px;border:1px solid #ddd;border-radius:3px;font-size:11px;color:#999;">已归档</span>'
				: "";
			const appealed = c.appealedFrom
				? `<div style="font-size:12px;line-height:1.6;color:#8a6d3b;">你捞回来的;原本因为「${esc(c.appealedFrom)}」被排除</div>`
				: "";
			return `<li style="margin:0 0 14px;">
		<div style="font-size:15px;line-height:1.6;"><strong>${esc(c.fullName)}</strong> <span style="color:#666;">★${fmtStars(c.stars)}</span>${badge}</div>
		${appealed}
		<div style="font-size:13px;line-height:1.7;color:#555;">${esc(c.oneLiner ?? "(这一句形态描述没问出来,清单本身不受影响)")}</div>
	</li>`;
		})
		.join("\n");

	const stoppedHtml = input.stopped
		? `<p style="margin:0 0 16px;padding:10px 12px;background:#fdf6e3;border-left:3px solid #d9a441;font-size:13px;line-height:1.7;color:#6b4e16;">${esc(stoppedLine(input.stopped))}</p>`
		: "";
	const listHtml =
		n === 0
			? `<p style="margin:0;font-size:13px;line-height:1.8;color:#555;">${esc(EMPTY_LIST)}</p>`
			: `<ol style="margin:0;padding-left:20px;">${li}</ol>`;

	const html = `<div style="margin:0 auto;max-width:560px;padding:32px 20px;font-family:-apple-system,'PingFang SC','Microsoft YaHei',sans-serif;color:#1a1a1a;">
	<p style="margin:0 0 20px;font-size:12px;letter-spacing:0.08em;color:#999;">领域拆解 · ${esc(input.weekOf)}</p>
	<p style="margin:0 0 16px;font-size:14px;line-height:1.7;">你的领域:<strong>${esc(input.domain)}</strong></p>
	${stoppedHtml}
	<p style="margin:24px 0 8px;font-size:12px;letter-spacing:0.08em;color:#999;">本周清单</p>
	${listHtml}
	<p style="margin:28px 0 8px;font-size:12px;letter-spacing:0.08em;color:#999;">${esc(diffTitle)}</p>
	<ul style="margin:0;padding-left:20px;font-size:13px;line-height:1.9;color:#333;">${dLines.map((l) => `<li>${esc(l)}</li>`).join("")}</ul>
	<p style="margin:28px 0;">
		<a href="${esc(input.openUrl)}" style="display:inline-block;padding:10px 22px;background:#1a1a1a;color:#fff;text-decoration:none;font-size:14px;border-radius:4px;">打开网页挑一个 →</a>
	</p>
	<p style="margin:32px 0 0;border-top:1px solid #eee;padding-top:12px;font-size:12px;color:#999;">
		完整清单、每一条排除理由和深度拆解都在网页上 —— 报告里那些能点回源码某一行的永久链接,在邮件客户端里是死的,所以这里只放门铃。<br>
		不想收到这封邮件?<a href="${esc(input.unsubUrl)}" style="color:#999;">一键退订</a>(退订只关掉邮件,周扫照跑、网页照常能看)。
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
	/** 裸发件地址(teardown@nanisle.com)。显示名在这里统一加,免得各调用点自己拼编码。 */
	from: string;
}

/** 显示名带中文,按 RFC 2047 B-encoding 包一层——SES 不收裸 UTF-8 显示名。 */
function fromHeader(address: string): string {
	const name = b64url(new TextEncoder().encode("领域拆解")).replace(/-/g, "+").replace(/_/g, "/");
	return `=?UTF-8?B?${name}?= <${address}>`;
}

/**
 * 发一封门铃邮件。抛错交给调用方决定死活——cron 那一层吞掉并记进
 * `weekly_email.error`,一个人发不出去不该拖垮整趟(周扫结果已经安全落库了)。
 */
export async function sendTeardownEmail(
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
