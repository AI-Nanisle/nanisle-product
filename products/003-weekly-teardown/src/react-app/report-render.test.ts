// 第三屏(深度报告)的**渲染层**回归测试 + SSE 状态机。跑法:npm test。
//
// 为什么这一屏比另外两屏更需要这一层:它长得像一篇文章,而文章天然会把降级
// 藏起来 —— 一份 HN 上没记录、文件树被截断、判断层被丢掉一半的报告,排版上和
// 一份完整的报告一模一样(docs/01 风险 1「错得很安静」)。这一屏的每一条产品
// 承诺都是「页面上应该出现某句话」这种形状,而它们全都能在纯函数层测得很绿、
// 屏幕上一个字都没有(阶段 3 栽过一次,教训写在 render.test.ts 顶部)。
//
// 所以这里的断言只有两种形状:
//   1. **渲染成 HTML,然后在 HTML 里找那句话**(而且找它落在哪个容器里);
//   2. **喂一串事件进状态机,看它落到哪个状态**。
//
// 打包方式与 render.test.ts / scan-render.test.ts 同款(esbuild → node_modules/.cache,
// react 保持 external 以便共用同一个 React 实例),理由在那两个文件顶部写全了。
//
// **反证做过的三处**(2026-09-01,退回之后每一处都当场红,详见各 it 的注释):
//   ① 把 anchoredRatio 改成前端拿 evidence 数组自己算  → 「后端算的比例」那一条红
//   ② 把 NoteList 包进 <details>                        → 「notes 不在折叠容器里」红
//   ③ 把永久回链换成 blob/main/                          → 「回链里是 40 位 sha」红
//
// **这套用例测不到什么**(如实记):
//   - App.tsx 里真的 fetch 一条 SSE 回来那一段。SSR 渲染器驱动不了状态更新,
//     也没有真的 ReadableStream。这里能测的是分帧(splitSse)和状态推进
//     (reduceRun)这两个纯函数,而 App 里剩下的是「把字节喂给它们」的十来行。
//   - CSS。.tl-unanchored 是不是真的看起来灰,只能靠眼睛;这里只断言那个 class
//     和那句「未能在原文中定位」同时出现 —— 那是灰显的必要条件不是充分条件。

import assert from "node:assert/strict";
import { mkdirSync } from "node:fs";
import path from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { before, describe, it } from "node:test";

import React from "react";
import ReactDOMServer from "react-dom/server";

import type { ReportEvent, TeardownReport } from "../shared/types.ts";
import { IDLE, phaseIndex, pctText, reduceRun, shortSha, sourceLabel, splitSse, startRun, streamCutOff } from "./report-run.ts";
import type { RunState } from "./report-run.ts";
import { defaultView, reportTargetInSearch, searchForView, viewInSearch } from "./view.ts";

const HERE = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(HERE, "../..");
const OUT = path.join(ROOT, "node_modules/.cache/nanisle-003-render/report.mjs");

let mod: {
	default: (props: any) => unknown;
	ReportProgress: (props: any) => unknown;
	AnchorLedger: (props: any) => unknown;
	NoteList: (props: any) => unknown;
	EvidenceCard: (props: any) => unknown;
	TakeawayList: (props: any) => unknown;
	DroppedBlock: (props: any) => unknown;
	HnBlock: (props: any) => unknown;
	Timeline: (props: any) => unknown;
	SourceFiles: (props: any) => unknown;
	LayerLegend: (props: any) => unknown;
};

before(async () => {
	const esbuild = (await import("esbuild")) as any;
	const build = (esbuild.build ?? esbuild.default?.build) as (o: unknown) => Promise<unknown>;
	mkdirSync(path.dirname(OUT), { recursive: true });
	await build({
		entryPoints: [path.join(HERE, "Report.tsx")],
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
// 折叠检测:一段文字**落在不落在任何 <details> 里**
// ---------------------------------------------------------------------------

/** HTML 里每一对 details 的 [起, 止) 区间(嵌套也算得对,用栈配对)。 */
function detailsRanges(out: string): Array<[number, number]> {
	const re = /<details\b|<\/details>/g;
	const stack: number[] = [];
	const ranges: Array<[number, number]> = [];
	for (let m = re.exec(out); m !== null; m = re.exec(out)) {
		if (m[0] === "</details>") {
			const start = stack.pop();
			if (start !== undefined) ranges.push([start, m.index + m[0].length]);
		} else {
			stack.push(m.index);
		}
	}
	return ranges;
}

/** 这句话在页面上,而且**不在任何折叠容器里**。规矩 ② 的机械判据。 */
function assertNotFolded(out: string, needle: string) {
	const at = out.indexOf(needle);
	assert.ok(at >= 0, `页面上根本没有这句话:${needle}`);
	const folded = detailsRanges(out).filter(([a, b]) => at >= a && at < b);
	assert.equal(folded.length, 0, `这句话被折叠起来了(落在 <details> 里):${needle}`);
}

// ---------------------------------------------------------------------------
// 夹具
// ---------------------------------------------------------------------------

const SHA = "9f3c1d2b4a5e6f708192a3b4c5d6e7f809a1b2c3"; // 40 位
const blob = (p: string, lines = "") => `https://github.com/acme/widget/blob/${SHA}/${p}${lines}`;

/**
 * 一份**故意自相矛盾**的报告:后端说已锚定比例是 0.5,而证据数组里 4 条有 3 条
 * anchored(75%)。页面必须印 50%。
 *
 * 这个矛盾是整份用例里最重要的一件事(同 scan-render.test.ts 里 honesty 说 5、
 * 候选只有 2 行那一条):前端一旦拿证据数组自己算一个百分比出来,它就会在某次
 * 改版里和后端分叉,而分叉之后页面还是理直气壮地印着一个数。
 */
const report = (over: Partial<TeardownReport> = {}): TeardownReport => ({
	id: "rep-1",
	fullName: "acme/widget",
	commitSha: SHA,
	dossierRev: 3,
	caresAbout: ["部署形态", "上下文怎么装"],
	generatedAt: 1_756_000_000_000,
	history: {
		timeline: [
			{ kind: "created", at: "2021-04-02T00:00:00Z", label: "仓库建立", evidenceId: "e1" },
			{ kind: "hn-comment", at: "2021-05-10T00:00:00Z", label: "HN 上的一条质疑", evidenceId: "e-off", pickedWhy: "它是当时唯一说到部署成本的一条" },
			{ kind: "last-push", at: "2026-08-20T00:00:00Z", label: "最后一次 push", evidenceId: "e2" },
		],
		hnStory: null,
		commentCandidates: 0,
		commentOrder: "kids",
		commentsMissing: 0,
		takeaways: [
			{ text: "作者从第一天就把部署当成产品的一部分", basedOn: ["e1"], caresAboutIndex: 0 },
		],
		dropped: [
			{ text: "这个项目很重视开发者体验", kind: "no-basis", reason: "basedOn 是空的:没有地基的判断就是凭空" },
		],
		gateNote: "模型给了 8 条,5 条挂得上已锚定的原文,3 条挂不上已丢弃",
	},
	source: {
		commitSha: SHA,
		files: [
			{ path: "src/index.ts", size: 4210, score: 12, why: "路径命中 src/index.*", chars: 4210, blobUrl: blob("src/index.ts") },
			{ path: "README.md", size: 0, score: 9, why: "README 永远读", chars: 8000, blobUrl: blob("README.md") },
		],
		treeTruncated: false,
		takeaways: [
			{ text: "它把上下文装配写成一个纯函数,好测", basedOn: ["e3"], caresAboutIndex: 1 },
		],
		dropped: [
			{ text: "这个项目用 zod 做输入校验", kind: "cares-about-out-of-range", reason: "caresAboutIndex 越界:标不出对应哪一条在意" },
		],
		gateNote: "模型给了 4 条,1 条挂得上已锚定的原文,3 条挂不上已丢弃",
	},
	evidence: [
		{ id: "e1", quote: "Initial commit: docker-compose up and you are done", source: "readme", anchored: true, permalink: blob("README.md", "#L1-L4"), context: "上下文片段" },
		{ id: "e2", quote: "chore: bump deps", source: "changelog", anchored: true, permalink: blob("CHANGELOG.md", "#L9") },
		{ id: "e3", quote: "export function buildContext(parts: Part[]): string", source: "raw:src/index.ts", anchored: true, permalink: blob("src/index.ts", "#L12-L28") },
		{ id: "e-off", quote: "this will never scale past ten users", source: "hn:38291043", anchored: false, permalink: "https://news.ycombinator.com/item?id=38291043" },
	],
	anchoredRatio: 0.5,
	notes: [
		{ kind: "hn-no-record", text: "这个项目在 HN 上没有记录 —— 节 1 里没有当年的一手反应" },
		{ kind: "no-changelog", text: "这个仓没有发布过 release,时间线上没有 changelog 节点" },
		{ kind: "history-model-failed", text: "节 1 的模型调用没成功,时间线照常,但没有发展史判断" },
	],
	estUsd: 0.6,
	model: { provider: "deepseek", historyModel: "deepseek-v4-pro", sourceModel: "deepseek-v4-pro" },
	...over,
});

const full = (over: Partial<TeardownReport> = {}): string =>
	ReactDOMServer.renderToStaticMarkup(React.createElement(mod.default as never, { report: report(over) } as never));

// ---------------------------------------------------------------------------
// 1 · gateNote 与 anchoredRatio(规矩 ①)
// ---------------------------------------------------------------------------

describe("锚定与丢弃的账必须显示", () => {
	it("两节的 gateNote 原样出现在页面上", () => {
		const out = full();
		assert.match(out, /模型给了 8 条,5 条挂得上已锚定的原文,3 条挂不上已丢弃/);
		assert.match(out, /模型给了 4 条,1 条挂得上已锚定的原文,3 条挂不上已丢弃/);
	});

	it("gateNote 不许被折叠起来 —— 硬门的对价就是把删了什么说清楚", () => {
		const out = full();
		assertNotFolded(out, "模型给了 8 条,5 条挂得上已锚定的原文,3 条挂不上已丢弃");
	});

	it("**反证的落点**:比例印后端给的 anchoredRatio,不是前端拿证据数组算的", () => {
		// 夹具里 anchoredRatio = 0.5,而 evidence 是 4 条里 3 条 anchored(75%)。
		// 把 AnchorLedger 改成自己数 evidence,这一条当场红。
		const out = html(mod.AnchorLedger, { report: report() });
		assert.ok(out.includes('<b class="hn">50%</b>'), `页面上没有后端算的 50%:\n${out}`);
		assert.ok(!out.includes("75%"), "印成自己数出来的 75% 就是前端在算数");
	});

	it("被丢弃的判断查得到:入口在页面上,丢了什么和为什么都在", () => {
		const out = full();
		assert.match(out, /被硬门丢弃的判断/);
		assert.match(out, /这个项目很重视开发者体验/);
		assert.match(out, /no-basis/);
		assert.match(out, /这个项目用 zod 做输入校验/);
		assert.match(out, /caresAboutIndex 越界/);
	});

	it("一条都没丢时说出来,不是留白(留白读起来像「这一节没什么可说的」)", () => {
		const out = html(mod.DroppedBlock, { dropped: [], where: "节 1 " });
		assert.match(out, /没有被丢弃的/);
	});
});

// ---------------------------------------------------------------------------
// 2 · notes 不许折叠(规矩 ②)
// ---------------------------------------------------------------------------

describe("这份报告缺了什么 —— 每一条都在,而且不在折叠容器里", () => {
	it("三条 note 全部出现", () => {
		const out = full();
		for (const n of report().notes) assert.ok(out.includes(n.text), `页面上没有这条 note:${n.text}`);
	});

	it("**反证的落点**:每一条 note 都不落在任何 <details> 里", () => {
		// 把 NoteList 的 <section> 换成 <details>,这一条当场红。
		// 折叠它们就等于把降级藏起来 —— 藏起来之后,一份残的报告和一份完整的
		// 报告长得一模一样,而那正是这个产品最反对的事。
		const out = full();
		for (const n of report().notes) assertNotFolded(out, n.text);
		// 页面上确实有折叠容器(被丢弃的判断、上下文),所以这条断言不是空跑
		assert.ok(detailsRanges(out).length > 0, "页面上一个 details 都没有,这条反证就没有意义了");
	});

	it("**在两节正文之前**出现,不是压在报告末尾的脚注", () => {
		// 位置本身就是内容:读者读到第一条判断的时候,得已经知道这份报告缺了什么。
		// 摆到最后等于让他先信了再告诉他地基是残的(同 scan-render.test.ts 里
		// 「残缺提示必须在第一屏可见」那一条)。
		const out = full();
		const noteAt = out.indexOf(report().notes[0]!.text);
		const sec01 = out.indexOf("它当年怎么走到今天");
		assert.ok(noteAt >= 0 && sec01 >= 0);
		assert.ok(noteAt < sec01, "这份报告缺了什么,必须在第一节正文之前说");
	});

	it("kind 也印出来:分组和判断看 kind,不解析那句中文", () => {
		const out = html(mod.NoteList, { notes: report().notes });
		assert.match(out, /hn-no-record/);
		assert.match(out, /tree-truncated|history-model-failed/);
	});

	it("一条 note 都没有时不画一个空框", () => {
		assert.equal(html(mod.NoteList, { notes: [] }), "");
	});
});

// ---------------------------------------------------------------------------
// 3 · HN 上没有记录 —— 不假装有
// ---------------------------------------------------------------------------

describe("HN 语料的降级", () => {
	it("commentCandidates 为 0 且没有帖子时,明写「这个项目在 HN 上没有记录」", () => {
		const out = html(mod.HnBlock, { report: report() });
		assert.match(out, /这个项目在 HN 上没有记录/);
	});

	it("没有帖子时**一个伪造的 HN 区块都不渲染**", () => {
		const out = full();
		assert.ok(!out.includes('class="hn-story"'), "hnStory 是 null,不许画出一个帖子区块");
		assert.ok(!out.includes("去 HN 看当年的讨论"), "没有帖子就没有链接可以点");
	});

	it("有帖子但一条评论都没有时,说的是另一句话(不撒谎说「没有记录」也不装作有反应)", () => {
		const out = html(mod.HnBlock, {
			report: report({
				history: {
					...report().history,
					hnStory: { id: "38291043", title: "Show HN: Widget", url: "https://acme.dev", points: 412, numComments: 0, permalink: "https://news.ycombinator.com/item?id=38291043" },
					commentCandidates: 0,
				},
			}),
		});
		assert.match(out, /一条评论都没有/);
		assert.match(out, /没有记录/);
		assert.ok(out.includes('class="hn-story"'));
	});

	/** 有帖子有评论的那一档;order 决定页面说哪一句话。 */
	const withComments = (over: Record<string, unknown> = {}) =>
		html(mod.HnBlock, {
			report: report({
				history: {
					...report().history,
					hnStory: { id: "38291043", title: "Show HN: Widget", url: "https://acme.dev", points: 412, numComments: 87, permalink: "https://news.ycombinator.com/item?id=38291043" },
					commentCandidates: 30,
					...over,
				},
			}),
		});

	it("有帖子有评论时,分数、评论数和回链都在", () => {
		const out = withComments();
		// **帖子**的分数是真的:HN Algolia 对 story 给 points(评论不给)
		assert.ok(out.includes('<b class="hn">412</b>'));
		assert.ok(out.includes('<b class="hn">87</b>'));
		assert.match(out, /news\.ycombinator\.com\/item\?id=38291043/);
		assert.ok(out.includes('<b class="hn">30</b>'), "取回了几条候选评论要说出来:模型只是从里面挑");
	});

	// ---- 2026-09-01 阶段 7 评审必须修 2:排序口径要说清,分数一个字都不许提 ----

	it("拿到 kids 时才敢说「HN 自己的排序」,而且明说分数印不出来", () => {
		const out = withComments({ commentOrder: "kids" });
		assert.match(out, /HN 自己的排序/);
		assert.match(out, /HN 不公开评论分数/);
		assert.ok(!out.includes("按分数"), "页面上不许出现一个我们拿不到的排序依据");
	});

	it("拿不到 kids 时改口:按时间给的,不代表当年被顶得最高", () => {
		const out = withComments({ commentOrder: "chronological" });
		assert.match(out, /拿不到 HN 自己的排序/);
		assert.match(out, /不代表当年被顶得最高/);
		assert.ok(!out.includes("真实反映当年的投票"), "降级了就别再声称这是 HN 的排名");
		assert.ok(!out.includes("HN 排在第"), "没有名次就一个名次都别给");
	});

	it("正文对不上的那几条如实说少给了,不含糊过去", () => {
		const out = withComments({ commentOrder: "kids", commentsMissing: 4 });
		assert.match(out, /4 条的正文取不到,如实少给/);
		assert.match(out, /没有拿后面的评论补上来充数/);
	});
});

// ---------------------------------------------------------------------------
// 3.5 · 锚定总账那两个数的口径(2026-09-01 阶段 7 评审建议修 5)
// ---------------------------------------------------------------------------

describe("AnchorLedger 的两个数", () => {
	it("印的是**后端整张证据表**的条数,而且在页面上说破它含被丢弃的那些", () => {
		const out = html(mod.AnchorLedger, { report: report() });
		// 这一页真正渲染得出的证据只有 e1 / e3(两条 takeaway 挂着的),而
		// e2 / e-off 挂在被丢弃的判断和灰显节点上 —— 分母仍然是 4,不藏
		assert.ok(out.includes('<b class="hn">4</b>'), out);
		assert.match(out, /含被丢弃的判断挂过的那些/);
		assert.match(out, /50%/, "百分比直接印后端的 anchoredRatio,前端不自己算");
	});
});

// ---------------------------------------------------------------------------
// 4 · 文件树被截断
// ---------------------------------------------------------------------------

describe("节 2 的问责区", () => {
	it("**treeTruncated 为 true 时标注必须出现**,而且写清后果", () => {
		const out = full({ source: { ...report().source, treeTruncated: true } });
		assert.match(out, /文件树太大被截断/);
		assert.match(out, /只读了 README/);
		assert.ok(out.includes('role="alert"'), "这条降级要让读屏软件也听得到");
	});

	it("没被截断时不制造假警报", () => {
		assert.ok(!full().includes("文件树太大被截断"));
	});

	it("真的读过的那几份文件、打分和挑它的理由都摊开", () => {
		const out = html(mod.SourceFiles, { report: report() });
		assert.match(out, /src\/index\.ts/);
		assert.match(out, /路径命中 src\/index/);
		assert.match(out, /README 永远读/);
		assert.match(out, /4210/);
	});

	it("一份文件都没取到时说出来", () => {
		const out = html(mod.SourceFiles, { report: report({ source: { ...report().source, files: [] } }) });
		assert.match(out, /一份文件正文都没取到/);
	});
});

// ---------------------------------------------------------------------------
// 5 · 事实层灰显 vs 判断层已丢弃(决策 T4 的反转)
// ---------------------------------------------------------------------------

describe("两层的处理是相反的,页面上要分得开", () => {
	it("**事实层锚不上:节点还在,灰显并标注**", () => {
		const out = html(mod.Timeline, { report: report() });
		assert.match(out, /HN 上的一条质疑/, "锚不上的节点不许删");
		assert.ok(out.includes("tl-unanchored"), "灰显要有一个可断言的 class");
		assert.match(out, /未能在原文中定位/, "色盲用户看不到灰,只能读字");
	});

	it("锚上了的节点不许被灰掉", () => {
		const out = html(mod.Timeline, {
			report: report({ history: { ...report().history, timeline: [report().history.timeline[0]!] } }),
		});
		assert.ok(!out.includes("tl-unanchored"));
		assert.ok(!out.includes("未能在原文中定位"));
	});

	it("判断层不合格的**根本不在页面上**(后端已经丢掉了),但两种处理的区别写明了", () => {
		const out = full();
		assert.match(out, /灰显不删/);
		assert.match(out, /直接丢弃/);
		assert.match(out, /在最想被读的那一层放软门就是自欺/);
	});

	it("每条判断都标出它对应档案里在意的第几条,以及它站在哪几段原文上", () => {
		const out = full();
		assert.match(out, /对应你在意的第 1 条/);
		assert.match(out, /部署形态/);
		assert.match(out, /它的地基/);
		assert.match(out, /Initial commit: docker-compose up and you are done/);
	});

	it("caresAbout 是**报告快照那一份**,页面要说清这件事", () => {
		const out = full();
		assert.match(out, /不是你现在那一份档案/);
		assert.match(out, /上下文怎么装/);
	});

	it("takeaway 一条都没剩下时不留白", () => {
		const out = html(mod.TakeawayList, { takeaways: [], caresAbout: [], evidence: new Map(), empty: "一条都没剩下:被硬门丢完了" });
		assert.match(out, /被硬门丢完了/);
	});
});

// ---------------------------------------------------------------------------
// 6 · 永久回链里是 commit sha,不是分支名
// ---------------------------------------------------------------------------

describe("永久回链", () => {
	it("**页面上每一条 /blob/ 链接里都是 40 位 sha**", () => {
		// 反证:把 blobUrl / permalink 换成 blob/main/...,这一条当场红。
		const out = full();
		const blobs = out.match(/https:\/\/github\.com\/[^"]*\/blob\/[^"]*/g) ?? [];
		assert.ok(blobs.length >= 3, `页面上应该有好几条 blob 回链,只找到 ${blobs.length} 条`);
		for (const href of blobs) {
			assert.match(href, /\/blob\/[0-9a-f]{40}\//, `这条回链里不是 40 位 sha,会漂:${href}`);
		}
		assert.ok(!out.includes("/blob/main/") && !out.includes("/blob/master/"), "分支名回链在对方下次提交后就指向别的代码了");
	});

	it("链接文案点出「不会漂」这件事 —— 这是相对同类工具真正的差异之一", () => {
		const out = html(mod.EvidenceCard, { e: report().evidence[0] });
		assert.match(out, /指向当时那几行/);
		assert.match(out, /不会漂/);
	});

	it("整份报告的抬头把 40 位 sha 原样印出来(短的那个只是显示)", () => {
		const out = full();
		assert.ok(out.includes(SHA), "全长 sha 要能被复制走");
		assert.equal(shortSha(SHA), "9f3c1d2");
	});

	it("锚不上的那条证据照样给链接,但文案不许说「指向当时那几行」", () => {
		const out = html(mod.EvidenceCard, { e: report().evidence[3] });
		assert.match(out, /未能在原文中定位/);
		assert.ok(out.includes("ev-off"));
		assert.ok(!out.includes("指向当时那几行"), "HN 那条不是 blob 回链,不该借用永久回链的说法");
	});
});

// ---------------------------------------------------------------------------
// 7 · 那句必须写清的话(规矩 ③)
// ---------------------------------------------------------------------------

describe("可校验的是推理的地基,不是推理本身", () => {
	it("**这句话真的在页面上**", () => {
		assert.match(full(), /可校验的是推理的地基,不是推理本身/);
	});

	it("而且不许被折叠 —— 它是决策 T4 的核心诚实点,不是脚注", () => {
		assertNotFolded(full(), "可校验的是推理的地基,不是推理本身");
	});

	it("旁边把「判断句不可能被锚定」说破,免得读者以为判断本身有引用", () => {
		const out = html(mod.AnchorLedger, { report: report() });
		assert.match(out, /判断句在原文里根本不存在/);
		assert.match(out, /不可能/);
	});
});

// ---------------------------------------------------------------------------
// 8 · SSE:分帧与状态机
// ---------------------------------------------------------------------------

describe("SSE 分帧", () => {
	it("一次收到多帧,全都解析出来", () => {
		const buf = 'data: {"type":"phase","phase":"fetching"}\n\ndata: {"type":"ping"}\n\n';
		const { events, rest } = splitSse(buf);
		assert.equal(events.length, 2);
		assert.equal(rest, "");
	});

	it("**收到半帧时留着,不丢也不解析**", () => {
		const { events, rest } = splitSse('data: {"type":"ping"}\n\ndata: {"type":"del');
		assert.equal(events.length, 1);
		assert.equal(rest, 'data: {"type":"del');
		// 下一次 read 把剩下的补齐
		const next = splitSse(`${rest}ta","chars":42}\n\n`);
		assert.deepEqual(next.events, [{ type: "delta", chars: 42 }]);
	});

	it("坏掉的一帧跳过,**不中断整条流**", () => {
		const { events } = splitSse('data: {oops\n\ndata: {"type":"ping"}\n\n');
		assert.deepEqual(events, [{ type: "ping" }]);
	});

	it("非 data: 的行忽略(注释 / event: / id:)", () => {
		const { events } = splitSse(': keepalive\n\nevent: x\nid: 3\n\ndata: {"type":"ping"}\n\n');
		assert.deepEqual(events, [{ type: "ping" }]);
	});
});

describe("SSE 状态机", () => {
	const feed = (evs: ReportEvent[], from: RunState = startRun("acme/widget")): RunState =>
		evs.reduce<RunState>((s, e) => reduceRun(s, e), from);

	it("phase 按顺序推进", () => {
		const s = feed([
			{ type: "phase", phase: "fetching" },
			{ type: "phase", phase: "history" },
			{ type: "phase", phase: "source" },
		]);
		assert.equal(s.kind, "running");
		assert.equal(s.kind === "running" && s.phase, "source");
	});

	it("**ping 不推进 phase**,只证明连接还活着", () => {
		const s = feed([
			{ type: "phase", phase: "history" },
			{ type: "ping" },
			{ type: "ping" },
			{ type: "ping" },
		]);
		assert.equal(s.kind === "running" && s.phase, "history", "ping 把进度往前推了 —— 那是在编");
		assert.equal(s.kind === "running" && s.beats, 3);
	});

	it("delta 只带字符数,进 chars 不进 phase", () => {
		const s = feed([{ type: "phase", phase: "history" }, { type: "delta", chars: 1234 }]);
		assert.equal(s.kind === "running" && s.chars, 1234);
		assert.equal(s.kind === "running" && s.phase, "history");
	});

	it("乱序 / 重复的 phase 不许把进度拖回去", () => {
		const s = feed([
			{ type: "phase", phase: "anchoring" },
			{ type: "phase", phase: "fetching" },
		]);
		assert.equal(s.kind === "running" && s.phase, "anchoring");
	});

	it("**result 进终态**,并带上 cached", () => {
		const s = feed([{ type: "phase", phase: "anchoring" }, { type: "result", report: report(), cached: false }]);
		assert.equal(s.kind, "done");
		assert.equal(s.kind === "done" && s.cached, false);
	});

	it("**error 进错误态**,文案原样带过来(quota 也要带上)", () => {
		const s = feed([{ type: "error", error: "GitHub 这会儿不通,材料没抓齐。这一次已经计入今天的额度,过几分钟再试。", quota: true }]);
		assert.equal(s.kind, "failed");
		assert.equal(s.kind === "failed" && s.quota, true);
		assert.match(s.kind === "failed" ? s.error : "", /已经计入今天的额度/, "后端的文案不许改写:计不计额度这个区别对用户很重要");
	});

	it("终态吸收一切:result 之后再来的事件不许把页面拖回「生成中」", () => {
		const done = feed([{ type: "result", report: report(), cached: true }]);
		const after = reduceRun(reduceRun(done, { type: "ping" }), { type: "phase", phase: "fetching" });
		assert.equal(after.kind, "done");
	});

	it("idle 状态不接受任何事件(没点过按钮就不该有进度)", () => {
		assert.equal(reduceRun(IDLE, { type: "phase", phase: "history" }).kind, "idle");
	});

	it("流断了但没收到终态 → 失败态,而且说清那一单可能还在跑", () => {
		const cut = streamCutOff(feed([{ type: "phase", phase: "history" }]));
		assert.equal(cut.kind, "failed");
		assert.match(cut.kind === "failed" ? cut.error : "", /还在跑/);
		assert.equal(cut.kind === "failed" && cut.refresh, true, "重试没有出路,只能刷新接回");
	});

	it("已经收到终态的流断掉时什么都不改", () => {
		const done = feed([{ type: "result", report: report(), cached: false }]);
		assert.equal(streamCutOff(done).kind, "done");
	});
});

describe("生成中那一屏", () => {
	it("四步都在,当前那一步标出来", () => {
		const out = html(mod.ReportProgress, { run: startRun("acme/widget", false, "source") });
		assert.match(out, /抓材料/);
		assert.match(out, /逐字锚定/);
		assert.ok(out.includes("run-now"), "当前那一步要有一个可断言的 class");
		assert.ok(out.includes("run-done"), "走过的那几步要打勾");
	});

	it("**delta 只报字符数,页面不许假装能预览**", () => {
		const run = reduceRun(startRun("acme/widget", false, "history"), { type: "delta", chars: 900 });
		const out = html(mod.ReportProgress, { run });
		assert.ok(out.includes('<b class="hn">900</b>'));
		assert.match(out, /只报字符数不报内容/);
	});

	it("接回来的那一路照实说「接回来的是进度不是流」", () => {
		const out = html(mod.ReportProgress, { run: startRun("acme/widget", true, "history") });
		assert.match(out, /接回来的进度/);
		assert.match(out, /原来那条流已经断了/);
	});

	it("没在跑的时候什么都不画", () => {
		assert.equal(html(mod.ReportProgress, { run: IDLE }), "");
		assert.equal(html(mod.ReportProgress, { run: { kind: "done", fullName: "a/b", cached: false } }), "");
	});
});

// ---------------------------------------------------------------------------
// 9 · 显示口径的小函数
// ---------------------------------------------------------------------------

describe("显示口径", () => {
	it("source id 翻成人话,解析的是冒号前那一截", () => {
		assert.equal(sourceLabel("readme"), "README");
		assert.equal(sourceLabel("raw:src/index.ts"), "源码 src/index.ts");
		assert.equal(sourceLabel("hn:38291043"), "HN #38291043");
		assert.equal(sourceLabel("something-new"), "something-new", "认不出来就原样回显,不猜");
	});

	it("phaseIndex 认不出来的 phase 回 -1(页面据此不给任何一步打勾)", () => {
		assert.equal(phaseIndex("fetching"), 0);
		assert.equal(phaseIndex("anchoring"), 3);
		assert.equal(phaseIndex("discovering"), -1);
	});

	it("pctText 四舍五入,NaN 不印成 NaN%", () => {
		assert.equal(pctText(0.5), "50%");
		assert.equal(pctText(0.666), "67%");
		assert.equal(pctText(Number.NaN), "—");
	});
});

// ---------------------------------------------------------------------------
// 10 · 路由:报告要能被直接链接到(阶段 8 的门铃邮件会链过来)
// ---------------------------------------------------------------------------

describe("三屏之间怎么切", () => {
	it("view 只认三个值,别的一律当没指定", () => {
		assert.equal(viewInSearch("?view=scan"), "scan");
		assert.equal(viewInSearch("?view=dossier"), "dossier");
		assert.equal(viewInSearch("?view=report"), "report");
		assert.equal(viewInSearch("?view=nope"), null);
		assert.equal(viewInSearch(""), null);
	});

	it("`?id=` / `?repo=` 单独出现时就是报告屏(邮件里的短链接)", () => {
		assert.equal(viewInSearch("?repo=acme%2Fwidget"), "report");
		assert.equal(viewInSearch("?id=rep-1"), "report");
		assert.deepEqual(reportTargetInSearch("?repo=acme%2Fwidget"), { repo: "acme/widget" });
		assert.deepEqual(reportTargetInSearch("?id=rep-1"), { id: "rep-1" });
		assert.equal(reportTargetInSearch("?view=scan"), null);
	});

	it("显式的 view 永远优先(从报告屏切回清单屏时地址栏还留着 repo)", () => {
		assert.equal(viewInSearch("?view=scan&repo=acme%2Fwidget"), "scan");
	});

	it("往返:切到哪一份报告,地址栏就读得回哪一份(刷新不丢、贴给别人也是那一份)", () => {
		const s1 = searchForView("report", { repo: "acme/widget" });
		assert.equal(viewInSearch(s1), "report");
		assert.deepEqual(reportTargetInSearch(s1), { repo: "acme/widget" });
		const s2 = searchForView("report", { id: "rep-1" });
		assert.deepEqual(reportTargetInSearch(s2), { id: "rep-1" });
		// 两屏那一套没被改坏
		assert.equal(viewInSearch(searchForView("scan")), "scan");
		assert.equal(viewInSearch(searchForView("dossier")) ?? "dossier", "dossier");
		assert.equal(defaultView(true), "scan");
	});

	it("没给 target 时退回裸的 ?view=report(由 App 显示「地址里没说是哪一份」)", () => {
		assert.equal(searchForView("report"), "?view=report");
		assert.equal(reportTargetInSearch("?view=report"), null);
	});
});
