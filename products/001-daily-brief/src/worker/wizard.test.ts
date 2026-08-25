// 向导纯逻辑的测试(node:test,`npm test` 跑,无需 AWS/AI 凭证)。
// 重点是 docs/02 §7.2 点名「必须有测试」的那条:理解重生成后,用户红标
// 圈改过(edited:true)的句子由服务端按位置强制覆盖,不信任模型的自觉。

import { test } from "node:test";
import assert from "node:assert/strict";
import {
	MAX_INTENT_SEGMENTS,
	MAX_INTENT_VERSIONS,
	PURPOSE_OPTIONS_FALLBACK,
	PURPOSE_OPT_OUT,
	purposeOptions,
	pushIntentVersion,
} from "../shared/pipeline-core.ts";
import type { Tracker } from "../shared/pipeline-core";
import {
	cleanCandidates,
	cleanRefinePatch,
	cleanStringList,
	finishDraft,
	mergeLockedSegments,
	mergeTagLists,
	parseJsonBlock,
	wizardSuggest,
} from "./wizard.ts";
import type { WizardContext } from "./wizard.ts";
import { cleanTrackers } from "./config.ts";

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

// ---------- V1 · 理解的历史快照(pushIntentVersion) ----------

function trackerWith(partial: Partial<Tracker>): Tracker {
	return { key: "t-1", name: "测试", quota: 3, ...partial };
}

test("pushIntentVersion:当前理解压进历史,新在前", () => {
	const t = trackerWith({
		intentSegments: [{ text: "当前版" }],
		intentVersions: [{ at: "2026-08-01T00:00:00Z", segments: [{ text: "更早的版" }] }],
	});
	const versions = pushIntentVersion(t, "重写前", "2026-08-25T00:00:00Z");
	assert.equal(versions.length, 2);
	assert.deepEqual(versions[0], { at: "2026-08-25T00:00:00Z", note: "重写前", segments: [{ text: "当前版" }] });
	assert.equal(versions[1].segments[0].text, "更早的版");
});

test("pushIntentVersion:当前为空或与最近快照相同时不记", () => {
	assert.equal(pushIntentVersion(trackerWith({}), "x").length, 0);
	const dup = trackerWith({
		intentSegments: [{ text: "同一版", edited: true }],
		intentVersions: [{ at: "2026-08-01T00:00:00Z", segments: [{ text: "同一版", edited: true }] }],
	});
	assert.equal(pushIntentVersion(dup, "x").length, 1);
});

test("pushIntentVersion:legacy 只有 intent 字符串的也能快照(经 trackerSegments 拆句)", () => {
	const versions = pushIntentVersion(trackerWith({ intent: "第一句;第二句" }), "重写前");
	assert.deepEqual(versions[0].segments, [{ text: "第一句" }, { text: "第二句" }]);
});

test("pushIntentVersion:超过上限时最旧的被挤掉", () => {
	const full = Array.from({ length: MAX_INTENT_VERSIONS }, (_, i) => ({
		at: `2026-08-${String(i + 1).padStart(2, "0")}T00:00:00Z`,
		segments: [{ text: `第${i}版` }],
	}));
	const versions = pushIntentVersion(trackerWith({ intentSegments: [{ text: "最新" }], intentVersions: full }), "x");
	assert.equal(versions.length, MAX_INTENT_VERSIONS);
	assert.equal(versions[0].segments[0].text, "最新");
	assert.equal(versions.at(-1)?.segments[0].text, `第${MAX_INTENT_VERSIONS - 2}版`);
});

// ---------- F8 · 帮我想(不建草稿,纯出题;这里只测不碰模型的两条路) ----------

/** wizardSuggest 在 mock/校验路径上不碰 store,给个假的就行。 */
const suggestCtx = (provider: string): WizardContext =>
	({ store: null, email: "t@x", ai: { provider } }) as unknown as WizardContext;

test("wizardSuggest:处境为空是 400,不扣白工", async () => {
	const res = await wizardSuggest(suggestCtx("mock"), { context: "   " });
	assert.equal(res.status, 400);
});

test("wizardSuggest:mock 模式给空列表 + 明说没接 AI,不编造例题", async () => {
	const res = await wizardSuggest(suggestCtx("mock"), { context: "在做跨境电商" });
	assert.equal(res.status, 200);
	assert.deepEqual(res.body.suggestions, []);
	assert.ok(typeof res.body.note === "string" && (res.body.note as string).length > 0);
});

// ---------- R10 · 「再给几个」标签合并 ----------

test("mergeTagLists:并集去重,已有的一个不动,超上限时新标签让位", () => {
	assert.deepEqual(mergeTagLists(["a", "b"], ["b", "c"]), ["a", "b", "c"]);
	assert.deepEqual(mergeTagLists(undefined, ["x"]), ["x"]);
	assert.deepEqual(mergeTagLists(["a", "b", "c"], ["d", "e"], 4), ["a", "b", "c", "d"]);
});

// ---------- 存储清洗:新字段过得了 cleanTrackers,不被 PUT 洗掉 ----------

test("cleanTrackers:intentVersions 原样存续,wizardMessages 只在草稿期保留", () => {
	const base = {
		key: "t-1",
		name: "测试",
		quota: 3,
		intentVersions: [{ at: "2026-08-25T00:00:00Z", note: "重写前", segments: [{ text: "旧版" }] }],
		wizardMessages: ["原话", "补充的一句"],
	};
	const draft = cleanTrackers([{ ...base, stage: "understanding" }]);
	assert.ok("trackers" in draft);
	assert.deepEqual(draft.trackers[0].intentVersions, base.intentVersions);
	assert.deepEqual(draft.trackers[0].wizardMessages, base.wizardMessages);

	// 生效(无 stage)后:版本历史仍在,向导对话丢弃
	const live = cleanTrackers([base]);
	assert.ok("trackers" in live);
	assert.deepEqual(live.trackers[0].intentVersions, base.intentVersions);
	assert.equal(live.trackers[0].wizardMessages, undefined);
});

test("cleanTrackers:形状不对的 intentVersions 整条丢弃,不带垃圾入库", () => {
	const cleaned = cleanTrackers([
		{
			key: "t-1",
			name: "测试",
			quota: 3,
			intentVersions: [
				{ at: "", segments: [{ text: "缺时间戳" }] },
				{ at: "2026-08-25T00:00:00Z", segments: [] },
				{ at: "2026-08-25T00:00:00Z", segments: [{ text: "合格的" }] },
			],
		},
	]);
	assert.ok("trackers" in cleaned);
	assert.equal(cleaned.trackers[0].intentVersions?.length, 1);
	assert.equal(cleaned.trackers[0].intentVersions?.[0].segments[0].text, "合格的");
});

// ---------- finishDraft(草稿转生效,yiren 反馈 #4 的根因修复) ----------

test("finishDraft:删 stage、丢 wizardMessages、记一行变更,其余字段原样", () => {
	const trackers: Tracker[] = [
		{ key: "t-0", name: "别的定义", quota: 3 },
		{
			key: "t-1",
			name: "测试",
			quota: 3,
			stage: "sources",
			wizardMessages: ["原话"],
			sourceKeys: ["a", "b"],
			include: ["收这个"],
		},
	];
	const res = finishDraft(trackers, "t-1");
	assert.ok(res);
	assert.equal(res.changed, true);
	assert.equal(res.tracker.stage, undefined);
	assert.equal(res.tracker.wizardMessages, undefined);
	assert.deepEqual(res.tracker.sourceKeys, ["a", "b"]);
	assert.deepEqual(res.tracker.include, ["收这个"]);
	assert.match(res.tracker.changelog?.[0].text ?? "", /开始生效/);
	// 列表里只动这一份,别的定义一个字节都不碰
	assert.equal(res.trackers[0], trackers[0]);
	assert.equal(res.trackers[1], res.tracker);
});

test("finishDraft:已生效的定义幂等成功,不重复记变更", () => {
	const trackers: Tracker[] = [{ key: "t-1", name: "测试", quota: 3, changelog: [{ at: "x", text: "旧" }] }];
	const res = finishDraft(trackers, "t-1");
	assert.ok(res);
	assert.equal(res.changed, false);
	assert.equal(res.trackers, trackers);
	assert.equal(res.tracker.changelog?.length, 1);
});

test("finishDraft:trackerKey 不存在返回 null", () => {
	assert.equal(finishDraft([{ key: "t-1", name: "测试", quota: 3 }], "t-404"), null);
});
