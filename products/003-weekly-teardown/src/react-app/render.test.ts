// 档案页的**渲染层**回归测试。跑法:npm test。
//
// 为什么非要有这一层(2026-09-01 第二轮评审 ①):dossier-edit.test.ts 里那条
// 「addItem 拒绝空、满、重复,且每种都给理由」一直是绿的,**而行为是坏的**——
// 纯函数确实把理由算出来了,但组件那一层把它丢了(`if (r.ok) onItems(...)`,
// 拒绝那一支什么都不做),页面上一个字都没有。测纯函数测不到「理由有没有
// 送到屏幕上」,这正是那次漏掉的原因。所以这里的断言只有一种形状:
// **走一遍真的提交回调,然后看渲染出来的 HTML 里有没有那句理由。**
//
// 怎么在没有浏览器的情况下做到:
//   1. 用 esbuild 把 Dossier.tsx 打成一个 .mjs(node 的 --experimental-strip-types
//      只会剥类型,不认 JSX);react / react-dom 保持 external,所以测试和组件
//      用的是**同一个 React 实例**。产物写在 node_modules/.cache 下,node 从那里
//      往上找 node_modules 正好能解析到本项目的 react。
//   2. ListColumn 是**无 hook 的纯函数组件**(状态全在 DossierView 里),所以
//      可以直接当函数调用、拿到它返回的 React 元素树,在树上找到输入框那个
//      元素、调它的 onCommit —— 等价于用户敲了回车,但不需要 DOM 事件。
//   3. 再用 react-dom/server 把同一个组件渲染成 HTML,断言理由在里面。
//
// **这套用例测不到什么**(如实记):
//   - DossierView 那个 useState(reject) 到 ListColumn 的接线。SSR 渲染器不
//     支持状态更新,没有 DOM 就驱动不了。这一段靠 TypeScript 兜:ListColumn 的
//     reject / onReject 是**必填** prop,漏传编译不过(tsconfig.app.json 覆盖
//     src/react-app 下的 .tsx)。剩下的风险只有「传了一个空实现」,而那在
//     DossierView 里是一眼能看见的两行。
//   - CSS。.reject-note 有没有被样式表藏起来,只能靠眼睛。
//   - 真实浏览器里的输入法、失焦、autoFocus 行为。

import assert from "node:assert/strict";
import { mkdirSync } from "node:fs";
import path from "node:path";
import { pathToFileURL, fileURLToPath } from "node:url";
import { before, describe, it } from "node:test";

import React from "react";
import ReactDOMServer from "react-dom/server";

import { DOSSIER_LIMITS } from "../shared/types.ts";
import { addItem } from "./dossier-edit.ts";

const HERE = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(HERE, "../..");
// 放进 node_modules/.cache:node 解析这个文件里的 "react" 时会一路往上找到
// 本项目的 node_modules。放 os.tmpdir() 的话 external 的 react 解析不出来。
const OUT = path.join(ROOT, "node_modules/.cache/nanisle-003-render/dossier.mjs");

/** React 元素树上的一个节点。用 any 是因为这棵树本来就是异构的。 */
type AnyEl = { type: unknown; props: Record<string, any> };

/** 组件模块(打包产物)。 */
let mod: {
	default: (props: any) => unknown;
	ListColumn: (props: any) => unknown;
	EmailSwitch: (props: any) => unknown;
};

before(async () => {
	const esbuild = (await import("esbuild")) as any;
	const build = (esbuild.build ?? esbuild.default?.build) as (o: unknown) => Promise<unknown>;
	mkdirSync(path.dirname(OUT), { recursive: true });
	await build({
		entryPoints: [path.join(HERE, "Dossier.tsx")],
		outfile: OUT,
		bundle: true,
		format: "esm",
		platform: "neutral",
		jsx: "automatic",
		// react / react-dom 不打进来:测试和组件必须用同一个 React 实例
		external: ["react", "react-dom", "react/jsx-runtime"],
		logLevel: "silent",
	});
	// 加一个查询串绕开 ESM 模块缓存,免得改了源码还跑上一次的产物
	mod = (await import(`${pathToFileURL(OUT).href}?t=${Date.now()}`)) as typeof mod;
});

/**
 * 在元素树上找第一个满足条件的元素。**碰到还没展开的函数组件就调一次把它
 * 展开**(Item / ListColumn 都是无 hook 的纯函数,可以直接当函数调用),
 * 否则「正在编辑的那一行」里的输入框根本不在树上——它在 Item 的返回值里。
 *
 * 展开发生在**匹配之后**:InlineInput 自己有 hook,直接调会炸,而它总是先
 * 被条件命中(带 value + onCommit),所以永远轮不到被展开。
 */
function find(node: unknown, ok: (el: AnyEl) => boolean): AnyEl | null {
	if (Array.isArray(node)) {
		for (const n of node) {
			const hit = find(n, ok);
			if (hit) return hit;
		}
		return null;
	}
	if (!node || typeof node !== "object") return null;
	const el = node as AnyEl;
	if (!("props" in el) || !el.props) return null;
	if (ok(el)) return el;
	if (typeof el.type === "function") {
		return find((el.type as (p: unknown) => unknown)(el.props), ok);
	}
	return find(el.props.children, ok);
}

/**
 * 当前开着的那个就地编辑输入框(InlineInput)。
 * 判据是 `value` + `onCommit` 两个一起有:光看 onCommit 会先撞上列表里的
 * Item —— 它也带一个 onCommit(用来改那一条),但它不是输入框。
 */
const findInput = (tree: unknown): AnyEl => {
	const el = find(tree, (e) => typeof e.props.onCommit === "function" && typeof e.props.value === "string");
	assert.ok(el, "元素树里没有找到打开着的输入框");
	return el;
};

/** 一栏的默认 props;测试各自覆盖需要的那几个。 */
function columnProps(over: Record<string, unknown> = {}) {
	return {
		listKey: "queries",
		title: "检索词",
		note: "note",
		items: ["KV cache", "agent memory"],
		max: DOSSIER_LIMITS.queriesMax,
		tone: "ink",
		emptyText: "空的",
		addLabel: "加一条检索词",
		edit: null,
		onEditTarget: () => {},
		onItems: () => {},
		reject: null,
		onReject: () => {},
		...over,
	};
}

const html = (props: Record<string, unknown>): string =>
	ReactDOMServer.renderToStaticMarkup(React.createElement(mod.ListColumn, props as never));

describe("被规则拒绝时,理由要出现在页面上", () => {
	it("加一条撞了重复:不改数据、不收输入框、把理由交出去", () => {
		const calls: { items: number; edit: number; reject: (string | null)[] } = { items: 0, edit: 0, reject: [] };
		const props = columnProps({
			edit: { key: "queries", index: "new" },
			onItems: () => calls.items++,
			onEditTarget: () => calls.edit++,
			onReject: (m: string | null) => calls.reject.push(m),
		});
		// 直接调组件函数拿元素树(ListColumn 没有 hook),等价于用户点开了
		// 「+ 加一条检索词」那个输入框
		findInput(mod.ListColumn(props)).props.onCommit("kv cache");

		assert.equal(calls.items, 0, "撞重复的那条不许进列表");
		assert.equal(calls.edit, 0, "输入框必须留在原地(收起来的话用户得重打一遍)");
		assert.equal(calls.reject.length, 1);
		// 理由必须是纯函数算出来的那一句,不是组件另写的一句
		const expected = addItem(["KV cache", "agent memory"], "kv cache", DOSSIER_LIMITS.queriesMax);
		assert.equal(expected.ok, false);
		assert.equal(calls.reject[0], expected.ok ? "" : expected.reason);
	});

	it("那句理由渲染在开着的输入框旁边(**这条才是这次评审要修的**)", () => {
		const reject = "「kv cache」已经在这一栏里了。";
		const out = html(columnProps({ edit: { key: "queries", index: "new" }, reject }));
		assert.ok(out.includes(reject), `渲染结果里没有这句理由:\n${out}`);
		assert.ok(out.includes('role="alert"'), "理由要让读屏软件也读得到");
	});

	it("改一条撞了别的一条:同样不静默,而且不把输入框弹回旧文本", () => {
		const calls: { items: number; edit: number; reject: (string | null)[] } = { items: 0, edit: 0, reject: [] };
		const props = columnProps({
			edit: { key: "queries", index: 1 },
			onItems: () => calls.items++,
			onEditTarget: () => calls.edit++,
			onReject: (m: string | null) => calls.reject.push(m),
		});
		// 把第 2 条 "agent memory" 改成第 1 条的大小写变体
		findInput(mod.ListColumn(props)).props.onCommit("kv cache");
		assert.equal(calls.items, 0);
		assert.equal(calls.edit, 0, "原来这里先收输入框再看结果,于是那一条原地弹回旧文本");
		assert.equal(calls.reject.length, 1);
		assert.match(String(calls.reject[0]), /已经在这一栏里了/);
	});

	it("改一条的理由渲染在那一行上", () => {
		const reject = "「kv cache」已经在这一栏里了。";
		const out = html(columnProps({ edit: { key: "queries", index: 1 }, reject }));
		assert.ok(out.includes(reject), `渲染结果里没有这句理由:\n${out}`);
	});

	it("成功那一路要把上一条理由收掉(否则改对了红字还挂着)", () => {
		const seen: (string | null)[] = [];
		const props = columnProps({
			edit: { key: "queries", index: "new" },
			reject: "「kv cache」已经在这一栏里了。",
			onReject: (m: string | null) => seen.push(m),
		});
		findInput(mod.ListColumn(props)).props.onCommit("prompt caching");
		assert.deepEqual(seen, [null]);
	});

	it("理由只显示在开着输入框的那一栏,不跟着别的栏跑", () => {
		const reject = "「kv cache」已经在这一栏里了。";
		// edit 指向 caresAbout,而这一栏是 queries
		const out = html(columnProps({ edit: { key: "caresAbout", index: "new" }, reject }));
		assert.ok(!out.includes(reject), "别的栏不该跟着报错");
	});
});

describe("整页渲染冒烟", () => {
	it("四节渲染得出来,原话原样在里面", () => {
		const out = ReactDOMServer.renderToStaticMarkup(
			React.createElement(mod.default as never, {
				sentence: "我想跟踪 AI agent 的记忆与上下文工程",
				fields: {
					domain: "AI agent 的记忆与上下文工程",
					caresAbout: ["工程实践"],
					notCaresAbout: [],
					queries: ["agent memory", "context engineering", "topic:llm-memory"],
				},
				onFields: () => {},
				draft: true,
				verbatim: true,
				rev: null,
				onRestate: () => {},
				onNotice: () => {},
			} as never),
		);
		assert.ok(out.includes("我想跟踪 AI agent 的记忆与上下文工程"));
		assert.ok(out.includes("只读 · AI 不改"));
	});
});

// ---------------------------------------------------------------------------
// 订阅开关(阶段 9)
// ---------------------------------------------------------------------------
//
// 这一层要接住的和上面那次漏掉的是同一类东西:后端的 optedOut 是对的、
// 开关的回调也是对的,但**屏幕上印的那句话说反了**。那种错没有任何测试
// 会红,而用户看到「在收」却收不到信,要等一个星期才发现。

const renderSwitch = (props: any) => ReactDOMServer.renderToStaticMarkup(React.createElement(mod.EmailSwitch, props));

describe("EmailSwitch · 屏幕上必须说出当前状态", () => {
	const prefs = (over: Partial<{ email: string; optedOut: boolean; configured: boolean }> = {}) => ({
		email: "you@example.com",
		optedOut: false,
		configured: true,
		...over,
	});

	it("在收:徽记「在收」、地址印出来、按钮是「停掉这封信」", () => {
		const html = renderSwitch({ prefs: prefs(), busy: false, onChange: () => {} });
		assert.ok(html.includes("在收"));
		assert.ok(html.includes("you@example.com"));
		assert.ok(html.includes("停掉这封信"));
		assert.ok(!html.includes("重新开始收"));
	});

	it("已退订:徽记「已退订」,按钮变成「重新开始收」—— **阶段 8 没有的那个入口**", () => {
		const html = renderSwitch({ prefs: prefs({ optedOut: true }), busy: false, onChange: () => {} });
		assert.ok(html.includes("已退订"));
		assert.ok(html.includes("重新开始收"));
		assert.ok(!html.includes("停掉这封信"));
	});

	it("按钮点下去,推的是**当前状态的反面**(说反了的话用户点「重新开始收」会被退订)", () => {
		const seen: boolean[] = [];
		// 在收 → 点一下应该请求 optedOut=true
		const on = mod.EmailSwitch({ prefs: prefs(), busy: false, onChange: (v: boolean) => seen.push(v) }) as unknown;
		find(on, (e) => e.type === "button" && typeof e.props.onClick === "function")!.props.onClick();
		// 已退订 → 点一下应该请求 optedOut=false
		const off = mod.EmailSwitch({
			prefs: prefs({ optedOut: true }),
			busy: false,
			onChange: (v: boolean) => seen.push(v),
		}) as unknown;
		find(off, (e) => e.type === "button" && typeof e.props.onClick === "function")!.props.onClick();
		assert.deepEqual(seen, [true, false]);
	});

	it("退订之后失去什么、以及**不影响网页**,都要写在屏幕上", () => {
		const html = renderSwitch({ prefs: prefs(), busy: false, onChange: () => {} });
		assert.ok(html.includes("与上一周比"));
		assert.ok(html.includes("归档"));
		assert.ok(html.includes("退订不影响网页"));
		assert.ok(html.includes("周扫照跑"));
	});

	it("这个实例没配发信凭证时如实说,不让人以为开关坏了", () => {
		const html = renderSwitch({ prefs: prefs({ configured: false }), busy: false, onChange: () => {} });
		assert.ok(html.includes("没有配发信凭证"));
	});

	it("还没读到状态时**不编一个「在收」出来**", () => {
		const html = renderSwitch({ prefs: null, busy: false, onChange: () => {} });
		assert.ok(html.includes("正在读订阅状态"));
		assert.ok(!html.includes("停掉这封信"));
		assert.ok(!html.includes("重新开始收"));
	});

	it("保存中时按钮禁用 —— 免得连点两下把状态推来推去", () => {
		const el = mod.EmailSwitch({ prefs: prefs(), busy: true, onChange: () => {} }) as unknown;
		const btn = find(el, (e) => e.type === "button")!;
		assert.equal(btn.props.disabled, true);
	});
});
