// releases.atom 的解析(阶段 7 · 节 1)。**纯字符串,零网络、零依赖。**
//
// 为什么手写正则而不是找一个 XML 解析器:Workers 里没有 DOMParser,而
// releases.atom 的形状是 GitHub 自己生成的、极其规整的一小段 XML(entry /
// title / updated / link / content)。为一个固定形状的 feed 引一个解析器,
// 换来的是一份新依赖和它的供应链,挡住的风险是「GitHub 改了 atom 的格式」
// ——那种改动会让任何解析器一起失效。
//
// **这里解析出来的每一行,后面都要当锚定的底本用**(SourceId = "changelog")。
// 所以有一条硬规矩:落进 ChangelogEntry 的字段必须是**原文的字**,不许在这一层
// 重写、补全或者归一化措辞。想让它更好读是渲染层的事,底本一改,模型引对了的
// 句子就会判成没锚上。

/** 一条 release。字段全部是 atom 里的原文。 */
export interface ChangelogEntry {
	/** release 标题,通常是版本号或版本号 + 一句话。 */
	title: string;
	/** ISO 时间戳原文(atom 的 <updated>)。 */
	updated: string;
	/** github.com/{o}/{r}/releases/tag/vX —— 永久回链,tag 不会漂。 */
	link: string;
	/** release notes 正文(去过 HTML 标签)。可能为空:很多 release 不写 notes。 */
	body: string;
}

function tagText(xml: string, tag: string): string {
	const m = new RegExp(`<${tag}(?:\\s[^>]*)?>([\\s\\S]*?)</${tag}>`, "i").exec(xml);
	return m ? decodeXml(m[1]!) : "";
}

/**
 * XML 实体解码。`&amp;` 必须最后换 —— 先换它的话 `&amp;lt;` 会被两步连着
 * 解成 `<`,而原文作者写的是字面量 `&lt;`。
 */
function decodeXml(s: string): string {
	return s
		.replace(/&#x([0-9a-f]+);/gi, (_m, h: string) => String.fromCodePoint(Number.parseInt(h, 16)))
		.replace(/&#(\d+);/g, (_m, d: string) => String.fromCodePoint(Number.parseInt(d, 10)))
		.replace(/&quot;/g, '"')
		.replace(/&apos;/g, "'")
		.replace(/&lt;/g, "<")
		.replace(/&gt;/g, ">")
		.replace(/&amp;/g, "&");
}

/**
 * atom 的 <content type="html"> 里是转义过的 HTML。先去标签再解实体:
 * 反过来做的话,正文里字面量的 `&lt;div&gt;` 会先变成真的 `<div>`,
 * 再被去标签那一步吃掉 —— 作者写的那几个字就这么消失了,而底本少了字,
 * 引它的那条证据就锚不上。
 */
function htmlBody(raw: string): string {
	return decodeXml(
		raw
			.replace(/<\s*br\s*\/?\s*>/gi, "\n")
			.replace(/<\s*\/\s*(p|li|h\d|div)\s*>/gi, "\n")
			.replace(/<[^>]*>/g, " "),
	)
		.replace(/[ \t]+/g, " ")
		.replace(/\n{3,}/g, "\n\n")
		.trim();
}

/** 单条 release notes 截到多少字。整份 atom 已经在 github.ts 那层截过一道。 */
const BODY_MAX_CHARS = 2_000;

/**
 * 解析 releases.atom。**按 atom 里的顺序返回**(GitHub 给的是最新在前),
 * 调用方要按时间排就自己排 —— 这一层不替它决定时间线怎么走。
 *
 * 解析不出任何 entry 时返回空数组,不抛错:没有 release 的仓多得是,
 * 那是「时间线上少两个节点」,不是故障。
 */
export function parseReleasesAtom(xml: string): ChangelogEntry[] {
	const out: ChangelogEntry[] = [];
	const entries = xml.match(/<entry[\s\S]*?<\/entry>/gi) ?? [];
	for (const entry of entries) {
		const title = tagText(entry, "title").trim();
		const updated = tagText(entry, "updated").trim();
		// <link rel="alternate" type="text/html" href="https://github.com/..."/>
		const href = /<link[^>]*href="([^"]+)"/i.exec(entry);
		const rawBody = /<content(?:\s[^>]*)?>([\s\S]*?)<\/content>/i.exec(entry);
		if (!title && !updated) continue;
		out.push({
			title,
			updated,
			link: href ? decodeXml(href[1]!) : "",
			body: rawBody ? htmlBody(rawBody[1]!).slice(0, BODY_MAX_CHARS) : "",
		});
	}
	return out;
}

/**
 * 整份 changelog 的**锚定底本**。时间线上每个 release 节点的引文都要在这份
 * 文本里逐字对得上,所以它必须包含 title / updated / body 的原文。
 *
 * 拼装格式是固定的、代码写的:模型看到的和锚定用的是**同一份字符串**,
 * 中间没有第二次加工。这一条是整个锚定机制能成立的前提 —— 喂给模型一份、
 * 拿另一份去比对,判失败的原因就会和引文对不对完全无关。
 *
 * 顺带回每条 release 在这份文本里占的区间:锚定命中时拿到的是一个字符下标,
 * 而永久回链要的是**那一条** release 的 tag 链接。没有这张区间表,就只能给
 * 一个「这个仓的 releases 页」的粗链接,读者点开还得自己找是哪一条。
 */
export function changelogSource(entries: readonly ChangelogEntry[]): {
	text: string;
	/** 每条 release 在 text 里占的区间,以及它自己的永久回链(tag 链接不会漂)。 */
	ranges: { from: number; to: number; link: string; title: string }[];
} {
	const SEP = "\n\n---\n\n";
	let text = "";
	const ranges: { from: number; to: number; link: string; title: string }[] = [];
	for (const e of entries) {
		if (text) text += SEP;
		const from = text.length;
		text += [`## ${e.title}`, `updated: ${e.updated}`, e.link ? `link: ${e.link}` : "", "", e.body].filter(Boolean).join("\n");
		ranges.push({ from, to: text.length, link: e.link, title: e.title });
	}
	return { text, ranges };
}

/**
 * 一段引文落在哪一条 release 上 → 它的永久回链。找不到就回 `fallback`
 * (仓库的 releases 页):**宁可给一个粗一点但一定对的链接,也不要猜一条 tag**
 * ——猜错的链接点开是另一个版本的 notes,而它旁边挂着「逐字引文」四个字。
 */
export function changelogPermalink(
	ranges: readonly { from: number; to: number; link: string }[],
	startChar: number | undefined,
	fallback: string,
): string {
	if (startChar === undefined) return fallback;
	const hit = ranges.find((r) => startChar >= r.from && startChar < r.to);
	return hit?.link || fallback;
}
