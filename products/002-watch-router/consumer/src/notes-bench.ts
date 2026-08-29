// 详细笔记的本地基准(docs/05 实施计划 A2 的验证工具):不经 Worker/Lambda,
// 直接对一份段落或转写 JSON 跑「大纲 → 逐章详写 → 补漏」,打印每步耗时、
// DeepSeek 用量(缓存命中)与产出统计。
//
// 用法(在产品目录):
//   npm run build:consumer   # 顺带打出 consumer/dist/notes-bench.mjs
//   node consumer/dist/notes-bench.mjs paragraphs.json   # {"title":..., "paragraphs":[...]}
//   node consumer/dist/notes-bench.mjs transcript.json   # {"title":..., "durationSec":..., "segments":[{start,text}]}
// 环境变量:DEEPSEEK_API_KEY(必需),可选 AI_MODEL / FAST_AI_MODEL / AI_MAX_OUTPUT_TOKENS。

import { readFile, writeFile } from "node:fs/promises";
import { fastVariant } from "../../src/shared/ai";
import { anchorKeyPoints } from "../../src/shared/anchor";
import { editContentWithSource, editTranscriptWithSource } from "../../src/shared/editor";
import { buildNotes } from "../../src/shared/notes";
import type { WatchResult } from "../../src/shared/schema";
import { parseVtt } from "./pipeline";

const file = process.argv[2];
if (!file) throw new Error("usage: notes-bench.mjs <input.json>");
const ai = {
	provider: "deepseek",
	model: process.env.AI_MODEL ?? "deepseek-v4-pro",
	maxOutputTokens: process.env.AI_MAX_OUTPUT_TOKENS ?? "16384",
	deepseekApiKey: process.env.DEEPSEEK_API_KEY,
};
const fast = fastVariant(ai, { model: process.env.FAST_AI_MODEL });
const input = (
	file.endsWith(".vtt")
		? { title: process.env.BENCH_TITLE, segments: parseVtt(await readFile(file, "utf8")), durationSec: Number(process.env.BENCH_DURATION) || undefined }
		: JSON.parse(await readFile(file, "utf8"))
) as {
	title?: string;
	paragraphs?: string[];
	segments?: { start: number; text: string }[];
	durationSec?: number;
};

const t0 = Date.now();
const lap = (label: string) => console.log(`[${((Date.now() - t0) / 1000).toFixed(1)}s] ${label}`);
let result: WatchResult;
if (input.segments) {
	const edited = await editTranscriptWithSource(ai, { title: input.title, segments: input.segments, path: "subtitle", durationSec: input.durationSec });
	lap(`outline done: chapters=${edited.result.chapters.length} keyPoints=${edited.result.keyPoints.length} terms=${edited.result.terms?.length ?? 0}`);
	result = anchorKeyPoints(edited.result, input.segments.map((s) => s.text).join("\n"));
	result = await buildNotes(ai, fast, {
		kind: "transcript",
		source: edited.source,
		result,
		segments: edited.segments,
		durationSec: edited.durationSec,
		onChapter: (d, n) => lap(`chapter ${d}/${n}`),
	});
} else {
	const edited = await editContentWithSource(ai, { title: input.title, paragraphs: input.paragraphs ?? [], path: "article" });
	lap(`outline done: chapters=${edited.result.chapters.length} keyPoints=${edited.result.keyPoints.length} terms=${edited.result.terms?.length ?? 0}`);
	result = anchorKeyPoints(edited.result, edited.paragraphs.join("\n"));
	result = await buildNotes(ai, fast, {
		kind: "text",
		source: edited.source,
		result,
		paragraphs: edited.paragraphs,
		onChapter: (d, n) => lap(`chapter ${d}/${n}`),
	});
}
lap("notes done");
const out = file.replace(/\.(json|vtt)$/, "") + ".result.json";
await writeFile(out, JSON.stringify({ type: "result", result }), "utf8");
const chars = (result.notes ?? []).reduce((s, n) => s + n.body.reduce((t, p) => t + p.length, 0), 0);
const pts = (result.notes ?? []).flatMap((n) => n.points);
console.log(
	`notes chars=${chars} points=${pts.length} anchored=${pts.filter((p) => p.anchored).length} gaps=${result.meta.coverageGaps} failed=${(result.notes ?? []).filter((n) => n.failed).length} → ${out}`,
);
