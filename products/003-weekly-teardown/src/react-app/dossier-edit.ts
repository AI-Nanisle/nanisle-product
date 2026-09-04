// 档案编辑的纯逻辑。**页面上一条数字都不许自己写**——上限全部来自
// shared/types.ts 的 DOSSIER_LIMITS,和后端 dossier.ts 用的是同一份常量。
//
// 为什么把这些从组件里拆出来:
//   1. 后端的清洗是**静默截断不报错**(cleanList:trim、折换行、去空、
//      大小写不敏感去重、单条截 120 字、列表截 5/8 条)。前端如果不先挡,
//      用户会看着自己刚写的第 6 条在保存后消失,而全程没有任何提示——
//      这正是 docs/01 风险 1 说的那种「错得很安静」。所以前端必须提前
//      把同一套规则跑一遍,并**当场说出理由**(重复了 / 满了 / 太长了)。
//   2. 这几个函数是这一阶段唯一有分支的纯逻辑,能被 node --test 直接钉住;
//      「还能加几条」和「跨栏改判」的边界一旦分叉,症状是数据悄悄丢失。
//
// 这里的规则和后端**必须同源**:改任何一条之前先去看 worker/dossier.ts 的
// cleanList / cleanDossierFields,两边同时改。

import { DOSSIER_LIMITS } from "../shared/types.ts";
import type { DossierFields } from "../shared/types.ts";

/** 三条可编辑列表的键。domain 是单值,不在这里。 */
export type ListKey = "caresAbout" | "notCaresAbout" | "queries";

/** 各列表的条数上限。数字只在 DOSSIER_LIMITS 里出现一次。 */
export function limitOf(key: ListKey): number {
	return key === "queries" ? DOSSIER_LIMITS.queriesMax : DOSSIER_LIMITS.listMax;
}

/**
 * 单条清洗:和后端 cleanList 里逐条那一段**逐字同规则**——换行折成空格、
 * 首尾去空、截到 itemMax。前端先做,是为了让「被截断」这件事发生在用户
 * 眼皮底下(输入框有 maxLength、列表里显示的就是截断后的样子),而不是
 * 发生在保存之后的库里。
 */
export function normalizeItem(raw: string): string {
	return raw.replace(/\s+/g, " ").trim().slice(0, DOSSIER_LIMITS.itemMax);
}

/** domain 同理,只是上限不同(domainMax)。 */
export function normalizeDomain(raw: string): string {
	return raw.replace(/\s+/g, " ").trim().slice(0, DOSSIER_LIMITS.domainMax);
}

/** 还能加几条。负数没有意义(理论上进不来),夹到 0。 */
export function remaining(list: readonly string[], max: number): number {
	return Math.max(0, max - list.length);
}

/**
 * 去重键。后端是**大小写不敏感**去重(理由见 dossier.ts:同一条检索词
 * 大小写不同会让 GitHub 返回同一批仓,白发一次请求还把台账分母做大)。
 * 前端必须用同一把尺子,否则用户加了 "KV cache" 和 "kv cache" 两条,
 * 前端显示两条、后端只存一条,差额无人解释。
 */
function dedupeKey(s: string): string {
	return s.toLowerCase();
}

export type EditResult = { ok: true; list: string[] } | { ok: false; reason: string };

/**
 * 加一条。三种拒绝都**当场给理由**,不静默吞掉:
 *   - 空:什么都没写;
 *   - 满:已经到上限(后端会把超出的直接截掉,不报错);
 *   - 重复:大小写不敏感撞了已有的一条。
 */
export function addItem(list: readonly string[], raw: string, max: number): EditResult {
	const text = normalizeItem(raw);
	if (!text) return { ok: false, reason: "空的一条,没有加进去。" };
	if (list.length >= max) return { ok: false, reason: `已经有 ${max} 条了,先删掉一条再加。` };
	const key = dedupeKey(text);
	if (list.some((v) => dedupeKey(v) === key)) return { ok: false, reason: `「${text}」已经在这一栏里了。` };
	return { ok: true, list: [...list, text] };
}

/**
 * 就地改一条。去重时要**排除自己**——否则把一条从 "kv cache" 改成
 * "KV cache"(只改大小写)会被自己拦下,用户完全无法理解。
 * 改成空 = 删掉这一条:就地编辑里清空内容再回车,意图很明确。
 */
export function replaceItem(list: readonly string[], index: number, raw: string): EditResult {
	if (index < 0 || index >= list.length) return { ok: false, reason: "这一条已经不在了。" };
	const text = normalizeItem(raw);
	if (!text) return { ok: true, list: list.filter((_, i) => i !== index) };
	const key = dedupeKey(text);
	if (list.some((v, i) => i !== index && dedupeKey(v) === key)) {
		return { ok: false, reason: `「${text}」已经在这一栏里了。` };
	}
	return { ok: true, list: list.map((v, i) => (i === index ? text : v)) };
}

/** 删一条。越界当无事发生(并发点击时不该炸)。 */
export function removeItem(list: readonly string[], index: number): string[] {
	return list.filter((_, i) => i !== index);
}

/**
 * 跨栏改判:把「我在意」的一条挪到「我不在意」,或者反过来。
 *
 * 这个动作不是顺手做的花活,它是版面上「两栏等重」这句话的证据——
 * 能一键挪过去的两栏,天然是对等的两栏。而且改判**恰恰是这份档案最有
 * 价值的编辑**:notCaresAbout 直接变成周扫的排除清单(docs/01 决策 3)。
 *
 * 目标栏满了要拒绝并说清楚:悄悄丢一条 = 用户以为改判成功了,下周的
 * 排除清单里却没有它。
 */
export function moveItem(
	from: readonly string[],
	to: readonly string[],
	index: number,
	toMax: number,
): { ok: true; from: string[]; to: string[] } | { ok: false; reason: string } {
	const text = from[index];
	if (text === undefined) return { ok: false, reason: "这一条已经不在了。" };
	const added = addItem(to, text, toMax);
	if (!added.ok) return added;
	return { ok: true, from: removeItem(from, index), to: added.list };
}

/**
 * 两份字段是不是一模一样——**顺序敏感**。
 *
 * 注意它和后端 sameDossierFields 故意不同:后端按集合比,决定的是
 * 「要不要涨 rev」(顺序改不了周扫的产出,所以不算一次版本变更);
 * 这里按顺序比,决定的是「保存按钮要不要亮」。用户拖了一下顺序、
 * 页面却说「没有未保存的改动」,那是在骗他;而拖完保存之后不涨 rev,
 * 是诚实的——两件事不是一回事,所以两个函数。
 */
export function fieldsEqual(a: DossierFields, b: DossierFields): boolean {
	const sameSeq = (x: readonly string[], y: readonly string[]) =>
		x.length === y.length && x.every((v, i) => v === y[i]);
	return (
		a.domain === b.domain &&
		sameSeq(a.caresAbout, b.caresAbout) &&
		sameSeq(a.notCaresAbout, b.notCaresAbout) &&
		sameSeq(a.queries, b.queries)
	);
}

/**
 * 保存前的拦截理由(空数组 = 可以保存)。**逐条对应后端 PUT 的 400 分支**,
 * 目的不是替后端把关(后端自己会拦),而是把那几个 400 变成「保存按钮旁边
 * 一句能读懂的话」,而不是「点了保存,弹出一条红字」。
 */
export function blockers(fields: DossierFields): string[] {
	const out: string[] = [];
	if (!normalizeDomain(fields.domain)) out.push("「我理解的领域」不能空——没有它,周扫连这句话在说哪个圈子都不知道。");
	if (fields.caresAbout.length === 0) {
		out.push("「我在意」至少要 1 条——将来每条结论都要标出它对应哪一条,这一栏空了那道门就自动失效。");
	}
	if (fields.queries.length < DOSSIER_LIMITS.queriesMin) {
		out.push(
			`检索词至少要 ${DOSSIER_LIMITS.queriesMin} 条(现在 ${fields.queries.length} 条)——` +
				"它是每周扫描唯一的召回入口,少了就什么都捞不回来。",
		);
	}
	return out;
}

/**
 * 那句话本身的问题(null = 没问题)。对应 POST /api/dossier/draft 的两个 400。
 *
 * 前端先挡,是为了**省一次注定失败的往返**,并且把理由显示在输入框旁边,
 * 而不是让用户点完「拆解」等一秒再看一个红框。
 *
 * **不是为了省 AI 额度**:这两个 400 在 dossier.ts 里发生在 `reserveOrDeny`
 * **之前**,后端拦下时一格额度都不扣。这段注释原来写的是「draft 端点先占位
 * 再调用,一次注定 400 的请求照样吃掉一次配额」——是假的,而且是有后果的假:
 * 下一个人照着这句话去动闸口顺序(把占位提到校验前面),就真的会开始扣了
 * (2026-09-01 第二轮评审 ⑤)。
 */
export function sentenceIssue(raw: string): string | null {
	const s = raw.trim();
	if (!s) return "先写一句话:你想跟踪什么?";
	if (s.length > DOSSIER_LIMITS.sentenceMax) {
		return `这句话太长了(${s.length} 字,上限 ${DOSSIER_LIMITS.sentenceMax} 字)。`;
	}
	return null;
}
