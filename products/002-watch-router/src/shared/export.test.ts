// 想法导出(export.ts)。这里验的是三条**错了就悄悄骗人**的规则:
//   ① 版本对不上的定点想法绝不挂 context(挂错等于给下游模型编一段假出处)
//   ② 结果缓存过期照样导想法(想法是长期资产,不能因为 context 没了就不给)
//   ③ 未锚定的引文要带着「待核」的标注一起出去,不能洗成一句干净的引用
import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { buildNotesExport, exportFileName } from "./export.ts";
import type { ExportItem } from "./export.ts";
import type { WatchResult } from "./schema.ts";

const TZ = { now: Date.UTC(2026, 8, 1, 14, 33), timeZone: "UTC" };

function result(over: Partial<WatchResult> = {}): WatchResult {
	return {
		verdict: { worth: "partial", reason: "前 20 分钟值得听。" },
		overview: { summary: "整体在讲成本。", interesting: "抽样评测那段。", counter: "前提是算力不收紧。" },
		keyPoints: [
			{ point: "成本一年降十倍。", quote: "成本一年降了十倍", start: 312, anchored: true },
			{ point: "护城河只剩数据与分发。", quote: "只剩数据和分发", start: 640, anchored: false },
		],
		chapters: [
			{ start: 0, end: 180, gist: "开场", value: "low" },
			{ start: 180, end: 1500, gist: "核心论点", value: "core" },
		],
		meta: { path: "subtitle", truncated: false, title: "模型成本的下一站" },
		...over,
	};
}

/** 一条内容 + 一条挂在要点 1 上的想法,版本戳对得上。 */
function item(over: Partial<ExportItem> = {}): ExportItem {
	return {
		contentKey: "c1",
		url: "https://youtu.be/abc",
		title: "模型成本的下一站",
		result: result(),
		resultAt: 1000,
		entries: [{ at: Date.UTC(2026, 7, 30, 21, 14), target: "kp:0", text: "这个数字可以当开头。", resultAt: 1000 }],
		...over,
	};
}

describe("buildNotesExport · 单条内容", () => {
	it("标题进 H1,想法带上它锚定的那条要点与逐字引文", () => {
		const md = buildNotesExport([item()], TZ);
		assert.match(md, /^# 想法导出 · 模型成本的下一站\n/);
		assert.ok(md.includes("原文:https://youtu.be/abc"), "要带原链接");
		assert.ok(md.includes("判决:部分值得 —— 前 20 分钟值得听。"), "要带判决");
		assert.ok(md.includes("这条内容讲了什么"), "要带导读");
		assert.ok(md.includes("挂在「要点 1」"), "锚点标签按人读序号从 1 起");
		assert.ok(md.includes("> 要点:成本一年降十倍。"), "要带那条要点原文");
		assert.ok(md.includes("> 引文「成本一年降了十倍」 · 5:12"), "引文带时间戳");
		assert.ok(md.includes("这个数字可以当开头。"), "我写的字一字不动");
		assert.ok(md.includes("2026-08-30 21:14"), "想法带写下的时刻");
	});

	it("按写下的先后排,不按锚点序", () => {
		const md = buildNotesExport(
			[
				item({
					entries: [
						{ at: 200, target: "kp:1", text: "后写的。", resultAt: 1000 },
						{ at: 100, target: "kp:0", text: "先写的。", resultAt: 1000 },
					],
				}),
			],
			TZ,
		);
		assert.ok(md.indexOf("先写的。") < md.indexOf("后写的。"));
	});

	it("未锚定的引文带着待核标注一起出去", () => {
		const md = buildNotesExport([item({ entries: [{ at: 100, target: "kp:1", text: "记一笔。", resultAt: 1000 }] })], TZ);
		assert.ok(md.includes("未锚定"), "引文没对上就要说出来");
	});

	it("文章类内容的位置印段号不印时分", () => {
		const r = result({ meta: { path: "article", truncated: false, title: "一篇长文" } });
		const md = buildNotesExport([item({ result: r })], TZ);
		assert.ok(md.includes("§312"), "文章的 start 是段号");
		assert.ok(!md.includes("5:12"));
	});

	it("挂在分段上的想法带那一段的标题与范围;有详细笔记时用笔记的章标题", () => {
		const r = result({ notes: [{ chapter: 1, title: "成本降十倍之后", body: ["正文"], points: [] }] });
		const md = buildNotesExport([item({ result: r, entries: [{ at: 100, target: "ch:1", text: "记一笔。", resultAt: 1000 }] })], TZ);
		assert.ok(md.includes("> 第 2 段 3:00–25:00:成本降十倍之后"));
	});
});

describe("buildNotesExport · 挂不住的 context", () => {
	it("版本对不上的定点想法只留标注,绝不挂一段错的原文", () => {
		const md = buildNotesExport([item({ entries: [{ at: 100, target: "kp:0", text: "上一版记的。", resultAt: 999 }] })], TZ);
		assert.ok(md.includes("记于上一版结果,序号已对不上"));
		assert.ok(!md.includes("> 要点:"), "对不上就一条要点原文都不能带");
		assert.ok(md.includes("上一版记的。"), "想法本身照导");
	});

	it("存量想法没有版本戳,而结果有:同样按对不上处理", () => {
		const md = buildNotesExport([item({ entries: [{ at: 100, target: "kp:0", text: "老条目。" }] })], TZ);
		assert.ok(md.includes("记于上一版结果,序号已对不上"));
	});

	it("结果本身没有版本戳(旧缓存/mock)时不做甄别,照挂 context", () => {
		const md = buildNotesExport([item({ resultAt: undefined, entries: [{ at: 100, target: "kp:0", text: "老结果。" }] })], TZ);
		assert.ok(md.includes("> 要点:成本一年降十倍。"));
	});

	it("那条要点已经不在这一版里:只留标注", () => {
		const md = buildNotesExport([item({ entries: [{ at: 100, target: "kp:9", text: "越界。", resultAt: 1000 }] })], TZ);
		assert.ok(md.includes("记于上一版结果,序号已对不上"));
		assert.ok(md.includes("越界。"));
	});

	it("结果缓存过期:想法照导,并写明 context 没了", () => {
		const md = buildNotesExport([item({ result: null, resultAt: undefined })], TZ);
		assert.ok(md.includes("结果缓存已过期"));
		assert.ok(md.includes("这个数字可以当开头。"));
		assert.ok(!md.includes("判决:"));
	});

	it("整体想法不硬凑 context", () => {
		const md = buildNotesExport([item({ entries: [{ at: 100, target: "general", text: "整体感想。" }] })], TZ);
		assert.ok(md.includes("挂在「整体」"));
		assert.ok(!md.includes("当时看的是:"));
	});
});

describe("buildNotesExport · 批量", () => {
	it("多条内容:H1 报总数,每条一个 H2,中间用分隔线", () => {
		const md = buildNotesExport([item(), item({ contentKey: "c2", title: "另一条", url: undefined })], TZ);
		assert.match(md, /^# 想法导出 · 2 条内容 · 2 条想法\n/);
		assert.ok(md.includes("## 1. 模型成本的下一站"));
		assert.ok(md.includes("## 2. 另一条"));
		assert.ok(md.includes("\n---\n"));
	});

	it("一条想法都没有的内容不进文件", () => {
		const md = buildNotesExport([item(), item({ contentKey: "c2", title: "空的", entries: [] })], TZ);
		assert.ok(!md.includes("空的"));
		assert.match(md, /^# 想法导出 · 模型成本的下一站\n/, "只剩一条时退回单条版式");
	});

	it("完全没有想法也给一份文件,不抛错", () => {
		const md = buildNotesExport([], TZ);
		assert.ok(md.includes("还没有记过想法"));
	});
});

describe("exportFileName", () => {
	it("单条用内容标题,批量用「全部」,都带导出日期", () => {
		assert.equal(exportFileName([item()], TZ), "想法-模型成本的下一站-20260901.md");
		assert.equal(exportFileName([item(), item({ contentKey: "c2" })], TZ), "想法-全部-20260901.md");
	});

	it("标题里的路径字符剔干净,不让它变成目录", () => {
		const name = exportFileName([item({ title: 'a/b\\c:d*e?f"g<h>i|j' })], TZ);
		assert.equal(name, "想法-abcdefghij-20260901.md");
	});
});

describe("时区", () => {
	it("非法时区不把整份导出搞崩,退回 UTC", () => {
		const md = buildNotesExport([item()], { now: TZ.now, timeZone: "Not/AZone" });
		assert.ok(md.includes("2026-09-01 14:33"));
	});

	it("给了时区就按它印", () => {
		const md = buildNotesExport([item()], { now: TZ.now, timeZone: "America/New_York" });
		assert.ok(md.includes("2026-09-01 10:33"));
	});
});

describe("没有标题的内容", () => {
	it("粘贴进来的正文既无标题也无链接:署「未命名内容」,不印哈希", () => {
		const md = buildNotesExport([item({ title: undefined, url: undefined, contentKey: "paste:4255276" })], TZ);
		assert.match(md, /^# 想法导出 · 未命名内容\n/);
		assert.ok(!md.includes("paste:4255276"));
	});

	it("只有链接没有标题:用链接署名,文件名退回「全部」", () => {
		const it0 = item({ title: undefined });
		assert.match(buildNotesExport([it0], TZ), /^# 想法导出 · https:\/\/youtu\.be\/abc\n/);
		assert.equal(exportFileName([it0], TZ), "想法-全部-20260901.md");
	});
});
