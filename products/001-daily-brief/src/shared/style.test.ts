// 文风兜底、Google News 解码与防重复的单元测试。跑法:
//   node --experimental-strip-types --test src/shared/style.test.ts
//
// 这三样都是「代码挡住的不变量」:引号/破折号规整是文风的最后一道闸,
// 解码决定去重和成稿能不能落在真实页面,防重复决定读者会不会连续两天
// 看到同一条——都不能只靠提示词的自觉。

import assert from "node:assert/strict";
import { test } from "node:test";
import { Buffer } from "node:buffer";
import { countAiTells, normalizeCnStyle } from "./style.ts";
import {
	decodeGoogleNewsUrl,
	dropSeenCandidates,
	fnv1a,
	seenItemIds,
	stripPublisherSuffix,
} from "./pipeline-core.ts";
import type { Candidate, FetchResult } from "./pipeline-core.ts";
import type { Brief } from "./types";

// ---------- normalizeCnStyle ----------

test("引号归一:直角引号与半角引号都变成大陆弯引号", () => {
	assert.equal(normalizeCnStyle("他说「模型路由」很重要"), "他说“模型路由”很重要");
	assert.equal(normalizeCnStyle("回应'别人是怎么做的'这个问题"), "回应“别人是怎么做的”这个问题");
	assert.equal(normalizeCnStyle('主打"成本优势"的产品'), "主打“成本优势”的产品");
	// 纯英文引号不动:代码、原文引用都可能是它
	assert.equal(normalizeCnStyle('run "npm test" first'), 'run "npm test" first');
});

test("破折号降级为逗号,英文/数字语境不动", () => {
	assert.equal(normalizeCnStyle("成本很高——大约十倍"), "成本很高，大约十倍");
	assert.equal(normalizeCnStyle("pages 150—320 stay"), "pages 150—320 stay");
});

test("CJK 邻接的半角标点全角化,英文标点不动", () => {
	assert.equal(normalizeCnStyle("先选材, 再成稿. 分两段"), "先选材，再成稿。分两段");
	assert.equal(normalizeCnStyle("see example.com, ok."), "see example.com, ok.");
	assert.equal(normalizeCnStyle("非常重要!"), "非常重要。");
});

test("countAiTells:数破折号、直角引号和套话,给换模对照当指标", () => {
	assert.equal(countAiTells("这凸显了趋势——值得关注"), 3);
	assert.equal(countAiTells("平平常常说件事,没有套话"), 0);
});

// ---------- Google News 解码 ----------

function googleNewsUrl(target: string): string {
	// 旧式链接的 path 段 = base64url(protobuf),前缀恰好是 CBMi;
	// 解码器只按可打印 URL 捞,所以测试里手工拼一个同构的字节流即可。
	const inner = `\x08\x13\x22.${target}`;
	const seg = Buffer.from(inner, "binary")
		.toString("base64")
		.replace(/\+/g, "-")
		.replace(/\//g, "_")
		.replace(/=+$/, "");
	return `https://news.google.com/rss/articles/${seg}?oc=5`;
}

test("decodeGoogleNewsUrl:旧式 CBMi 链接解出原文 URL", () => {
	const target = "https://siliconangle.com/2026/08/18/fortinet-virtue-ai/";
	assert.equal(decodeGoogleNewsUrl(googleNewsUrl(target)), target);
});

test("decodeGoogleNewsUrl:新式链接与非 Google 链接返回 null", () => {
	assert.equal(decodeGoogleNewsUrl("https://news.google.com/rss/articles/AU_yqLnothing?oc=5"), null);
	assert.equal(decodeGoogleNewsUrl("https://siliconangle.com/story"), null);
});

test("stripPublisherSuffix:只剥「 - 出版方」的精确尾巴", () => {
	assert.equal(stripPublisherSuffix("Fortinet buys Virtue AI - SiliconANGLE", "SiliconANGLE"), "Fortinet buys Virtue AI");
	assert.equal(stripPublisherSuffix("A - B testing guide", "SiliconANGLE"), "A - B testing guide");
	assert.equal(stripPublisherSuffix("无出版方的标题", undefined), "无出版方的标题");
});

// ---------- 防重复(seen) ----------

function cand(id: string, url: string): Candidate {
	return { id, sourceKey: "s1", source: "某源", category: "news", title: `t-${id}`, url, publishedAt: "2026-08-19T00:00:00.000Z", excerpt: "" };
}

function seenBrief(itemUrl: string, mergedUrl?: string): Brief {
	return {
		date: "2026-08-18",
		generatedAt: "2026-08-18T11:00:00.000Z",
		sections: [
			{
				key: "t1",
				title: "定义一",
				items: [
					{
						id: fnv1a(itemUrl),
						title: "昨天入选的",
						whyClick: "why",
						url: itemUrl,
						source: "某源",
						sourceKey: "s1",
						publishedAt: "2026-08-18T00:00:00.000Z",
						...(mergedUrl ? { mergedFrom: [{ label: "同事件", url: mergedUrl }] } : {}),
					},
				],
			},
		],
		filteredOut: { scanned: 1, dropped: 0, summary: "", items: [] },
		sourceCount: 1,
	};
}

test("昨天入选过的(含合并报道)今天绝不再进候选池,且理由进问责区", () => {
	const picked = "https://a.example/yesterday";
	const merged = "https://b.example/same-story";
	const seen = seenItemIds([seenBrief(picked, merged)]);
	const fetched: FetchResult = {
		candidates: [cand(fnv1a(picked), picked), cand(fnv1a(merged), merged), cand(fnv1a("https://c.example/new"), "https://c.example/new")],
		ruleDropped: [],
		scanned: 3,
		sourcesOk: 1,
		sourceErrors: [],
		sourceStatus: [],
	};
	const dropped = dropSeenCandidates(fetched, seen);
	assert.equal(dropped, 2);
	assert.equal(fetched.candidates.length, 1);
	assert.equal(fetched.candidates[0].url, "https://c.example/new");
	assert.equal(fetched.ruleDropped.length, 2);
	assert.match(fetched.ruleDropped[0].reason, /已入选过/);
});
