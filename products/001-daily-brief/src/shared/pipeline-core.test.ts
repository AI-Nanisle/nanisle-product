// H6(死源停抓)与同事件归簇的单元测试。跑法:
//   node --experimental-strip-types --test src/shared/pipeline-core.test.ts
//
// 两个都是「模型看到候选之前」的硬规则,坏了不会报错、只会悄悄多花钱或
// 让同一条新闻占三个坑,所以必须有测试兜着。

import assert from "node:assert/strict";
import { test } from "node:test";
import type { Candidate, EditorialResult } from "./pipeline-core";
import {
	SAME_STORY_SIM,
	UNHEALTHY_FAILURES,
	applySameStoryMerges,
	buildEditorialPrompt,
	clusterSameStory,
	fetchAllSources,
	titleTokens,
} from "./pipeline-core.ts";
import { DEFAULT_FILTERS } from "./default-sources.ts";

function cand(over: Partial<Candidate> & { id: string; title: string }): Candidate {
	return {
		sourceKey: "s1",
		source: "某源",
		category: "news",
		url: `https://a.example/${over.id}`,
		publishedAt: "2026-08-20T00:00:00Z",
		excerpt: "正文",
		...over,
	};
}

test("H6 · fetchAllSources:连续失败的源整轮跳过,不抓、不计健康", async () => {
	const result = await fetchAllSources(
		[
			{
				key: "dead",
				name: "坏源",
				url: "https://dead.example/feed",
				category: "news",
				health: { consecutiveFailures: UNHEALTHY_FAILURES },
			},
			{ key: "off", name: "停用源", url: "https://off.example/feed", category: "news", enabled: false },
		],
		DEFAULT_FILTERS,
	);
	// 两个源都没被抓:一个健康跳过、一个停用——sourceStatus 里谁都不该出现,
	// 否则 applyHealth 会把没抓过的源记成又失败了一次
	assert.equal(result.sourceStatus.length, 0);
	assert.deepEqual(result.skippedUnhealthy, ["坏源"]);
});

test("titleTokens:英文按词、中文按二字组,大小写不敏感", () => {
	const t = titleTokens("OpenAI Releases GPT-6 模型发布");
	assert.ok(t.has("openai"));
	assert.ok(t.has("gpt-6"));
	assert.ok(t.has("模型"));
	assert.ok(t.has("发布"));
});

test("clusterSameStory:机械转载并成一簇,直连源优先当主报道", () => {
	const primary = cand({ id: "a", title: "OpenAI releases GPT-6 with new agent mode", excerpt: "长长的正文".repeat(10) });
	// 检索源条目(带 publisher)哪怕正文更长也让位给直连源
	const dupQuery = cand({
		id: "b",
		title: "OpenAI releases GPT-6 with new agent mode",
		publisher: "TechCrunch",
		excerpt: "更长更长的正文".repeat(50),
	});
	const unrelated = cand({ id: "c", title: "Fed holds rates steady in August meeting" });
	const { primaries, mergedByPrimary } = clusterSameStory([dupQuery, primary, unrelated]);
	assert.deepEqual(primaries.map((c) => c.id).sort(), ["a", "c"]);
	assert.deepEqual(mergedByPrimary.get("a"), ["b"]);
});

test("clusterSameStory:标题不够像就不合并(阈值保守,错合并比漏合并伤)", () => {
	const a = cand({ id: "a", title: "OpenAI releases GPT-6" });
	const b = cand({ id: "b", title: "Anthropic ships Claude Fable 5" });
	const { primaries, mergedByPrimary } = clusterSameStory([a, b]);
	assert.equal(primaries.length, 2);
	assert.equal(mergedByPrimary.size, 0);
	assert.ok(SAME_STORY_SIM >= 0.5, "阈值不该悄悄放松");
});

test("applySameStoryMerges:预归簇的报道并进选中项的 merged,并与模型给的去重", () => {
	const editorial: EditorialResult = {
		sections: { t1: [{ id: "a", whyClick: "why", merged: ["b"] }] },
		notableDrops: [],
		droppedSummary: "",
	};
	const n = applySameStoryMerges(editorial, new Map([["a", ["b", "d"]]]));
	assert.equal(n, 2);
	assert.deepEqual(editorial.sections.t1[0].merged, ["b", "d"]);
});

test("buildEditorialPrompt:口味画像段进用户消息,并带对应的系统规则", () => {
	const { system, user } = buildEditorialPrompt(
		[cand({ id: "a", title: "t" })],
		[{ key: "t1", name: "定义一", quota: 2 }],
		"",
		false,
		new Map(),
		"读者的长期口味画像:偏爱一手案例",
	);
	assert.ok(user.includes("读者的长期口味画像:偏爱一手案例"));
	assert.ok(system.includes("长期口味画像"));
	// 没画像时既不加段也不加规则
	const bare = buildEditorialPrompt([cand({ id: "a", title: "t" })], [{ key: "t1", name: "定义一", quota: 2 }]);
	assert.ok(!bare.system.includes("长期口味画像"));
});

// ---------- 成稿重试(docs/05 后日谈:2026-08-24 断流事故) ----------

import { enrichBrief } from "./pipeline-core.ts";
import type { Brief } from "./types";
import type { FetchResult } from "./pipeline-core";

function enrichFixture() {
	// excerpt 超过 TEASER_THRESHOLD(1500):不走原文抓取,测试不出网
	const brief = {
		date: "2026-08-24",
		generatedAt: "2026-08-24T11:00:00Z",
		tldr: [],
		sections: [
			{
				key: "t1",
				title: "追踪一",
				items: [{ id: "a1", title: "标题", whyClick: "路由一句", url: "https://a.example/a1", source: "某源" }],
			},
		],
	} as unknown as Brief;
	const fetched = {
		candidates: [cand({ id: "a1", title: "标题", excerpt: "字".repeat(1600) })],
	} as unknown as FetchResult;
	return { brief, fetched };
}

test("enrichBrief:首次调用断流,重试成功后散文照常写回", async () => {
	const { brief, fetched } = enrichFixture();
	let calls = 0;
	const n = await enrichBrief(brief, fetched, [], async () => {
		calls += 1;
		// 2026-08-24 定时刊真实炸法:undici 流中途断,fetch 抛 TypeError: terminated
		if (calls === 1) throw new TypeError("terminated");
		return JSON.stringify({ items: { a1: { substance: "实质一百五十字的替身", take: "判断" } } });
	});
	assert.equal(calls, 2);
	assert.equal(n, 1);
	assert.equal(brief.sections[0].items[0].substance, "实质一百五十字的替身");
	assert.equal(brief.sections[0].items[0].take, "判断");
});

test("enrichBrief:只有导语的条目走降档成稿,提示词带上导语标记", async () => {
	const { brief, fetched } = enrichFixture();
	// 付费墙形态:feed 只有 200 字导语,抓原文也只拿到空
	(fetched as unknown as { candidates: { excerpt: string }[] }).candidates[0].excerpt = "字".repeat(200);
	let seenUser = "";
	const n = await enrichBrief(
		brief,
		fetched,
		[],
		async (_system, user) => {
			seenUser = user;
			return JSON.stringify({ items: { a1: { substance: "仅基于导语:一句实质" } } });
		},
		() => {},
		async () => "",
	);
	assert.equal(n, 1);
	assert.ok(seenUser.includes("只拿到导语"));
	// normalizeCnStyle 会把半角冒号规整成全角
	assert.equal(brief.sections[0].items[0].substance, "仅基于导语：一句实质");
});

test("enrichBrief:连导语都没有的条目照旧跳过成稿", async () => {
	const { brief, fetched } = enrichFixture();
	(fetched as unknown as { candidates: { excerpt: string }[] }).candidates[0].excerpt = "太短";
	let calls = 0;
	const n = await enrichBrief(
		brief,
		fetched,
		[],
		async () => {
			calls += 1;
			return "{}";
		},
		() => {},
		async () => "",
	);
	assert.equal(calls, 0);
	assert.equal(n, 0);
	assert.equal(brief.sections[0].items[0].substance, undefined);
});

test("enrichBrief:连炸两次才认输,保住路由版不抛错", async () => {
	const { brief, fetched } = enrichFixture();
	let calls = 0;
	const n = await enrichBrief(brief, fetched, [], async () => {
		calls += 1;
		throw new TypeError("terminated");
	});
	assert.equal(calls, 2);
	assert.equal(n, 0);
	assert.equal(brief.sections[0].items[0].substance, undefined);
});
