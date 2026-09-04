// 规则层与 ISO 周编号的测试。跑法:npm test。
//
// 这两个模块是发现层里**唯一完全确定的部分**——没有网络、没有模型、没有 D1,
// 输入一份构造出来的 JSON 就能把每条分支钉死。所以它们的用例密度要比别处高:
// 规则层每条规则都配一个正例和一个反例(只有正例的话,一条「永远返回排除」
// 的坏规则照样全绿),ISO 周则专门打跨年那几天。

import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { COPYLEFT_SPDX, STALE_MONTHS, TINY_STARS, excludeReason } from "./scan-rules.ts";
import type { RuleInput } from "./scan-rules.ts";
import { WEEK_OF_RE, isoWeek } from "./week.ts";

/** 「今天」钉死,免得用例在真实时间往前走之后开始飘。 */
const NOW = Date.UTC(2026, 8, 1); // 2026-09-01

/**
 * 一条规则排除的两半:**给人读的中文 reason** 和**给机器读的 kind**。
 * 每条规则都要把两半一起钉住 —— kind 是落库那一列(scan_exclusion.reason_kind,
 * 第一屏按它分组),reason 是显示文案。只钉一半的话,改文案时 kind 会跟着漂,
 * 而那正是加这一列要消灭的东西。
 */
const why = (r: RuleInput, now: number = NOW) => excludeReason(r, now);
const reasonOf = (r: RuleInput, now: number = NOW) => why(r, now)?.reason ?? null;
const kindOf = (r: RuleInput, now: number = NOW) => why(r, now)?.kind ?? null;

/** 一个什么毛病都没有的仓:每条用例只改它的一个字段,反例才有意义。 */
const clean = (over: Partial<RuleInput> = {}): RuleInput => ({
	archived: false,
	pushedAt: "2026-08-20T00:00:00Z",
	createdAt: "2023-01-05T00:00:00Z",
	license: "MIT",
	stars: 900,
	...over,
});

describe("excludeReason · 规则层(模型不接触)", () => {
	it("基线:干净的仓不被任何规则筛掉(反例的公共前提)", () => {
		assert.equal(why(clean()), null);
	});

	it("已归档:archived=true 筛掉,false 不筛", () => {
		assert.equal(reasonOf(clean({ archived: true })), "已归档(GitHub 字段)");
		assert.equal(reasonOf(clean({ archived: false })), null);
	});

	it(`停更:push 早于 ${STALE_MONTHS} 个月筛掉,刚好在窗口内不筛`, () => {
		// 2024-07 距 2026-09 已经 26 个月
		assert.equal(reasonOf(clean({ pushedAt: "2024-07-11T00:00:00Z" })), "最后一次 push 在 2024-07");
		// 17 个月前(2025-04)仍在窗口内 —— 边界那一侧必须留一个反例,
		// 否则把 18 写成 8 也一样全绿
		assert.equal(reasonOf(clean({ pushedAt: "2025-04-01T00:00:00Z" })), null);
	});

	it("停更的理由带上真实年月(不是一句笼统的「太久了」)", () => {
		assert.equal(reasonOf(clean({ pushedAt: "2019-12-31T23:00:00Z" })), "最后一次 push 在 2019-12");
	});

	it("许可证冲突:AGPL 家族每一种写法都筛掉,MIT / Apache 不筛", () => {
		for (const spdx of COPYLEFT_SPDX) {
			assert.equal(reasonOf(clean({ license: spdx })), "AGPL 会污染 MIT", spdx);
		}
		assert.equal(reasonOf(clean({ license: "MIT" })), null);
		assert.equal(reasonOf(clean({ license: "Apache-2.0" })), null);
		// GPL-3.0 也传染,但它不在这条规则的名单里(docs/02 只写了 AGPL)。
		// 钉住现状:要加是一次有意的改动,不该靠某次重构悄悄发生。
		assert.equal(reasonOf(clean({ license: "GPL-3.0" })), null);
	});

	it("无许可证:license 为 null 筛掉;NOASSERTION 不算「没有许可证」", () => {
		assert.equal(reasonOf(clean({ license: null })), "没有许可证,法律上不可用");
		// GitHub 认出有 LICENSE 文件但识别不出是哪个时给 NOASSERTION。
		// 把它当成「没有许可证」会让排除理由变成假话(点开一看明明有文件)。
		assert.equal(reasonOf(clean({ license: "NOASSERTION" })), null);
	});

	it(`太小:不到 ${TINY_STARS} 星**且**建了一年以上才筛;上个月建的不筛`, () => {
		assert.equal(
			reasonOf(clean({ stars: 3, createdAt: "2022-02-01T00:00:00Z" })),
			`一年了还不到 ${TINY_STARS} 星`,
		);
		// 两个判据要同时成立:9 星但上个月才建的仓,正是双路检索里
		// sort=updated 那一路最该捞回来的东西,不能被这条规则误伤
		assert.equal(reasonOf(clean({ stars: 9, createdAt: "2026-08-01T00:00:00Z" })), null);
		// 老仓但星够:同样不筛
		assert.equal(reasonOf(clean({ stars: 10, createdAt: "2019-01-01T00:00:00Z" })), null);
	});

	it("同时满足几条时,给出最能解释它的那一条(归档 > 停更)", () => {
		const zombie = clean({ archived: true, pushedAt: "2021-01-01T00:00:00Z", license: null, stars: 1 });
		assert.equal(reasonOf(zombie), "已归档(GitHub 字段)");
		assert.equal(kindOf(zombie), "archived", "kind 也要跟着走那条最能解释它的规则");
	});

	it("每条规则同时给出 kind:分组读它,不读中文文案", () => {
		// 这一组是 scan_exclusion.reason_kind 那一列的全部来源。改中文文案不该
		// 动这里的任何一个值 —— 那正是加这一列的意思(阶段 4/5 评审)。
		assert.equal(kindOf(clean({ archived: true })), "archived");
		assert.equal(kindOf(clean({ pushedAt: "2024-07-11T00:00:00Z" })), "stale");
		assert.equal(kindOf(clean({ license: COPYLEFT_SPDX[0]! })), "copyleft");
		assert.equal(kindOf(clean({ license: null })), "no-license");
		assert.equal(kindOf(clean({ stars: 3, createdAt: "2022-02-01T00:00:00Z" })), "tiny");
		assert.equal(kindOf(clean()), null, "没被筛掉就没有 kind");
	});

	it("日期解析不动时放行,不是筛掉(错得很安静比放个怪东西进来更危险)", () => {
		assert.equal(reasonOf(clean({ pushedAt: "" })), null);
		assert.equal(reasonOf(clean({ createdAt: "not-a-date", stars: 1 })), null);
	});
});

describe("isoWeek · 跨年边界", () => {
	const w = (y: number, m: number, d: number) => isoWeek(Date.UTC(y, m - 1, d));

	it("常规的一周(docs/02 举的那个例子)", () => {
		assert.equal(w(2026, 9, 1), "2026-W36");
		assert.match(w(2026, 9, 1), WEEK_OF_RE);
	});

	it("12 月的日期归到下一年:2024-12-30(周一)是 2025-W01", () => {
		assert.equal(w(2024, 12, 30), "2025-W01");
		assert.equal(w(2024, 12, 31), "2025-W01");
		assert.equal(w(2025, 1, 1), "2025-W01");
		// 前一天还留在 2024:边界的另一侧必须钉住,否则「整个 12 月都算下一年」
		// 这种错法也会全绿
		assert.equal(w(2024, 12, 29), "2024-W52");
	});

	it("1 月的日期归到上一年:2021-01-01(周五)是 2020-W53", () => {
		assert.equal(w(2021, 1, 1), "2020-W53");
		assert.equal(w(2021, 1, 3), "2020-W53");
		assert.equal(w(2021, 1, 4), "2021-W01");
	});

	it("53 周的年份真的存在(2015 / 2020),不是 52 周封顶", () => {
		assert.equal(w(2015, 12, 28), "2015-W53");
		assert.equal(w(2016, 1, 1), "2015-W53");
		assert.equal(w(2020, 12, 28), "2020-W53");
		assert.equal(w(2020, 12, 31), "2020-W53");
	});

	it("2025-12-29(周一)已经是 2026-W01,而前一天还是 2025-W52", () => {
		assert.equal(w(2025, 12, 28), "2025-W52");
		assert.equal(w(2025, 12, 29), "2026-W01");
		assert.equal(w(2026, 1, 1), "2026-W01");
	});

	it("周数补到两位:字典序排出来就是时间序(store.ts 靠这个 ORDER BY)", () => {
		assert.equal(w(2026, 3, 2), "2026-W10");
		const ordered = [w(2025, 12, 28), w(2025, 12, 29), w(2026, 3, 2), w(2026, 9, 1)];
		assert.deepEqual([...ordered].sort(), ordered);
		// 没补零的话 "2026-W9" 会排到 "2026-W10" 后面去
		assert.ok(w(2026, 2, 23) < w(2026, 3, 2));
	});

	it("同一天的任何时刻算出同一周;Date 和毫秒数两种入参等价", () => {
		const a = isoWeek(Date.UTC(2026, 8, 1, 0, 0, 0));
		const b = isoWeek(Date.UTC(2026, 8, 1, 23, 59, 59));
		const c = isoWeek(new Date(Date.UTC(2026, 8, 1, 12)));
		assert.equal(a, b);
		assert.equal(a, c);
	});
});
