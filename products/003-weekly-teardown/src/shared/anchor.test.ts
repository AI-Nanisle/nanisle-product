// 多源锚定 + 判断层硬门的测试。跑法:npm test。
//
// 这一层是整个产品的地基(docs/01 决策 6:砍了就不成立的那一条),所以用例密度
// 要比别处高:每条规则配正例和反例——只有正例的话,一个「永远返回 anchored: true」
// 的坏实现照样全绿,而那正是这一层最怕的失败模式。

import assert from "node:assert/strict";
import { describe, it } from "node:test";
import {
	anchorAcross,
	anchorAll,
	anchoredRatio,
	describeGate,
	gateTakeaways,
	normalizeForAnchor,
} from "./anchor.ts";
import type { Evidence, SourceId, Takeaway } from "./anchor.ts";

// ---------------------------------------------------------------------------
// 1. 跨源命中判失败 —— 这一层存在的全部理由
// ---------------------------------------------------------------------------

describe("anchorAcross · 跨源命中判失败(本模块存在的全部理由)", () => {
	// 开源项目之间抄来抄去,这一段在半个 GitHub 上都能找到。
	const MIT = "Permission is hereby granted, free of charge, to any person obtaining a copy";
	// 只在 B 项目里存在的一句话。模型可能声称它引自 A。
	const ONLY_IN_B = "we deliberately keep the scheduler single threaded for now";

	const sources = new Map<SourceId, string>([
		["raw:a/src/index.ts", `// project A\n${MIT}\nexport function boot() {}\n`],
		["readme:b", `# project B\n${MIT}\n\n${ONLY_IN_B}, see issue 42.\n`],
	]);

	it("同一句话在两份材料里都有:声称哪一份就在哪一份里命中,两边都 true", () => {
		assert.equal(anchorAcross(MIT, sources, "raw:a/src/index.ts").anchored, true);
		assert.equal(anchorAcross(MIT, sources, "readme:b").anchored, true);
	});

	it("**声称 A 而这句话只在 B 里存在 → 必须 false**(张冠李戴的引文比没有引文更危险)", () => {
		// 前提先钉住:这句话确实在 B 里 —— 否则下面那条 false 可能只是"哪儿都没有"
		assert.equal(anchorAcross(ONLY_IN_B, sources, "readme:b").anchored, true);

		// 直觉方案(把十几份材料拼成一个大字符串当底本)在这里会判 true,
		// 然后给这条引文挂上一个指向 A 某一行的永久回链——点开根本没有那句话。
		const naiveHay = [...sources.values()].join("\n");
		assert.ok(normalizeForAnchor(naiveHay).includes(normalizeForAnchor(ONLY_IN_B)), "前提:拼接底本里确实有这句话");

		assert.equal(anchorAcross(ONLY_IN_B, sources, "raw:a/src/index.ts").anchored, false);
	});

	it("跨源失败不带 context(失败就是失败,不给任何看起来像凭证的东西)", () => {
		assert.equal(anchorAcross(ONLY_IN_B, sources, "raw:a/src/index.ts").context, undefined);
	});
});

// ---------------------------------------------------------------------------
// 2. claimedSource 不在 sources 里
// ---------------------------------------------------------------------------

describe("anchorAcross · claimedSource 不认识", () => {
	const sources = new Map<SourceId, string>([["readme", "the quick brown fox jumps over the lazy dog"]]);

	it("模型编了个来源名 → false,不抛错,也不去别处找", () => {
		let hit: ReturnType<typeof anchorAcross> | null = null;
		assert.doesNotThrow(() => {
			hit = anchorAcross("the quick brown fox", sources, "raw:src/nowhere.ts");
		});
		assert.deepEqual(hit, { anchored: false });
	});

	it("空 sources 也一样 → false", () => {
		assert.equal(anchorAcross("the quick brown fox", new Map(), "readme").anchored, false);
	});
});

// ---------------------------------------------------------------------------
// 3. MIN_NEEDLE_CHARS —— 太短的命中是巧合
// ---------------------------------------------------------------------------

describe("anchorAcross · 引文太短判巧合", () => {
	const sources = new Map<SourceId, string>([["readme", "prefix abcd suffix"]]);

	it("归一后 3 个字符:即使原文里确实有也判 false", () => {
		// 前提:"abc" 确实是 "abcd" 的前缀,命中是真的,判 false 是因为太短
		assert.ok(normalizeForAnchor("prefix abcd suffix").includes("abc"));
		assert.equal(anchorAcross("abc", sources, "readme").anchored, false);
	});

	it("归一后 4 个字符:命中 true(边界的另一侧要有反例,否则把 4 写成 40 也全绿)", () => {
		assert.equal(anchorAcross("abcd", sources, "readme").anchored, true);
	});

	it("引文全是标点空白(归一后为空)→ false", () => {
		assert.equal(anchorAcross(" ,.!  ", sources, "readme").anchored, false);
	});
});

// ---------------------------------------------------------------------------
// 4. 归一化口径 —— 宽容无害改动,拦住内容性改写
// ---------------------------------------------------------------------------

describe("anchorAcross · 归一化口径(与 002 一字不差)", () => {
	const text = 'The scheduler is, quite deliberately, "single threaded" —— see 讨论区第 3 条。';
	const sources = new Map<SourceId, string>([["hn:38291043", text]]);
	const hit = (quote: string) => anchorAcross(quote, sources, "hn:38291043").anchored;

	it("无害改动应该命中:标点全半角", () => {
		assert.equal(hit("The scheduler is， quite deliberately"), true);
	});

	it("无害改动应该命中:引号样式(直引号 ↔ 弯引号)", () => {
		assert.equal(hit("deliberately, “single threaded”"), true);
	});

	it("无害改动应该命中:空格增删", () => {
		assert.equal(hit("thescheduler   is quite  deliberately"), true);
	});

	it("无害改动应该命中:大小写", () => {
		assert.equal(hit("THE SCHEDULER IS QUITE DELIBERATELY"), true);
	});

	it("内容性改写必须不命中:换词", () => {
		assert.equal(hit("The scheduler is, quite explicitly, single threaded"), false);
	});

	it("内容性改写必须不命中:增字", () => {
		assert.equal(hit("The scheduler is always quite deliberately single threaded"), false);
	});

	it("内容性改写必须不命中:删字", () => {
		assert.equal(hit("The scheduler is deliberately single threaded"), false);
	});
});

// ---------------------------------------------------------------------------
// 5. context 的正确性 —— 归一化后的下标要能映射回原文
// ---------------------------------------------------------------------------

describe("anchorAcross · context 是原文片段(下标映射)", () => {
	const before = "x, ".repeat(150); // 450 字符,归一化后只剩 150 —— 下标必须错位才验得出映射
	const after = "y. ".repeat(150);
	// 故意塞满标点和空格:归一化会把它们全删掉,下标于是整体左移。
	// 如果实现直接拿归一化串的下标去 slice 原文,截出来的就是别处的东西。
	const quoteInText = 'Hello, World! "This" is —— the quoted sentence.';
	const text = before + quoteInText + after;
	const sources = new Map<SourceId, string>([["readme", text]]);

	it("命中,且 context 是原文的一段子串(不是归一化后的串)", () => {
		const hit = anchorAcross(quoteInText, sources, "readme");
		assert.equal(hit.anchored, true);
		assert.ok(hit.context);
		assert.ok(text.includes(hit.context!), "context 必须逐字出现在原文里");
		// 归一化串里没有空格和标点,原文片段里必须有 —— 这一条钉死"给人看的是原文"
		assert.ok(/[\s,"!.]/.test(hit.context!), "context 必须保留原文的空白和标点");
		assert.ok(hit.context!.includes(quoteInText), "context 必须包含引文本身");
	});

	it("截取窗口的下标算得准:前后各 150 个原文字符,一个不多一个不少", () => {
		const hit = anchorAcross(quoteInText, sources, "readme");
		const start = before.length; // 归一化后第一个匹配字符 'H' 在原文的下标
		// 归一化后最后一个匹配字符是 "sentence" 的 e —— 末尾的 '.' 是标点,归一化时被删了
		const end = before.length + quoteInText.length - 1;
		assert.equal(hit.context, text.slice(start - 150, end + 150));
	});

	it("命中处贴着开头/结尾时窗口自动收边,不会越界", () => {
		const short = "abcdef";
		const hit = anchorAcross("abcdef", new Map([["readme", short]]), "readme");
		assert.equal(hit.context, short);
	});

	it("引文与原文标点不同时,context 仍截自原文(而不是照抄模型给的引文)", () => {
		const hit = anchorAcross("hello world this is the quoted sentence", sources, "readme");
		assert.equal(hit.anchored, true);
		assert.ok(hit.context!.includes(quoteInText), "截出来的是原文那一版,带原来的引号和破折号");
	});

	it("窗口边界落在代理对中间时往外退一格,不截出半个 emoji", () => {
		// 😀 占 2 个 code unit,放在下标 [0,2);后面 149 个 x,引文从下标 151 开始。
		// 151 - 150 = 1 正好落在代理对中间 —— 不处理的话 slice 会切出一个孤立代理字符。
		const emojiText = "😀" + "x".repeat(149) + "needle phrase here" + "z".repeat(10);
		const hit = anchorAcross("needle phrase here", new Map([["readme", emojiText]]), "readme");
		assert.equal(hit.anchored, true);
		assert.ok(hit.context!.startsWith("😀"), "整个 emoji 被包进来,而不是被切成半个");
		assert.equal(/[\uD800-\uDBFF](?![\uDC00-\uDFFF])|(?<![\uD800-\uDBFF])[\uDC00-\uDFFF]/.test(hit.context!), false);
	});
});

// ---------------------------------------------------------------------------
// 事实层:只标记不删
// ---------------------------------------------------------------------------

describe("anchorAll · 事实层灰显不删(沿用 002 的家法)", () => {
	const sources = new Map<SourceId, string>([["changelog", "1.2.0 dropped support for node 14"]]);

	it("配不上的条目照样留在数组里,只是 anchored: false", () => {
		const out = anchorAll(
			[
				{ quote: "dropped support for node 14", source: "changelog" },
				{ quote: "rewrote the whole thing in rust", source: "changelog" },
			],
			sources,
		);
		assert.equal(out.length, 2, "事实层一条都不许丢");
		assert.equal(out[0].anchored, true);
		assert.equal(out[1].anchored, false);
	});
});

// ---------------------------------------------------------------------------
// 6/7. 判断层硬门
// ---------------------------------------------------------------------------

const ev = (id: string, anchored: boolean): Evidence => ({
	id,
	quote: `quote for ${id}`,
	source: "raw:src/index.ts",
	anchored,
	permalink: `github.com/o/r/blob/deadbeef/src/index.ts#L1-L2`,
});

/** 两条证据:e1 锚上了,e2 没锚上。每条用例只改 takeaway 的一个字段。 */
const EVIDENCE = [ev("e1", true), ev("e2", false)];

const tk = (over: Partial<Takeaway> = {}): Takeaway => ({
	text: "它把调度器刻意做成单线程,把并发复杂度挡在了库外面",
	basedOn: ["e1"],
	caresAboutIndex: 0,
	...over,
});

describe("gateTakeaways · 判断层直接丢弃(有意反转 002 的软门)", () => {
	const gate = (t: Takeaway, count = 3) => gateTakeaways([t], EVIDENCE, count);

	it("基线:地基齐全的判断留下(反例的公共前提)", () => {
		const r = gate(tk());
		assert.equal(r.kept.length, 1);
		assert.equal(r.dropped.length, 0);
	});

	it("丢弃条件 1:basedOn 为空 —— 没有地基的判断就是凭空", () => {
		const r = gate(tk({ basedOn: [] }));
		assert.equal(r.kept.length, 0);
		assert.equal(r.dropped[0].kind, "no-basis");
		assert.match(r.dropped[0].reason, /basedOn/);
	});

	it("丢弃条件 2:引用了证据表里找不到的 id —— 模型编了个证据 id", () => {
		const r = gate(tk({ basedOn: ["e1", "e999"] }));
		assert.equal(r.kept.length, 0);
		assert.equal(r.dropped[0].kind, "unknown-evidence");
		assert.match(r.dropped[0].reason, /e999/, "理由要说出是哪个 id,不是一句笼统的不合格");
	});

	it("丢弃条件 3:依据的证据 anchored === false —— 地基本身没锚上", () => {
		const r = gate(tk({ basedOn: ["e1", "e2"] }));
		assert.equal(r.kept.length, 0);
		assert.equal(r.dropped[0].kind, "unanchored-evidence");
		assert.match(r.dropped[0].reason, /e2/);
	});

	it("丢弃条件 4:caresAboutIndex 越界 —— 滤掉「真但无用」的观察", () => {
		const r = gate(tk({ caresAboutIndex: 3 }), 3); // 合法下标 0..2
		assert.equal(r.kept.length, 0);
		assert.equal(r.dropped[0].kind, "cares-about-out-of-range");
	});

	it("判断层是**丢弃**不是灰显:kept 里不能出现被判不合格的条目", () => {
		const r = gateTakeaways([tk(), tk({ basedOn: [] }), tk({ basedOn: ["e2"] })], EVIDENCE, 3);
		assert.equal(r.kept.length, 1);
		assert.equal(r.dropped.length, 2);
		assert.ok(
			!r.kept.some((k) => k.basedOn.length === 0 || k.basedOn.includes("e2")),
			"配不上的判断绝不能带着一个 anchored: false 的标记留在 kept 里 —— 读者会把灰色当排版照读不误",
		);
	});
});

describe("gateTakeaways · caresAboutIndex 边界", () => {
	const gate = (i: number, count = 2) => gateTakeaways([tk({ caresAboutIndex: i })], EVIDENCE, count);

	it("负数越界", () => {
		assert.equal(gate(-1).kept.length, 0);
	});

	it("等于长度越界(下标从 0 数)", () => {
		assert.equal(gate(2, 2).kept.length, 0);
	});

	it("远超长度越界", () => {
		assert.equal(gate(99, 2).kept.length, 0);
	});

	it("0 和 length-1 是合法的(边界的另一侧要有反例)", () => {
		assert.equal(gate(0, 2).kept.length, 1);
		assert.equal(gate(1, 2).kept.length, 1);
	});

	it("非整数按越界处理(模型偶尔回 1.5,它同样标不出是哪一条)", () => {
		assert.equal(gate(1.5, 3).kept.length, 0);
		assert.equal(gate(Number.NaN, 3).kept.length, 0);
	});

	it("档案一条 caresAbout 都没有时,任何下标都越界", () => {
		assert.equal(gate(0, 0).kept.length, 0);
	});
});

// ---------------------------------------------------------------------------
// 8. 产出统计
// ---------------------------------------------------------------------------

describe("anchoredRatio / describeGate · 丢掉多少要能被看见", () => {
	it("已锚定证据 / 全部证据", () => {
		assert.equal(anchoredRatio([ev("a", true), ev("b", true), ev("c", false), ev("d", false)]), 0.5);
		assert.equal(anchoredRatio([ev("a", true)]), 1);
		assert.equal(anchoredRatio([ev("a", false)]), 0);
	});

	it("没有证据时是 0,不是 1 —— 「零分之零」不该算满分", () => {
		assert.equal(anchoredRatio([]), 0);
	});

	it("gateTakeaways 把比例一起带出来", () => {
		const r = gateTakeaways([tk()], EVIDENCE, 3);
		assert.equal(r.anchoredRatio, 0.5); // EVIDENCE 是一锚上一没锚上
	});

	it("一句话统计能上页面(模型给了几条 / 留下几条 / 丢了几条)", () => {
		const r = gateTakeaways(
			[tk(), tk(), tk(), tk(), tk(), tk({ basedOn: [] }), tk({ basedOn: ["e2"] }), tk({ caresAboutIndex: 9 })],
			EVIDENCE,
			3,
		);
		assert.equal(describeGate(r), "模型给了 8 条,5 条挂得上已锚定的原文,3 条挂不上已丢弃");
	});

	it("每条丢弃都带得出理由(不允许静默丢)", () => {
		const r = gateTakeaways([tk({ basedOn: [] }), tk({ basedOn: ["e2"] }), tk({ caresAboutIndex: 9 })], EVIDENCE, 3);
		for (const d of r.dropped) {
			assert.ok(d.reason.length > 0, "每条丢弃都要说得出理由");
			assert.ok(d.item, "被丢的原件要留着,页面要能展开看");
		}
	});
});
