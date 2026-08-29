// W5 · 编辑调用(docs/02 T3/T4):整篇正文一次调用出 T4 schema,不做
// 摘要链。128K context 一把梭:估算 token(字符 ÷ 2 粗算),超过预算就
// 诚实截断并在 meta.truncated 标注——复杂度不花在一年遇不到几次的输入上。
//
// meta 由代码填,不由模型填:path/truncated/title 是我们知道的事实,
// 让模型复述只会给幻觉开口子。
//
// 2026-08-28(docs/05 §2.2 第 2 条)消息结构对调:**原文块当 system 消息,
// 指令当 user 消息**。原因是 DeepSeek 的上下文缓存按消息前缀命中——这一次
// 大纲调用之后还有 N 次逐章详写(notes.ts),它们共享同一个原文块作前缀,
// 命中价是未命中的 1/30。原文块必须逐字节相同,所以由 buildTextSource /
// buildTranscriptSource 唯一生成,调用方拿到的 source 原样传给 notes.ts。

import { complete, resolveProvider } from "./ai";
import type { AiConfig } from "./ai";
import { mockWatchResult, validateWatchResult } from "./schema";
import type { ExtractPath, WatchResult } from "./schema";
import { normalizeCnStyle } from "./style";

/**
 * 去 AI 味规整(001 同款 style.ts,一直复制着没接线):只动读者可见的
 * 编辑产出(判词/要点/段落大意)。quote 绝对不动——它必须与原文逐字一致,
 * 动了锚定校验(anchor.ts)就会把真引文误判成幻觉。
 */
export function polishResult(r: WatchResult): WatchResult {
	return {
		...r,
		verdict: { ...r.verdict, reason: normalizeCnStyle(r.verdict.reason) },
		...(r.overview
			? {
					overview: {
						summary: normalizeCnStyle(r.overview.summary),
						interesting: normalizeCnStyle(r.overview.interesting),
						counter: normalizeCnStyle(r.overview.counter),
					},
				}
			: {}),
		keyPoints: r.keyPoints.map((kp) => ({ ...kp, point: normalizeCnStyle(kp.point) })),
		chapters: r.chapters.map((ch) => ({ ...ch, gist: normalizeCnStyle(ch.gist) })),
		...(r.notes
			? {
					notes: r.notes.map((n) => ({
						...n,
						title: normalizeCnStyle(n.title),
						body: n.body.map(normalizeCnStyle),
						points: n.points.map((kp) => ({ ...kp, point: normalizeCnStyle(kp.point) })),
					})),
				}
			: {}),
	};
}

/** ≈100K token 的字符预算(中文约 2 字符/token,docs/02 T3)。 */
export const MAX_INPUT_CHARS = 200_000;

export class EditError extends Error {}

export interface EditInput {
	title?: string;
	paragraphs: string[];
	path: ExtractPath;
	/** 生成进度回调(透传给 ai.ts;快车道 SSE 用)。 */
	onDelta?: (textDelta: string) => void;
}

/** 大纲调用与逐章详写共用的 schema 片段说明(术语表)。 */
const TERMS_RULE = `7. terms 是术语表:这篇内容里反复出现、读者可能不熟或作者有特定用法的名词(产品名、方法名、缩写、行话),每条给一句本文语境下的定义;3~12 条,没有就给空数组。后续按章展开笔记时会沿用这套名词,所以定义要以正文用法为准。`;

const EDIT_INSTRUCTIONS = `你是「长视频总结」的编辑:读者没时间看完上面这篇内容(system 消息里的正文,每段以 [P段号] 开头),你替他看完,产出判决、要点和分段地图。只输出一个 JSON 对象,不要输出任何其他文字。

输出 schema(字段名与类型必须完全一致):
{
  "verdict": { "worth": "yes|no|partial", "reason": "值不值得花时间读,一句话,说出判断依据" },
  "overview": { "summary": "整篇在讲什么,3~5 句连贯概述", "interesting": "最有意思的一两处及为什么", "counter": "反着想:哪个论点可能站不住,另一面怎么解读" },
  "keyPoints": [ { "point": "要点", "quote": "支撑该要点的原文摘录", "start": 段号 } ],
  "chapters": [ { "start": 段号, "end": 段号, "gist": "这一段在讲什么,一句话", "value": "core|context|low" } ],
  "terms": [ { "term": "术语", "definition": "本文语境下的一句话定义" } ]
}

硬规则:
1. overview.summary 要连贯像一段完整叙述,读完等于听了一遍主线——长度以讲清主线为准,信息密的正文宁可写长,不为凑短丢论点;不是要点罗列。interesting 指出最出人意料或最值得停下来想的地方及为什么;counter 是你的批判视角——针对正文里的**具体论点**指出可能站不住的地方或另一面的解读,必须落在正文说过的内容上,不引入外部事实;实在没有可质疑之处就写「这篇立论平实,没有明显可反驳处」之类的诚实判断,禁止硬凑。
2. keyPoints 条数由正文信息量决定,至少 3 条,信息密的长文可以多出,但每条都必须独立成立,禁止为凑数拆分或注水。point 要把这个观点本身讲清楚——它主张什么、依据或结论是什么,带具体的数字、名字、方法;「讨论了 AI 的影响」这类只报话题不给内容的话禁止出现。
3. quote 必须从正文逐字摘录,30 字以内,一字不改、不加省略号、不拼接两处原文;start 填它所在的段号(正文里 [P3] 就填 3)。
4. chapters 按内容的自然转折切段:start/end 都是段号,首段从 1 开始、末段到最后一段,首尾相接、不重叠、无空洞。core 段的 gist 要讲清这段的论点和结论,可以写两三句,不要只给一个话题标签;context/low 段一句带过即可。广告、寒暄、重复啰嗦的车轱辘话标 "low";背景铺垫标 "context";核心内容标 "core"。
5. 除引用外只依据给你的正文判断,禁止补充你自己知道的外部信息。
6. point/gist/reason/overview 用简体中文;quote 保持原文语言不翻译。
${TERMS_RULE}`;

const TRANSCRIPT_INSTRUCTIONS = `你是「长视频总结」的编辑:读者没时间看上面这条视频/播客(system 消息里带秒数标记的转写文本),你替他看完,产出判决、要点和分段地图,方便他跳回原片只看值得看的部分。只输出一个 JSON 对象,不要输出任何其他文字。

输出 schema(字段名与类型必须完全一致,所有时间一律用秒的整数):
{
  "verdict": { "worth": "yes|no|partial", "reason": "值不值得花时间看,一句话,说出判断依据" },
  "overview": { "summary": "整条内容在讲什么,3~5 句连贯概述", "interesting": "最有意思的一两处及为什么", "counter": "反着想:哪个论点可能站不住,另一面怎么解读" },
  "keyPoints": [ { "point": "要点", "quote": "支撑该要点的转写原文摘录", "start": 秒 } ],
  "chapters": [ { "start": 秒, "end": 秒, "gist": "这一段在讲什么,一句话", "value": "core|context|low" } ],
  "terms": [ { "term": "术语", "definition": "本内容语境下的一句话定义" } ]
}

硬规则:
1. overview.summary 要连贯像一段完整叙述,读完等于把主线听了一遍——长度以讲清主线为准,一小时的信息密内容宁可写长,不为凑短丢论点;不是要点罗列。interesting 指出最出人意料或最值得停下来想的地方及为什么;counter 是你的批判视角——针对内容里的**具体论点**指出可能站不住的地方或另一面的解读(例如嘉宾立场带来的偏向、论据的外推前提),必须落在说过的内容上,不引入外部事实;实在没有就诚实写没有,禁止硬凑。
2. keyPoints 条数由内容信息量决定,至少 3 条,一小时的信息密内容可以多出,但每条都必须独立成立,禁止为凑数拆分或注水。point 要把这个观点本身讲清楚——它主张什么、依据或结论是什么,带具体的数字、名字、方法;「讨论了 AI 的影响」这类只报话题不给内容的话禁止出现。
3. quote 必须从转写文本逐字摘录,30 字以内,一字不改、不加省略号、不拼接两处;start 填它出现处的秒数(取所在 [t=秒] 标记)。
4. chapters 按内容的自然转折切段,每段约 2~10 分钟:第一段 start=0,最后一段 end=总时长,首尾相接、不重叠、无空洞。core 段的 gist 要讲清这段的论点和结论,可以写两三句,不要只给一个话题标签;context/low 段一句带过即可。片头寒暄、广告、抽奖、重复啰嗦标 "low";背景铺垫标 "context";核心内容标 "core"。
5. 除引用外只依据给你的转写判断,禁止补充你自己知道的外部信息;转写可能有错字,引用时保持原样。
6. point/gist/reason/overview 用简体中文;quote 保持原文语言不翻译。
${TERMS_RULE}`;

// ---------- 原文块(system 消息;大纲与逐章详写共用同一份,docs/05 §2.2) ----------

/** 文章/粘贴:每段以 [P段号] 开头。 */
export function buildTextSource(paragraphs: string[], title?: string): string {
	const numbered = paragraphs.map((p, i) => `[P${i + 1}] ${p}`).join("\n\n");
	return (title ? `标题:${title}\n` : "") + `正文共 ${paragraphs.length} 段,每段以 [P段号] 开头:\n\n${numbered}`;
}

/** 视频/播客:每行以 [t=秒] 开头。 */
export function buildTranscriptSource(segments: TranscriptSegment[], durationSec: number, title?: string): string {
	const lines = segments.map((s) => `[t=${Math.round(s.start)}] ${s.text.replace(/\s+/g, " ").trim()}`).join("\n");
	return (title ? `标题:${title}\n` : "") + `总时长约 ${durationSec} 秒。以下是带秒数标记的转写文本:\n\n${lines}`;
}

function parseResult(text: string, meta: WatchResult["meta"]): WatchResult {
	let parsed: unknown;
	try {
		parsed = JSON.parse(text);
	} catch {
		throw new EditError("模型没有返回合法 JSON");
	}
	// meta 由代码事实填写,模型给的一律丢弃
	(parsed as Record<string, unknown>).meta = meta;
	const valid = validateWatchResult(parsed);
	if (!valid) throw new EditError("模型输出不符合 schema");
	return polishResult(valid);
}

// ---------- 文章/粘贴(快车道) ----------

export interface EditedText {
	result: WatchResult;
	/** 实际喂给模型的段落(按预算截断后)。 */
	paragraphs: string[];
	/** 原文块;逐章详写要原样复用它才能命中缓存。 */
	source: string;
}

/**
 * 一次编辑调用。mock 模式(没配 key)直接返回内置示例——调用方不用
 * 单独判断 provider。抛 EditError = 模型输出坏了(JSON 解析或 schema
 * 校验失败),调用方给 502,配额不退(docs/02 T6 的立场)。
 */
export async function editContentWithSource(cfg: AiConfig, input: EditInput): Promise<EditedText> {
	// 截断到字符预算:按段落边界截,不切半句
	const paragraphs: string[] = [];
	let chars = 0;
	let truncated = false;
	for (const p of input.paragraphs) {
		if (chars + p.length > MAX_INPUT_CHARS) {
			truncated = true;
			break;
		}
		paragraphs.push(p);
		chars += p.length;
	}
	if (paragraphs.length === 0) throw new EditError("正文是空的");
	const source = buildTextSource(paragraphs, input.title);
	const meta = { path: input.path, truncated, ...(input.title ? { title: input.title } : {}) };

	if (resolveProvider(cfg) === "mock") {
		const mock = mockWatchResult(input.path);
		mock.meta = meta;
		return { result: mock, paragraphs, source };
	}

	const res = await complete(cfg, { system: source, prompt: EDIT_INSTRUCTIONS, json: true, onDelta: input.onDelta });
	return { result: parseResult(res.text, meta), paragraphs, source };
}

export async function editContent(cfg: AiConfig, input: EditInput): Promise<WatchResult> {
	return (await editContentWithSource(cfg, input)).result;
}

// ---------- 视频/播客转写变体(慢车道消费者用,docs/03 C 线) ----------

export interface TranscriptSegment {
	/** 秒。 */
	start: number;
	text: string;
}

export interface TranscriptInput {
	title?: string;
	segments: TranscriptSegment[];
	path: "subtitle" | "whisper";
	/** 总时长(秒);没有就取最后一段的 start 兜底。 */
	durationSec?: number;
	onDelta?: (textDelta: string) => void;
}

export interface EditedTranscript {
	result: WatchResult;
	/** 实际喂给模型的转写段(按预算截断后)。 */
	segments: TranscriptSegment[];
	durationSec: number;
	source: string;
}

/** 转写 → 一次编辑调用出 T4 schema。截断与 meta 规则同 editContent。 */
export async function editTranscriptWithSource(cfg: AiConfig, input: TranscriptInput): Promise<EditedTranscript> {
	const segments: TranscriptSegment[] = [];
	let chars = 0;
	let truncated = false;
	for (const s of input.segments) {
		if (chars + s.text.length > MAX_INPUT_CHARS) {
			truncated = true;
			break;
		}
		segments.push(s);
		chars += s.text.length;
	}
	if (segments.length === 0) throw new EditError("转写是空的");
	const durationSec = Math.round(input.durationSec ?? segments[segments.length - 1].start);
	const source = buildTranscriptSource(segments, durationSec, input.title);
	const meta = { path: input.path, truncated, ...(input.title ? { title: input.title } : {}) };

	if (resolveProvider(cfg) === "mock") {
		const mock = mockWatchResult(input.path);
		mock.meta = meta;
		return { result: mock, segments, durationSec, source };
	}

	const res = await complete(cfg, { system: source, prompt: TRANSCRIPT_INSTRUCTIONS, json: true, onDelta: input.onDelta });
	return { result: parseResult(res.text, meta), segments, durationSec, source };
}

export async function editTranscript(cfg: AiConfig, input: TranscriptInput): Promise<WatchResult> {
	return (await editTranscriptWithSource(cfg, input)).result;
}
