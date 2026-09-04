// 阶段 8 · 跨周增量(docs/01 决策 8)。
//
// 同一份档案相邻两周的候选清单做 diff,变化上门铃邮件:
//   新进清单 / 转归档 / 换许可证 / star 跃迁
//
// 阶段 9(站长 2026-09-01 拍板)在这之上加了**复查**:上一周进过候选清单的仓,
// 这一周各打一次 GET /repos —— 因为归档的仓会被规则层筛掉、进不了本周清单,
// 所以「上周那个仓这周归档了」这件事上面那条口径**天生看不见**。
//
// **这是一个纯函数,没有 D1、没有网络、没有模型。**这不是洁癖:这一层是决策 8
// 给「网站形态相对 skill 的存在理由」押的那个宝(docs/01 风险 5 承认它的证据
// 只有 n=1),它出错的形状是「邮件里写了一条根本没发生的变化」,而那种错
// 在邮件里看不出来——所以它必须能被喂两周快照、逐类断言。
//
// **第一周物理上没有上一周**,这里如实返回 `prevWeekOf: null`,不假装有增量。
// 这正是 docs/01 TL;DR 承认的代价:「第一周注定看起来平庸」。

/** diff 只看这四个字段。**故意不收 ScanCandidate 整个类型**:纯函数不该被 D1 行的形状绑住。 */
export interface RepoSnapshot {
	fullName: string;
	stars: number;
	archived: boolean;
	/** SPDX id;无许可证为 null(它本身就是一条排除理由)。 */
	license: string | null;
}

/** 一周的候选清单快照。 */
export interface WeekSnapshot {
	weekOf: string;
	repos: RepoSnapshot[];
}

/**
 * 一条许可证变更。
 *
 * **`from` / `to` 都可空,而 `null` 不是「没查到」,是「这个仓没有许可证」。**
 * 契约摘要里曾把它写成 `string`(2026-09-01 冻结前最后一轮更正),而这两头的
 * null 恰恰是最该说出口的那一种变化:`null → MIT` 是「本来法律上不能抄,现在
 * 能抄了」,`MIT → null` 是反过来 —— 两个方向都会改变你能不能用它。
 *
 * 所以渲染侧**不许把 null 画成空白**:空白会被读成「我没查」。网页走
 * `Changes.tsx` 的 `lic()`、邮件走 `email.ts` 的 `licenseLabel()`,两处都印
 * 「没有许可证」四个字,各自有用例钉着。
 */
export interface LicenseChange {
	fullName: string;
	from: string | null;
	to: string | null;
}

export interface StarJump {
	fullName: string;
	from: number;
	to: number;
	delta: number;
}

// ---------------------------------------------------------------------------
// 复查(阶段 9,站长 2026-09-01 拍板)
// ---------------------------------------------------------------------------
//
// 阶段 8 留下的洞:归档的仓被规则层筛掉,**进不了本周的候选清单**,于是
// 「你上周在看的那个项目这周归档了」这件事在产品里是看不见的 —— 它只是从清单里
// 安静地消失。而「你跟的项目死了」恰恰是这个产品最该报出来的事。这就是 docs/01
// 风险 1 说的「错得很安静」,只不过发生在我们自己的产品逻辑里。
//
// 补法:周扫跑完之后,对**上一周进过候选清单**的那些仓各打一次 GET /repos,
// 拿今天的实况和上周的快照比。它不依赖「这个仓这周还在不在清单上」,所以
// **掉出清单 + 已归档**这两件事能被同时报出来 —— 后者比前者重要得多。
//
// 下面这些是纯函数,I/O(真的 GET /repos、退避、限流时停下来)在 worker/cron.ts。

/**
 * 复查一个仓的结局。**三种,不是两种**——「仓没了」和「我没查成」必须分开
 * (阶段 4/5 评审的必须修 2 就是栽在把它们混成一栏)。
 *
 *   ok         200:拿到了今天的实况,和上周的快照比。
 *   gone       404 / 410 / 451:仓真的不在了(删库 / 改名 / 被 DMCA 下架)。
 *              **这本身就是一种「死了」,值得报。**
 *   unchecked  5xx / 403 限流 / 预算到了 / 网络抖:**我们不知道这个仓怎么样了。**
 *              这时候说它「没了」是在报一件没发生的事,而那种错在邮件里看不出来。
 */
export type RecheckOutcome =
	| { kind: "ok"; repo: RepoSnapshot }
	| { kind: "gone" }
	| { kind: "unchecked"; why: string };

/** 复查报出来的一类变化。`gone` 只从复查来,`archived` / `license` 也可能从周扫比出来。 */
export type RecheckChangeKind = "archived" | "license" | "gone";

export interface RecheckChange {
	fullName: string;
	kind: RecheckChangeKind;
	/**
	 * `kind === "license"` 时才有。
	 *
	 * **它是一个对象 `{ from, to }`,不是一个 `string`**(契约摘要曾写错,
	 * 2026-09-01 冻结前最后一轮更正)。两头同样可空,口径与 `LicenseChange`
	 * 一模一样:`null` = 没有许可证,渲染侧不许画成空白。
	 */
	license?: { from: string | null; to: string | null };
	/**
	 * 这个仓在**本周**的候选清单里吗。
	 *
	 * false = 它同时掉出了清单。**两件事都要说**:「它掉出清单了」和「它死了」是
	 * 两回事,而后者重要得多 —— 只说前者的话,读者会以为它只是排名掉下去了。
	 */
	stillListed: boolean;
}

/**
 * 一趟复查的账。**三个数要能直接读成一句人话**:「我复查了 checked 个,
 * changed 个有变化,unchecked 个没查成」。
 *
 * `checked` 是**尝试了几个**(= 上一周清单的长度),不是「成功了几个」:
 * 分母写成成功数的话,GitHub 挂掉的那一周会打印出「复查了 0 个,0 个有变化」
 * ——字面全对,读起来却是「一切正常」。分母必须是我们本该查的那些。
 */
export interface RecheckReport {
	/** 上一周清单上有几个仓(= 本该复查几个)。 */
	checked: number;
	/** 其中几个有变化(转归档 / 换许可证 / 没了)。一个仓最多算一次。 */
	changed: number;
	/** 其中几个没查成。**和「没了」是两件事。** */
	unchecked: number;
	changes: RecheckChange[];
	/** 没查成的那些:名字 + 原因原文。给邮件里那句诚实话和日志用。 */
	unavailable: { fullName: string; why: string }[];
	/**
	 * 复查真的给出了答案(**ok 或 gone**)的仓名。
	 *
	 * `diffWeeks` 用它避免把同一件事报两遍:复查对这些仓的判断比「上周清单 vs
	 * 本周清单」更新、更全,所以复查说了算;没在这个集合里的才退回去比。
	 *
	 * ## 它**不是**「查过没事」—— 和 `unchanged` 的区别写死在这里
	 *
	 * `resolved` 的口径是「我们问到了 GitHub,拿到了一个答案」,而「仓已经没了」
	 * (404 / 410 / 451)**也是一个答案** —— 所以刚被删库的那几个仓在这个集合里。
	 * 照字面把它渲染成「查过没事」,就会把一个死掉的仓印在「没事」那一栏,而那
	 * 正是复查这一整条改动最想避免的错。
	 *
	 * 想要「查过、而且真的没事」的那一份名单,用 `unchanged`。两者的关系是:
	 *
	 *   resolved = unchanged ∪ { changes 里出现过的仓名 }
	 *   checked  = resolved.length + unchecked
	 *            = unchanged.length + changed + unchecked
	 *
	 * (`changed` 数的是**仓**不是**条**,所以上面第二行成立;`changes.length` 会
	 * 更大 —— 一个仓同时归档 + 换许可证是两条一个仓。)
	 */
	resolved: string[];
	/**
	 * 复查问到了、而且**一切照旧**的仓名。`resolved` 减去出过事的那些。
	 *
	 * 为什么后端要直接给出来,而不是让每个下游自己做这个减法(2026-09-01 冻结前
	 * 最后一轮):任务书和直觉都会把 `resolved` 读成「查过没事」,而它的真实定义
	 * 包含刚被删库的那几个。网页可以自己减一次(它上一轮就是这么绕开的),但
	 * **将来的邮件模板得自己想起来再减一次,而想不起来的那一次不会报错** ——
	 * 它只会安静地把一个死掉的仓印在「没事」那一栏。一个每个下游都要各自记得的
	 * 减法,迟早会有一个下游忘掉。
	 *
	 * 它同时是复查那三个数的**页面级自检**的最后一块拼图:在它出现之前,
	 * `checked = changed + unchecked + 没事的` 里的最后一项在明细层拿不到,
	 * 于是那三个数是全页唯一「无人核对」的数(Changes.tsx 的 `RecheckCheck`)。
	 */
	unchanged: string[];
}

/** 没做复查(第一周 / 没传 probe)时的空账。**checked 为 0 时不该印任何复查文案。** */
export const EMPTY_RECHECK: RecheckReport = {
	checked: 0,
	changed: 0,
	unchecked: 0,
	changes: [],
	unavailable: [],
	resolved: [],
	unchanged: [],
};

/**
 * 上一周的快照 + 今天逐个复查的结局 → 一份能读成人话的账。**纯函数。**
 *
 * `listedNow` 是本周候选清单的仓名集合,只用来给每条变化盖一个 `stillListed`。
 *
 * **「停更断崖」这一类故意没有做**,理由写在 worker/cron.ts 的 recheckPrevious
 * 上面(一句话:`pushed_at` 只会变新,所以「断崖」的真实含义是「上周之后一次
 * 提交都没有」,而那对一个健康项目是每周都可能发生的常态,报出来就是每周准时
 * 送达一条假警报)。
 */
export function foldRecheck(
	prev: readonly RepoSnapshot[],
	outcomes: ReadonlyMap<string, RecheckOutcome>,
	listedNow: ReadonlySet<string>,
): RecheckReport {
	const changes: RecheckChange[] = [];
	const unavailable: { fullName: string; why: string }[] = [];
	const resolved: string[] = [];
	// 「查过、而且真的没事」。**和 resolved 分开攒,不在返回处做减法**:
	// 减法版本要靠 changes 里的名字去过滤 resolved,而那是一次可以写错、
	// 也可以被下游忘掉的推导(这一整条改动就是为了把它从下游手里收回来)。
	// 在这里攒的话,它是循环里的一个分支,和 changed 那个计数同一处产出。
	const unchanged: string[] = [];
	let changed = 0;

	for (const was of prev) {
		const name = was.fullName;
		const stillListed = listedNow.has(name);
		// 调用方没给结局 = 它根本没被查过。**当成 unchecked,不当成「没变化」**:
		// 「没轮到」和「查过了、一切正常」在邮件里是完全不同的两句话。
		const out = outcomes.get(name) ?? { kind: "unchecked" as const, why: "这一趟没轮到复查它" };
		if (out.kind === "unchecked") {
			unavailable.push({ fullName: name, why: out.why });
			continue;
		}
		resolved.push(name);
		if (out.kind === "gone") {
			// **注意它进了 resolved 却不进 unchanged**:「仓没了」是一个答案,
			// 但它显然不是「没事」。这一行就是两个字段全部的区别所在。
			changes.push({ fullName: name, kind: "gone", stillListed });
			changed += 1;
			continue;
		}
		let hit = false;
		if (!was.archived && out.repo.archived) {
			changes.push({ fullName: name, kind: "archived", stillListed });
			hit = true;
		}
		// null(没有许可证)和 "MIT" 之间的来回也是许可证变更,而且是最该说的
		// 那一种 ——「本来不能抄现在能抄了」和反过来,都会改变你能不能用它。
		if (was.license !== out.repo.license) {
			changes.push({
				fullName: name,
				kind: "license",
				license: { from: was.license, to: out.repo.license },
				stillListed,
			});
			hit = true;
		}
		// 一个仓同时归档 + 换许可证,只算**一个仓有变化**(changes 里是两条)。
		// changed 的口径是「几个仓出事了」,不是「一共几条变化」——后者会让
		// 「5 个里 2 个有变化」变成「5 个里 3 个有变化」这种读不通的话。
		if (hit) changed += 1;
		// 问到了、一条变化都没有 —— 这才是「查过没事」。
		else unchanged.push(name);
	}

	return { checked: prev.length, changed, unchecked: unavailable.length, changes, unavailable, resolved, unchanged };
}

export interface WeekDiff {
	/** 拿来比的那一周;**null = 这是第一周,没有可比的上一周**。 */
	prevWeekOf: string | null;
	/** 上一周的候选清单里没有它。 */
	appeared: string[];
	/**
	 * `archived` 由 false 变 true,**只包含复查没给出答案的那些仓**。
	 *
	 * 为什么会是「只包含一部分」(阶段 9):归档的仓会被规则层筛掉,所以它**不会
	 * 出现在本周的候选清单里** —— 而这个字段比的是「上周清单 vs 本周清单」,两边
	 * 都在才比得成。也就是说这条口径天生看不见「上周那个仓这周归档了」,那正是
	 * 阶段 8 留下的洞。补洞的是复查(`recheck`),它去打真的 GET /repos,不依赖
	 * 这个仓这周还在不在清单上。复查已经给出答案的仓在这里被跳过,免得同一件事
	 * 报两遍;复查**没查成**的那些才退回用这条比一次(本周扫描拿到的字段同样是
	 * 真的 GET /repos 拿到的,只是早了几十秒)。
	 */
	archivedNow: string[];
	/** 同 archivedNow:复查已经给出答案的仓不在这里(见那个字段的注释)。 */
	licenseChanged: LicenseChange[];
	/**
	 * star 跃迁。**永远来自两周的扫描快照,不看复查**——复查那一发 GET /repos
	 * 比本周扫描晚几十秒,拿它当「本周的 star 数」会让同一个仓在不同字段上有
	 * 两个时刻的值,而 star 是唯一一个每分钟都在动的字段。
	 */
	starJumps: StarJump[];
	/** 上一周清单上那些仓的复查结果(阶段 9)。没做复查时是 EMPTY_RECHECK。 */
	recheck: RecheckReport;
	/** 五类里至少有一条。第一周恒为 false。 */
	changed: boolean;
}

/**
 * star 跃迁的阈值:**按比例,但两头都夹住**。
 *
 * 为什么不是纯绝对值:`+100 星`对一个 40 星的新项目是翻了两倍半的大事,对一个
 * 5 万星的老仓是 0.2% 的日常波动。一个固定的绝对值只能同时对这两头都说错话
 * ——要么每周把大仓的正常涨幅当成新闻报一遍,要么小项目哪怕一周翻三倍也永远
 * 触发不了。而周更清单里这两种仓**必然同时存在**(决策 T3 的双路检索,
 * `sort=updated` 那一路捞的就是还没有 star 的新东西)。
 *
 * 为什么也不是纯比例:20% 对一个 8 星的仓是「多了 2 颗星」,那不是信号是噪声;
 * 对一个 5 万星的仓是「多了 1 万颗」,那种事一年都未必有一次,等于这一类变化
 * 对大仓永远不触发——而「一个成熟项目一周涨了两千星」恰恰是最值得知道的一种
 * 异动。
 *
 * 所以是一条夹住两头的比例线:`clamp(prev × 20%, 50, 1000)`。
 *
 *   prev = 8      → 需要 +50(下限接管:小仓要涨到有存在感才算数)
 *   prev = 500    → 需要 +100(20%)
 *   prev = 5000   → 需要 +1000(20%)
 *   prev = 50000  → 需要 +1000(上限接管,2%:大仓涨一千星就是新闻)
 *
 * 三个数字都是拍的,但拍的方式可解释:20% 是「一周涨两成」这个直觉,50 是
 * scan-rules 那条「一年还不到 10 星就排除」的量级往上一档(50 星以内的变化在
 * 这个产品里不构成挑选依据),1000 是「一周一千星」这个在 GitHub 上确实少见的
 * 事件。要改就改这三个常量,别在判据里加分支。
 *
 * **只报涨不报跌**:star 掉数几乎只有一个来源——GitHub 清理刷量账号,那是平台
 * 的动作不是项目的变化,报出来只会让人以为项目出了事。
 */
export const STAR_JUMP_RATIO = 0.2;
export const STAR_JUMP_FLOOR = 50;
export const STAR_JUMP_CAP = 1000;

/** 上周 star 数 → 这一周至少要涨多少才算跃迁。 */
export function starJumpThreshold(prevStars: number): number {
	const byRatio = prevStars * STAR_JUMP_RATIO;
	return Math.min(STAR_JUMP_CAP, Math.max(STAR_JUMP_FLOOR, byRatio));
}

/**
 * 相邻两周的候选清单做 diff。
 *
 * `prev` 传 null = 第一周(或者上一周那趟根本没跑成)。那时返回的四个数组
 * **全为空**,而不是「把本周全部 5 个都算成新出现的」——后者读起来像一份
 * 热闹的增量,实际上没有任何信息量,而且它会让第二周真正的「新出现」失去分量。
 *
 * `recheck` 是可选的第三份输入(阶段 9):上一周那些仓今天的实况。传了它,
 * 归档/许可证这两类就由它说了算(见 WeekDiff.archivedNow);不传就是纯粹的
 * 「上周清单 vs 本周清单」,和阶段 8 一模一样。
 *
 * 注意「新进清单」不等于「GitHub 上新出现」:一个仓上周排在第 9 位没进清单、
 * 这周挤进前 5,也会出现在 appeared 里。所以邮件里的措辞是**「本周新进清单」**
 * 而不是「新项目」——后者是一句我们拿不出证据的话(要证明它得回答「上周这个仓
 * 到底存不存在」,而清单外的那 380 个仓我们只记了名字和排除理由)。
 */
export function diffWeeks(prev: WeekSnapshot | null, curr: WeekSnapshot, recheck: RecheckReport = EMPTY_RECHECK): WeekDiff {
	const empty: WeekDiff = {
		prevWeekOf: prev?.weekOf ?? null,
		appeared: [],
		archivedNow: [],
		licenseChanged: [],
		starJumps: [],
		recheck,
		changed: false,
	};
	if (!prev) return empty;

	// 复查已经给出答案的那些仓,归档/许可证由复查说了算(见 WeekDiff.archivedNow
	// 的注释)。**只跳过 resolved 的**:复查没查成的仓退回用两周的扫描快照比一次,
	// 那份数据同样是真的 GET /repos 拿到的,只是早了几十秒。
	const owned = new Set(recheck.resolved);
	const before = new Map(prev.repos.map((r) => [r.fullName, r]));
	const appeared: string[] = [];
	const archivedNow: string[] = [];
	const licenseChanged: LicenseChange[] = [];
	const starJumps: StarJump[] = [];

	for (const now of curr.repos) {
		const was = before.get(now.fullName);
		if (!was) {
			appeared.push(now.fullName);
			// 新进清单的仓没有「上一周的自己」可比,后面三类对它无意义。
			// 硬要比的话得拿它和 undefined 比,那只会造出三条假变化。
			continue;
		}
		if (!owned.has(now.fullName)) {
			if (!was.archived && now.archived) archivedNow.push(now.fullName);
			// null(没有许可证)和 "MIT" 之间的来回也是许可证变更,而且是最该说的
			// 那一种——「本来不可用现在可用了」和反过来,都会改变能不能抄它。
			if (was.license !== now.license) {
				licenseChanged.push({ fullName: now.fullName, from: was.license, to: now.license });
			}
		}
		const delta = now.stars - was.stars;
		if (delta > 0 && delta >= starJumpThreshold(was.stars)) {
			starJumps.push({ fullName: now.fullName, from: was.stars, to: now.stars, delta });
		}
	}

	return {
		prevWeekOf: prev.weekOf,
		appeared,
		archivedNow,
		licenseChanged,
		starJumps,
		recheck,
		// 复查报出来的变化**也算变化**:漏掉它的话,一个「上周那个仓这周归档了、
		// 别的什么都没动」的星期会被算成「没有变化」,而那正是这一整条改动要报的事。
		changed:
			appeared.length + archivedNow.length + licenseChanged.length + starJumps.length + recheck.changes.length > 0,
	};
}
