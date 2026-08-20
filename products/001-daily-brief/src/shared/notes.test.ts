// N1 的单元测试。跑法(和 feedback.test.ts 同一条命令):
//   node --experimental-strip-types --test src/shared/notes.test.ts
//
// 盯的是台账最容易悄悄坏掉的三处:
//   1. 快照只在建账时抄一次,追加**永远不动**已有快照——台账记的是「当时」;
//   2. 轴外位和「已筛掉」区的反馈也要有名有姓(feedback.ts 的 findInBrief
//      就漏了轴外位,这里不能重蹈);
//   3. 简报已不在时想法本身仍要留住——无快照账合法,丢想法不合法。

import assert from "node:assert/strict";
import { test } from "node:test";
import type { Brief, FeedbackEvent, ItemNote } from "./types";
import { ISSUE_ITEM_ID, MAX_NOTE_ENTRIES } from "./types.ts";
import { applyEventToNote } from "./notes.ts";

const BRIEF: Brief = {
	date: "2026-08-19",
	generatedAt: "2026-08-19T11:00:00.000Z",
	sections: [
		{
			key: "t1",
			title: "平台风向",
			items: [
				{
					id: "item-1",
					title: "某平台改了 API 定价",
					whyClick: "",
					url: "https://example.com/pricing",
					source: "Example Blog",
				},
			],
		},
	],
	offAxis: {
		id: "off-1",
		title: "一条轴外内容",
		whyClick: "",
		url: "https://example.com/off",
		source: "Off Source",
	},
	filteredOut: {
		scanned: 10,
		dropped: 1,
		summary: "",
		items: [{ id: "drop-1", title: "被筛掉的那条", url: "https://example.com/drop", reason: "旧闻", source: "Dropped Source" }],
	},
	sourceCount: 3,
};

function ev(over: Partial<FeedbackEvent> = {}): FeedbackEvent {
	return { date: "2026-08-19", itemId: "item-1", kind: "text", text: "我的想法", at: "2026-08-19T12:00:00.000Z", ...over };
}

test("建账抄快照:标题/链接/来源/分区都来自当期简报", () => {
	const note = applyEventToNote(null, ev(), BRIEF);
	assert.equal(note.title, "某平台改了 API 定价");
	assert.equal(note.url, "https://example.com/pricing");
	assert.equal(note.source, "Example Blog");
	assert.equal(note.sectionTitle, "平台风向");
	assert.deepEqual(note.entries, [{ at: "2026-08-19T12:00:00.000Z", kind: "text", text: "我的想法" }]);
});

test("轴外位与「已筛掉」区的反馈也有名有姓", () => {
	const off = applyEventToNote(null, ev({ itemId: "off-1", kind: "up", text: undefined }), BRIEF);
	assert.equal(off.title, "一条轴外内容");
	assert.equal(off.sectionTitle, "不在你的追踪范围内");
	const dropped = applyEventToNote(null, ev({ itemId: "drop-1", kind: "want", text: undefined }), BRIEF);
	assert.equal(dropped.title, "被筛掉的那条");
	assert.equal(dropped.sectionTitle, "已替你筛掉");
});

test("追加不动快照:哪怕这时给的简报里已经找不到这条", () => {
	const first = applyEventToNote(null, ev({ kind: "up", text: undefined }), BRIEF);
	const second = applyEventToNote(
		{ ...first, title: "落账时的标题", url: "https://example.com/old" },
		ev({ text: "两个月后的补记", at: "2026-10-20T09:00:00.000Z" }),
		null,
	);
	assert.equal(second.title, "落账时的标题");
	assert.equal(second.url, "https://example.com/old");
	assert.equal(second.entries.length, 2);
	assert.equal(second.entries[1].text, "两个月后的补记");
	assert.equal(second.updatedAt, "2026-10-20T09:00:00.000Z");
});

test("简报已不在:想法仍然落账,只是无快照", () => {
	const note = applyEventToNote(null, ev(), null);
	assert.equal(note.title, undefined);
	assert.equal(note.entries[0].text, "我的想法");
});

test("刊级反馈不去简报里找条目", () => {
	const note = applyEventToNote(null, ev({ itemId: ISSUE_ITEM_ID, text: "缺了 xx 的消息" }), BRIEF);
	assert.equal(note.title, undefined);
	assert.equal(note.itemId, ISSUE_ITEM_ID);
});

test("有界状态:表态满了挤掉最旧的", () => {
	let note: ItemNote | null = null;
	for (let i = 0; i < MAX_NOTE_ENTRIES + 5; i++) {
		note = applyEventToNote(note, ev({ text: `想法 ${i}`, at: `2026-08-19T12:${String(i).padStart(2, "0")}:00.000Z` }), BRIEF);
	}
	assert.equal(note!.entries.length, MAX_NOTE_ENTRIES);
	assert.equal(note!.entries[0].text, "想法 5");
	assert.equal(note!.entries.at(-1)!.text, `想法 ${MAX_NOTE_ENTRIES + 4}`);
});
