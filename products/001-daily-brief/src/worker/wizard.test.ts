// 向导纯逻辑的测试(node:test,`npm test` 跑,无需 AWS/AI 凭证)。
// 重点是 docs/02 §7.2 点名「必须有测试」的那条:理解重生成后,用户红标
// 圈改过(edited:true)的句子由服务端按位置强制覆盖,不信任模型的自觉。

import { test } from "node:test";
import assert from "node:assert/strict";
import {
	MAX_INTENT_SEGMENTS,
	PURPOSE_OPTIONS_FALLBACK,
	PURPOSE_OPT_OUT,
	purposeOptions,
} from "../shared/pipeline-core.ts";
import {
	cleanCandidates,
	cleanRefinePatch,
	cleanStringList,
	mergeLockedSegments,
	parseJsonBlock,
} from "./wizard.ts";

// ---------- mergeLockedSegments(§7.2 兜底) ----------

test("无圈改句时,模型的新理解原样通过", () => {
	const next = [{ text: "a" }, { text: "b" }];
	assert.deepEqual(mergeLockedSegments([{ text: "旧" }], next), next);
	assert.deepEqual(mergeLockedSegments(undefined, next), next);
});

test("圈改句按位置强制覆盖,不管模型返回了什么", () => {
	const prev = [{ text: "第一句" }, { text: "用户手改的第二句", edited: true }, { text: "第三句" }];
	const next = [{ text: "新一" }, { text: "模型擅自改写的第二句" }, { text: "新三" }];
	assert.deepEqual(mergeLockedSegments(prev, next), [
		{ text: "新一" },
		{ text: "用户手改的第二句", edited: true },
		{ text: "新三" },
	]);
});

test("新理解比锁定位置短时,锁定句追加在尾部而不是丢失", () => {
	const prev = [{ text: "一" }, { text: "二" }, { text: "用户手改的第三句", edited: true }];
	const next = [{ text: "只剩一句" }];
	assert.deepEqual(mergeLockedSegments(prev, next), [
		{ text: "只剩一句" },
		{ text: "用户手改的第三句", edited: true },
	]);
});

test("结果不超过 MAX_INTENT_SEGMENTS,锁定句优先保住", () => {
	const prev = Array.from({ length: MAX_INTENT_SEGMENTS }, (_, i) => ({
		text: `旧${i}`,
		...(i === MAX_INTENT_SEGMENTS - 1 ? { edited: true as const } : {}),
	}));
	const next = Array.from({ length: MAX_INTENT_SEGMENTS + 3 }, (_, i) => ({ text: `新${i}` }));
	const merged = mergeLockedSegments(prev, next);
	assert.equal(merged.length, MAX_INTENT_SEGMENTS);
	assert.deepEqual(merged[MAX_INTENT_SEGMENTS - 1], { text: `旧${MAX_INTENT_SEGMENTS - 1}`, edited: true });
});

// ---------- parseJsonBlock(宽容解析) ----------

test("parseJsonBlock:裸 JSON、markdown 围栏、前后杂文都能解", () => {
	assert.deepEqual(parseJsonBlock('{"a":1}'), { a: 1 });
	assert.deepEqual(parseJsonBlock('```json\n{"a":1}\n```'), { a: 1 });
	assert.deepEqual(parseJsonBlock('好的,这是结果:{"a":1} 希望有帮助'), { a: 1 });
});

test("parseJsonBlock:非对象输出要响,不静默", () => {
	assert.throws(() => parseJsonBlock("[1,2]"));
	assert.throws(() => parseJsonBlock("完全不是 JSON"));
});

// ---------- 清洗 ----------

test("cleanStringList:去空、截长、去重、限量", () => {
	assert.deepEqual(cleanStringList([" a ", "", "a", "b", 3, "x".repeat(50)], 3, 4), ["a", "b", "xxxx"]);
	assert.deepEqual(cleanStringList("not-array", 5, 10), []);
});

test("cleanCandidates:字段不全/分类非法/URL 非 http 的整条丢弃,URL 去重", () => {
	const cands = cleanCandidates([
		{ name: "好源", url: "https://a.com/feed", category: "news", reason: "有用" },
		{ name: "重复", url: "https://a.com/feed", category: "blog" },
		{ name: "坏分类", url: "https://b.com/feed", category: "video" },
		{ name: "", url: "https://c.com/feed", category: "news" },
		{ name: "坏URL", url: "javascript:alert(1)", category: "news" },
	]);
	assert.equal(cands.length, 1);
	assert.equal(cands[0].url, "https://a.com/feed");
	assert.equal(cands[0].reason, "有用");
});

// ---------- refine patch(只许四个字段,sourceKey 不许越界) ----------

test("cleanRefinePatch:只认四个字段,越界 sourceKey 整条丢弃", () => {
	const patch = cleanRefinePatch(
		{
			intent: " 新的理解 ",
			include: ["a"],
			name: "不许改名",
			question: "不许改原话",
			sourceRules: [
				{ sourceKey: "known", exclude: ["噪音"] },
				{ sourceKey: "unknown", include: ["x"] },
				{ sourceKey: "known", include: ["重复 key 丢弃"] },
			],
		},
		new Set(["known"]),
	);
	assert.deepEqual(patch, {
		intent: "新的理解",
		include: ["a"],
		sourceRules: [{ sourceKey: "known", exclude: ["噪音"] }],
	});
	assert.ok(!("name" in patch) && !("question" in patch));
});

test("cleanRefinePatch:模型没给可改字段时返回空 patch", () => {
	assert.deepEqual(cleanRefinePatch({ note: "这句话改不了" }, new Set()), {});
});

// R8 · 追问选项:模型按话题生成,但退出口是服务端的护栏,不能依赖模型自觉
test("purposeOptions:退出口永远在最后一个", () => {
	const opts = purposeOptions(["在做产品盯竞品", "在选技术栈", "手里有仓位"]);
	assert.equal(opts.length, 4);
	assert.equal(opts.at(-1), PURPOSE_OPT_OUT);
});

test("purposeOptions:模型没给选项时退回通用兜底,退出口照样在", () => {
	const opts = purposeOptions([]);
	assert.deepEqual(opts, [...PURPOSE_OPTIONS_FALLBACK, PURPOSE_OPT_OUT]);
});

test("purposeOptions:模型自己也写了退出口时不重复", () => {
	const opts = purposeOptions(["在做产品", PURPOSE_OPT_OUT, "在看投资"]);
	assert.equal(opts.filter((o) => o === PURPOSE_OPT_OUT).length, 1);
});

test("purposeOptions:超过 3 个只取前 3 个(加退出口共 4 个)", () => {
	assert.equal(purposeOptions(["a", "b", "c", "d", "e"]).length, 4);
});
