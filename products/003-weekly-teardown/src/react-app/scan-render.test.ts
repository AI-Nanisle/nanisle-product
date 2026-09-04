// 第一屏(本周清单)的**渲染层**回归测试。跑法:npm test。
//
// 为什么非要有这一层:阶段 3 栽过一次,教训写在 render.test.ts 顶部——
// dossier-edit.test.ts 里那条「addItem 拒绝空、满、重复,且每种都给理由」
// 一直是绿的,**而行为是坏的**:纯函数确实把理由算出来了,但没有任何一层
// 把它送到屏幕上。**单测的边界正好切在洞的上游。**
//
// 这一屏的每一条产品承诺都有同样的风险面,而且更危险,因为它们全是「页面上
// 应该出现某句话/某个数」这种形状:
//
//   诚实声明的每个数 = ScanHonesty 给的值(**不是前端自己算的**)
//   排除清单 rule / model 分色渲染成不同的 class
//   台账四个数 = WeeklyScan 给的值
//   stopped 非空 → 提示真的出现
//   oneLiner 为 null → 有降级显示,不是空洞
//   license 为 null → 「没有许可证」而不是空白
//
// 每一条都能在纯函数层「测得很绿」而在屏幕上什么都没有。所以这里的断言只有
// 一种形状:**渲染成 HTML,然后在 HTML 里找那句话。**
//
// 打包方式与 render.test.ts 同款(esbuild → node_modules/.cache,react 保持
// external 以便共用同一个 React 实例),理由在那个文件顶部写全了,不重复。
//
// **这套用例测不到什么**(如实记):
//   - App.tsx 里的取数、视图切换、申诉回调的接线。SSR 渲染器驱动不了状态更新。
//     这一段靠 TypeScript(props 必填)和 `npm run check` 兜。
//   - CSS。.src-chip-rule 和 .src-chip-model 是不是真的两种颜色,只能靠眼睛;
//     这里只能断言两者渲染出**不同的 class**,那是分色的必要条件不是充分条件。
//   - `<details>` 的实际开合动画、键盘操作。

import assert from "node:assert/strict";
import { mkdirSync } from "node:fs";
import path from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { before, describe, it } from "node:test";

import React from "react";
import ReactDOMServer from "react-dom/server";

import { rankedOutReason } from "../shared/scan-groups.ts";
import type { ScanCandidate, ScanExclusion, ScanHonesty, WeeklyScan } from "../shared/types.ts";
import { defaultView, searchForView, viewInSearch } from "./view.ts";

const HERE = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(HERE, "../..");
const OUT = path.join(ROOT, "node_modules/.cache/nanisle-003-render/scan.mjs");

let mod: {
	default: (props: any) => unknown;
	HonestyStatement: (props: any) => unknown;
	CandidateList: (props: any) => unknown;
	CandidateRow: (props: any) => unknown;
	ExclusionList: (props: any) => unknown;
	ExclusionGroupBlock: (props: any) => unknown;
	Ledger: (props: any) => unknown;
	StoppedNotice: (props: any) => unknown;
	RerunBar: (props: any) => unknown;
	RerunConfirm: (props: any) => unknown;
	RerunReceipt: (props: any) => unknown;
};

before(async () => {
	const esbuild = (await import("esbuild")) as any;
	const build = (esbuild.build ?? esbuild.default?.build) as (o: unknown) => Promise<unknown>;
	mkdirSync(path.dirname(OUT), { recursive: true });
	await build({
		entryPoints: [path.join(HERE, "Scan.tsx")],
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
// 夹具:形状照着 dev@local 那份真周扫来(391 个仓 / 5 候选 / 386 排除)
// ---------------------------------------------------------------------------

const scan: WeeklyScan = {
	id: "d1#2026-W36",
	dossierId: "d1",
	weekOf: "2026-W36",
	dossierRev: 1,
	queries: ["video summarizer", "youtube summarizer", "topic:video-summarization"],
	returned: 391,
	admitted: 5,
	excluded: 386,
	fetchFailed: 0,
	routeCount: 2,
	claimedTotal: 81234,
	stopped: null,
	createdAt: 1,
};

const honesty: ScanHonesty = {
	searchCap: 1000,
	queryCount: 8,
	routeCount: 2,
	returned: 391,
	excluded: 386,
	admitted: 5,
	fetchFailed: 0,
	claimedTotal: 81234,
};

const cand = (over: Partial<ScanCandidate> = {}): ScanCandidate => ({
	scanId: "d1#2026-W36",
	fullName: "nexmoe/VidBee",
	stars: 10473,
	pushedAt: "2026-08-25T00:00:00Z",
	archived: false,
	license: "MIT",
	repoCreatedAt: "2024-03-01T00:00:00Z",
	oneLiner: "网页应用,粘一个视频链接就出带时间戳的摘要,要自己配 key",
	sourceRoute: "stars",
	rank: 1,
	appealedFrom: null,
	...over,
});

const excl = (over: Partial<ScanExclusion> = {}): ScanExclusion => ({
	scanId: "d1#2026-W36",
	fullName: "who/knows",
	reason: "没有许可证,法律上不可用",
	reasonKind: "no-license",
	reasonSource: "rule",
	appealedAt: null,
	...over,
});

const noAppeal = { onAppeal: null, pending: null };

// ---------------------------------------------------------------------------
// 1 · 诚实声明:每一个数都来自 ScanHonesty
// ---------------------------------------------------------------------------

describe("诚实声明的数字全部来自 ScanHonesty,前端不算数", () => {
	it("八个空全部按 honesty 印出来", () => {
		const out = html(mod.HonestyStatement, { honesty });
		for (const [name, v] of [
			["claimedTotal", honesty.claimedTotal],
			["searchCap", honesty.searchCap],
			["queryCount", honesty.queryCount],
			["routeCount", honesty.routeCount],
			["returned", honesty.returned],
			["excluded", honesty.excluded],
			["admitted", honesty.admitted],
		] as const) {
			assert.ok(out.includes(`<b class="hn">${v}</b>`), `诚实声明里没印出 ${name}=${v}:\n${out}`);
		}
	});

	it("**反证的落点**:honesty 说 5、候选只有 2 行时,印的必须是 5", () => {
		// 这一条是整份用例里最重要的一条。types.ts ScanHonesty 的 docblock 说得
		// 很直白:前端一旦拿 candidates.length 凑分子分母,它就会在某次改版里和
		// 台账分叉,而分叉之后这句话还是理直气壮地摆在页面顶部。
		//
		// 所以这里故意喂进一份**自相矛盾**的输入(后端说进清单 5 个,手上只有
		// 2 行候选),断言页面印的是后端那个 5。把 HonestyStatement 改成
		// `candidates.length` 之类的实现,这一条当场红。
		const out = ReactDOMServer.renderToStaticMarkup(
			React.createElement(mod.default as never, {
				scan,
				candidates: [cand(), cand({ fullName: "a/b", rank: 2 })],
				exclusions: [excl()],
				honesty,
				extras: {},
				appeal: noAppeal,
			} as never),
		);
		assert.ok(out.includes('<b class="hn">5</b>'), "顶部那句话必须印后端算的 admitted=5");
		assert.ok(!out.includes("剩下 <b class=\"hn\">2</b> 个在这里"), "印成候选行数就是前端自己算数了");
	});

	it("claimedTotal 为 0(历史那一路没有 trace)时不撒谎说「有 0 个」", () => {
		const out = html(mod.HonestyStatement, { honesty: { ...honesty, claimedTotal: 0 } });
		assert.ok(!out.includes('<b class="hn">0</b>'), "0 个是假话");
		assert.ok(out.includes("可能有上万个"), "退回一句不带数字的话");
	});

	it("fetchFailed > 0 时必须说出来,否则那三个数加不起来", () => {
		const out = html(mod.HonestyStatement, { honesty: { ...honesty, fetchFailed: 4, admitted: 1 } });
		assert.ok(out.includes('<b class="hn">4</b>'));
		assert.match(out, /抓不通/);
	});
});

// ---------------------------------------------------------------------------
// 2 · rule / model 分色
// ---------------------------------------------------------------------------

describe("排除理由 rule / model 分色,不许混成一色", () => {
	const group = (source: "rule" | "model") => ({
		key: source === "rule" ? "no-license" : "model",
		label: source === "rule" ? "没有许可证" : "模型判的",
		block: source === "rule" ? "eligibility" : "judgement",
		source,
		note: "note",
		count: 1,
		items: [excl({ reasonKind: source === "rule" ? "no-license" : "model", reasonSource: source })],
	});

	it("两组渲染出的 class 确实不同", () => {
		const ruleHtml = html(mod.ExclusionGroupBlock, { group: group("rule"), appeal: noAppeal });
		const modelHtml = html(mod.ExclusionGroupBlock, { group: group("model"), appeal: noAppeal });
		assert.ok(ruleHtml.includes("src-rule") && ruleHtml.includes("src-chip-rule"));
		assert.ok(modelHtml.includes("src-model") && modelHtml.includes("src-chip-model"));
		assert.ok(!ruleHtml.includes("src-chip-model"), "规则组不许带上模型那枚徽记");
		assert.ok(!modelHtml.includes("src-chip-rule"), "模型组不许带上规则那枚徽记");
	});

	it("徽记上的字也不一样(色盲用户看不到颜色,只能读字)", () => {
		assert.match(String(html(mod.ExclusionGroupBlock, { group: group("rule"), appeal: noAppeal })), /代码算的/);
		assert.match(String(html(mod.ExclusionGroupBlock, { group: group("model"), appeal: noAppeal })), /模型判的/);
	});

	it("整块清单里,规则块和模型块是两个不同的容器", () => {
		const out = html(mod.ExclusionList, {
			exclusions: [excl(), excl({ fullName: "m/one", reason: "形态不同", reasonKind: "model", reasonSource: "model" })],
			appeal: noAppeal,
			excluded: 2,
		});
		assert.ok(out.includes("blk-rule") && out.includes("blk-model"));
	});
});

// ---------------------------------------------------------------------------
// 3 · 排除清单的条数与分组
// ---------------------------------------------------------------------------

describe("386 行的现实:分组头必须印真实条数", () => {
	/** 照真数据的形状造一份:153 排名之外 / 145 没有许可证 / 70 停更 / …… */
	const many: ScanExclusion[] = [
		...Array.from({ length: 153 }, (_, i) =>
			excl({ fullName: `r/${i}`, reason: rankedOutReason(i + 6, 158), reasonKind: "ranked-out" }),
		),
		...Array.from({ length: 145 }, (_, i) => excl({ fullName: `n/${i}` })),
		...Array.from({ length: 70 }, (_, i) => excl({ fullName: `s/${i}`, reason: "最后一次 push 在 2023-04", reasonKind: "stale" })),
		...Array.from({ length: 10 }, (_, i) => excl({ fullName: `t/${i}`, reason: "一年了还不到 10 星", reasonKind: "tiny" })),
		...Array.from({ length: 6 }, (_, i) => excl({ fullName: `g/${i}`, reason: "AGPL 会污染 MIT", reasonKind: "copyleft" })),
		...Array.from({ length: 2 }, (_, i) => excl({ fullName: `a/${i}`, reason: "已归档(GitHub 字段)", reasonKind: "archived" })),
	];

	it("每一组的计数都对,加起来等于台账的 excluded", () => {
		assert.equal(many.length, 386);
		const out = html(mod.ExclusionList, { exclusions: many, appeal: noAppeal, excluded: 386 });
		for (const n of [153, 145, 70, 10, 6, 2]) {
			assert.ok(out.includes(`>${n} 条<`), `分组头上没有 ${n} 条`);
		}
		assert.ok(!out.includes("对不上"), "分组之和与台账相等时不该报警");
	});

	it("386 条一条不少地渲染出来(不靠少显示解决噪音)", () => {
		const out = html(mod.ExclusionList, { exclusions: many, appeal: noAppeal, excluded: 386 });
		// 每一条排除都有一个指向仓库的链接;「差一点进清单的」那 5 条会重复一次
		const links = out.match(/class="excl-name"/g) ?? [];
		assert.equal(links.length, 386 + 5);
	});

	it("分组之和和台账对不上时当场报警", () => {
		const out = html(mod.ExclusionList, { exclusions: many, appeal: noAppeal, excluded: 999 });
		assert.match(out, /对不上/);
	});

	it("「排名之外」独占一块,且把差一点进清单的几个常驻在外面", () => {
		const out = html(mod.ExclusionList, { exclusions: many, appeal: noAppeal, excluded: 386 });
		assert.ok(out.includes("blk-rank"), "名次问题要和资格问题分块");
		assert.match(out, /差一点进清单的/);
		assert.match(out, /通过了全部规则/);
		// 第 6 名(最靠前的那个)必须在常驻区里
		assert.ok(out.includes("#6"));
	});

	it("model 组一条都没有时仍然出现,并且说出来", () => {
		const out = html(mod.ExclusionList, { exclusions: many, appeal: noAppeal, excluded: 386 });
		assert.ok(out.includes("src-chip-model"), "「这一周没有模型判的排除」本身就是要说的事实");
		assert.ok(out.includes(">0 条<"));
	});

	it("已申诉的单列,并写清「不再计入排除数」", () => {
		const out = html(mod.ExclusionList, {
			exclusions: [...many.slice(0, 3), excl({ fullName: "won/back", appealedAt: 1 })],
			appeal: noAppeal,
			excluded: 3,
		});
		assert.match(out, /你捞回来的/);
		assert.match(out, /不再计入排除数/);
	});
});

describe("申诉按钮", () => {
	it("给了 onAppeal 才出现,点下去报的是那一行的仓名", () => {
		const seen: string[] = [];
		const tree = mod.ExclusionList({
			exclusions: [excl({ fullName: "pick/me" })],
			appeal: { onAppeal: (n: string) => seen.push(n), pending: null },
			excluded: 1,
		});
		const btn = findEl(tree, (el) => el.props?.className === "excl-appeal");
		assert.ok(btn, "没有渲染出申诉按钮");
		btn.props.onClick();
		assert.deepEqual(seen, ["pick/me"]);
	});

	it("没给 onAppeal 时一个按钮都不渲染(比如正在跑周扫)", () => {
		const out = html(mod.ExclusionList, { exclusions: [excl()], appeal: noAppeal, excluded: 1 });
		assert.ok(!out.includes("excl-appeal"));
	});

	it("正在申诉的那一行按钮禁用并改文案", () => {
		const out = html(mod.ExclusionList, {
			exclusions: [excl({ fullName: "pick/me" })],
			appeal: { onAppeal: () => {}, pending: "pick/me" },
			excluded: 1,
		});
		assert.match(out, /捞回中/);
		assert.match(out, /disabled/);
	});
});

/** 在元素树上找第一个满足条件的元素,碰到未展开的纯函数组件就调一次(同 render.test.ts)。 */
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

// ---------------------------------------------------------------------------
// 4 · 台账 · stopped
// ---------------------------------------------------------------------------

describe("检索台账", () => {
	it("四个数与传进来的 WeeklyScan 一致", () => {
		const out = html(mod.Ledger, { scan, extras: {} });
		for (const v of [scan.returned, scan.admitted, scan.excluded, scan.fetchFailed]) {
			assert.ok(out.includes(`<b class="hn">${v}</b>`), `台账里没印出 ${v}`);
		}
	});

	it("检索词原文可见(决策 3:它是查全的唯一补救手段)", () => {
		const out = html(mod.Ledger, { scan, extras: {} });
		for (const q of scan.queries) assert.ok(out.includes(`<code>${q}</code>`), `台账里没有检索词原文 ${q}`);
	});

	it("trace 每一路都露出来,出错的那一路标红且写出原因", () => {
		const out = html(mod.Ledger, {
			scan,
			extras: {
				trace: [
					{ query: "video summarizer", sort: "stars", returned: 30, totalCount: 81234 },
					{ query: "video summarizer", sort: "updated", returned: 0, totalCount: 81234, error: "HTTP 403 限流" },
				],
			},
		});
		assert.match(out, /81234/);
		assert.match(out, /HTTP 403 限流/);
		assert.ok(out.includes("trace-bad"));
	});

	it("配额档露出来 —— 「这周只捞回 12 个」要有个能查的解释", () => {
		const out = html(mod.Ledger, {
			scan,
			extras: {
				rate: { authenticated: false, searchCalls: 16, coreCalls: 5, searchRemaining: 0, coreRemaining: 55, waitedMs: 112472 },
			},
		});
		assert.match(out, /匿名档/);
		assert.match(out, /16 次/);
		assert.match(out, /112 秒/);
	});

	it("**stopped 非空时提示真的出现在输出里**", () => {
		const out = html(mod.StoppedNotice, { stopped: "search 额度不够,只跑完了 7/8 条检索词" });
		assert.match(out, /这一周没跑完/);
		assert.match(out, /search 额度不够,只跑完了 7\/8 条检索词/);
		assert.ok(out.includes('role="alert"'), "残缺的清单要让读屏软件也听得到");
	});

	it("stopped 为空时什么都不画(不制造假警报)", () => {
		assert.equal(html(mod.StoppedNotice, {}), "");
		// 台账里存的是 null(不是 undefined),这一路也必须什么都不画
		assert.equal(html(mod.StoppedNotice, { stopped: null }), "");
	});

	it("台账那一节的警示也读 scan.stopped(刷新之后它还在)", () => {
		const out = html(mod.Ledger, { scan: { ...scan, stopped: "search 额度不够,只跑完了 7/8 条检索词" }, extras: {} });
		assert.match(out, /这一周没跑完/);
		assert.match(out, /7\/8 条检索词/);
	});

	it("整屏渲染时 stopped 出现在第一屏,而不是只埋在第 03 节里", () => {
		// stopped 来自**台账那一行**(它落库了),不是只挂在「刚跑完」的 extras 上
		// ——阶段 4/5 评审:留在 extras 里的后果是刷新一次警示就没了,而清单还是残的。
		const out = ReactDOMServer.renderToStaticMarkup(
			React.createElement(mod.default as never, {
				scan: { ...scan, stopped: "预算到了" },
				candidates: [cand()],
				exclusions: [excl()],
				honesty,
				extras: {},
				appeal: noAppeal,
			} as never),
		);
		// 诚实声明之后、第 01 节之前就得出现一次
		const alarmAt = out.indexOf("这一周没跑完");
		const sec01 = out.indexOf("候选清单");
		assert.ok(alarmAt >= 0 && alarmAt < sec01, "残缺提示必须在第一屏可见,不能只挂在第 03 节");
	});

	it("台账等式破了时,页面当场说破", () => {
		const out = html(mod.Ledger, { scan: { ...scan, excluded: 300 }, extras: {} });
		assert.match(out, /台账对不上/);
	});
});

// ---------------------------------------------------------------------------
// 5 · 候选行的降级与徽记
// ---------------------------------------------------------------------------

describe("候选行", () => {
	it("**oneLiner 为 null 时有降级显示,不是空洞**", () => {
		const out = html(mod.CandidateRow, { c: cand({ oneLiner: null }) });
		assert.match(out, /没拿到描述/);
		assert.match(out, /那次模型调用没成功/);
		assert.match(out, /清单本身不受影响/, "要说清「谁进清单是代码判的」,否则读者会以为清单也坏了");
	});

	it("**license 为 null 时显示「没有许可证」而不是空白**", () => {
		const out = html(mod.CandidateRow, { c: cand({ license: null }) });
		assert.match(out, /没有许可证/);
		assert.ok(out.includes("fact-warn"), "它是一条硬排除理由,不该和 MIT 长一个样");
	});

	it("license 有值时原样显示 SPDX id", () => {
		assert.match(String(html(mod.CandidateRow, { c: cand({ license: "GPL-3.0" }) })), /GPL-3\.0/);
	});

	it("oneLiner 旁边永远标着「模型写的描述」", () => {
		const out = html(mod.CandidateRow, { c: cand() });
		assert.match(out, /模型写的描述/);
		assert.ok(out.includes("by-model"));
	});

	it("归档徽章", () => {
		assert.match(String(html(mod.CandidateRow, { c: cand({ archived: true }) })), /已归档/);
		assert.ok(!String(html(mod.CandidateRow, { c: cand() })).includes("已归档"));
	});

	it("sourceRoute 看得见,updated 那一路单独标出来", () => {
		const stars = html(mod.CandidateRow, { c: cand({ sourceRoute: "stars" }) });
		const updated = html(mod.CandidateRow, { c: cand({ sourceRoute: "updated" }) });
		const both = html(mod.CandidateRow, { c: cand({ sourceRoute: "both" }) });
		assert.match(stars, /star 路/);
		assert.match(updated, /新冒出来的/);
		assert.match(both, /两路都有/);
		// 双路检索的全部价值就在这一枚徽记上:它得比另外两种更显眼
		assert.ok(updated.includes("route-hot"));
		assert.ok(!stars.includes("route-hot") && !both.includes("route-hot"));
	});

	it("申诉捞回来的行:标出来,并写明当初的排除理由(理由挂在候选行自己身上)", () => {
		// **不再靠调用方传一份 fullName → 理由的 Map**:那份 Map 只有第一屏拼得
		// 出来,阶段 8 的门铃邮件只拿候选清单渲染,徽记和理由会安静地消失。
		// 现在 appealedFrom 是候选行的一个字段,由 store 层 join 好(阶段 4/5 评审)。
		const out = html(mod.CandidateList, {
			candidates: [
				cand({ fullName: "won/back", sourceRoute: "appealed", rank: 6, appealedFrom: "没有许可证,法律上不可用" }),
			],
		});
		assert.match(out, /你捞回来的/);
		assert.match(out, /没有许可证,法律上不可用/);
		assert.ok(out.includes("cand-appealed"));
	});

	it("没申诉过的行不许出现那句「你捞回来的」", () => {
		const out = html(mod.CandidateList, { candidates: [cand()] });
		assert.ok(!out.includes("你捞回来的"));
		assert.ok(!out.includes("cand-appealed"));
	});

	it("清单超过 5 行时说清楚为什么,并且交代台账怎么动的", () => {
		const rows = Array.from({ length: 6 }, (_, i) => cand({ fullName: `a/${i}`, rank: i + 1 }));
		const out = html(mod.CandidateList, { candidates: rows });
		assert.match(out, /6 行而不是 5 行/);
		assert.match(out, /三个数仍然加得起来/);
	});

	// 2026-09-01 阶段 7 评审必须修 3:去重键加了 dossierRev,「拆过第二次不扣额度」
	// 从此有了一个前提。原来那句话在用户改过档案之后会变成假的,而变假的方向恰好
	// 是**用户以为免费、结果扣了一份额度**。
	it("代价说明里写清「改过档案再拆同一个仓要再扣一份额度」", () => {
		const out = html(mod.CandidateList, { candidates: [cand()], teardown: { onTeardown: () => {}, pending: null } });
		assert.match(out, /按上限估 \$0\.4-0\.6/);
		assert.match(out, /除非你中间改过档案/);
		assert.match(out, /要再扣一份额度/);
	});

	it("一个候选都没有时,说清这不是页面坏了", () => {
		const out = html(mod.CandidateList, { candidates: [] });
		assert.match(out, /不是页面坏了/);
	});
});

// ---------------------------------------------------------------------------
// 7 · 重跑这一周:确认框与回执(2026-09-01 上线前终审 A2)
// ---------------------------------------------------------------------------

describe("重跑确认框", () => {
	// 终审把这颗按钮的后果写得很具体:用户申诉过 3 个仓(每个花掉一次 ai 额度 +
	// 一次 GitHub 调用),点一下重跑,「你捞回来的」那一节连同 3 行候选一起消失,
	// **而台账是重新算的,所以四个数照样自洽,没有一处会报错,页面看起来完全正常。**
	// 更难受的是台账对不上时页面给的提示原文就是「请把这一周重跑一次」——
	// 我们自己把人往这颗按钮上推。
	const confirm = (appealCount: number) =>
		html(mod.RerunConfirm, { weekOf: "2026-W36", appealCount, busy: false, onConfirm: () => {}, onCancel: () => {} });

	it("**有 N 个申诉时点名 N**", () => {
		const out = confirm(3);
		assert.match(out, /这一周有 3 个仓是你自己捞回来的/);
		assert.match(out, /那 3 个/);
		assert.match(out, /2026-W36/, "说清是哪一周 —— 重跑只影响这一周");
	});

	it("说清三件事:整批换掉、会尽量搬回来、搬不回来的下次自动回来", () => {
		const out = confirm(3);
		assert.match(out, /整批换掉/);
		assert.match(out, /会尽量搬回来/);
		assert.match(out, /下一次搜到它的重跑会自动把它搬回去/);
		assert.match(out, /不用再点一次,也不用再花一次额度/);
	});

	it("一个申诉都没有时不吓唬人,但照样说清重跑会做什么", () => {
		const out = confirm(0);
		assert.match(out, /没有.*你自己捞回来的仓/s);
		assert.match(out, /不会丢掉任何一次申诉/);
		assert.match(out, /整批换掉/);
		// 没有申诉就不该出现那三条关于恢复的说明
		assert.ok(!out.includes("会尽量搬回来"));
	});

	it("两颗按钮:确认与再想想,各自报回调", () => {
		const hit: string[] = [];
		const tree = mod.RerunConfirm({
			weekOf: "2026-W36",
			appealCount: 2,
			busy: false,
			onConfirm: () => hit.push("go"),
			onCancel: () => hit.push("back"),
		});
		const go = findEl(tree, (el: any) => el.props?.className === "btn-danger");
		const back = findEl(tree, (el: any) => el.props?.className === "btn-line");
		assert.ok(go && back, "确认和取消都要有");
		go.props.onClick();
		back.props.onClick();
		assert.deepEqual(hit, ["go", "back"]);
	});

	it("跑起来之后按钮禁用并改文案(免得点第二下)", () => {
		const out = html(mod.RerunConfirm, {
			weekOf: "2026-W36",
			appealCount: 1,
			busy: true,
			onConfirm: () => {},
			onCancel: () => {},
		});
		assert.match(out, /扫描中…/);
		assert.match(out, /disabled/);
	});
});

describe("重跑那颗按钮:闸门和按钮在同一个组件里", () => {
	// 上面那个 RerunConfirm 单独测得再绿,也拦不住「有人把按钮直接接回重跑、确认框
	// 从此再也不会被渲染」—— 那正是 render.test.ts 顶部记的阶段 3 那个洞的形状。
	// 所以断言必须打在**按钮身上**:点它只会打开确认框。
	const bar = (over: Record<string, unknown> = {}) => ({
		scan,
		appealCount: 3,
		busy: false,
		running: false,
		confirming: false,
		onAsk: () => {},
		onConfirm: () => {},
		onCancel: () => {},
		...over,
	});

	it("**点「现在重跑这一周」只会打开确认框,不会真的重跑**", () => {
		const hit: string[] = [];
		const tree = mod.RerunBar(bar({ onAsk: () => hit.push("ask"), onConfirm: () => hit.push("rerun") }));
		const btn = findEl(tree, (el: any) => el.props?.className === "btn-ink");
		assert.ok(btn, "没有渲染出重跑按钮");
		btn.props.onClick();
		assert.deepEqual(hit, ["ask"], "这颗按钮不许直接触发重跑");
	});

	it("确认框没开时,屏幕上不该有那段警告(不吓唬还没打算重跑的人)", () => {
		const out = html(mod.RerunBar, bar());
		assert.match(out, /现在重跑这一周/);
		assert.ok(!out.includes("整批换掉"));
		assert.ok(!out.includes("是你自己捞回来的"));
	});

	it("确认框开着时,警告和 N 都在,而且那颗按钮被禁用(免得再点一次)", () => {
		const out = html(mod.RerunBar, bar({ confirming: true }));
		assert.match(out, /这一周有 3 个仓是你自己捞回来的/);
		assert.match(out, /整批换掉/);
		assert.match(out, /disabled/);
	});

	it("收单台照旧说清这是哪一周、基于哪一版档案", () => {
		const out = html(mod.RerunBar, bar());
		assert.match(out, /2026-W36/);
		assert.match(out, /档案 v1/);
	});

	it("跑起来之后按钮改文案", () => {
		assert.match(String(html(mod.RerunBar, bar({ busy: true, running: true }))), /扫描中…/);
	});
});

describe("重跑回执", () => {
	const rate = { authenticated: true, searchCalls: 16, coreCalls: 9, searchRemaining: 14, coreRemaining: 4900, waitedMs: 0 };

	it("搬回来的和没搬回来的分开说,名字逐个列出来", () => {
		const out = html(mod.RerunReceipt, {
			appeals: { restored: ["alibaba/zvec", "mem0ai/mem0"], missing: ["1deat0r/3V0-Agent"] },
			stopped: null,
			rate,
		});
		assert.match(out, /你之前捞回来的 <b class="hn">2<\/b> 个搬回来了/);
		assert.ok(out.includes("alibaba/zvec") && out.includes("mem0ai/mem0"));
		assert.match(out, /有 <b class="hn">1<\/b> 个这一趟没搜到/);
		assert.ok(out.includes("1deat0r/3V0-Agent"));
	});

	it("**missing 非空时必须说清「下次搜到会自动回来」**", () => {
		// 不说的话,少掉的那一行会被读成「我那次申诉白点了」,而下一步他多半会
		// 再点一次「这个该进来」—— 再花一次额度做一件系统已经答应会自动做的事。
		const out = html(mod.RerunReceipt, {
			appeals: { restored: [], missing: ["1deat0r/3V0-Agent"] },
			stopped: null,
			rate,
		});
		assert.match(out, /这不是白点了/);
		assert.match(out, /申诉记录还留着/);
		assert.match(out, /<strong>自动<\/strong>把它们搬回清单/);
		assert.match(out, /不用再点一次/);
		assert.match(out, /也不用再花一次额度/);
	});

	it("一次申诉都没有的那一趟,不提申诉两个字(不制造一段空话)", () => {
		const out = html(mod.RerunReceipt, { appeals: { restored: [], missing: [] }, stopped: null, rate });
		assert.ok(!out.includes("捞回来的"));
		assert.ok(!out.includes("没搜到"));
		assert.match(out, /跑完了。这一趟打了 16 次 search \+ 9 次 REST。/);
	});

	it("提前收工的那一趟,第一句先说清单是残的", () => {
		const out = html(mod.RerunReceipt, {
			appeals: { restored: ["a/b"], missing: [] },
			stopped: "search 额度不够,只跑完了 7/8 条检索词",
			rate,
		});
		assert.match(out, /提前收工/);
		assert.match(out, /这一周的清单是残的/);
		// 残缺归残缺,申诉那一栏照样要说
		assert.match(out, /搬回来了/);
	});
});

// ---------------------------------------------------------------------------
// 6 · 视图切换(纯函数那一半)
// ---------------------------------------------------------------------------

describe("两屏之间怎么切", () => {
	it("地址栏里的 view 只认两个值,别的一律当没指定", () => {
		assert.equal(viewInSearch("?view=scan"), "scan");
		assert.equal(viewInSearch("?view=dossier"), "dossier");
		assert.equal(viewInSearch(""), null);
		// 阶段 7 起 report 是**真的一屏**了(view.ts 的联合加了它),所以这里换一个
		// 确实不存在的值来验「认不出来就当没指定」。三屏那一套在 report-render.test.ts 里。
		assert.equal(viewInSearch("?view=nope"), null);
		assert.equal(viewInSearch("?a=1&view=scan&b=2"), "scan");
	});

	it("往返:切到哪一屏,地址栏就读得回哪一屏(刷新不丢)", () => {
		for (const v of ["scan", "dossier"] as const) {
			const search = searchForView(v);
			// 档案页是默认屏,不留参数——读回来是 null,由 defaultView 兜
			assert.equal(viewInSearch(search) ?? "dossier", v);
		}
	});

	it("SSO 落到 /app(没有查询串)时:有档案进清单,没档案进档案页", () => {
		assert.equal(viewInSearch(""), null);
		assert.equal(defaultView(true), "scan");
		assert.equal(defaultView(false), "dossier");
	});
});
