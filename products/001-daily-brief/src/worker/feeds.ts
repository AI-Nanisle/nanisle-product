// Feed probing + discovery. Given any URL — a feed, or just a homepage —
// find a fetchable RSS/Atom feed behind it and report what it currently
// carries. Every source the chat agent touches goes through here first:
// nothing enters the config unless it actually parsed.

import { isBlockedFeedHost, parseFeedMeta, USER_AGENT } from "../shared/pipeline-core.ts";
import type { RawEntry } from "../shared/pipeline-core";
import { DEFAULT_FILTERS } from "../shared/default-sources.ts";

export interface FeedProbe {
	ok: boolean;
	/** The URL that actually served a feed (differs from the input after discovery). */
	url: string;
	/** Feed 自报的标题——「源名称」留空时的回填来源。 */
	title?: string;
	total?: number;
	fresh?: number;
	latest?: { title: string; publishedAt: string | null }[];
	/** Present when the feed was found via HTML autodiscovery / common paths. */
	resolvedFrom?: string;
	error?: string;
}

// Tried in order on the site origin when the page itself declares no feed.
const COMMON_PATHS = ["/feed", "/rss", "/rss.xml", "/atom.xml", "/feed.xml", "/index.xml"];
// Discovery fetches beyond the direct attempt — keeps worst-case subrequests bounded.
const MAX_DISCOVERY_FETCHES = 3;

type FetchOutcome = { entries: RawEntry[]; title: string } | { error: string; html?: string };

async function fetchOnce(url: string, timeoutMs: number): Promise<FetchOutcome> {
	let res: Response;
	try {
		res = await fetch(url, {
			headers: {
				"user-agent": USER_AGENT,
				accept: "application/rss+xml, application/atom+xml, application/xml, text/xml, text/html, */*",
			},
			signal: AbortSignal.timeout(timeoutMs),
			redirect: "follow",
		});
	} catch (err) {
		return { error: err instanceof Error && err.name === "TimeoutError" ? "抓取超时" : "网络错误" };
	}
	if (!res.ok) return { error: `HTTP ${res.status}` };
	const body = await res.text();
	try {
		const { title, entries } = parseFeedMeta(body);
		if (entries.length > 0) return { entries, title };
	} catch {
		// fall through — not XML at all
	}
	const ctype = res.headers.get("content-type") ?? "";
	const isHtml = ctype.includes("html") || /<html[\s>]/i.test(body.slice(0, 2000));
	return { error: "不是可解析的 RSS/Atom", ...(isHtml ? { html: body.slice(0, 120_000) } : {}) };
}

function summarize(url: string, entries: RawEntry[], title: string): FeedProbe {
	const now = Date.now();
	const fresh = entries.filter(
		(e) => e.publishedAt && now - e.publishedAt.getTime() <= DEFAULT_FILTERS.max_age_hours * 3600_000,
	).length;
	return {
		ok: true,
		url,
		...(title ? { title } : {}),
		total: entries.length,
		fresh,
		latest: entries.slice(0, 5).map((e) => ({
			title: e.title,
			publishedAt: e.publishedAt ? e.publishedAt.toISOString() : null,
		})),
	};
}

/** `<link rel="alternate" type="application/rss+xml" href=…>` — the autodiscovery standard. */
function discoverInHtml(html: string, baseUrl: string): string[] {
	const found: string[] = [];
	for (const m of html.matchAll(/<link\b[^>]*>/gi)) {
		const tag = m[0];
		if (!/rel=["']?alternate["']?/i.test(tag)) continue;
		if (!/application\/(?:rss|atom)\+xml/i.test(tag)) continue;
		const href = /href=["']([^"']+)["']/i.exec(tag)?.[1];
		if (!href) continue;
		try {
			found.push(new URL(href, baseUrl).toString());
		} catch {
			// unresolvable href — skip
		}
	}
	return found;
}

export async function probeFeed(input: string, timeoutMs = 12_000): Promise<FeedProbe> {
	let url = input.trim();
	if (!/^https?:\/\//i.test(url)) url = `https://${url}`;
	try {
		// 内网/云元数据地址在这里就拒:试抓是「立刻用我们的出口打一次这个地址」,
		// 是这条路上最直接的探针(见 pipeline-core 的 isBlockedFeedHost)。
		if (isBlockedFeedHost(new URL(url).hostname)) {
			return { ok: false, url: input, error: "不接受内网地址" };
		}
	} catch {
		return { ok: false, url: input, error: "不是合法的 URL" };
	}

	const direct = await fetchOnce(url, timeoutMs);
	if ("entries" in direct) return summarize(url, direct.entries, direct.title);

	// Discovery: feeds the page declares first, then conventional paths on the origin.
	const candidates: string[] = [];
	if ("html" in direct && direct.html) candidates.push(...discoverInHtml(direct.html, url));
	try {
		const origin = new URL(url).origin;
		for (const p of COMMON_PATHS) candidates.push(origin + p);
	} catch {
		// origin unavailable — HTML candidates only
	}

	const seen = new Set([url]);
	let attempts = 0;
	for (const cand of candidates) {
		if (seen.has(cand)) continue;
		// 候选来自页面自己声明的 <link>:那是被抓页面说了算的内容,等于第二次
		// 用户可控输入,必须再过一遍主机名黑名单(否则一个公网页面就能把我们
		// 的出口指向内网,绕开上面那次校验)。
		try {
			if (isBlockedFeedHost(new URL(cand).hostname)) continue;
		} catch {
			continue;
		}
		if (attempts >= MAX_DISCOVERY_FETCHES) break;
		seen.add(cand);
		attempts++;
		const res = await fetchOnce(cand, timeoutMs);
		if ("entries" in res) return { ...summarize(cand, res.entries, res.title), resolvedFrom: input };
	}
	return { ok: false, url, error: direct.error };
}
