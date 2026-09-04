// scan-groups.ts 的分组口径。跑法:npm test。
//
// **历史**:分组曾经是拿 `reason` 的中文文案去认的,而文案是 scan-rules.ts 写的。
// 两边分叉的症状是「一大批排除条目掉进『其他』组」——不报错、不崩、页面照样
// 好看(docs/01 风险 1「错得很安静」)。当时靠一组「真的调 excludeReason() 造
// 理由再交给分类器」的用例钉着;2026-09-01 阶段 4/5 评审给 scan_exclusion 加了
// `reason_kind` 一列,分组改读那一列,文案退回纯显示。
//
// 那一组用例因此**简化但没有删**:
//   ① excludeReason 产出的 kind 逐条对得上分组键(reason 文案已经不参与分组,
//      所以不必再逐字比对文案,但 kind 仍然必须来自真函数,不许手抄);
//   ② **每个 kind 都有对应的中文文案且非空** —— 加了新 kind 却没写标签/说明,
//      症状是页面上出现一个没有名字的分组头,同样是安静的错。

import assert from "node:assert/strict";
import { describe, it } from "node:test";

import {
	GROUP_META,
	classifyExclusion,
	defaultOpen,
	groupExclusions,
	notReachedReason,
	rankedOutRank,
	rankedOutReason,
} from "./scan-groups.ts";
import type { ExclusionGroupKey } from "./scan-groups.ts";
import { COPYLEFT_SPDX, TINY_STARS, excludeReason } from "./scan-rules.ts";
import type { RuleInput } from "./scan-rules.ts";
import type { ExclusionKind } from "./types.ts";

const NOW = Date.parse("2026-09-01T00:00:00Z");

/** 一个各方面都健康的仓,下面每条用例只改触发那一条规则的字段。 */
const healthy: RuleInput = {
	archived: false,
	pushedAt: "2026-08-20T00:00:00Z",
	createdAt: "2022-01-01T00:00:00Z",
	license: "MIT",
	stars: 500,
};

/** excludeReason 真的产出 kind,再交给分类器。**中间不许手抄。** */
function keyOfRule(over: Partial<RuleInput>): ExclusionGroupKey {
	const hit = excludeReason({ ...healthy, ...over }, NOW);
	assert.ok(hit, "这组输入本该被规则筛掉,但 excludeReason 放行了 —— 用例本身失效了");
	return classifyExclusion({ reasonKind: hit.kind, reasonSource: "rule" });
}

const excl = (
	fullName: string,
	reason: string,
	over: Partial<{ reasonKind: ExclusionKind; reasonSource: "rule" | "model"; appealedAt: number | null }> = {},
) => ({
	scanId: "s1",
	fullName,
	reason,
	reasonKind: "no-license" as ExclusionKind,
	reasonSource: "rule" as const,
	appealedAt: null as number | null,
	...over,
});

describe("规则产出的 kind 就是分组键(中间没有翻译表)", () => {
	it("已归档", () => assert.equal(keyOfRule({ archived: true }), "archived"));
	it("停更", () => assert.equal(keyOfRule({ pushedAt: "2023-04-01T00:00:00Z" }), "stale"));
	it("AGPL", () => assert.equal(keyOfRule({ license: COPYLEFT_SPDX[0]! }), "copyleft"));
	it("没有许可证", () => assert.equal(keyOfRule({ license: null }), "no-license"));
	it("太小", () => assert.equal(keyOfRule({ stars: TINY_STARS - 1, createdAt: "2020-01-01T00:00:00Z" }), "tiny"));

	it("每个 kind 都有对应的中文文案,而且非空", () => {
		// 加了新 kind 却没写标签/说明,症状是页面上出现一个没有名字的分组头
		// ——同样是「错得很安静」。类型层面的完整性由 scan-groups.ts 那条
		// `_EveryKindHasMeta` 断言钉着,这里钉的是**文案真的写了内容**。
		const kinds: ExclusionKind[] = [
			"archived",
			"stale",
			"copyleft",
			"no-license",
			"tiny",
			"ranked-out",
			"not-reached",
			"model",
		];
		for (const k of kinds) {
			const meta = GROUP_META.get(k);
			assert.ok(meta, `kind ${k} 没有 META,分组头会是空的`);
			assert.ok(meta.label.trim().length > 0, `kind ${k} 的 label 是空的`);
			assert.ok(meta.note.trim().length > 5, `kind ${k} 的 note 太短,等于没解释`);
		}
	});

	it("排名之外 / 没轮到验证:名次都能从理由里抠回来(组内排序靠它)", () => {
		assert.equal(rankedOutRank(rankedOutReason(7, 120)), 7);
		assert.equal(rankedOutRank(notReachedReason(9, 120, "配额不够")), 9);
	});

	it("库里出现这份代码不认识的 kind 时落进 other,而不是被丢掉", () => {
		assert.equal(classifyExclusion({ reasonKind: "某条将来才有的规则" as ExclusionKind, reasonSource: "rule" }), "other");
	});

	it("reasonSource 是 model 时,kind 再像规则也归 model", () => {
		// 这一条是分色承诺的底线:来源是落库的事实。数据写坏时,宁可把一条规则
		// 排除渲染成「模型判的」,也不能把模型判的渲染成「代码算的、你可以自己核」。
		assert.equal(classifyExclusion({ reasonKind: "archived", reasonSource: "model" }), "model");
	});
});

describe("groupExclusions", () => {
	const sample = [
		excl("a/one", "没有许可证,法律上不可用"),
		excl("b/two", "没有许可证,法律上不可用"),
		excl("c/three", "已归档(GitHub 字段)", { reasonKind: "archived" }),
		excl("d/four", rankedOutReason(9, 30), { reasonKind: "ranked-out" }),
		excl("e/five", rankedOutReason(6, 30), { reasonKind: "ranked-out" }),
		excl("f/six", "形态不同:它是一个浏览器插件", { reasonKind: "model", reasonSource: "model" }),
	];

	it("分组头上的条数是真实条数", () => {
		const { groups } = groupExclusions(sample);
		const byKey = new Map(groups.map((g) => [g.key, g]));
		assert.equal(byKey.get("no-license")!.count, 2);
		assert.equal(byKey.get("archived")!.count, 1);
		assert.equal(byKey.get("ranked-out")!.count, 2);
		assert.equal(byKey.get("model")!.count, 1);
		// count 必须等于真的渲染出去的条数,不是另算的一个数
		for (const g of groups) assert.equal(g.count, g.items.length);
	});

	it("未申诉条数之和 = 台账的 excluded(读者用来验「你说 293,点开真有 293」)", () => {
		const { total } = groupExclusions(sample);
		assert.equal(total, sample.length);
	});

	it("已申诉的摘出来单列,不再计入任何分组", () => {
		const withAppeal = [...sample, excl("g/seven", "没有许可证,法律上不可用", { appealedAt: 1_700_000_000_000 })];
		const { groups, appealed, total } = groupExclusions(withAppeal);
		assert.equal(appealed.length, 1);
		assert.equal(appealed[0]!.fullName, "g/seven");
		// 申诉时台账做的是 excluded-1,所以这里的和也必须不含它,否则两个数对不上
		assert.equal(total, sample.length);
		assert.ok(!groups.some((g) => g.items.some((e) => e.fullName === "g/seven")));
	});

	it("「排名之外」按名次升序 —— 第 6 名是差一点进清单的那个", () => {
		const { groups } = groupExclusions(sample);
		const ranked = groups.find((g) => g.key === "ranked-out")!;
		assert.deepEqual(ranked.items.map((e) => rankedOutRank(e.reason)), [6, 9]);
	});

	it("model 组一条都没有时也保留一行,其余空组不留", () => {
		const onlyRules = [excl("a/one", "已归档(GitHub 字段)", { reasonKind: "archived" })];
		const { groups } = groupExclusions(onlyRules);
		const model = groups.find((g) => g.key === "model");
		assert.ok(model, "「这一周一条模型判的排除都没有」本身就是要说出来的事实");
		assert.equal(model.count, 0);
		assert.ok(!groups.some((g) => g.key === "no-license"), "没发生的规则不该占版面");
	});

	it("每一组都带着 source,而且 model 组是唯一 source=model 的", () => {
		const { groups } = groupExclusions(sample);
		for (const g of groups) {
			assert.equal(g.source === "model", g.key === "model");
		}
	});
});

describe("defaultOpen", () => {
	const grp = (key: ExclusionGroupKey, count: number) => {
		const items = Array.from({ length: count }, (_, i) => excl(`x/${i}`, "已归档(GitHub 字段)", { reasonKind: "archived" }));
		return { key, label: "", block: "eligibility" as const, source: "rule" as const, note: "", count, items };
	};

	it("同质噪音默认折叠,几条的默认展开", () => {
		assert.equal(defaultOpen(grp("no-license", 117)), false);
		assert.equal(defaultOpen(grp("archived", 2)), true);
	});

	it("「排名之外」永远折叠,不管几条", () => {
		assert.equal(defaultOpen(grp("ranked-out", 3)), false);
		assert.equal(defaultOpen(grp("ranked-out", 153)), false);
	});
});
