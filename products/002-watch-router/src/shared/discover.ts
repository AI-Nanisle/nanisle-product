// 订阅模式 · 发现新内容的纯函数(docs/05 §3.2/§3.3;运行时无关,消费者
// Lambda 与本地基准都用;Worker 只用其中的 URL 解析部分)。
//
// 三个平台各一条路,结论来自 2026-08-28 调研与实测(docs/05 §1.4):
//   YouTube  隐藏 playlist 前缀 UULF 的 RSS(排除 Shorts 与直播,无需 key,15 条上限,
//            没有时长字段——时长由调用方按需补)
//   B站      APP 端 archive/cursor + 公开 appkey 的 md5 签名(实测 18/18;Web 端
//            arc/search 需 WBI+dm_img+登录 cookie,0/16)
//   播客     标准 RSS 2.0 enclosure + itunes:duration
//
// 所有网络请求都在调用方注入的 fetch 上跑(Lambda 走代理),这里不碰全局状态。

export type SubPlatform = "youtube" | "bilibili" | "podcast";

export interface SubscriptionRef {
	platform: SubPlatform;
	/** YouTube channelId(UC…)/ B站 mid / 播客 feed URL。 */
	id: string;
	title?: string;
}

export interface Candidate {
	platform: SubPlatform;
	/** 进 002 慢车道的 URL(视频页或音频 enclosure)。 */
	url: string;
	/** 与 content-id.ts 一致的内容键前半部分之外的原始 id(视频 id / bvid / enclosure url)。 */
	id: string;
	title: string;
	/** 发布时间(ms)。 */
	publishedAt: number;
	/** 秒;RSS 没有就缺席。 */
	durationSec?: number;
	/** 直播回放/番剧等不进候选的标记(B站给);YouTube 描述含 #shorts。 */
	excluded?: string;
	channelTitle?: string;
}

// ---------- 输入解析(Worker 侧,用户粘什么) ----------

export type ParsedSubInput =
	| { platform: "youtube"; channelId?: string; handle?: string }
	| { platform: "bilibili"; mid?: string; shortUrl?: string }
	| { platform: "podcast"; feedUrl: string }
	| null;

/**
 * 拒掉指向内网/云元数据的地址。播客订阅的 id **就是那个 URL**,存下来之后 Worker
 * 与消费者每天各抓一次——不挡住的话,任何登录用户都能拿我们的两个出口当探针。
 * 只按主机名判:Workers 里没法先解析 DNS 再校验,所以 DNS rebinding 这层挡不住;
 * 但那需要攻击者控制权威 DNS,和「随手粘一个 169.254.169.254」不是一个量级。
 */
export function isBlockedFeedHost(hostname: string): boolean {
	const h = hostname.toLowerCase().replace(/\.$/, "").replace(/^\[|\]$/g, "");
	if (!h) return true;
	if (h === "localhost" || h.endsWith(".localhost") || h.endsWith(".local") || h.endsWith(".internal")) return true;
	if (h.includes(":")) {
		// IPv6:回环、链路本地、唯一本地
		return h === "::" || h === "::1" || h.startsWith("fe80") || h.startsWith("fc") || h.startsWith("fd");
	}
	const m = /^(\d{1,3})\.(\d{1,3})\.(\d{1,3})\.(\d{1,3})$/.exec(h);
	if (!m) return false; // 普通域名放行
	const [a, b] = [Number(m[1]), Number(m[2])];
	if (m.slice(1).some((x) => Number(x) > 255)) return true;
	if (a === 0 || a === 10 || a === 127) return true;
	if (a === 172 && b >= 16 && b <= 31) return true;
	if (a === 192 && b === 168) return true;
	if (a === 169 && b === 254) return true; // 云元数据
	if (a === 100 && b >= 64 && b <= 127) return true; // CGNAT
	if (a >= 224) return true; // 组播与保留段
	return false;
}

/** 用户输入 → 平台与初步 id。解析不到 id 的(YouTube @handle、b23 短链)交给消费者经代理解析。 */
export function parseSubscriptionInput(raw: string): ParsedSubInput {
	const s = raw.trim();
	if (!s) return null;
	let u: URL;
	try {
		u = new URL(/^https?:\/\//i.test(s) ? s : `https://${s}`);
	} catch {
		return null;
	}
	const host = u.hostname.replace(/^www\.|^m\./, "");
	if (host === "youtube.com" || host === "youtu.be") {
		const m = u.pathname.match(/\/channel\/(UC[\w-]{20,})/);
		if (m) return { platform: "youtube", channelId: m[1] };
		const h = u.pathname.match(/\/@([\w.-]+)/);
		if (h) return { platform: "youtube", handle: h[1] };
		return null;
	}
	if (host === "space.bilibili.com") {
		const m = u.pathname.match(/^\/(\d+)/);
		return m ? { platform: "bilibili", mid: m[1] } : null;
	}
	if (host === "b23.tv") return { platform: "bilibili", shortUrl: u.toString() };
	if (host === "bilibili.com") return null;
	// 其余 URL 一律当播客 feed(是不是 RSS 由消费者拉一次校验)。
	// 只收 https:http 的 feed 既有中间人风险,也是绕开主机白名单最省事的入口。
	if (u.protocol !== "https:") return null;
	if (isBlockedFeedHost(u.hostname)) return null;
	return { platform: "podcast", feedUrl: u.toString() };
}

// ---------- YouTube ----------

/** UC… → UULF…(纯视频隐藏 playlist;未文档化但 2025 起社区广泛使用)。 */
export function youtubeUploadsFeedUrl(channelId: string): string {
	const tail = channelId.replace(/^UC/, "");
	return `https://www.youtube.com/feeds/videos.xml?playlist_id=UULF${tail}`;
}

function xmlText(block: string, tag: string): string | undefined {
	const m = block.match(new RegExp(`<${tag}(?:\\s[^>]*)?>([\\s\\S]*?)</${tag}>`));
	return m ? decodeXml(m[1].trim()) : undefined;
}

function decodeXml(s: string): string {
	return s
		.replace(/<!\[CDATA\[([\s\S]*?)\]\]>/g, "$1")
		.replace(/&lt;/g, "<")
		.replace(/&gt;/g, ">")
		.replace(/&quot;/g, '"')
		.replace(/&#39;|&apos;/g, "'")
		.replace(/&amp;/g, "&");
}

export function parseYoutubeFeed(xml: string): { channelTitle?: string; items: Candidate[] } {
	// UULF 是 playlist feed,顶层 <title> 是「Videos」;频道名在 <author><name>(实测)
	const head = xml.split("<entry>")[0] ?? "";
	const author = head.match(/<author>[\s\S]*?<name>([\s\S]*?)<\/name>/)?.[1];
	const channelTitle = author ? decodeXml(author.trim()) : xmlText(head, "title");
	const items: Candidate[] = [];
	for (const entry of xml.split("<entry>").slice(1)) {
		const id = xmlText(entry, "yt:videoId");
		const title = xmlText(entry, "title");
		const published = xmlText(entry, "published");
		if (!id || !title || !published) continue;
		const desc = xmlText(entry, "media:description") ?? "";
		items.push({
			platform: "youtube",
			id,
			url: `https://www.youtube.com/watch?v=${id}`,
			title,
			publishedAt: Date.parse(published),
			...(channelTitle ? { channelTitle } : {}),
			...(/#shorts\b/i.test(desc) || /#shorts\b/i.test(title) ? { excluded: "shorts" } : {}),
		});
	}
	return { channelTitle, items };
}

/** 频道页 HTML → channelId(<meta itemprop="channelId">);解析 @handle 用。 */
export function channelIdFromHtml(html: string): string | null {
	const m = html.match(/itemprop="channelId"\s+content="(UC[\w-]+)"/) ?? html.match(/"externalId":"(UC[\w-]+)"/);
	return m ? m[1] : null;
}

// ---------- B站 ----------

/** 公开的安卓粉版 appkey/appsec(bilibili-API-collect misc/sign/APPKey.md)。 */
export const BILI_APPKEY = "1d8b6e7d45233436";
export const BILI_APPSEC = "560c52ccd288fed045859ed18bffd973";

/** APP 签名:参数加 appkey,按 key 排序 urlencode,拼 appsec 取 md5 作 sign。 */
export async function biliAppSign(params: Record<string, string | number>, appkey = BILI_APPKEY, appsec = BILI_APPSEC): Promise<string> {
	const p = new URLSearchParams();
	for (const [k, v] of Object.entries({ ...params, appkey })) p.append(k, String(v));
	p.sort();
	const sign = await md5Hex(p.toString() + appsec);
	p.append("sign", sign);
	return p.toString();
}

/** WebCrypto 没有 md5;这里是自包含的 RFC 1321 实现(输入按 UTF-8)。 */
export async function md5Hex(input: string): Promise<string> {
	const bytes = new TextEncoder().encode(input);
	return md5(bytes);
}

function md5(data: Uint8Array): string {
	const K = new Uint32Array(64);
	for (let i = 0; i < 64; i++) K[i] = Math.floor(Math.abs(Math.sin(i + 1)) * 2 ** 32) >>> 0;
	const S = [7, 12, 17, 22, 7, 12, 17, 22, 7, 12, 17, 22, 7, 12, 17, 22, 5, 9, 14, 20, 5, 9, 14, 20, 5, 9, 14, 20, 5, 9, 14, 20, 4, 11, 16, 23, 4, 11, 16, 23, 4, 11, 16, 23, 4, 11, 16, 23, 6, 10, 15, 21, 6, 10, 15, 21, 6, 10, 15, 21, 6, 10, 15, 21];
	const len = data.length;
	const padded = new Uint8Array(((len + 8) >> 6 << 6) + 64);
	padded.set(data);
	padded[len] = 0x80;
	const dv = new DataView(padded.buffer);
	dv.setUint32(padded.length - 8, (len * 8) >>> 0, true);
	dv.setUint32(padded.length - 4, Math.floor((len * 8) / 2 ** 32), true);
	let a0 = 0x67452301, b0 = 0xefcdab89, c0 = 0x98badcfe, d0 = 0x10325476;
	const M = new Uint32Array(16);
	for (let off = 0; off < padded.length; off += 64) {
		for (let i = 0; i < 16; i++) M[i] = dv.getUint32(off + i * 4, true);
		let A = a0, B = b0, C = c0, D = d0;
		for (let i = 0; i < 64; i++) {
			let F: number, g: number;
			if (i < 16) { F = (B & C) | (~B & D); g = i; }
			else if (i < 32) { F = (D & B) | (~D & C); g = (5 * i + 1) % 16; }
			else if (i < 48) { F = B ^ C ^ D; g = (3 * i + 5) % 16; }
			else { F = C ^ (B | ~D); g = (7 * i) % 16; }
			F = (F + A + K[i] + M[g]) >>> 0;
			A = D; D = C; C = B;
			B = (B + ((F << S[i]) | (F >>> (32 - S[i])))) >>> 0;
		}
		a0 = (a0 + A) >>> 0; b0 = (b0 + B) >>> 0; c0 = (c0 + C) >>> 0; d0 = (d0 + D) >>> 0;
	}
	const out = new Uint8Array(16);
	new DataView(out.buffer).setUint32(0, a0, true);
	new DataView(out.buffer).setUint32(4, b0, true);
	new DataView(out.buffer).setUint32(8, c0, true);
	new DataView(out.buffer).setUint32(12, d0, true);
	return Array.from(out, (b) => b.toString(16).padStart(2, "0")).join("");
}

/** 浏览器 UA:Python/Node 默认 UA 打 APP 接口也会 412(实测)。 */
export const BROWSER_UA =
	"Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/128.0.0.0 Safari/537.36";

export async function biliArchiveUrl(mid: string, ps = 20): Promise<string> {
	const qs = await biliAppSign({ vmid: mid, ps, order: "pubdate", ts: Math.floor(Date.now() / 1000) });
	return `https://app.biliapi.com/x/v2/space/archive/cursor?${qs}`;
}

interface BiliArchiveItem {
	bvid?: string;
	title?: string;
	duration?: number;
	ctime?: number;
	author?: string;
	is_live_playback?: number;
	is_pgc?: number;
	is_ugcpay?: number;
}

export function parseBiliArchive(json: unknown): { items: Candidate[]; error?: string } {
	const o = json as { code?: number; message?: string; data?: { item?: BiliArchiveItem[] } };
	if (o?.code !== 0) return { items: [], error: `bilibili code=${o?.code} ${o?.message ?? ""}`.trim() };
	const items: Candidate[] = [];
	for (const it of o.data?.item ?? []) {
		if (!it.bvid || !it.title || typeof it.ctime !== "number") continue;
		const excluded = it.is_live_playback ? "live_playback" : it.is_pgc ? "pgc" : it.is_ugcpay ? "ugcpay" : undefined;
		items.push({
			platform: "bilibili",
			id: it.bvid,
			url: `https://www.bilibili.com/video/${it.bvid}`,
			title: it.title,
			publishedAt: it.ctime * 1000,
			...(typeof it.duration === "number" ? { durationSec: it.duration } : {}),
			...(it.author ? { channelTitle: it.author } : {}),
			...(excluded ? { excluded } : {}),
		});
	}
	return { items };
}

/** `x/web-interface/card?mid=` 的回包 → 昵称(免签免 cookie,校验 mid 用)。 */
export function parseBiliCard(json: unknown): { name?: string; archives?: number } | null {
	const o = json as { code?: number; data?: { card?: { name?: string }; archive_count?: number } };
	if (o?.code !== 0) return null;
	return { name: o.data?.card?.name, archives: o.data?.archive_count };
}

// ---------- 播客 ----------

function itunesDuration(s: string | undefined): number | undefined {
	if (!s) return undefined;
	const parts = s.split(":").map(Number);
	if (parts.some((n) => !Number.isFinite(n))) return undefined;
	if (parts.length === 1) return parts[0];
	if (parts.length === 2) return parts[0] * 60 + parts[1];
	return parts[0] * 3600 + parts[1] * 60 + parts[2];
}

export function parsePodcastFeed(xml: string): { channelTitle?: string; items: Candidate[] } {
	const head = xml.split("<item")[0] ?? "";
	const channelTitle = xmlText(head, "title");
	const items: Candidate[] = [];
	for (const raw of xml.split(/<item(?:\s[^>]*)?>/).slice(1)) {
		const enc = raw.match(/<enclosure\s[^>]*url="([^"]+)"/);
		const title = xmlText(raw, "title");
		const pub = xmlText(raw, "pubDate");
		if (!enc || !title || !pub) continue;
		const url = decodeXml(enc[1]);
		const dur = itunesDuration(xmlText(raw, "itunes:duration"));
		items.push({
			platform: "podcast",
			id: url,
			url,
			title,
			publishedAt: Date.parse(pub),
			...(dur !== undefined ? { durationSec: dur } : {}),
			...(channelTitle ? { channelTitle } : {}),
		});
	}
	return { channelTitle, items };
}

// ---------- 挑选(Worker 侧,docs/05 §3.3) ----------

export interface PickInput {
	candidates: Candidate[];
	/** 已处理过的候选 id(READ# 记录)。 */
	seen: Set<string>;
	/** 各订阅上次被挑中的时间(频道轮转用),键为 `${platform}:${id}` 的订阅键 → 候选的 channel 对应关系由调用方在 Candidate 上标 subKey。 */
	lastPicked: Map<string, number>;
	subKeyOf: (c: Candidate) => string;
	now?: number;
	windowMs?: number;
	minDurationSec?: number;
	maxDurationSec?: number;
}

export interface PickOutcome {
	picked: Candidate | null;
	considered: number;
	reasons: Record<string, number>;
}

/** 规则:48h 内 · 未处理 · 非直播/番剧/Shorts · 时长在 [8min, 150min] · 频道轮转优先 · 新的在前。 */
export function pickDaily(input: PickInput): PickOutcome {
	const now = input.now ?? Date.now();
	const windowMs = input.windowMs ?? 48 * 3600 * 1000;
	const minDur = input.minDurationSec ?? 8 * 60;
	const maxDur = input.maxDurationSec ?? 150 * 60;
	const reasons: Record<string, number> = {};
	const bump = (k: string) => (reasons[k] = (reasons[k] ?? 0) + 1);
	const ok = input.candidates.filter((c) => {
		if (c.excluded) return bump(`excluded:${c.excluded}`), false;
		if (now - c.publishedAt > windowMs) return bump("too_old"), false;
		if (c.publishedAt > now + 3600_000) return bump("future"), false;
		if (input.seen.has(`${c.platform}:${c.id}`)) return bump("seen"), false;
		if (typeof c.durationSec === "number" && c.durationSec < minDur) return bump("too_short"), false;
		if (typeof c.durationSec === "number" && c.durationSec > maxDur) return bump("too_long"), false;
		return true;
	});
	ok.sort((a, b) => {
		const la = input.lastPicked.get(input.subKeyOf(a)) ?? 0;
		const lb = input.lastPicked.get(input.subKeyOf(b)) ?? 0;
		if (la !== lb) return la - lb; // 久没轮到的频道在前
		return b.publishedAt - a.publishedAt;
	});
	return { picked: ok[0] ?? null, considered: input.candidates.length, reasons };
}
