// 详细笔记(docs/05 §2):大纲之后的「1 + N + 补漏」。
//
//   ① 大纲调用(editor.ts)已经给了 chapters/terms;这里按时长给每章算字数配额
//   ② 逐章详写:N 次调用并发 3,每次 system = 同一份原文块(命中 DeepSeek
//      前缀缓存)、user = 本章窗口 + 术语表 + 各章大意 + 字数目标;reasoning low
//   ③ 程序校验:每条要点的引文必须在**本章窗口**的原文里配得上(anchor.ts),
//      配不上标 anchored:false 灰显,不删
//   ④ 确定性拼装 notes[],不再让模型「汇总」——每汇总一层就薄一层
//   ⑤ 覆盖检查:每 5 分钟(文章:每 8 段)一窗,窗内没有任何带位置的要点、
//      又不在 low 章里 → 记一个空窗;空窗才用 flash 只看那一窗原文补要点
//
// 为什么详写输入的是原文不是上一层摘要:递归合并会放大幻觉,带原文才稳
// (Context-Aware Hierarchical Merging,docs/05 附录 A)。
// 为什么「各章大意」给的是大纲的 gist 而不是已写正文:并发下前面的章还没写完;
// 给正文也只会撑大前缀、诱导复述。防重复靠「只写本窗口 + 知道别的章在讲什么」。

import { complete, resolveProvider } from "./ai";
import type { AiConfig } from "./ai";
import { normalizeForAnchor } from "./anchor";
import type { TranscriptSegment } from "./editor";
import type { WatchChapter, WatchKeyPoint, WatchNoteChapter, WatchResult } from "./schema";
import { normalizeCnStyle } from "./style";

/** 每分钟配多少字(docs/05 §2.1)。 */
const CHARS_PER_MINUTE = 70;
const MIN_CHAPTER_CHARS = 200;
const MAX_CHAPTER_CHARS = 1200;
/** 文章的配额:不超过该章原文字数的这个比例(笔记不该比原文长)。 */
const TEXT_RATIO = 0.6;
/** 覆盖窗口:转写 5 分钟;文章 8 段。 */
const WINDOW_SEC = 300;
const WINDOW_PARAS = 8;
/** 单次任务最多补几个空窗(防长视频把空窗补成第二份大纲)。 */
const MAX_FILLS = 4;
// 只在 Node(消费者/基准)里读环境变量做对照实验;Worker 里没有 process 就用默认
const nodeEnv = (globalThis as { process?: { env?: Record<string, string | undefined> } }).process?.env ?? {};
/**
 * 详写并发与思考力度(2026-08-28 Karpathy 1h 对照实验,consumer/src/notes-bench.ts):
 *   low  × 并发 3:575s,7.3K 字,要点锚定 49/60(82%),数字准确(「700 亿参数」)
 *   none × 并发 4:284s,8.5K 字,要点锚定 52/75(69%),出现「70 亿参数」这类数字错
 * 关 thinking 省一半时间但引文保真和数字准确都掉——质量优先,留 low,用并发换时间。
 * 每章 completion 含 1.3K–8.4K thinking token,一小时视频约 $0.15–0.2(可接受)。
 */
const CONCURRENCY = Number(nodeEnv.NOTES_CONCURRENCY) || 6;
const CHAPTER_REASONING = (nodeEnv.NOTES_REASONING as "none" | "low" | undefined) ?? "low";

export type NotesKind = "transcript" | "text";

export interface NotesInput {
	kind: NotesKind;
	/** 大纲调用用过的原文块,逐字节相同才命中缓存。 */
	source: string;
	result: WatchResult;
	/** kind=transcript 时给;要点锚定与覆盖检查按它切窗口。 */
	segments?: TranscriptSegment[];
	durationSec?: number;
	/** kind=text 时给(按预算截断后的那份)。 */
	paragraphs?: string[];
	/** 每章完成时回调(慢车道拿它刷新任务 updatedAt,快车道推 SSE)。 */
	onChapter?: (done: number, total: number) => void | Promise<void>;
}

/** 每章字数配额:由代码按时长/篇幅算,不让模型定。 */
export function assignTargetChars(chapters: WatchChapter[], input: Pick<NotesInput, "kind" | "paragraphs">): WatchChapter[] {
	return chapters.map((ch) => {
		if (ch.value === "low") return { ...ch, targetChars: 0 };
		let target: number;
		if (input.kind === "transcript") {
			target = Math.round(((ch.end - ch.start) / 60) * CHARS_PER_MINUTE);
		} else {
			const paras = input.paragraphs ?? [];
			// 段号从 1 起,end 含
			const chars = paras.slice(Math.max(0, ch.start - 1), ch.end).reduce((s, p) => s + p.length, 0);
			target = Math.round(chars * TEXT_RATIO);
		}
		return { ...ch, targetChars: Math.min(MAX_CHAPTER_CHARS, Math.max(MIN_CHAPTER_CHARS, target)) };
	});
}

/** 本章窗口内的原文(锚定与补漏都只看它)。 */
function windowText(input: NotesInput, start: number, end: number): string {
	if (input.kind === "transcript") {
		return (input.segments ?? [])
			.filter((s) => s.start >= start && s.start < end)
			.map((s) => s.text)
			.join("\n");
	}
	return (input.paragraphs ?? []).slice(Math.max(0, start - 1), end).join("\n");
}

function anchorWithin(points: WatchKeyPoint[], text: string): WatchKeyPoint[] {
	const hay = normalizeForAnchor(text);
	return points.map((kp) => {
		const needle = normalizeForAnchor(kp.quote);
		return { ...kp, anchored: needle.length >= 4 && hay.includes(needle) };
	});
}

function parsePoints(list: unknown): WatchKeyPoint[] {
	if (!Array.isArray(list)) return [];
	const out: WatchKeyPoint[] = [];
	for (const p of list) {
		const k = p as Record<string, unknown>;
		if (typeof k?.point !== "string" || typeof k?.quote !== "string") continue;
		out.push({ point: k.point, quote: k.quote, ...(typeof k.start === "number" ? { start: k.start } : {}) });
	}
	return out;
}

const CHAPTER_INSTRUCTIONS = (input: NotesInput, ch: WatchChapter, index: number) => {
	const r = input.result;
	const unit = input.kind === "transcript" ? "秒" : "段号";
	const pos = input.kind === "transcript" ? "[t=秒] 标记" : "[P段号] 标记";
	const others = r.chapters
		.map((c, i) => `${i === index ? "▶ " : "  "}${i + 1}. [${c.start}–${c.end}] ${c.gist}`)
		.join("\n");
	const terms = (r.terms ?? []).map((t) => `- ${t.term}:${t.definition}`).join("\n");
	return `你是「长视频总结」的编辑,正在把 system 消息里的内容按章写成详细笔记。读者已经决定不看原片、只读你的笔记,所以**这一章里说过的具体论点、依据、数字、例子、步骤,一个都不能漏**;篇幅可以长,但不许注水。只输出一个 JSON 对象。

现在只写第 ${index + 1} 章,窗口 [${ch.start}–${ch.end}](${unit});大纲对它的概括:「${ch.gist}」。
全部章节(▶ 是本章;其他章的内容别在这里展开,知道它们讲什么只是为了不重复):
${others}
${terms ? `\n术语表(全篇统一用这套名词和定义):\n${terms}\n` : ""}
输出 schema:
{
  "title": "这一章的标题,一句话点出论点,不是话题标签",
  "body": ["正文段落 1", "正文段落 2", "..."],
  "points": [ { "point": "要点", "quote": "支撑它的原文逐字摘录", "start": ${unit} } ]
}

硬规则:
1. 只写窗口 [${ch.start}–${ch.end}] 内说过的内容;窗口外的内容一个字都不要写进来,哪怕它更重要。
2. body 是连贯的叙述性段落,3~8 段,按内容顺序展开:作者/嘉宾主张什么、怎么论证、给了什么数字或例子、结论是什么;有反方或转折也写出来。目标约 ${ch.targetChars ?? MIN_CHAPTER_CHARS} 字——**这是上限式的目标,内容不够就提前结束,禁止为凑字数复述、空泛总结或加「总之」式的套话**。
3. points 是这一章的要点,每 5 分钟(文章每 8 段)至少 1 条,每条必须独立成立;quote 必须从本窗口原文逐字摘录,30 字以内,一字不改、不加省略号、不拼接;start 填它所在的${pos}的值。
4. 只依据原文,禁止补充外部信息;转写有错字时引用保持原样。
5. title/body/point 用简体中文;quote 保持原文语言;像在继续同一篇笔记,不要写开场白或结束语。`;
};

const FILL_INSTRUCTIONS = (kind: NotesKind, start: number, end: number) =>
	`下面是一段内容的原文片段(${kind === "transcript" ? "带 [t=秒] 标记的转写" : "带 [P段号] 标记的正文"},范围 [${start}–${end}])。笔记里这一段还没有任何要点,请从中提取 1~3 条要点。只输出 JSON:
{ "points": [ { "point": "要点(讲清主张/依据/结论,带具体数字或例子)", "quote": "原文逐字摘录,30 字以内", "start": ${kind === "transcript" ? "秒" : "段号"} } ] }
如果这一段真的只有寒暄、广告或车轱辘话,返回 { "points": [] }。只依据给出的片段,禁止补充外部信息;point 用简体中文,quote 保持原文语言。`;

async function pool<T>(items: T[], n: number, fn: (item: T, i: number) => Promise<void>): Promise<void> {
	let next = 0;
	const workers = Array.from({ length: Math.min(n, items.length) }, async () => {
		for (;;) {
			const i = next++;
			if (i >= items.length) return;
			await fn(items[i], i);
		}
	});
	await Promise.all(workers);
}

async function writeChapter(cfg: AiConfig, input: NotesInput, ch: WatchChapter, index: number): Promise<WatchNoteChapter> {
	const basePrompt = CHAPTER_INSTRUCTIONS(input, ch, index);
	let lastErr: unknown;
	let draft: WatchNoteChapter | null = null;
	for (let attempt = 0; attempt < 2; attempt++) {
		// 实测(英文长文 1/18 章):模型把 quote 翻成了中文,整章要点全部锚定失败。
		// 第二次带上这句纠正再要一次;还不行就带着未锚定的要点交付(灰显),不丢正文
		const prompt =
			attempt === 0 || !draft
				? basePrompt
				: `${basePrompt}

上一次你给的 quote 全部没能在原文里逐字找到(很可能被翻译或改写了)。quote 必须是原文语言的逐字摘录,连标点都不改;请重新输出整个 JSON。`;
		try {
			const res = await complete(cfg, { system: input.source, prompt, json: true, reasoning: CHAPTER_REASONING });
			const parsed = JSON.parse(res.text) as Record<string, unknown>;
			const body = Array.isArray(parsed.body) ? (parsed.body as unknown[]).filter((p): p is string => typeof p === "string" && p.trim().length > 0) : [];
			const title = typeof parsed.title === "string" && parsed.title.trim() ? parsed.title.trim() : ch.gist;
			if (body.length === 0) throw new Error("empty body");
			const points = anchorWithin(parsePoints(parsed.points), windowText(input, ch.start, ch.end));
			const note: WatchNoteChapter = {
				chapter: index,
				title: normalizeCnStyle(title),
				body: body.map(normalizeCnStyle),
				points: points.map((kp) => ({ ...kp, point: normalizeCnStyle(kp.point) })),
			};
			if (points.length >= 2 && points.every((kp) => !kp.anchored) && attempt === 0) {
				draft = note;
				continue;
			}
			return note;
		} catch (err) {
			lastErr = err;
		}
	}
	if (draft) return draft;
	console.error(`chapter ${index + 1} notes failed twice: ${(lastErr as Error)?.message?.slice(0, 200)}`);
	return { chapter: index, title: ch.gist, body: [], points: [], failed: true };
}

/** 覆盖窗口:[start, end) 列表,按内容单位。 */
function coverageWindows(input: NotesInput): { start: number; end: number }[] {
	const out: { start: number; end: number }[] = [];
	if (input.kind === "transcript") {
		const total = input.durationSec ?? Math.max(0, ...(input.segments ?? []).map((s) => s.start));
		for (let t = 0; t < total; t += WINDOW_SEC) out.push({ start: t, end: Math.min(total, t + WINDOW_SEC) });
	} else {
		const n = input.paragraphs?.length ?? 0;
		// 文章窗口 end 含(与 chapters 的段号语义一致);转写窗口 end 不含
		for (let p = 1; p <= n; p += WINDOW_PARAS) out.push({ start: p, end: Math.min(n, p + WINDOW_PARAS - 1) });
	}
	return out;
}

/** 这一窗是否整个落在 low 章里(寒暄广告不算空窗)。 */
function insideLow(chapters: WatchChapter[], w: { start: number; end: number }): boolean {
	return chapters.some((c) => c.value === "low" && c.start <= w.start && c.end >= w.end);
}

function chapterIndexAt(chapters: WatchChapter[], pos: number): number {
	const i = chapters.findIndex((c) => pos >= c.start && pos < c.end);
	return i >= 0 ? i : chapters.length - 1;
}

/**
 * 大纲 → 详细笔记。失败语义:单章失败标 failed 不拖垮整份;补漏失败静默跳过。
 * 返回带 notes/terms/targetChars/coverageGaps 的新 result。
 */
export async function buildNotes(cfg: AiConfig, fastCfg: AiConfig, input: NotesInput): Promise<WatchResult> {
	const chapters = assignTargetChars(input.result.chapters, input);
	const withTargets: WatchResult = { ...input.result, chapters };
	if (resolveProvider(cfg) === "mock") {
		// mock 大纲已自带 notes(schema.ts);这里只补配额字段
		return withTargets;
	}
	const src = { ...input, result: withTargets };

	// ② 逐章详写(low 章不写)
	const notes: WatchNoteChapter[] = chapters.map((ch, i) => ({ chapter: i, title: ch.gist, body: [], points: [] }));
	const todo = chapters.map((ch, i) => ({ ch, i })).filter((x) => x.ch.value !== "low");
	let done = 0;
	await pool(todo, CONCURRENCY, async ({ ch, i }) => {
		notes[i] = await writeChapter(cfg, src, ch, i);
		done++;
		await input.onChapter?.(done, todo.length);
	});

	// ⑤ 覆盖检查 + 补漏
	const positioned = [...withTargets.keyPoints, ...notes.flatMap((n) => n.points)]
		.filter((kp) => typeof kp.start === "number")
		.map((kp) => kp.start as number);
	const inWindow = (p: number, w: { start: number; end: number }) =>
		p >= w.start && (src.kind === "text" ? p <= w.end : p < w.end);
	const gaps = coverageWindows(src).filter((w) => !insideLow(chapters, w) && !positioned.some((p) => inWindow(p, w)));
	let filled = 0;
	for (const w of gaps.slice(0, MAX_FILLS)) {
		const text = windowText(src, w.start, w.end);
		if (text.trim().length < 40) continue;
		try {
			const snippet =
				src.kind === "transcript"
					? (src.segments ?? [])
							.filter((s) => s.start >= w.start && s.start < w.end)
							.map((s) => `[t=${Math.round(s.start)}] ${s.text}`)
							.join("\n")
					: (src.paragraphs ?? [])
							.slice(w.start - 1, w.end)
							.map((p, k) => `[P${w.start + k}] ${p}`)
							.join("\n\n");
			const res = await complete(fastCfg, { system: snippet, prompt: FILL_INSTRUCTIONS(src.kind, w.start, w.end), json: true, reasoning: "low" });
			const pts = anchorWithin(parsePoints((JSON.parse(res.text) as Record<string, unknown>).points), text)
				.filter((kp) => kp.anchored)
				.map((kp) => ({ ...kp, point: normalizeCnStyle(kp.point) }));
			if (pts.length === 0) continue;
			const idx = chapterIndexAt(chapters, w.start);
			notes[idx] = { ...notes[idx], points: [...notes[idx].points, ...pts], filled: true };
			filled++;
		} catch (err) {
			console.error(`coverage fill [${w.start}-${w.end}] failed: ${(err as Error).message.slice(0, 160)}`);
		}
	}
	console.log(`notes: chapters=${todo.length} failed=${notes.filter((n) => n.failed).length} gaps=${gaps.length} filled=${filled}`);

	return {
		...withTargets,
		notes,
		meta: { ...withTargets.meta, coverageGaps: gaps.length },
	};
}
