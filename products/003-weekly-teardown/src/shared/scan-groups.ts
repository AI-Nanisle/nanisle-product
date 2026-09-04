// 排除清单的分组(阶段 5 · 第一屏)。**纯函数,没有任何 import 逻辑依赖**——
// 前端(第一屏)和 worker(申诉端点造理由)共用同一份口径。
//
// 为什么需要这个文件:站长 2026-09-01 拍板「排除清单保等式」,于是
// `returned = admitted + excluded + fetchFailed` 里的 excluded 是**逐行落库**的
// (实测一周 293-386 行)。UI 噪音只能靠分组折叠解决,不能靠少显示。
// 而分组要有一个 key,库里却只有一句给人读的中文 `reason`。
//
// **那处脆弱已经修掉了(2026-09-01 阶段 4/5 评审)。**原来分组是拿 reason 的
// 中文文案去认的,而文案是 scan-rules.ts 写的:两边分叉时的症状是「一大批排除
// 条目掉进『其他』」——不报错、不崩、页面照样好看。当时靠一条「真的调
// excludeReason() 造理由再交给分类器」的用例钉着,但正解是加一列:
// `scan_exclusion.reason_kind` 现在由**造理由的那个函数**同时产出,分组只读
// 这一列,中文 reason 退回纯显示用途。`other` 因此从「文案改过了」的症状变成
// 了「库里有一个这份代码不认识的 kind」,那只可能来自将来的新规则。
//
// `rankedOutReason` 从 worker/scan.ts 搬到这里:造这句话的地方和把名次抠回来
// 排序的地方必须挨着(rankedOutRank 仍然解析文案 —— 它只在组内排序,认错了
// 最坏是顺序乱,不会让条目消失)。

import { SCAN_PICK_LIMIT } from "./types.ts";
import type { ExclusionKind, ReasonSource, ScanExclusion } from "./types.ts";

/**
 * 「通过了全部规则,但每周只挑 5 个」。
 *
 * **它不是 scan-rules.ts 那五条规则之一**,所以不由 excludeReason 产出——
 * 那个纯函数只回答「这个仓有没有硬毛病」,而这里说的是「这一批里它排第几」,
 * 判据是别的仓长什么样,不是它自己的字段。分开写是为了让规则层保持可核对:
 * 读者拿 GitHub 页面能当场验证「已归档」,但验证不了「第 9 名」。
 *
 * 仍然写 reason_source: 'rule',因为它确实是代码算的、确定性的、模型不接触的
 * (rankSurvivors 是纯函数)。写 'model' 才是撒谎。
 */
export const rankedOutReason = (rank: number, total: number): string =>
	`通过了全部规则,但按「星数 / 活跃度」交替排名排在第 ${rank} 位(共 ${total} 个通过规则,每周只挑 ${SCAN_PICK_LIMIT} 个)`;

/**
 * 「这一趟提前收工了,门 1 根本没轮到验证它」。
 *
 * **和 ranked-out 是两件事**,所以另有一句话、另有一个 kind:ranked-out 说的是
 * 「它排第 9,而每周只挑 5 个」——一句完整的、可以核对的解释;而这一批的真相是
 * 「我根本没走到它」。被截断的那一趟如果把它们也写成 ranked-out,页面会一边说
 * 「每周只挑 5 个」一边只列出 3 行,而读者无从知道差在哪。
 */
export const notReachedReason = (rank: number, total: number, why: string): string =>
	`这一趟没跑完 —— ${why};门 1 没轮到验证它。它按「星数 / 活跃度」交替排在第 ${rank} 位(共 ${total} 个通过规则)`;

/** 从「排名之外」那句理由里把名次抠回来。认不出来返回 null。 */
export function rankedOutRank(reason: string): number | null {
	const m = /排在第 (\d+) 位/.exec(reason);
	if (!m) return null;
	const n = Number.parseInt(m[1]!, 10);
	return Number.isFinite(n) ? n : null;
}

/**
 * 分组的 key = 落库的 `reason_kind`,**再加一个兜底的 `other`**。
 *
 * 写成 `ExclusionKind | "other"` 而不是另抄一份联合:抄一份就等于给「落库的
 * 类型」和「分组的类型」各留一个能分叉的地方,而这个文件存在的理由就是消灭
 * 那种分叉。加了新 kind 却忘了给它一条 META,`npm run check` 当场编译不过
 * (下面那条 `Record<ExclusionKind, ...>` 的完整性断言钉着)。
 *
 * `other` 兜的是**库里出现了这份代码不认识的 kind**(将来的新规则、回滚到旧版
 * 代码去读新数据)。掉进去的东西照样显示、照样计数,只是没归好类。
 */
export type ExclusionGroupKey = ExclusionKind | "other";

/**
 * 三种块。**这一层的区分不是排版偏好,是产品方案决策 4 的原话落到代码**:
 *
 * - `eligibility` 资格问题:代码从 GitHub 字段直接算的,读者拿仓库页面能当场核对
 *   (归档了没有、上次 push 是哪个月、许可证写的什么);
 * - `rank` 名次问题:这个仓**一点毛病都没有**,只是这周排在 5 名之外。它和上面
 *   那一类的信息量完全不同——前者是「我不该看它」,后者是「我这周没看到它」,
 *   而后者才是最值得申诉的那一批;
 * - `judgement` 模型判的:形态不同 / 目标用户不同。读者只能自己判断信不信。
 *
 * 混成一色等于让读者把判断当事实读,把「名次」当「毛病」读。
 */
export type ExclusionBlock = "eligibility" | "rank" | "judgement";

export interface ExclusionGroupMeta {
	key: ExclusionGroupKey;
	/** 分组头上的短标签。 */
	label: string;
	block: ExclusionBlock;
	source: ReasonSource;
	/** 一句话说清这一组是怎么判出来的(分组头下面那行小字)。 */
	note: string;
}

/** 顺序即渲染顺序。资格问题按「硬到软」排:作者宣布的 → 时间算的 → 法律 → 体量。 */
const META: readonly ExclusionGroupMeta[] = [
	{
		key: "archived",
		label: "已归档",
		block: "eligibility",
		source: "rule",
		note: "作者自己在 GitHub 上按了归档。这是这几条里最硬的一条 —— 不是推断,是声明。",
	},
	{
		key: "stale",
		label: "停更",
		block: "eligibility",
		source: "rule",
		note: "最后一次 push 距今超过 18 个月。每条后面写着具体是哪个月,你可以点开仓库自己核。",
	},
	{
		key: "copyleft",
		label: "AGPL 传染",
		block: "eligibility",
		source: "rule",
		note: "license.spdx_id 落在 AGPL 家族里。只挡 AGPL,不挡 GPL —— GPL 的仓照常进候选清单。",
	},
	{
		key: "no-license",
		label: "没有许可证",
		block: "eligibility",
		source: "rule",
		note: "GitHub 返回 license: null。法律上默认保留所有权利,抄一行都不行 —— 这一条通常是最大的一组。",
	},
	{
		key: "tiny",
		label: "太小",
		block: "eligibility",
		source: "rule",
		note: "不到 10 星,而且仓库已经建了一年以上。刚开源的小仓不受这条影响。",
	},
	{
		key: "other",
		label: "其他规则",
		block: "eligibility",
		source: "rule",
		note: "代码判的,但不属于上面任何一类。这一组不该有东西 —— 有的话说明规则文案改过而分组没跟上。",
	},
	{
		key: "not-reached",
		label: "没轮到验证",
		block: "eligibility",
		source: "rule",
		note: "这一趟提前收工了(额度不够 / 预算到了 / GitHub 不通),门 1 根本没走到它们。**这不是「它有毛病」,是「我没看」** —— 配额恢复后重跑一次,它们就会重新参加排名。",
	},
	{
		key: "model",
		label: "模型判的",
		block: "judgement",
		source: "model",
		note: "「形态不同」「目标用户不同」这两类。**不是**从 GitHub 字段算出来的,你核不了,只能自己判断信不信。",
	},
	{
		key: "ranked-out",
		label: "排名之外",
		block: "rank",
		source: "rule",
		note: "这些仓一点毛病都没有,只是这周排在前 5 之外。名次由 rankSurvivors 这个纯函数算,模型不接触。",
	},
];

export const GROUP_META: ReadonlyMap<ExclusionGroupKey, ExclusionGroupMeta> = new Map(META.map((m) => [m.key, m]));

/**
 * 编译期完整性断言:**每一个 `ExclusionKind` 都必须有一条 META**(也就是有一个
 * 中文标签和一句说明)。加了新 kind 却忘了写文案,`npm run check` 当场不过,
 * 而不是等到那一组在页面上顶着一个空标签出现。
 */
type _MetaKeys = (typeof META)[number]["key"];
type _EveryKindHasMeta = ExclusionKind extends _MetaKeys ? true : never;
const _everyKindHasMeta: _EveryKindHasMeta = true;
void _everyKindHasMeta;

/**
 * 一条排除属于哪一组。**读落库的 `reasonKind`,一个字符串都不解析。**
 *
 * `reasonSource === 'model'` 仍然先判:来源是落库的事实,而一条模型判的排除
 * 绝不能被渲染成「代码算的、你可以自己核」——那正是分色要防的事。正常情况下
 * 两者本来就一致(模型那条路写的 kind 就是 `model`),这一行防的是数据写坏。
 */
export function classifyExclusion(e: { reasonKind: ExclusionKind; reasonSource: ReasonSource }): ExclusionGroupKey {
	if (e.reasonSource === "model") return "model";
	return GROUP_META.has(e.reasonKind) ? e.reasonKind : "other";
}

export interface ExclusionGroup extends ExclusionGroupMeta {
	/** **真实条数**,不是显示了几条。分组头上印的就是它。 */
	count: number;
	items: ScanExclusion[];
}

export interface GroupedExclusions {
	groups: ExclusionGroup[];
	/**
	 * 已申诉捞回的那些。**从分组里摘出来单列**,因为台账的 excluded 已经不再
	 * 数它们了(申诉时 excluded-1 / admitted+1,见 store.ts appealExclusion)。
	 * 留在组里的话,分组头上的计数加起来会比 excluded 大,而那个和恰恰是
	 * 读者用来验「你说筛掉 293 个,点开真有 293 条」的东西。
	 */
	appealed: ScanExclusion[];
	/** 未申诉条数之和。**应当等于 weekly_scan.excluded**;不等就是台账破了。 */
	total: number;
}

/**
 * 按组归拢。组内顺序:「排名之外」按名次升序(第 6 名是差一点进清单的那个,
 * 它比字母序有用得多),其余按仓名升序(和 getWeeklyScan 的 ORDER BY 一致)。
 *
 * **空组不丢**:`model` 那一组即使是 0 条也保留一行。这一周一条模型判的排除都
 * 没有,本身就是要说出来的事实 —— 它证明这一屏上的 293 条排除全部可核对。
 * 其余空组不留(没发生的事不必占版面),但 model 是分色承诺的另一半,必须在场。
 */
export function groupExclusions(exclusions: readonly ScanExclusion[]): GroupedExclusions {
	const buckets = new Map<ExclusionGroupKey, ScanExclusion[]>();
	const appealed: ScanExclusion[] = [];
	for (const e of exclusions) {
		if (e.appealedAt !== null) {
			appealed.push(e);
			continue;
		}
		const key = classifyExclusion(e);
		const bucket = buckets.get(key);
		if (bucket) bucket.push(e);
		else buckets.set(key, [e]);
	}

	const groups: ExclusionGroup[] = [];
	for (const meta of META) {
		const items = buckets.get(meta.key) ?? [];
		if (items.length === 0 && meta.key !== "model") continue;
		// 两个「名次型」的组按名次升序:第 6 名是差一点进清单的那个,它比字母序
		// 有用得多。not-reached 的理由里同样带着「排在第 N 位」,同一个抠法。
		if (meta.key === "ranked-out" || meta.key === "not-reached") {
			items.sort((a, b) => (rankedOutRank(a.reason) ?? 1e9) - (rankedOutRank(b.reason) ?? 1e9));
		} else {
			items.sort((a, b) => a.fullName.localeCompare(b.fullName));
		}
		groups.push({ ...meta, count: items.length, items });
	}
	appealed.sort((a, b) => a.fullName.localeCompare(b.fullName));
	return { groups, appealed, total: groups.reduce((n, g) => n + g.count, 0) };
}

/**
 * 这一组默认展开还是折叠。
 *
 * 判据只有一条:**它是不是同质噪音**。「没有许可证」117 条,每一条的理由一模
 * 一样,展开等于把 117 行毫无信息量的东西推到读者脸上;而「已归档」2 条、
 * 「AGPL」5 条这种,展开就直接看见是哪几个仓,连点都不用点。
 *
 * 「排名之外」永远折叠:它是最大的一组,而且第一屏另有一段「差一点进清单的」
 * 把最有用的前几名摘出来常驻了(见 Scan.tsx),整组展开只服务于翻查。
 */
export function defaultOpen(g: ExclusionGroup): boolean {
	if (g.key === "ranked-out") return false;
	return g.count > 0 && g.count <= 10;
}

/** 「差一点进清单的」常驻几条。第 6 名是这一屏最该被看见的一行。 */
export const NEAR_MISS_SHOWN = 5;
