// 规则层:**模型不接触的那部分**(docs/02 决策 T3「规则层」)。
//
// 这个文件里没有任何 import,也就没有任何模型调用的可能——这不是巧合,是
// 它存在的全部理由。产品方案决策 4 要求排除清单按「规则筛的」和「AI 判的」
// 分色渲染,而分色只有在两者真的来自不同代码路径时才不是装饰:规则那一栏的
// 每一条都能被读者拿 GitHub 页面当场核对(归档了没有、上次 push 是哪个月、
// 许可证写的什么),AI 那一栏则要读者自己判断信不信。混成一色等于让读者把
// 判断当事实读。
//
// 只有「形态不同」「目标用户不同」这两类由模型判,写 reason_source: 'model';
// 本文件产出的一律是 'rule'。
//
// **唯一的 import 是一个 `import type`**(2026-09-01 阶段 4/5 评审加的
// ExclusionKind)。类型 import 在编译后被完全擦除,运行时这个文件仍然没有任何
// 依赖,「这里不可能有模型调用」那条不变量原封不动。

import type { ExclusionKind } from "./types.ts";

/** 停更的判据:最后一次 push 早于这么多个月。 */
export const STALE_MONTHS = 18;

/** 「太小」的两个判据:星数低于这个数,**且**仓库年龄超过下面那个天数。 */
export const TINY_STARS = 10;
export const TINY_MIN_AGE_DAYS = 365;

/**
 * 会污染 MIT 的传染性许可证(SPDX id)。
 *
 * 列全 AGPL 家族的几种写法是因为 GitHub 返回哪一种取决于仓库 LICENSE 文件
 * 里的措辞:同一个 AGPLv3 项目,写 "AGPL-3.0-or-later" 和写 "AGPL-3.0" 的
 * 都有,只认其中一种就会漏掉另一批。AGPL-1.0 极少见但同样传染,一并列上。
 *
 * **故意不含 SSPL / BUSL / Commons Clause**:它们确实不能商用,但理由不是
 * 「污染 MIT」,而是「压根不是开源许可证」。硬塞进来会让排除理由那句话
 * 变成假话(读者点开一看写的是 SSPL,而我们说的是 AGPL),而假的理由比
 * 没有理由更糟。要挡它们得另立一条规则、另写一句理由,不是这一条的活。
 */
export const COPYLEFT_SPDX: readonly string[] = [
	"AGPL-3.0",
	"AGPL-3.0-only",
	"AGPL-3.0-or-later",
	"AGPL-1.0",
	"AGPL-1.0-only",
	"AGPL-1.0-or-later",
];

/** 规则层要看的那几个字段,全部来自 `GET /repos/{owner}/{repo}` 的原始返回。 */
export interface RuleInput {
	archived: boolean;
	/** ISO 字符串原文,GitHub 给什么存什么。 */
	pushedAt: string;
	createdAt: string;
	/** SPDX id;GitHub 在「没有许可证」时返回 license: null,这里就是 null。 */
	license: string | null;
	stars: number;
}

/**
 * 一条规则排除:**机器读的 kind + 人读的 reason**,一起产出。
 *
 * 为什么必须成对(2026-09-01 阶段 4/5 评审):第一屏要把 293-386 条排除按类型
 * 分组,而在这条改动之前,分组只能去**解析 `reason` 的中文文案**——那是显示
 * 字符串,改一个字就会让一大批条目集体掉进「其他」组,不报错、不崩、页面照样
 * 好看(docs/01 风险 1「错得很安静」)。
 *
 * 正解是让**造理由的地方同时说出它是哪一类**,kind 落进 `scan_exclusion.reason_kind`
 * 这一列,分组只读这一列,中文 reason 退回纯显示用途。这条越拖越贵:历史行没法
 * 回填(要重扫),所以在库里还没有真实历史的时候做掉。
 */
export interface RuleExclusion {
	/** 落库的分组键,机器读。改文案不影响它。 */
	kind: ExclusionKind;
	/** 直接显示给用户的中文理由,人读。**不再承担分组职责**。 */
	reason: string;
}

/** null = 这个仓没被规则筛掉。 */
export type RuleReason = RuleExclusion | null;

/** YYYY-MM,给「最后一次 push 在 2024-07」那句理由用。解析不动就返回原文。 */
function yearMonth(iso: string): string {
	const t = Date.parse(iso);
	if (!Number.isFinite(t)) return iso;
	const d = new Date(t);
	return `${d.getUTCFullYear()}-${String(d.getUTCMonth() + 1).padStart(2, "0")}`;
}

/** now 往前推 n 个月的时刻。按日历月退(不是 30 天×n):「18 个月」是人话口径。 */
function monthsBefore(now: number, months: number): number {
	const d = new Date(now);
	d.setUTCMonth(d.getUTCMonth() - months);
	return d.getTime();
}

/**
 * 一个仓该不该被规则筛掉,以及理由。**纯函数,喂 JSON 就能测**——这是它
 * 值得单独成文件的另一半理由:五条规则各自的边界(17 个月算不算停更、
 * 9 星但上周才建的仓算不算太小)只有在能被逐条钉住时才是真的。
 *
 * 顺序即优先级,第一条命中就返回。按 docs/02 那张表的顺序排:
 * 已归档 → 停更 → 许可证冲突 → 无许可证 → 太小。一个仓可能同时满足几条
 * (归档的仓多半也停更了),给出的必须是**最能解释它的那一条**——「已归档」
 * 是作者明确宣布的事实,比「最后一次 push 在两年前」这种推断更硬。
 *
 * **日期解析不动时一律放行**,不是筛掉。GitHub 不会返回坏日期,真出现了
 * 只可能是我们自己的字段接错了——那种情况下「安静地把一批真实的仓筛掉」
 * 比「放一个怪东西进清单」危险得多(docs/01 风险 1:错得很安静)。
 */
export function excludeReason(r: RuleInput, now: number = Date.now()): RuleReason {
	if (r.archived) return { kind: "archived", reason: "已归档(GitHub 字段)" };

	const pushed = Date.parse(r.pushedAt);
	if (Number.isFinite(pushed) && pushed < monthsBefore(now, STALE_MONTHS)) {
		return { kind: "stale", reason: `最后一次 push 在 ${yearMonth(r.pushedAt)}` };
	}

	if (r.license !== null && COPYLEFT_SPDX.includes(r.license)) {
		return { kind: "copyleft", reason: "AGPL 会污染 MIT" };
	}
	if (r.license === null) return { kind: "no-license", reason: "没有许可证,法律上不可用" };

	const created = Date.parse(r.createdAt);
	const oldEnough = Number.isFinite(created) && now - created > TINY_MIN_AGE_DAYS * 86_400_000;
	if (r.stars < TINY_STARS && oldEnough) {
		return { kind: "tiny", reason: `一年了还不到 ${TINY_STARS} 星` };
	}

	return null;
}
