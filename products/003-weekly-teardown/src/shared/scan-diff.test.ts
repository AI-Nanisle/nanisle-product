// scan-diff.ts 的测试。跑法:npm test。
//
// 这一份**全是纯函数**:喂两周的候选快照,断言四类变化各自被认出来。
// 为什么值得单独一份而不是塞进 cron 的端到端里:跨周增量出错的形状是
// 「邮件里写了一条根本没发生的变化」,而那种错在一封邮件里看不出来
// ——它没有报错、没有空白、读起来完全合理。只有拿两份自己造的快照去比,
// 才能断言「这一条变化确实来自这两周之间的差」。

import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { EMPTY_RECHECK, STAR_JUMP_CAP, STAR_JUMP_FLOOR, diffWeeks, foldRecheck, starJumpThreshold } from "./scan-diff.ts";
import type { RecheckOutcome, RepoSnapshot } from "./scan-diff.ts";

const r = (fullName: string, over: Partial<RepoSnapshot> = {}): RepoSnapshot => ({
	fullName,
	stars: 100,
	archived: false,
	license: "MIT",
	...over,
});

const week = (weekOf: string, repos: RepoSnapshot[]) => ({ weekOf, repos });

describe("diffWeeks · 第一周", () => {
	it("没有上一周时如实说,不假装有增量", () => {
		const d = diffWeeks(null, week("2026-W36", [r("a/one"), r("b/two")]));
		assert.equal(d.prevWeekOf, null);
		assert.equal(d.changed, false);
		// **本周这两个不算「新出现」**:第一周把全部候选算成新增,读起来像一份
		// 热闹的增量,实际零信息量,还会让第二周真正的新增失去分量。
		assert.deepEqual(d.appeared, []);
		assert.deepEqual(d.archivedNow, []);
		assert.deepEqual(d.licenseChanged, []);
		assert.deepEqual(d.starJumps, []);
	});
});

describe("diffWeeks · 四类变化", () => {
	it("新出现的仓:上一周的候选清单里没有它", () => {
		const prev = week("2026-W35", [r("a/one")]);
		const curr = week("2026-W36", [r("a/one"), r("new/comer")]);
		const d = diffWeeks(prev, curr);
		assert.deepEqual(d.appeared, ["new/comer"]);
		assert.equal(d.prevWeekOf, "2026-W35");
		assert.equal(d.changed, true);
	});

	it("上周有、这周掉出清单的**不报**:这一节讲的是「新出现了什么」", () => {
		const d = diffWeeks(week("2026-W35", [r("a/one"), r("gone/away")]), week("2026-W36", [r("a/one")]));
		assert.deepEqual(d.appeared, []);
		assert.equal(d.changed, false);
	});

	it("转归档:archived 由 false 变 true", () => {
		const d = diffWeeks(
			week("2026-W35", [r("a/one", { archived: false }), r("b/two", { archived: true })]),
			week("2026-W36", [r("a/one", { archived: true }), r("b/two", { archived: true })]),
		);
		// b/two 上周就是归档的,不是「转」归档 —— 只报状态发生翻转的那一个
		assert.deepEqual(d.archivedNow, ["a/one"]);
	});

	it("换许可证:包括「本来没有许可证」和「变成没有许可证」两个方向", () => {
		const d = diffWeeks(
			week("2026-W35", [r("a/one", { license: "MIT" }), r("b/two", { license: null }), r("c/same", { license: "MIT" })]),
			week("2026-W36", [r("a/one", { license: null }), r("b/two", { license: "Apache-2.0" }), r("c/same", { license: "MIT" })]),
		);
		assert.deepEqual(d.licenseChanged, [
			{ fullName: "a/one", from: "MIT", to: null },
			{ fullName: "b/two", from: null, to: "Apache-2.0" },
		]);
	});

	it("star 跃迁:超过阈值才算,而且只报涨不报跌", () => {
		const d = diffWeeks(
			week("2026-W35", [r("up/big", { stars: 1000 }), r("up/small", { stars: 1000 }), r("down/one", { stars: 1000 })]),
			week("2026-W36", [r("up/big", { stars: 1400 }), r("up/small", { stars: 1050 }), r("down/one", { stars: 400 })]),
		);
		// 1000 的阈值是 200(20%):+400 算,+50 不算,-600 一律不算
		assert.deepEqual(d.starJumps, [{ fullName: "up/big", from: 1000, to: 1400, delta: 400 }]);
	});

	it("四类可以同时发生,changed 只要有一条就为 true", () => {
		const d = diffWeeks(
			week("2026-W35", [r("a/one", { stars: 500, license: "MIT", archived: false })]),
			week("2026-W36", [r("a/one", { stars: 900, license: "AGPL-3.0", archived: true }), r("new/one")]),
		);
		assert.deepEqual(d.appeared, ["new/one"]);
		assert.deepEqual(d.archivedNow, ["a/one"]);
		assert.equal(d.licenseChanged.length, 1);
		assert.equal(d.starJumps.length, 1);
		assert.equal(d.changed, true);
	});

	it("新进清单的仓不参与后三类:它没有「上一周的自己」可比", () => {
		// 一个这周才进清单、而且是归档的仓,不该同时被报成「转归档」——
		// 那是在说一件我们不知道的事(它上周归没归档,我们没有记录)。
		const d = diffWeeks(week("2026-W35", []), week("2026-W36", [r("new/archived", { archived: true, license: null })]));
		assert.deepEqual(d.appeared, ["new/archived"]);
		assert.deepEqual(d.archivedNow, []);
		assert.deepEqual(d.licenseChanged, []);
		assert.deepEqual(d.starJumps, []);
	});
});

describe("starJumpThreshold · 比例夹住两头", () => {
	it("小仓由下限接管:20% 只有几颗星,那不是信号是噪声", () => {
		assert.equal(starJumpThreshold(8), STAR_JUMP_FLOOR);
		assert.equal(starJumpThreshold(0), STAR_JUMP_FLOOR);
		// 8 星涨到 12(+50%)不报;涨到 60(+52)才报
		assert.deepEqual(diffWeeks(week("w1", [r("t/t", { stars: 8 })]), week("w2", [r("t/t", { stars: 12 })])).starJumps, []);
		assert.equal(diffWeeks(week("w1", [r("t/t", { stars: 8 })]), week("w2", [r("t/t", { stars: 60 })])).starJumps.length, 1);
	});

	it("中间档按 20% 比例", () => {
		assert.equal(starJumpThreshold(500), 100);
		assert.equal(starJumpThreshold(5000), 1000);
	});

	it("大仓由上限接管:纯比例的话 5 万星的仓永远触发不了", () => {
		assert.equal(starJumpThreshold(50_000), STAR_JUMP_CAP);
		// 5 万星一周涨两千是新闻;要求 20%(一万星)等于这一类对大仓永不触发
		assert.equal(
			diffWeeks(week("w1", [r("t/t", { stars: 50_000 })]), week("w2", [r("t/t", { stars: 52_000 })])).starJumps.length,
			1,
		);
	});
});

// ---------------------------------------------------------------------------
// 复查(阶段 9)
// ---------------------------------------------------------------------------

/** 复查结局的 map,写起来短一点。 */
const outcomes = (m: Record<string, RecheckOutcome>) => new Map(Object.entries(m));
const listed = (...names: string[]) => new Set(names);

describe("foldRecheck · 三种结局必须分开", () => {
	it("**掉出清单 + 已归档**照样报 —— 这正是阶段 8 看不见的那件事", () => {
		// 上周清单上有 dead/one,这周它归档了,于是被规则层筛掉、不在本周清单里。
		// 只比「上周清单 vs 本周清单」的话,它只是安静地消失。
		const rep = foldRecheck(
			[r("dead/one"), r("a/two")],
			outcomes({ "dead/one": { kind: "ok", repo: r("dead/one", { archived: true }) }, "a/two": { kind: "ok", repo: r("a/two") } }),
			listed("a/two"),
		);
		assert.equal(rep.checked, 2);
		assert.equal(rep.changed, 1);
		assert.equal(rep.unchecked, 0);
		assert.deepEqual(rep.changes, [{ fullName: "dead/one", kind: "archived", stillListed: false }]);
	});

	it("仓被删(404 → gone)是一种变化,不是一次失败", () => {
		const rep = foldRecheck([r("poof/gone")], outcomes({ "poof/gone": { kind: "gone" } }), listed());
		assert.equal(rep.changed, 1);
		assert.equal(rep.unchecked, 0);
		assert.equal(rep.changes[0]!.kind, "gone");
		// 它给出了答案 → diffWeeks 不该再为它报一遍
		assert.deepEqual(rep.resolved, ["poof/gone"]);
	});

	it("**GitHub 挂了不是「仓没了」**:进 unchecked,不进 changes,也不进 resolved", () => {
		const rep = foldRecheck(
			[r("a/one")],
			outcomes({ "a/one": { kind: "unchecked", why: "GET /repos/a/one 失败:HTTP 503" } }),
			listed("a/one"),
		);
		assert.equal(rep.checked, 1);
		assert.equal(rep.changed, 0);
		assert.equal(rep.unchecked, 1);
		assert.deepEqual(rep.changes, []);
		assert.deepEqual(rep.resolved, []);
		assert.equal(rep.unavailable[0]!.why, "GET /repos/a/one 失败:HTTP 503");
	});

	it("分母是「本该查几个」不是「查成几个」—— 否则全挂的那一周印出来是「一切正常」", () => {
		const rep = foldRecheck(
			[r("a/one"), r("b/two"), r("c/three")],
			outcomes({
				"a/one": { kind: "unchecked", why: "503" },
				"b/two": { kind: "unchecked", why: "503" },
				"c/three": { kind: "unchecked", why: "503" },
			}),
			listed(),
		);
		assert.equal(rep.checked, 3);
		assert.equal(rep.unchecked, 3);
	});

	it("没有结局的仓当成 unchecked,不当成「没变化」", () => {
		const rep = foldRecheck([r("a/one")], outcomes({}), listed("a/one"));
		assert.equal(rep.unchecked, 1);
		assert.match(rep.unavailable[0]!.why, /没轮到/);
	});

	it("一个仓同时归档 + 换许可证:changes 两条,但只算一个仓有变化", () => {
		const rep = foldRecheck(
			[r("x/y")],
			outcomes({ "x/y": { kind: "ok", repo: r("x/y", { archived: true, license: "AGPL-3.0" }) } }),
			listed(),
		);
		assert.equal(rep.changes.length, 2);
		assert.equal(rep.changed, 1);
	});

	// -------------------------------------------------------------------------
	// resolved vs unchanged(2026-09-01 冻结前最后一轮)
	//
	// 任务书和直觉都会把 resolved 读成「查过没事」,而它的定义是「复查真的给出了
	// 答案(ok **或** gone)」—— **它包含刚被删库的那几个**。照字面渲染就会把一个
	// 死掉的仓印在「没事」那一栏,正好是那一屏最想避免的错。
	// -------------------------------------------------------------------------

	it("**gone 的仓在 resolved 里,但绝不在 unchanged 里** —— 两个字段的全部区别就在这一条", () => {
		const rep = foldRecheck(
			[r("poof/gone"), r("fine/one")],
			outcomes({ "poof/gone": { kind: "gone" }, "fine/one": { kind: "ok", repo: r("fine/one") } }),
			listed("fine/one"),
		);
		assert.ok(rep.resolved.includes("poof/gone"), "它给出了答案 → 在 resolved 里");
		assert.ok(!rep.unchanged.includes("poof/gone"), "但「没了」不是「没事」→ 不在 unchanged 里");
		assert.deepEqual(rep.unchanged, ["fine/one"]);
	});

	it("出了事的仓(归档 / 换许可证)同样只进 resolved,不进 unchanged", () => {
		const rep = foldRecheck(
			[r("dead/one"), r("lic/two"), r("fine/three")],
			outcomes({
				"dead/one": { kind: "ok", repo: r("dead/one", { archived: true }) },
				"lic/two": { kind: "ok", repo: r("lic/two", { license: "AGPL-3.0" }) },
				"fine/three": { kind: "ok", repo: r("fine/three") },
			}),
			listed(),
		);
		assert.deepEqual(rep.resolved, ["dead/one", "lic/two", "fine/three"]);
		assert.deepEqual(rep.unchanged, ["fine/three"]);
	});

	it("没查成的仓两个集合都不进(它既不是「有答案」也不是「没事」)", () => {
		const rep = foldRecheck([r("shy/one")], outcomes({ "shy/one": { kind: "unchecked", why: "503" } }), listed());
		assert.deepEqual(rep.resolved, []);
		assert.deepEqual(rep.unchanged, []);
	});

	it("**账要平**:checked = changed(仓数) + unchecked + unchanged.length —— 页面自检验的就是这条", () => {
		const rep = foldRecheck(
			// 5 个仓:1 个没了、1 个同时归档+换证(两条一个仓)、1 个没查成、2 个没事
			[r("poof/gone"), r("both/x"), r("shy/one"), r("fine/a"), r("fine/b")],
			outcomes({
				"poof/gone": { kind: "gone" },
				"both/x": { kind: "ok", repo: r("both/x", { archived: true, license: null }) },
				"shy/one": { kind: "unchecked", why: "503" },
				"fine/a": { kind: "ok", repo: r("fine/a") },
				"fine/b": { kind: "ok", repo: r("fine/b") },
			}),
			listed(),
		);
		assert.equal(rep.checked, 5);
		assert.equal(rep.changed, 2, "仓数:没了的那个 + 同时归档换证的那个");
		assert.equal(rep.changes.length, 3, "条数比仓数多 —— 所以等式里不能用 changes.length");
		assert.equal(rep.unchecked, 1);
		assert.deepEqual(rep.unchanged, ["fine/a", "fine/b"]);
		assert.equal(rep.checked, rep.changed + rep.unchecked + rep.unchanged.length);
	});

	it("EMPTY_RECHECK 的 unchanged 也是空的(没做复查时一个字都不该提)", () => {
		assert.deepEqual(EMPTY_RECHECK.unchanged, []);
		assert.equal(diffWeeks(week("w1", [r("x/y")]), week("w2", [r("x/y")])).recheck.unchanged.length, 0);
	});

	it("还在清单里的仓,stillListed 为 true", () => {
		const rep = foldRecheck(
			[r("x/y")],
			outcomes({ "x/y": { kind: "ok", repo: r("x/y", { license: null }) } }),
			listed("x/y"),
		);
		assert.equal(rep.changes[0]!.stillListed, true);
		assert.deepEqual(rep.changes[0]!.license, { from: "MIT", to: null });
	});
});

describe("diffWeeks × 复查 · 同一件事不报两遍", () => {
	it("复查给出答案的仓,周扫那条口径就不再报它(否则邮件里同一条出现两次)", () => {
		const prev = week("2026-W35", [r("x/y")]);
		const curr = week("2026-W36", [r("x/y", { license: null })]);
		const rep = foldRecheck(prev.repos, outcomes({ "x/y": { kind: "ok", repo: r("x/y", { license: null }) } }), listed("x/y"));
		const d = diffWeeks(prev, curr, rep);
		assert.deepEqual(d.licenseChanged, []); // 周扫那条不报
		assert.equal(d.recheck.changes.length, 1); // 复查那条报了
		assert.equal(d.changed, true);
	});

	it("复查**没查成**的仓退回用周扫比一次 —— 少说一条真变化比重复更糟", () => {
		const prev = week("2026-W35", [r("x/y")]);
		const curr = week("2026-W36", [r("x/y", { license: null })]);
		const rep = foldRecheck(prev.repos, outcomes({ "x/y": { kind: "unchecked", why: "503" } }), listed("x/y"));
		const d = diffWeeks(prev, curr, rep);
		assert.equal(d.licenseChanged.length, 1);
		assert.equal(d.changed, true);
	});

	it("只有复查报出变化时,changed 也必须是 true", () => {
		const prev = week("2026-W35", [r("dead/one")]);
		const curr = week("2026-W36", []); // 归档之后被规则筛掉,本周清单是空的
		const rep = foldRecheck(prev.repos, outcomes({ "dead/one": { kind: "ok", repo: r("dead/one", { archived: true }) } }), listed());
		const d = diffWeeks(prev, curr, rep);
		assert.deepEqual(d.appeared, []);
		assert.deepEqual(d.archivedNow, []);
		assert.equal(d.changed, true);
	});

	it("不传复查时和阶段 8 一模一样(EMPTY_RECHECK,checked=0)", () => {
		const d = diffWeeks(week("w1", [r("x/y")]), week("w2", [r("x/y", { archived: true })]));
		assert.deepEqual(d.archivedNow, ["x/y"]);
		assert.equal(d.recheck.checked, 0);
	});
});
