// W5 · 编辑调用(docs/02 T3/T4):整篇正文一次调用出 T4 schema,不做
// 摘要链。128K context 一把梭:估算 token(字符 ÷ 2 粗算),超过预算就
// 诚实截断并在 meta.truncated 标注——复杂度不花在一年遇不到几次的输入上。
//
// meta 由代码填,不由模型填:path/truncated/title 是我们知道的事实,
// 让模型复述只会给幻觉开口子。

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
function polishResult(r: WatchResult): WatchResult {
	return {
		...r,
		verdict: { ...r.verdict, reason: normalizeCnStyle(r.verdict.reason) },
		keyPoints: r.keyPoints.map((kp) => ({ ...kp, point: normalizeCnStyle(kp.point) })),
		chapters: r.chapters.map((ch) => ({ ...ch, gist: normalizeCnStyle(ch.gist) })),
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

const EDIT_SYSTEM = `你是「长视频总结」的编辑:读者没时间看完这篇内容,你替他看完,产出判决、要点和分段地图。只输出一个 JSON 对象,不要输出任何其他文字。

输出 schema(字段名与类型必须完全一致):
{
  "verdict": { "worth": "yes|no|partial", "reason": "值不值得花时间读,一句话,说出判断依据" },
  "keyPoints": [ { "point": "要点", "quote": "支撑该要点的原文摘录", "start": 段号 } ],
  "chapters": [ { "start": 段号, "end": 段号, "gist": "这一段在讲什么,一句话", "value": "core|context|low" } ]
}

硬规则:
1. keyPoints 出 3~6 条。point 必须带具体的数字、名字、方法或结论——「讨论了 AI 的影响」这类说了跟没说一样的话禁止出现。
2. quote 必须从正文逐字摘录,30 字以内,一字不改、不加省略号、不拼接两处原文;start 填它所在的段号(正文里 [P3] 就填 3)。
3. chapters 按内容的自然转折切段:start/end 都是段号,首段从 1 开始、末段到最后一段,首尾相接、不重叠、无空洞。gist 一句话。广告、寒暄、重复啰嗦的车轱辘话标 "low";背景铺垫标 "context";核心内容标 "core"。
4. 只依据给你的正文判断,禁止外推或补充你自己知道的信息。
5. point/gist/reason 用简体中文;quote 保持原文语言不翻译。`;

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

const TRANSCRIPT_SYSTEM = `你是「长视频总结」的编辑:读者没时间看这条视频/播客,你替他看完,产出判决、要点和分段地图,方便他跳回原片只看值得看的部分。只输出一个 JSON 对象,不要输出任何其他文字。

输出 schema(字段名与类型必须完全一致,所有时间一律用秒的整数):
{
  "verdict": { "worth": "yes|no|partial", "reason": "值不值得花时间看,一句话,说出判断依据" },
  "keyPoints": [ { "point": "要点", "quote": "支撑该要点的转写原文摘录", "start": 秒 } ],
  "chapters": [ { "start": 秒, "end": 秒, "gist": "这一段在讲什么,一句话", "value": "core|context|low" } ]
}

硬规则:
1. keyPoints 出 3~6 条。point 必须带具体的数字、名字、方法或结论——「讨论了 AI 的影响」这类说了跟没说一样的话禁止出现。
2. quote 必须从转写文本逐字摘录,30 字以内,一字不改、不加省略号、不拼接两处;start 填它出现处的秒数(取所在 [t=秒] 标记)。
3. chapters 按内容的自然转折切段,每段约 2~10 分钟:第一段 start=0,最后一段 end=总时长,首尾相接、不重叠、无空洞。gist 一句话。片头寒暄、广告、抽奖、重复啰嗦标 "low";背景铺垫标 "context";核心内容标 "core"。
4. 只依据给你的转写判断,禁止外推或补充你自己知道的信息;转写可能有错字,引用时保持原样。
5. point/gist/reason 用简体中文;quote 保持原文语言不翻译。`;

/** 转写 → 一次编辑调用出 T4 schema。截断与 meta 规则同 editContent。 */
export async function editTranscript(cfg: AiConfig, input: TranscriptInput): Promise<WatchResult> {
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

	if (resolveProvider(cfg) === "mock") {
		const mock = mockWatchResult(input.path);
		mock.meta = { path: input.path, truncated, ...(input.title ? { title: input.title } : {}) };
		return mock;
	}

	const duration = Math.round(input.durationSec ?? segments[segments.length - 1].start);
	const lines = segments.map((s) => `[t=${Math.round(s.start)}] ${s.text.replace(/\s+/g, " ").trim()}`).join("\n");
	const prompt =
		(input.title ? `标题:${input.title}\n` : "") +
		`总时长约 ${duration} 秒。以下是带秒数标记的转写文本:\n\n${lines}`;

	const res = await complete(cfg, { system: TRANSCRIPT_SYSTEM, prompt, json: true, onDelta: input.onDelta });

	let parsed: unknown;
	try {
		parsed = JSON.parse(res.text);
	} catch {
		throw new EditError("模型没有返回合法 JSON");
	}
	(parsed as Record<string, unknown>).meta = {
		path: input.path,
		truncated,
		...(input.title ? { title: input.title } : {}),
	};
	const valid = validateWatchResult(parsed);
	if (!valid) throw new EditError("模型输出不符合 schema");
	return polishResult(valid);
}

/**
 * 一次编辑调用。mock 模式(没配 key)直接返回内置示例——调用方不用
 * 单独判断 provider。抛 EditError = 模型输出坏了(JSON 解析或 schema
 * 校验失败),调用方给 502,配额不退(docs/02 T6 的立场)。
 */
export async function editContent(cfg: AiConfig, input: EditInput): Promise<WatchResult> {
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

	if (resolveProvider(cfg) === "mock") {
		const mock = mockWatchResult(input.path);
		mock.meta = { path: input.path, truncated, ...(input.title ? { title: input.title } : {}) };
		return mock;
	}

	const numbered = paragraphs.map((p, i) => `[P${i + 1}] ${p}`).join("\n\n");
	const prompt =
		(input.title ? `标题:${input.title}\n` : "") +
		`正文共 ${paragraphs.length} 段,每段以 [P段号] 开头:\n\n${numbered}`;

	const res = await complete(cfg, { system: EDIT_SYSTEM, prompt, json: true, onDelta: input.onDelta });

	let parsed: unknown;
	try {
		parsed = JSON.parse(res.text);
	} catch {
		throw new EditError("模型没有返回合法 JSON");
	}
	// meta 由代码事实填写,模型给的一律丢弃
	(parsed as Record<string, unknown>).meta = {
		path: input.path,
		truncated,
		...(input.title ? { title: input.title } : {}),
	};
	const valid = validateWatchResult(parsed);
	if (!valid) throw new EditError("模型输出不符合 schema");
	return polishResult(valid);
}
