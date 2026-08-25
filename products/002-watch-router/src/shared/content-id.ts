// W8 · 内容 ID 归一(docs/02 T6 的缓存键前提):同一内容的不同 URL 形态
// 必须命中同一个缓存键,否则「按内容全站缓存」名存实亡。
// 归一结果同时决定车道:视频/播客平台 → 慢车道,其余按文章走快车道。
//
// 已知局限(诚实记录):B站 b23.tv 短链和 YouTube 的部分共享链接要跟一次
// 重定向才知道真实 ID,Worker 里跟跳转要花一次 fetch——v1 不做,短链按
// URL hash 归一,代价是同内容短链/长链各占一个缓存位,不影响正确性。

export type Lane = "fast" | "slow";

export interface ContentId {
	/** 缓存键:<platform>:<id>(docs/02 T6 的 content: 前缀由 store 侧拼)。 */
	key: string;
	platform: string;
	lane: Lane;
}

/** 去掉跟踪参数、hash、尾斜杠,host 小写——文章 URL 的归一基础。 */
function normalizeUrl(raw: string): string {
	const url = new URL(raw);
	url.hostname = url.hostname.toLowerCase();
	url.hash = "";
	const params = url.searchParams;
	for (const k of [...params.keys()]) {
		if (/^(utm_|fbclid|gclid|spm|from|share_|vd_source|buvid)/i.test(k)) params.delete(k);
	}
	url.search = params.toString() ? `?${params.toString()}` : "";
	return url.toString().replace(/\/+$/, "");
}

async function sha256Hex(s: string): Promise<string> {
	const digest = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(s));
	return [...new Uint8Array(digest)].map((b) => b.toString(16).padStart(2, "0")).join("");
}

/** URL → 平台 + 内容 ID + 车道。抛错 = 不是合法 http(s) URL(调用方给 400)。 */
export async function identifyUrl(raw: string): Promise<ContentId> {
	const url = new URL(raw);
	const host = url.hostname.toLowerCase().replace(/^www\./, "");

	// YouTube:watch?v= / youtu.be/ / shorts/ / live/
	if (host === "youtube.com" || host === "m.youtube.com" || host === "youtu.be") {
		let id = "";
		if (host === "youtu.be") id = url.pathname.split("/")[1] ?? "";
		else if (url.pathname === "/watch") id = url.searchParams.get("v") ?? "";
		else {
			const m = url.pathname.match(/^\/(shorts|live|embed)\/([\w-]{6,})/);
			if (m) id = m[2];
		}
		if (id) return { key: `youtube:${id}`, platform: "youtube", lane: "slow" };
	}

	// B站:/video/BVxxxx(分P 用 ?p= 区分——不同 P 是不同内容,进 key)
	if (host === "bilibili.com" || host === "m.bilibili.com") {
		const m = url.pathname.match(/\/video\/(BV[\w]+|av\d+)/i);
		if (m) {
			const p = url.searchParams.get("p");
			const id = p && p !== "1" ? `${m[1]}_p${p}` : m[1];
			return { key: `bilibili:${id}`, platform: "bilibili", lane: "slow" };
		}
	}

	// 小宇宙单集
	if (host === "xiaoyuzhoufm.com") {
		const m = url.pathname.match(/\/episode\/([\w-]+)/);
		if (m) return { key: `xiaoyuzhou:${m[1]}`, platform: "xiaoyuzhou", lane: "slow" };
	}

	// 裸音频文件(播客 enclosure 直链)
	if (/\.(mp3|m4a|aac|ogg|opus|flac|wav)(\?|$)/i.test(url.pathname + url.search)) {
		return { key: `audio:${await sha256Hex(normalizeUrl(raw))}`, platform: "podcast", lane: "slow" };
	}

	// b23.tv / youtu 短链等没解析出 ID 的视频域,以及一切其余 URL:按文章走快车道。
	// (b23.tv 落到这里会走快车道抽取然后失败提示——比静默猜车道诚实;v2 跟一跳重定向)
	return { key: `article:${await sha256Hex(normalizeUrl(raw))}`, platform: "article", lane: "fast" };
}

/** 粘贴正文:按文本内容 hash 归一(同一段文本贴两次命中同一缓存)。 */
export async function identifyText(text: string): Promise<ContentId> {
	const norm = text.replace(/\s+/g, " ").trim();
	return { key: `paste:${await sha256Hex(norm)}`, platform: "paste", lane: "fast" };
}
