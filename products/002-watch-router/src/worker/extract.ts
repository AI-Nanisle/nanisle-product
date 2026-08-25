// W4 · 文章抽取链(docs/02 T2):自抽为主,r.jina.ai 兜底,粘贴保底。
//
//   fetch(浏览器 UA) → linkedom parse → Defuddle(出 markdown;不行退
//   Readability)→ 正文 < 500 字符视为静默失败 → r.jina.ai → 仍失败则
//   调用方提示「把正文粘贴进来」。
//
// 抽取器会「静默失败返回半空正文」是调研确认的常态(docs/02 §1.1),
// 所以字数阈值判断不是防御性冗余,是这条链的核心逻辑。
// Workers 出口是 Cloudflare 数据中心 IP,对硬防护站直抓成功率为零——
// jina 兜底是生命线不是锦上添花;没配 JINA_KEY 时仍匿名试一次(免费
// 匿名档限流很紧,只当聊胜于无)。

import { parseHTML } from "linkedom";
import Defuddle from "defuddle";
import { Readability } from "@mozilla/readability";

export interface Extracted {
	title?: string;
	/** 正文段落(已滤空段)。编辑调用按 [P#] 段号喂给模型,锚定/跳转也用段号。 */
	paragraphs: string[];
	source: "self" | "jina";
}

export type ExtractOutcome = { ok: true; value: Extracted } | { ok: false; error: string };

/** 低于这个字符数视为抽取静默失败(代码块/表格被误删的半空正文也会落进来)。 */
const MIN_CONTENT_CHARS = 500;
const FETCH_TIMEOUT_MS = 15_000;
const MAX_HTML_BYTES = 3 * 1024 * 1024;
const BROWSER_UA =
	"Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/126.0.0.0 Safari/537.36";

/** 连续空行切段 + 滤空;粘贴正文也走这一个函数,保证段号语义一致。 */
export function textToParagraphs(text: string): string[] {
	let parts = text.split(/\n\s*\n+/);
	// 没有空行的长文(单换行排版)退一级按行切,否则整篇挤成 1 段,
	// 分段地图和段号锚定全部失效(实测 Defuddle 输出踩过)
	if (parts.length <= 1 && text.length > 2000) {
		parts = text.split(/\n+/);
	}
	return parts.map((p) => p.replace(/\s+/g, " ").trim()).filter((p) => p.length > 0);
}

/** 块级元素集合:每个匹配元素的 textContent 作为一个候选段落。 */
const BLOCK_SELECTOR = "p, h1, h2, h3, h4, h5, h6, li, pre, blockquote, td, dd, dt, figcaption";

/**
 * HTML 片段 → 干净段落。不信任抽取器给的 content 字符串形态:Defuddle 的
 * markdown 选项在 linkedom 下可能静默失效,返回的是无换行的 HTML——直接
 * 当文本用,行内标签会插在句子中间,既毁段落切分又毁 quote 锚定(实测)。
 * 逐块取 textContent 是确定性的:段落干净,锚定匹配的是纯正文。
 */
export function htmlToParagraphs(html: string): string[] {
	// <br> 先换成真换行:上古排版(如 paulgraham.com)整篇正文塞在一个
	// <td>/<font> 里、段落全靠 <br><br> 分隔,textContent 里 <br> 是消失的,
	// 不先转换整篇会挤成一个段落(实测)
	const withBreaks = html.replace(/<br\s*\/?>/gi, "\n");
	const { document } = parseHTML(`<article>${withBreaks}</article>`);
	const nodes = [...document.querySelectorAll(BLOCK_SELECTOR)] as { textContent: string | null }[];
	// 嵌套去重:li 里套 p 时两个都会被选中,只保留没有祖先入选的节点
	const picked = new Set<unknown>(nodes);
	const paragraphs: string[] = [];
	for (const node of nodes) {
		let ancestor = (node as { parentElement?: unknown }).parentElement;
		let nested = false;
		while (ancestor) {
			if (picked.has(ancestor)) {
				nested = true;
				break;
			}
			ancestor = (ancestor as { parentElement?: unknown }).parentElement;
		}
		if (nested) continue;
		// 块内再切一次:一个 <td> 里装整篇文章时,靠 br 转出来的空行分段
		paragraphs.push(...textToParagraphs(node.textContent ?? ""));
	}
	if (paragraphs.length > 0) return paragraphs;
	// 块级元素一个都没有(纯文本 HTML):退回整体 textContent 按行切
	const whole = (document.querySelector("article")?.textContent ?? "").trim();
	return textToParagraphs(whole);
}

/** content 字符串是 HTML 还是文本/markdown:有像样的标签就按 HTML 处理。 */
function looksLikeHtml(s: string): boolean {
	return /<\/?[a-z][^>]*>/i.test(s);
}

async function fetchHtml(url: string): Promise<string | null> {
	try {
		const res = await fetch(url, {
			headers: { "user-agent": BROWSER_UA, accept: "text/html,application/xhtml+xml,*/*;q=0.8" },
			signal: AbortSignal.timeout(FETCH_TIMEOUT_MS),
			redirect: "follow",
		});
		if (!res.ok) return null;
		const html = await res.text();
		if (html.length > MAX_HTML_BYTES) return html.slice(0, MAX_HTML_BYTES);
		return html;
	} catch {
		return null;
	}
}

/** Defuddle 优先(正文识别质量高),不行退 Readability;两边都出干净段落。 */
function fromHtml(html: string, url: string): { title?: string; paragraphs: string[] } | null {
	// Workers tsconfig 没有 DOM lib,这两个库的类型签名要的是浏览器 Document;
	// linkedom 的 document 在运行时兼容,类型上用 never 桥接(仅此两处)。
	try {
		const { document } = parseHTML(html);
		const parsed = new Defuddle(document as never, { markdown: true, url }).parse();
		const content = (parsed?.content ?? "").trim();
		const paragraphs = looksLikeHtml(content) ? htmlToParagraphs(content) : textToParagraphs(content);
		if (paragraphs.join("").length >= MIN_CONTENT_CHARS) {
			return { title: parsed?.title || undefined, paragraphs };
		}
	} catch {
		// Defuddle 抛错不罕见,静默落到 Readability
	}
	try {
		// Readability 会改写 DOM,必须用一份新解析的 document;
		// 用它的 content(HTML)而不是 textContent——后者丢段落边界
		const { document } = parseHTML(html);
		const parsed = new Readability(document as never).parse();
		const content = (parsed?.content ?? "").trim();
		const paragraphs = looksLikeHtml(content) ? htmlToParagraphs(content) : textToParagraphs(content);
		if (paragraphs.join("").length >= MIN_CONTENT_CHARS) {
			return { title: parsed?.title || undefined, paragraphs };
		}
	} catch {
		// fall through
	}
	return null;
}

/** r.jina.ai 兜底:返回 markdown,头部带 Title:/URL Source: 元信息行。 */
async function fetchJina(url: string, key?: string): Promise<{ title?: string; text: string } | null> {
	try {
		const res = await fetch(`https://r.jina.ai/${url}`, {
			headers: {
				accept: "text/plain",
				...(key ? { authorization: `Bearer ${key}` } : {}),
			},
			signal: AbortSignal.timeout(30_000),
		});
		if (!res.ok) return null;
		const raw = await res.text();
		const title = raw.match(/^Title:\s*(.+)$/m)?.[1]?.trim();
		// 元信息头(Title/URL Source/Markdown Content:)之后才是正文
		const bodyStart = raw.indexOf("Markdown Content:");
		const text = (bodyStart >= 0 ? raw.slice(bodyStart + "Markdown Content:".length) : raw).trim();
		if (text.length < MIN_CONTENT_CHARS) return null;
		return { title, text };
	} catch {
		return null;
	}
}

export async function extractArticle(url: string, jinaKey?: string): Promise<ExtractOutcome> {
	const html = await fetchHtml(url);
	if (html) {
		const own = fromHtml(html, url);
		if (own) {
			console.log(`extract self: ${url} paragraphs=${own.paragraphs.length}`);
			return { ok: true, value: { title: own.title, paragraphs: own.paragraphs, source: "self" } };
		}
	}
	const jina = await fetchJina(url, jinaKey);
	if (jina) {
		const paragraphs = textToParagraphs(jina.text);
		console.log(`extract jina: ${url} chars=${jina.text.length} paragraphs=${paragraphs.length}`);
		return { ok: true, value: { title: jina.title, paragraphs, source: "jina" } };
	}
	console.log(`extract failed: ${url}`);
	return { ok: false, error: "这个站抓不动(直抓和兜底都失败了)。把正文复制粘贴进来,我照样能看。" };
}
