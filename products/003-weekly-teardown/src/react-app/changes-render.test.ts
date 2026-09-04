// 第四屏(跨周变化)的**渲染层**回归测试。跑法:npm test。
//
// 为什么这一屏比前三屏更需要这一层:它的每一条产品承诺都是「**两种状态必须
// 说成两句不同的话**」这种形状,而说成同一句话**不会报错、不会崩、不会少显示
// 任何东西**——页面看起来完全正常,只是在某一种状态下安静地说了假话。这正是
// docs/01 风险 1 那句「错得很安静」的原形,而这一屏是全站离它最近的一屏:
//
//   `change: null`(没记过) vs `counts.changed === false`(记了、没变化)
//   `recheck.unavailable`(没查成) vs `kind: "gone"`(已经没了)
//   `stillListed === false`(掉出清单) vs 「它出事了」
//   `recheckChecked === 0`(没做复查) vs 「复查了 0 个」(做了、没发现)
//   第一周(没得比) vs 四格全 0(比过了、没变化)
//
// 每一对里的两种都能在纯函数层测得很绿:计数是对的、数组长度是对的、类型是对的。
// 只有把它渲染成 HTML 再在 HTML 里找那句话,才抓得住「两种状态被写成了同一句」。
//
// 打包方式与 scan-render.test.ts 同款(esbuild → node_modules/.cache,react 保持
// external 以便共用同一个 React 实例),理由在 render.test.ts 顶部写全了。
//
// **这套用例测不到什么**(如实记):
//   - App.tsx 里的取数与翻周接线(哪一周该发哪两条请求、换周时先把手上那份清掉)。
//     SSR 渲染器驱动不了状态更新,这一段靠 TypeScript 和 `wrangler dev --local` 实跑兜。
//   - CSS。三栏的颜色是不是真的一冷一暖只能靠眼睛;这里只断言它们渲染出**不同的
//     class、落在不同的容器里**,那是「分得开」的必要条件不是充分条件。
//   - 重跑确认框和它的回执在 scan-render.test.ts 里(它们属于本周清单那一屏的模块)。

import assert from "node:assert/strict";
import { mkdirSync } from "node:fs";
import path from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { before, describe, it } from "node:test";

import React from "react";
import ReactDOMServer from "react-dom/server";

import type {
	GetScanResponse,
	RecheckReport,
	WeekDiff,
	WeeklyChange,
	WeeklyChangeCounts,
	WeeklyScan,
} from "../shared/types.ts";
import { searchForView, viewInSearch, weekOfInSearch } from "./view.ts";

const HERE = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(HERE, "../..");
const OUT = path.join(ROOT, "node_modules/.cache/nanisle-003-render/changes.mjs");

let mod: {
	default: (props: any) => unknown;
	WeekPicker: (props: any) => unknown;
	NoChangeRecord: (props: any) => unknown;
	FirstWeek: (props: any) => unknown;
	ChangeCheck: (props: any) => unknown;
	CrossWeek: (props: any) => unknown;
	RecheckCheck: (props: any) => unknown;
	RecheckChangeRow: (props: any) => unknown;
	RecheckPanel: (props: any) => unknown;
	WeekBundle: (props: any) => unknown;
};

before(async () => {
	const esbuild = (await import("esbuild")) as any;
	const build = (esbuild.build ?? esbuild.default?.build) as (o: unknown) => Promise<unknown>;
	mkdirSync(path.dirname(OUT), { recursive: true });
	await build({
		entryPoints: [path.join(HERE, "Changes.tsx")],
		outfile: OUT,
		bundle: true,
		format: "esm",
		platform: "neutral",
		jsx: "automatic",
		external: ["react", "react-dom", "react/jsx-runtime"],
		logLevel: "silent",
	});
	mod = (await import(`${pathToFileURL(OUT).href}?t=${Date.now()}`)) as typeof mod;
});

const html = (comp: (p: any) => unknown, props: Record<string, unknown>): string =>
	ReactDOMServer.renderToStaticMarkup(React.createElement(comp as never, props as never));

// ---------------------------------------------------------------------------
// 夹具:形状照着本地库里那两周(W35 / W36)和那趟真复查来
//   facebookarchive/draft-js  转归档,并且掉出了清单
//   google/gxui               换许可证(MIT → BSD-3-Clause),也掉出了清单
//   nanisle-test/...-003      GitHub 上 404 —— 已经没了
// ---------------------------------------------------------------------------

const week = (over: Partial<WeeklyScan> = {}): WeeklyScan => ({
	id: "d1#2026-W36",
	dossierId: "d1",
	weekOf: "2026-W36",
	dossierRev: 1,
	queries: ["llm memory", "context engineering"],
	returned: 176,
	admitted: 5,
	excluded: 171,
	fetchFailed: 0,
	routeCount: 2,
	claimedTotal: 81234,
	stopped: null,
	createdAt: 1,
	...over,
});

const recheck = (over: Partial<RecheckReport> = {}): RecheckReport => ({
	checked: 4,
	changed: 3,
	unchecked: 0,
	changes: [
		{ fullName: "facebookarchive/draft-js", kind: "archived", stillListed: false },
		{ fullName: "google/gxui", kind: "license", license: { from: "MIT", to: "BSD-3-Clause" }, stillListed: false },
		{ fullName: "nanisle-test/definitely-not-a-real-repo-003", kind: "gone", stillListed: false },
	],
	unavailable: [],
	resolved: [
		"facebookarchive/draft-js",
		"google/gxui",
		"nanisle-test/definitely-not-a-real-repo-003",
		"mem0ai/mem0",
	],
	// **只有它是「查过、真的没事」的**。上面 resolved 那四个里有三个出了事
	// (含一个删库的)—— 后端给出这一栏之前,每个下游都得自己记得做这个减法。
	unchanged: ["mem0ai/mem0"],
	...over,
});

const diff = (over: Partial<WeekDiff> = {}): WeekDiff => ({
	prevWeekOf: "2026-W35",
	appeared: ["alibaba/zvec", "mem0ai/mem0"],
	archivedNow: ["some/dead"],
	licenseChanged: [{ fullName: "acme/widget", from: "MIT", to: "AGPL-3.0" }],
	starJumps: [{ fullName: "hot/thing", from: 120, to: 640, delta: 520 }],
	recheck: recheck(),
	changed: true,
	...over,
});

const counts = (over: Partial<WeeklyChangeCounts> = {}): WeeklyChangeCounts => ({
	appeared: 2,
	archived: 1,
	licenseChanged: 1,
	starJumps: 1,
	recheckChecked: 4,
	recheckChanged: 3,
	recheckUnchecked: 0,
	changed: true,
	...over,
});

const change = (over: Partial<WeeklyChange> = {}): WeeklyChange => ({
	scanId: "d1#2026-W36",
	dossierId: "d1",
	weekOf: "2026-W36",
	prevWeekOf: "2026-W35",
	counts: counts(),
	diff: diff(),
	createdAt: 1,
	...over,
});

/** 整屏。默认不带那一周的清单(WeekBundle 的空态自己有用例)。 */
const screen = (props: Record<string, unknown> = {}): string =>
	ReactDOMServer.renderToStaticMarkup(
		React.createElement(mod.default as never, {
			change: change(),
			picked: "2026-W36",
			scans: [week()],
			onPick: null,
			weekScan: null,
			...props,
		} as never),
	);

// ---------------------------------------------------------------------------
// 1 · 「没有跨周记录」 ≠ 「记了,一个变化都没有」
// ---------------------------------------------------------------------------

describe("200 + change:null 和 counts.changed === false 是两句不同的话", () => {
	// 这是整份用例里最重要的一条,理由和 scan-render.test.ts 里那条「honesty 说 5、
	// 候选只有 2 行」一样:两种状态在库里、在类型上、在计数上都不同,唯独在**屏幕上**
	// 可能被写成同一句 —— 而写成同一句之后,一个从来没被算过跨周结论的星期会显示成
	// 「一切照旧」,没有任何一处会报错。
	const nulled = () => screen({ change: null });
	const quiet = () =>
		html(mod.CrossWeek, {
			change: change({
				counts: counts({ appeared: 0, archived: 0, licenseChanged: 0, starJumps: 0, changed: false }),
				diff: diff({ appeared: [], archivedNow: [], licenseChanged: [], starJumps: [], changed: false }),
			}),
		});

	it("change 为 null 时说的是「没有跨周记录」,不提「变化」", () => {
		const out = nulled();
		assert.match(out, /没有跨周记录/);
		assert.ok(!out.includes("一个变化都没有"), "「没记过」不许说成「没变化」");
	});

	it("counts.changed 为 false 时说的是「比过了,一个变化都没有」", () => {
		const out = quiet();
		assert.match(out, /一个变化都没有/);
		assert.match(out, /比过了/);
		assert.ok(!out.includes("没有跨周记录"), "「记了、没变化」不许说成「没记过」");
	});

	it("**两句话必须不同**(退回成同一句时这一条当场红)", () => {
		const a = nulled();
		const b = quiet();
		assert.ok(a.includes("没有跨周记录") && !b.includes("没有跨周记录"));
		assert.ok(b.includes("一个变化都没有") && !a.includes("一个变化都没有"));
	});

	it("「没记过」那一屏要说清它不等于「什么都没变」,并给出三种可能", () => {
		const out = nulled();
		assert.match(out, /不等于「这一周什么都没变」/);
		assert.match(out, /还没跑过周扫/);
		assert.match(out, /上线之前/);
		assert.match(out, /明细坏了/);
	});

	it("counts.changed 为 true 时不出现那句「一个变化都没有」", () => {
		assert.ok(!html(mod.CrossWeek, { change: change() }).includes("一个变化都没有"));
	});
});

// ---------------------------------------------------------------------------
// 2 · recheckChecked === 0:一个字都不许提复查
// ---------------------------------------------------------------------------

describe("没做复查的那一周,页面上一个「复查」都不许出现", () => {
	// 说「复查了 0 个」是把「没做」说成「做了没发现」(types.ts WeeklyChangeCounts
	// 的原话,邮件模板里守的是同一条)。所以这一节是**整节消失**,连标题都没有。
	it("整屏渲染时既没有那一节,也没有那两个字", () => {
		const out = screen({
			change: change({
				counts: counts({ recheckChecked: 0, recheckChanged: 0, recheckUnchecked: 0 }),
				diff: diff({ recheck: { checked: 0, changed: 0, unchecked: 0, changes: [], unavailable: [], resolved: [], unchanged: [] } }),
			}),
		});
		assert.ok(!out.includes("复查"), `页面上出现了「复查」:\n${out.slice(0, 4000)}`);
		assert.ok(!out.includes("rk-col"), "三栏那一节整块都不该渲染");
	});

	it("**第一周也不许**(它的 recheckChecked 恒为 0,不给「将来时」开例外)", () => {
		const out = screen({ change: change({ prevWeekOf: null, diff: diff({ prevWeekOf: null }), counts: counts({ recheckChecked: 0 }) }) });
		assert.ok(!out.includes("复查"));
	});

	it("recheckChecked > 0 时那一节回来,三个数取自 counts", () => {
		const out = screen();
		assert.match(out, /复查/);
		assert.ok(out.includes('<b class="hn">4</b>'), "本该查几个 = counts.recheckChecked");
		assert.ok(out.includes('<b class="hn">3</b>'), "几个有变化 = counts.recheckChanged");
	});

	it("三个数印的是 counts,不是明细数组的长度", () => {
		// 故意喂一份自相矛盾的:counts 说查了 9 个、2 个没查成,明细里只有 3 条变化
		const out = html(mod.RecheckPanel, {
			counts: counts({ recheckChecked: 9, recheckChanged: 3, recheckUnchecked: 2 }),
			recheck: recheck(),
		});
		assert.ok(out.includes('<b class="hn">9</b>'), "本该查几个必须是后端那个 9");
		assert.ok(out.includes('<b class="hn">2</b>'), "没查成几个必须是后端那个 2");
	});
});

// ---------------------------------------------------------------------------
// 3 · 「没查成」和「已经没了」是两栏
// ---------------------------------------------------------------------------

describe("没查成 ≠ 没了(终审那条「404 与 5xx 必须分开」的同一条纪律)", () => {
	const withUnavailable = () =>
		html(mod.RecheckPanel, {
			counts: counts({ recheckChecked: 5, recheckChanged: 3, recheckUnchecked: 1 }),
			recheck: recheck({
				unchecked: 1,
				unavailable: [{ fullName: "shy/repo", why: "GitHub 回了 502,这一趟没问到" }],
			}),
		});

	/** 三栏在 HTML 里是顺序出现的,按容器 class 切开就能各自断言。 */
	const cols = (out: string) => {
		const a = out.indexOf("rk-col-changed");
		const b = out.indexOf("rk-col-unchecked");
		const c = out.indexOf("rk-col-fine");
		assert.ok(a >= 0 && b > a && c > b, "三栏必须都在,而且是三个不同的容器");
		return { changed: out.slice(a, b), unchecked: out.slice(b, c), fine: out.slice(c) };
	};

	it("三栏是三个不同的容器,不是一栏", () => {
		const { changed, unchecked, fine } = cols(withUnavailable());
		assert.ok(changed.includes("出事了"));
		assert.ok(unchecked.includes("没查成"));
		assert.ok(fine.includes("查过,没事"));
	});

	it("**「已经没了」只出现在「出事了」那一栏**", () => {
		const { changed, unchecked } = cols(withUnavailable());
		assert.ok(changed.includes("已经没了"), "gone 必须落在出事那一栏");
		assert.ok(changed.includes("nanisle-test/definitely-not-a-real-repo-003"));
		assert.ok(!unchecked.includes("已经没了"), "没查成那一栏不许出现「已经没了」");
		assert.ok(!unchecked.includes("nanisle-test/definitely-not-a-real-repo-003"), "两栏不许装同一个仓");
	});

	it("**「没查成」的措辞不说它出事了**,而且原因原文可见", () => {
		const { unchecked } = cols(withUnavailable());
		assert.ok(unchecked.includes("shy/repo"));
		assert.ok(unchecked.includes("GitHub 回了 502,这一趟没问到"), "why 要原样显示");
		assert.match(unchecked, /这不代表它们有什么问题/);
		assert.match(unchecked, /只代表我们这一趟不知道它们怎么样/);
		// 那几个「出事了」的词一个都不许漏进这一栏
		for (const bad of ["已经没了", "转归档", "换了许可证"]) {
			assert.ok(!unchecked.includes(bad), `没查成那一栏出现了「${bad}」`);
		}
	});

	it("两栏都空的时候各自说自己的空话,不互相顶替", () => {
		const { changed, unchecked } = cols(
			html(mod.RecheckPanel, {
				counts: counts({ recheckChecked: 2, recheckChanged: 0, recheckUnchecked: 0 }),
				recheck: recheck({ changed: 0, changes: [], unavailable: [], resolved: ["a/one", "b/two"], unchanged: ["a/one", "b/two"] }),
			}),
		);
		assert.match(changed, /一个都没出事/);
		assert.match(unchecked, /该问的都问到了/);
	});

	it("「查过,没事」那一栏不许把出事的那几个也算进去", () => {
		// resolved 的定义是「复查真的给出了答案(ok **或** gone)的仓名」,它**包含**
		// 出事的那几个。直接拿它当「没事」会把一个刚被删库的仓印在「没事」那一栏里。
		// 2026-09-01 冻结前最后一轮把这个减法收回了后端(`recheck.unchanged`),
		// 这一屏现在直接用它 —— 但断言不变,它守的是**渲染出来的结果**。
		const { fine } = cols(withUnavailable());
		assert.ok(fine.includes("mem0ai/mem0"), "真的没事的那个要在");
		for (const hurt of ["facebookarchive/draft-js", "google/gxui", "nanisle-test/definitely-not-a-real-repo-003"]) {
			assert.ok(!fine.includes(hurt), `${hurt} 出了事,不该出现在「查过没事」那一栏`);
		}
	});

	it("**这一栏读的是 unchanged,不是自己拿 resolved 减一遍**", () => {
		// 喂一份 `resolved − changes ≠ unchanged` 的复查账:resolved 里有三个,
		// changes 只记住了其中一个的名字,而后端明说「没事的只有 fine/three」。
		//
		// 两种实现在这份输入上给出不同的答案,而**这正是这条改动的全部意义**:
		// 上一轮前端是自己做减法绕开 `resolved` 的歧义的,那份实现在这里会把
		// poof/two 印进「查过没事」那一栏 —— 一个刚被删库的仓被印成「没事」。
		// 减法本身是对的,问题是**每个下游都得自己想起来做一次**(将来的邮件模板
		// 是下一个),而想不起来的那一次不会报错。喂一份两者不一致的输入,是把
		// 「到底读谁」这件事钉死的唯一办法 —— 两者一致时,两种实现长得一模一样。
		const { fine } = cols(
			html(mod.RecheckPanel, {
				counts: counts({ recheckChecked: 3, recheckChanged: 2, recheckUnchecked: 0 }),
				recheck: recheck({
					changed: 2,
					changes: [{ fullName: "dead/one", kind: "archived", stillListed: false }],
					unavailable: [],
					resolved: ["dead/one", "poof/two", "fine/three"],
					unchanged: ["fine/three"],
				}),
			}),
		);
		assert.ok(fine.includes("fine/three"));
		assert.ok(!fine.includes("dead/one"));
		assert.ok(!fine.includes("poof/two"), "拿 resolved 减 changes 的实现会在这里把它印成「没事」");
	});
});

// ---------------------------------------------------------------------------
// 3.5 · 复查那三个数的页面级自检(2026-09-01 冻结前最后一轮)
//
// 在这之前它们是全页唯一「无人核对」的数:页面上别的每个数都有 LedgerCheck /
// ChangeCheck 盯着,只有这三个没有 —— 因为 `checked = changed + unchecked + 没事的`
// 里的最后一项在明细层拿不到。后端补上 unchanged 之后这条等式验得了了。
// ---------------------------------------------------------------------------

describe("RecheckCheck · 复查三数的自检", () => {
	it("账平的时候一个字都不渲染(自检不是装饰)", () => {
		const out = html(mod.RecheckCheck, {
			counts: counts({ recheckChecked: 5, recheckChanged: 3, recheckUnchecked: 1 }),
			recheck: recheck({ unchecked: 1, unavailable: [{ fullName: "shy/repo", why: "502" }] }),
		});
		assert.equal(out, "", "3 + 1 + 1 = 5,没有可说的");
	});

	it("三处加起来不等于本该查的个数 → 当场说破", () => {
		const out = html(mod.RecheckCheck, {
			counts: counts({ recheckChecked: 9, recheckChanged: 3, recheckUnchecked: 0 }),
			recheck: recheck({ unchecked: 0, unavailable: [] }), // unchanged 只有 1 个
		});
		assert.match(out, /复查账对不上|对不上/);
		assert.ok(out.includes("role=\"alert\"") || out.includes("scan-alarm"), "要用报警的样式");
		assert.ok(out.includes("9"), "把本该查的那个数印出来");
	});

	it("`unchecked` 和 `unavailable.length` 是同一个数的两处投影,对不上也要说", () => {
		const out = html(mod.RecheckCheck, {
			counts: counts({ recheckChecked: 3, recheckChanged: 0, recheckUnchecked: 2 }),
			// unchanged 1 个 + changed 0 + unchecked 2 = 3(第一条等式是平的),
			// 但明细里一条 unavailable 都没有 —— 只有第二条断言抓得住它
			recheck: recheck({ changed: 0, changes: [], unavailable: [], unchanged: ["fine/one"] }),
		});
		assert.match(out, /没查成 2 vs 明细 0 个/);
	});

	it("**自检真的被挂进了 RecheckPanel**(组件写好了但没接线,和没写一样)", () => {
		const out = html(mod.RecheckPanel, {
			counts: counts({ recheckChecked: 9, recheckChanged: 3, recheckUnchecked: 0 }),
			recheck: recheck({ unchecked: 0, unavailable: [] }),
		});
		assert.ok(out.includes("scan-alarm"), "账对不上时,整节里必须出现那条报警");
		assert.match(out, /复查账对不上/);
	});

	it("**changes.length 不参与等式**:一个仓同时归档 + 换许可证不许被算成两个仓", () => {
		const out = html(mod.RecheckCheck, {
			counts: counts({ recheckChecked: 2, recheckChanged: 1, recheckUnchecked: 0 }),
			recheck: recheck({
				changed: 1,
				changes: [
					{ fullName: "both/x", kind: "archived", stillListed: false },
					{ fullName: "both/x", kind: "license", license: { from: "MIT", to: null }, stillListed: false },
				],
				unavailable: [],
				resolved: ["both/x", "fine/one"],
				unchanged: ["fine/one"],
			}),
		});
		assert.equal(out, "", "两条一个仓,账照样是平的 —— 拿条数去验会造出每周都可能的假警报");
	});
});

// ---------------------------------------------------------------------------
// 4 · stillListed === false:「掉出清单」和「它死了」是两件事
// ---------------------------------------------------------------------------

describe("掉出清单 ≠ 出事(而后者重要得多 —— 那是加复查这个功能的全部理由)", () => {
	it("stillListed 为 false 的行:两件事都标出来", () => {
		const out = html(mod.RecheckChangeRow, {
			c: { fullName: "facebookarchive/draft-js", kind: "archived", stillListed: false },
		});
		assert.match(out, /已掉出这一周的清单/, "「它掉出清单了」要说");
		assert.match(out, /转归档/, "「它出了什么事」也要说");
		assert.ok(out.includes("facebookarchive/draft-js"));
	});

	it("gone 的那一行写清 404/410/451 是什么意思", () => {
		const out = html(mod.RecheckChangeRow, {
			c: { fullName: "nanisle-test/definitely-not-a-real-repo-003", kind: "gone", stillListed: false },
		});
		assert.match(out, /已经没了/);
		assert.match(out, /404 \/ 410 \/ 451/);
		assert.match(out, /已掉出这一周的清单/);
	});

	it("stillListed 为 true 时说的是另一句,不许出现「已掉出」", () => {
		const out = html(mod.RecheckChangeRow, { c: { fullName: "still/here", kind: "archived", stillListed: true } });
		assert.match(out, /还在这一周的清单上/);
		assert.ok(!out.includes("已掉出"));
	});

	it("换许可证那一行:from → to 原样可见,null 印成「没有许可证」不是空白", () => {
		const a = html(mod.RecheckChangeRow, {
			c: { fullName: "google/gxui", kind: "license", license: { from: "MIT", to: "BSD-3-Clause" }, stillListed: false },
		});
		assert.match(a, /MIT → BSD-3-Clause/);
		const b = html(mod.RecheckChangeRow, {
			c: { fullName: "x/y", kind: "license", license: { from: null, to: "MIT" }, stillListed: true },
		});
		assert.match(b, /没有许可证 → MIT/);
	});

	it("四格里那格「换许可证」也一样:`null` 印成「没有许可证」,不是空白", () => {
		// LicenseChange.from/to 是 `string | null`(不是 string)。null → MIT 是
		// 「本来不能抄现在能抄了」——**最该说出口的那一种**,画成空白会被读成
		// 「我没查」。这一格走 CrossWeek,和上面那条走 RecheckChangeRow 是两处渲染。
		const out = html(mod.CrossWeek, {
			change: change({
				counts: counts({ licenseChanged: 2 }),
				diff: diff({
					licenseChanged: [
						{ fullName: "free/now", from: null, to: "MIT" },
						{ fullName: "closed/now", from: "MIT", to: null },
					],
				}),
			}),
		});
		assert.match(out, /没有许可证 → MIT/);
		assert.match(out, /MIT → 没有许可证/);
	});

	it("复查那一节要说清它为什么必须存在(四格天生看不见「上周那个仓这周死了」)", () => {
		const out = html(mod.RecheckPanel, { counts: counts(), recheck: recheck() });
		assert.match(out, /一旦归档或者被删/);
		assert.match(out, /天生看不见/);
	});
});

// ---------------------------------------------------------------------------
// 5 · 第一周:如实说,不假装有
// ---------------------------------------------------------------------------

describe("第一周", () => {
	const first = () =>
		html(mod.CrossWeek, { change: change({ prevWeekOf: null, diff: diff({ prevWeekOf: null }) }) });

	it("说出来:这是第一周,没有可比的上一周", () => {
		const out = first();
		assert.match(out, /这是第一周/);
		assert.match(out, /没有可比的上一周/);
		assert.match(out, /增量要到/);
	});

	it("**不渲染伪造的「与上一次比」区块**(四个 0 读起来是「比过了,没变化」)", () => {
		const out = first();
		assert.ok(!out.includes("xw-grid"), "四格一个都不该画");
		assert.ok(!out.includes("xw-cell"), "格子里那些标签也不该有");
		assert.ok(!out.includes("和上一次("), "根本没有「上一次」可比");
		assert.ok(!out.includes("一个变化都没有"), "「没得比」不许说成「比过了没变化」");
	});

	it("prevWeekOf 非空时才画那四格", () => {
		const out = html(mod.CrossWeek, { change: change() });
		assert.ok(out.includes("xw-grid"));
		assert.ok(!out.includes("这是第一周"));
	});
});

// ---------------------------------------------------------------------------
// 6 · 四类变化的数字来自 counts,不是数组长度
// ---------------------------------------------------------------------------

describe("四类变化:数字取自 counts,前端不数明细", () => {
	it("四个数按 counts 印出来,四类明细也都铺开", () => {
		const out = html(mod.CrossWeek, { change: change() });
		for (const label of ["新进清单", "转归档", "换许可证", "star 跃迁"]) {
			assert.ok(out.includes(label), `少了一格:${label}`);
		}
		assert.ok(out.includes('<b class="hn">2</b>'), "appeared = 2");
		assert.ok(out.includes("alibaba/zvec") && out.includes("mem0ai/mem0"), "明细要铺开");
		assert.match(out, /MIT → AGPL-3\.0/);
		assert.ok(out.includes("★120 → ★640(+520)"), "star 跃迁要写清从多少到多少、涨了多少");
	});

	it("**反证的落点**:counts 说 7、明细只有 2 条时,印的必须是 7", () => {
		// 同 scan-render.test.ts 里那条「honesty 说 5、候选只有 2 行」。这几个数是
		// 后端从同一份 WeekDiff 算出来落库的,而**邮件正文用的也是同一组数** ——
		// 前端改成 diff.appeared.length 之后,网页和邮件会在某一周开始各说各的。
		// **四类一起验**:只验一类的话,把其中三格偷偷改成数组长度这条用例照样绿。
		const out = html(mod.CrossWeek, {
			change: change({ counts: counts({ appeared: 7, archived: 5, licenseChanged: 4, starJumps: 9 }) }),
		});
		for (const [what, v] of [
			["新进清单", 7],
			["转归档", 5],
			["换许可证", 4],
			["star 跃迁", 9],
		] as const) {
			assert.ok(out.includes(`<b class="hn">${v}</b>`), `${what} 那一格没印后端算的 ${v}:
${out}`);
		}
		// 明细照样只有 2 / 1 / 1 / 1 条,而它们一条都不该变成格子上那个数
		assert.ok(out.includes("alibaba/zvec"), "明细还是要铺开的,只是数字不归它管");
	});

	it("计数和明细对不上时当场说破(口径同 Scan.tsx 的 LedgerCheck)", () => {
		const out = html(mod.ChangeCheck, { counts: counts({ appeared: 7 }), diff: diff() });
		assert.match(out, /自相矛盾/);
		assert.match(out, /新进清单 7 vs 明细 2 条/);
		assert.ok(out.includes('role="alert"'));
	});

	it("对得上时什么都不画(不制造假警报)", () => {
		assert.equal(html(mod.ChangeCheck, { counts: counts(), diff: diff() }), "");
	});

	it("**changed 不参与自检**:复查报出来的变化不进那四栏,拿和去验它会每周误报", () => {
		// 四格全 0 而 changed 为 true 是完全正常的一周(比如「上周那个仓这周归档了,
		// 别的什么都没动」)—— 那正是复查这一整条改动要报的事。
		const out = html(mod.ChangeCheck, {
			counts: counts({ appeared: 0, archived: 0, licenseChanged: 0, starJumps: 0, changed: true }),
			diff: diff({ appeared: [], archivedNow: [], licenseChanged: [], starJumps: [] }),
		});
		assert.equal(out, "");
	});

	it("某一类为 0 时那一格说「这一类这周一个都没有」,不是留白", () => {
		const out = html(mod.CrossWeek, {
			change: change({ counts: counts({ starJumps: 0 }), diff: diff({ starJumps: [] }) }),
		});
		assert.match(out, /这一类这周一个都没有/);
	});

	it("拿来比的是哪一周印在页面上(不一定是「上周」)", () => {
		const out = html(mod.CrossWeek, { change: change({ weekOf: "2026-W40", prevWeekOf: "2026-W37" }) });
		assert.match(out, /2026-W40/);
		assert.match(out, /2026-W37/);
		assert.match(out, /定时扫描挂过一周/);
	});
});

// ---------------------------------------------------------------------------
// 7 · 翻周那一列
// ---------------------------------------------------------------------------

describe("翻周", () => {
	const scans = [
		week({ weekOf: "2026-W34", id: "d1#2026-W34", admitted: 3, excluded: 90, returned: 93 }),
		week({ weekOf: "2026-W36", id: "d1#2026-W36" }),
		week({ weekOf: "2026-W35", id: "d1#2026-W35", stopped: "search 额度不够,只跑完了 5/8 条检索词" }),
	];

	it("**按 week_of 倒序**渲染(喂进去的顺序是乱的)", () => {
		const out = html(mod.WeekPicker, { scans, picked: null, onPick: null });
		const at = (w: string) => out.indexOf(w);
		assert.ok(at("2026-W36") < at("2026-W35"), "W36 要排在 W35 前面");
		assert.ok(at("2026-W35") < at("2026-W34"), "W35 要排在 W34 前面");
	});

	it("stopped 非空的那几周有标注,原因挂在 title 上", () => {
		const out = html(mod.WeekPicker, { scans, picked: null, onPick: null });
		assert.match(out, /这一周没跑完 · 清单是残的/);
		assert.ok(out.includes('title="search 额度不够,只跑完了 5/8 条检索词"'), "当时提前收工的原因要留得住");
		assert.ok(out.includes("week-partial"), "残缺的那一周要和别的周长得不一样");
		// 没跑完的只有一周,标记就该只出现一次
		assert.equal((out.match(/week-stopped/g) ?? []).length, 1);
	});

	it("残缺那几周会让「新进清单」混进假货 —— 这句话要写出来", () => {
		const out = html(mod.WeekPicker, { scans, picked: null, onPick: null });
		assert.match(out, /其实上周就有、只是上周没搜到/);
	});

	it("每一周的四个计数原样来自 WeeklyScan", () => {
		const out = html(mod.WeekPicker, { scans: [scans[0]], picked: null, onPick: null });
		for (const v of [3, 90, 93, 0]) assert.ok(out.includes(`<b class="hn">${v}</b>`), `少了 ${v}`);
	});

	it("picked 为 null 时选中的是最新那一周", () => {
		const out = html(mod.WeekPicker, { scans, picked: null, onPick: null });
		const first = out.slice(0, out.indexOf("2026-W35"));
		assert.ok(first.includes("week-on"), "最新那一周要高亮");
		assert.ok(first.includes("最近一周"));
	});

	it("picked 指定某一周时高亮的是那一周", () => {
		const out = html(mod.WeekPicker, { scans, picked: "2026-W34", onPick: null });
		const w34 = out.slice(out.indexOf("2026-W34") - 400, out.indexOf("2026-W34"));
		assert.ok(w34.includes("week-on"));
		assert.equal((out.match(/week-on/g) ?? []).length, 1, "同时只有一周是选中的");
	});

	it("点某一周报的是那一周的编号", () => {
		const seen: string[] = [];
		const tree = mod.WeekPicker({ scans, picked: null, onPick: (w: string) => seen.push(w) });
		const btn = findEl(tree, (el) => el.props?.className === "week-pick");
		assert.ok(btn, "没有渲染出翻周按钮");
		btn.props.onClick();
		assert.deepEqual(seen, ["2026-W36"], "第一行是最新那一周");
	});

	it("onPick 为 null 时按钮禁用(正在换周时点不动)", () => {
		const out = html(mod.WeekPicker, { scans, picked: null, onPick: null });
		assert.match(out, /disabled/);
	});

	it("一周都没有时说清「要两周才比得出来」", () => {
		const out = html(mod.WeekPicker, { scans: [], picked: null, onPick: null });
		assert.match(out, /还没有任何一周的扫描记录/);
		assert.match(out, /两周/);
	});
});

// ---------------------------------------------------------------------------
// 8 · 整屏:节的编号、正在换周时不许摆上一周的结论
// ---------------------------------------------------------------------------

describe("整屏", () => {
	it("节的编号是现算的 —— 复查那一节消失时不留缺号", () => {
		const withRecheck = screen();
		assert.ok(withRecheck.includes(">01<") && withRecheck.includes(">04<"), "四节:翻周/比/复查/清单");
		const without = screen({
			change: change({
				counts: counts({ recheckChecked: 0, recheckChanged: 0, recheckUnchecked: 0 }),
				diff: diff({ recheck: { checked: 0, changed: 0, unchecked: 0, changes: [], unavailable: [], resolved: [], unchanged: [] } }),
			}),
		});
		assert.ok(without.includes(">03<"), "三节要编成 01/02/03");
		assert.ok(!without.includes(">04<"), "不许出现 01、02、04 这种缺号");
	});

	it("**正在换周时不许把上一周的结论摆在新的一周下面**", () => {
		// 换周期间 App 会先把手上那份清掉,但即使清掉之前渲染了一帧,这里也必须
		// 说「正在读」,而不是拿 change 里那个 weekOf 说事。
		const out = screen({ busy: true, picked: "2026-W35" });
		assert.match(out, /正在读 2026-W35 的跨周记录…/);
		assert.ok(!out.includes("xw-grid"), "上一周的四格不许留在屏幕上");
		assert.ok(!out.includes("没有跨周记录"), "「还没读到」不是「没有记录」");
	});

	it("这一屏要说清它为什么存在(风险 4 的判据靠它才执行得了)", () => {
		assert.match(screen(), /唯一存在理由/);
	});

	it("那一周没有存下来的清单时,说清可能是删过档案", () => {
		const out = html(mod.WeekBundle, { weekScan: null, weekOf: "2026-W31" });
		assert.match(out, /没有存下来的清单/);
		assert.match(out, /2026-W31/);
	});

	it("有清单时折叠着,摘要里写清里面有多少东西,而且不给申诉/拆解两个按钮", () => {
		const bundle: GetScanResponse = {
			scan: week(),
			candidates: [
				{
					scanId: "d1#2026-W36",
					fullName: "mem0ai/mem0",
					stars: 100,
					pushedAt: "2026-08-25T00:00:00Z",
					archived: false,
					license: "MIT",
					repoCreatedAt: "2024-01-01T00:00:00Z",
					oneLiner: "给 agent 加长期记忆的库",
					topics: ["llm", "memory"],
					sourceRoute: "stars",
					rank: 1,
					appealedFrom: null,
				},
			],
			exclusions: [],
			honesty: {
				searchCap: 1000,
				queryCount: 2,
				routeCount: 2,
				returned: 176,
				excluded: 171,
				admitted: 5,
				fetchFailed: 0,
				claimedTotal: 81234,
			},
		};
		const out = html(mod.WeekBundle, { weekScan: bundle, weekOf: "2026-W36" });
		assert.match(out, /展开 2026-W36 当时的完整清单/);
		assert.ok(out.includes("mem0ai/mem0"), "那一周的候选要真的渲染出来");
		assert.ok(!out.includes("excl-appeal"), "历史那一屏不给「这个该进来」");
		assert.ok(!out.includes("cand-teardown"), "历史那一屏不给「拆开看看」");
	});
});

// ---------------------------------------------------------------------------
// 9 · 路由:跨周屏能被直接链接到
// ---------------------------------------------------------------------------

describe("跨周屏的地址", () => {
	it("?view=changes 读得回来", () => {
		assert.equal(viewInSearch("?view=changes"), "changes");
		assert.equal(viewInSearch("?view=changes&weekOf=2026-W35"), "changes");
	});

	it("往返:切到跨周屏并翻到某一周,地址栏读得回同一周(刷新不丢)", () => {
		const s = searchForView("changes", null, "2026-W35");
		assert.equal(viewInSearch(s), "changes");
		assert.equal(weekOfInSearch(s), "2026-W35");
	});

	it("不带 weekOf 的裸 ?view=changes 合法,含义是「最近一周」", () => {
		assert.equal(searchForView("changes"), "?view=changes");
		assert.equal(weekOfInSearch("?view=changes"), null);
	});

	it("**形状不对的 weekOf 当没指定**(而不是拿去打一个必然 400 的请求)", () => {
		assert.equal(weekOfInSearch("?view=changes&weekOf=上周"), null);
		assert.equal(weekOfInSearch("?view=changes&weekOf=2026-36"), null);
		assert.equal(weekOfInSearch("?view=changes&weekOf="), null);
	});

	it("加了第四屏之后,认不出来的 view 仍然当没指定", () => {
		assert.equal(viewInSearch("?view=nope"), null);
		assert.equal(viewInSearch("?view=change"), null, "少一个 s 也不许猜");
	});
});

/** 在元素树上找第一个满足条件的元素,碰到未展开的纯函数组件就调一次(同 scan-render.test.ts)。 */
function findEl(node: unknown, ok: (el: any) => boolean): any {
	if (Array.isArray(node)) {
		for (const n of node) {
			const hit = findEl(n, ok);
			if (hit) return hit;
		}
		return null;
	}
	if (!node || typeof node !== "object") return null;
	const el = node as any;
	if (!("props" in el) || !el.props) return null;
	if (ok(el)) return el;
	if (typeof el.type === "function") return findEl(el.type(el.props), ok);
	return findEl(el.props.children, ok);
}
