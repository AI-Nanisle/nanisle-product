// Node 侧的正文抽取(Lambda 与 CLI 共用):@mozilla/readability 是 Firefox
// 阅读模式的同款算法,语言无关;linkedom 提供它要的 Document,比 jsdom 轻一个
// 数量级。只在 Node 里用——Worker 走 shared 里的正则版兜底,不背这份依赖。
//
// 失败语义与 shared/fetchArticleText 一致:任何一步失败都返回空串或正则结果,
// 深度是加分项,不能因为某个站结构怪就让整期出不来。

import { Readability } from "@mozilla/readability";
import { parseHTML } from "linkedom";
import { ENRICH_TEXT_CAP, USER_AGENT, decodeGoogleNewsUrl, stripHtml } from "../src/shared/pipeline-core.ts";
import type { Candidate } from "../src/shared/pipeline-core.ts";

// ---------- Google News 新式跳转链解析(Node 侧,只对入选条目做) ----------
//
// 2024 年中以后的链接把真实 URL 藏在服务端:要先 GET 文章页取 c-wiz 上的
// 时间戳和签名,再 POST 内部的 batchexecute 接口换出原文 URL(社区各解码库
// 的通用做法)。这是无文档接口,随时可能变——所以只在**已入选**的 ≤10 条上
// 花这两次请求,失败一律保留 Google 链接,任何机制都照常降级。

const GN_BATCH_URL = "https://news.google.com/_/DotsSplashUi/data/batchexecute";

export async function resolveGoogleNewsUrl(url: string, timeoutMs = 8000): Promise<string | null> {
	const direct = decodeGoogleNewsUrl(url);
	if (direct) return direct;
	let u: URL;
	try {
		u = new URL(url);
	} catch {
		return null;
	}
	if (u.hostname !== "news.google.com") return null;
	const seg = /\/(?:rss\/)?articles\/([^/?#]+)/.exec(u.pathname)?.[1];
	if (!seg) return null;
	try {
		const page = await fetch(url, {
			headers: { "user-agent": USER_AGENT, accept: "text/html" },
			signal: AbortSignal.timeout(timeoutMs),
			redirect: "follow",
		});
		if (!page.ok) return null;
		const html = await page.text();
		const ts = /data-n-a-ts="([^"]+)"/.exec(html)?.[1];
		const sg = /data-n-a-sg="([^"]+)"/.exec(html)?.[1];
		if (!ts || !sg) return null;
		const req = `[["Fbv4je","[\\"garturlreq\\",[[\\"X\\",\\"X\\",[\\"X\\",\\"X\\"],null,null,1,1,\\"US:en\\",null,1,null,null,null,null,null,0,1],\\"X\\",\\"X\\",1,[1,1,1],1,1,null,0,0,null,0],\\"${seg}\\",${ts},\\"${sg}\\"]",null,"generic"]]`;
		const res = await fetch(GN_BATCH_URL, {
			method: "POST",
			headers: {
				"user-agent": USER_AGENT,
				"content-type": "application/x-www-form-urlencoded;charset=UTF-8",
			},
			body: `f.req=${encodeURIComponent(`[${req}]`)}`,
			signal: AbortSignal.timeout(timeoutMs),
		});
		if (!res.ok) return null;
		const body = await res.text();
		const matches = body.match(/https?:\\?\/\\?\/[^"\\]+/g) ?? [];
		for (const raw of matches) {
			const candidate = raw.replace(/\\\//g, "/");
			try {
				const host = new URL(candidate).hostname;
				if (!host.endsWith("google.com") && !host.endsWith("gstatic.com")) return candidate;
			} catch {
				// 不是完整 URL,继续找
			}
		}
		return null;
	} catch {
		return null;
	}
}

/**
 * 把编辑**选中**的候选里的 Google News 跳转链就地换成原文 URL(id 保持原样,
 * 防重复按 feed 里稳定的跳转链算)。换掉之后:阅读页点开的是真实页面、成稿
 * 抓得到正文、HN 讨论查得到、每周的域名统计数得出出版方。
 */
export async function resolvePickedGoogleUrls(
	candidates: Candidate[],
	pickedIds: Set<string>,
	log: (msg: string) => void = () => {},
	cap = 16,
): Promise<number> {
	const targets = candidates
		.filter((c) => pickedIds.has(c.id))
		.filter((c) => {
			try {
				return new URL(c.url).hostname === "news.google.com";
			} catch {
				return false;
			}
		})
		.slice(0, cap);
	if (targets.length === 0) return 0;
	let resolved = 0;
	await Promise.all(
		targets.map(async (c) => {
			const real = await resolveGoogleNewsUrl(c.url);
			if (real) {
				c.url = real;
				resolved++;
			}
		}),
	);
	log(`[gn] Google News 跳转链解析 ${resolved}/${targets.length} 条`);
	return resolved;
}

/** readability 抽出的正文短于这个数就当失败,退回正则版(短页往往是壳)。 */
const MIN_READABLE = 200;

function regexFallback(html: string): string {
	const pick =
		/<article[^>]*>([\s\S]*?)<\/article>/i.exec(html)?.[1] ??
		/<main[^>]*>([\s\S]*?)<\/main>/i.exec(html)?.[1] ??
		/<body[^>]*>([\s\S]*?)<\/body>/i.exec(html)?.[1] ??
		html;
	return stripHtml(pick).slice(0, ENRICH_TEXT_CAP);
}

export async function fetchArticleTextNode(url: string, timeoutMs = 8000): Promise<string> {
	let html: string;
	try {
		// Google News 跳转链是 JS 壳页,抽出来全是导航噪音——先解析成原文 URL,
		// 解不开就放弃(正常情况下 resolvePickedGoogleUrls 已在上游换过了)
		if (new URL(url).hostname === "news.google.com") {
			const real = await resolveGoogleNewsUrl(url, timeoutMs);
			if (!real) return "";
			url = real;
		}
		const res = await fetch(url, {
			headers: { "user-agent": USER_AGENT, accept: "text/html,application/xhtml+xml" },
			signal: AbortSignal.timeout(timeoutMs),
			redirect: "follow",
		});
		if (!res.ok) return "";
		const type = res.headers.get("content-type") ?? "";
		if (!type.includes("html")) return "";
		html = await res.text();
	} catch {
		return "";
	}
	try {
		const { document } = parseHTML(html);
		// linkedom 的 parseHTML 不收 url,补一个 <base> 让相对链接可解析
		const base = document.createElement("base");
		base.setAttribute("href", url);
		document.head?.appendChild(base);
		// pipeline 的 tsconfig 没开 DOM lib,拿构造签名反推 Document 类型
		const article = new Readability(document as unknown as ConstructorParameters<typeof Readability>[0], {
			charThreshold: 100,
		}).parse();
		const text = article?.textContent?.replace(/\s+/g, " ").trim() ?? "";
		if (text.length >= MIN_READABLE) return text.slice(0, ENRICH_TEXT_CAP);
	} catch {
		// readability 在怪结构上会 throw,吞掉走正则
	}
	return regexFallback(html);
}
