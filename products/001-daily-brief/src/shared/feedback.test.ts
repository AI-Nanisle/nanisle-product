// R2/R3 的单元测试。跑法(和 wizard.test.ts 同一条命令):
//   node --experimental-strip-types --test src/shared/feedback.test.ts
//
// 盯的是两个最容易悄悄坏掉的地方:
//   1. 「已知道」和「没用」在提示词里必须是**相反**的指令(收敛到三按钮之后
//      老事件仍在流里,混为一谈会把读者最关心的话题误杀);
//   2. 回响只许说算得出来的话——没测出条数变化就不许写「所以今天少了 X」。

import assert from "node:assert/strict";
import { test } from "node:test";
import type { Brief, FeedbackKind } from "./types";
import { ISSUE_ITEM_ID } from "./types.ts";
import type { FeedbackDigest, FeedbackNote } from "./feedback.ts";
import { buildFeedbackEcho, feedbackPromptBlock } from "./feedback.ts";

function note(kind: FeedbackKind, over: Partial<FeedbackNote> = {}): FeedbackNote {
	return { kind, date: "2026-08-17", itemId: "i1", title: "标题", source: "某源", ...over };
}

function digestOf(notes: FeedbackNote[], briefs: Brief[] = []): FeedbackDigest {
	return {
		since: "2026-08-10T00:00:00.000Z",
		notes,
		clicks: new Map(),
		clickCount: 0,
		clickEvents: [],
		briefs: new Map(briefs.map((b) => [b.date, b])),
	};
}

function briefOf(date: string, sources: string[]): Brief {
	return {
		date,
		generatedAt: `${date}T11:00:00.000Z`,
		sections: [
			{
				key: "t1",
				title: "分区",
				items: sources.map((source, i) => ({
					id: `${date}-${i}`,
					title: `条目 ${i}`,
					whyClick: "why",
					url: `https://example.com/${date}/${i}`,
					source,
				})),
			},
		],
		filteredOut: { scanned: 10, dropped: 5, summary: "", items: [] },
		sourceCount: 3,
	};
}

test("feedbackPromptBlock:空摘要返回空串(调用方据此决定加不加这一段)", () => {
	assert.equal(feedbackPromptBlock(digestOf([])), "");
});

test("feedbackPromptBlock:「已知道」的指令必须是提高新鲜度、不是下调话题", () => {
	const block = feedbackPromptBlock(digestOf([note("known", { title: "看过的那条" })]));
	assert.match(block, /只提高新鲜度要求/);
	assert.match(block, /绝不要下调这个话题/);
	// 它不该被归进「没用」那一组
	assert.doesNotMatch(block, /【没用】/);
});

test("feedbackPromptBlock:want 带出当初的过滤理由(那才是最有用的信息)", () => {
	const block = feedbackPromptBlock(
		digestOf([note("want", { title: "被误杀的", droppedReason: "规则过滤:命中「融资」" })]),
	);
	assert.match(block, /当初理由:规则过滤:命中「融资」/);
});

test("feedbackPromptBlock:刊级反馈单独成段,不混进条目反馈里", () => {
	const block = feedbackPromptBlock(
		digestOf([note("text", { itemId: ISSUE_ITEM_ID, text: "今天完全没有 Cloudflare 的东西", title: undefined })]),
	);
	assert.match(block, /读者说这几期缺了什么/);
	assert.match(block, /Cloudflare/);
});

test("buildFeedbackEcho:没有历史反馈时不出回响(宁可没有,也不要一句废话)", () => {
	assert.equal(buildFeedbackEcho(digestOf([]), briefOf("2026-08-18", ["A"])), undefined);
});

test("buildFeedbackEcho:今天自己的反馈不算「上一次」", () => {
	const today = briefOf("2026-08-18", ["A"]);
	const d = digestOf([note("down", { date: "2026-08-18" })]);
	assert.equal(buildFeedbackEcho(d, today), undefined);
});

test("buildFeedbackEcho:测得出条数下降时,数字必须是真算出来的", () => {
	const prev = briefOf("2026-08-17", ["某源", "某源", "别家"]);
	const today = briefOf("2026-08-18", ["某源", "别家"]);
	const d = digestOf([note("down", { date: "2026-08-17", source: "某源" })], [prev]);
	const echo = buildFeedbackEcho(d, today);
	assert.ok(echo);
	assert.match(echo, /1 条「没用」/);
	assert.match(echo, /某源 从 2 条降到 1 条/);
});

test("buildFeedbackEcho:没测出变化就只说「已计入」,不许编因果", () => {
	// 上一期拿不到(简报过期/被删),差值无从算起
	const d = digestOf([note("down", { date: "2026-08-17", source: "某源" }), note("text", { date: "2026-08-17", text: "想看更深的" })]);
	const echo = buildFeedbackEcho(d, briefOf("2026-08-18", ["某源"]));
	assert.ok(echo);
	assert.match(echo, /已计入今天的选材/);
	assert.doesNotMatch(echo, /降到/);
});

test("buildFeedbackEcho:该源条数没降就不提它(不许说没发生的事)", () => {
	const prev = briefOf("2026-08-17", ["某源"]);
	const today = briefOf("2026-08-18", ["某源", "某源"]); // 反而多了
	const d = digestOf([note("down", { date: "2026-08-17", source: "某源" })], [prev]);
	const echo = buildFeedbackEcho(d, today);
	assert.ok(echo);
	assert.doesNotMatch(echo, /降到/);
});
