// R9 · 口味画像的单元测试。跑法:
//   node --experimental-strip-types --test src/shared/taste.test.ts
//
// 画像会**自动进每天的选材提示词**,所以护栏要有测试兜着:
//   · 反馈没攒够阈值绝不蒸馏(否则天天多一次调用,画像还全是噪音)
//   · 蒸馏失败返回 null,绝不挡当天的简报
//   · 读者改过的画像,重蒸馏提示词里必须带「逐条保留」的硬指令

import assert from "node:assert/strict";
import { test } from "node:test";
import type { Brief, FeedbackEvent } from "./types";
import type { Store, TasteProfile } from "./store";
import {
	TASTE_MIN_FEEDBACK,
	buildTastePrompt,
	maybeDistillTaste,
	parseTasteJson,
	tastePromptBlock,
} from "./taste.ts";

const NOW = new Date("2026-08-20T12:00:00.000Z");

function feedback(n: number): FeedbackEvent[] {
	return Array.from({ length: n }, (_, i) => ({
		date: "2026-08-18",
		itemId: `item-${i}`,
		kind: i % 2 === 0 ? ("up" as const) : ("down" as const),
		at: `2026-08-18T0${i % 10}:00:00Z`,
	}));
}

/** 只实现 maybeDistillTaste 路径上会碰到的两个方法,其余不该被调用。 */
function fakeStore(events: FeedbackEvent[]): Store {
	const brief: Brief = {
		date: "2026-08-18",
		generatedAt: "2026-08-18T11:00:00Z",
		sections: [
			{
				key: "t1",
				title: "定义一",
				items: events.map((ev) => ({
					id: ev.itemId,
					title: `条目 ${ev.itemId}`,
					whyClick: "why",
					url: `https://a.example/${ev.itemId}`,
					source: "某源",
				})),
			},
		],
		filteredOut: { scanned: 0, dropped: 0, summary: "", items: [] },
		sourceCount: 1,
	};
	return {
		listEvents: async () => events,
		getBrief: async () => ({ brief, generatedAt: brief.generatedAt }),
	} as unknown as Store;
}

const baseConfig = { trackers: [], sources: [], updatedAt: NOW.toISOString() };

test("maybeDistillTaste:反馈没攒够阈值不蒸馏、不调模型", async () => {
	let called = 0;
	const result = await maybeDistillTaste(fakeStore(feedback(TASTE_MIN_FEEDBACK - 1)), "a@b", baseConfig, {
		call: async () => {
			called++;
			return '{"summary":"x"}';
		},
		now: NOW,
	});
	assert.equal(result, null);
	assert.equal(called, 0);
});

test("maybeDistillTaste:攒够就蒸馏,产出带时间戳与消化条数的画像", async () => {
	const result = await maybeDistillTaste(fakeStore(feedback(TASTE_MIN_FEEDBACK)), "a@b", baseConfig, {
		call: async () => '{"summary":"偏爱一手案例,连续否掉招聘类"}',
		now: NOW,
	});
	// normalizeCnStyle 会把半角逗号规整成全角——画像和简报文案吃同一套文风规整
	assert.equal(result?.summary, "偏爱一手案例，连续否掉招聘类");
	assert.equal(result?.distilledFrom, TASTE_MIN_FEEDBACK);
	assert.equal(result?.updatedAt, NOW.toISOString());
	assert.equal(result?.edited, undefined, "模型蒸馏的版本不该带读者改过的标记");
});

test("maybeDistillTaste:模型炸了返回 null,不抛(绝不挡当天的简报)", async () => {
	const result = await maybeDistillTaste(fakeStore(feedback(TASTE_MIN_FEEDBACK)), "a@b", baseConfig, {
		call: async () => {
			throw new Error("boom");
		},
		now: NOW,
	});
	assert.equal(result, null);
});

test("buildTastePrompt:读者改过的旧画像带「逐条保留」硬指令", () => {
	const prev: TasteProfile = { summary: "不要二手转述", updatedAt: NOW.toISOString(), distilledFrom: 10, edited: true };
	const edited = buildTastePrompt(prev, []);
	assert.ok(edited.user.includes("读者亲手改过"));
	assert.ok(edited.user.includes("逐条保留"));
	const auto = buildTastePrompt({ ...prev, edited: undefined }, []);
	assert.ok(!auto.user.includes("读者亲手改过"));
});

test("parseTasteJson:剥 markdown 围栏,空摘要返回空串", () => {
	assert.equal(parseTasteJson('```json\n{"summary":"要点"}\n```'), "要点");
	assert.equal(parseTasteJson('{"summary":"  "}'), "");
});

test("tastePromptBlock:有画像才有段落,且声明让位规则", () => {
	assert.equal(tastePromptBlock(undefined), "");
	const block = tastePromptBlock({ summary: "偏爱一手案例", updatedAt: NOW.toISOString(), distilledFrom: 12 });
	assert.ok(block.includes("偏爱一手案例"));
	assert.ok(block.includes("以后者为准"));
});
