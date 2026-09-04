// 阶段 8 · 每周一的 cron + 门铃邮件(docs/01 决策 5 / 决策 8,docs/02 决策 T5)。
//
//   scheduled()  → runWeeklyCron(env)   每周一 08:00 UTC(wrangler.jsonc triggers)
//   GET/POST /unsub?token=…             一键退订(免登录,HMAC token 认身份)
//   GET/PUT  /api/email                 订阅开关(和上面那条写同一行)
//
// 一趟做的事,按顺序:
//   0. sweepExpired():D1 没有 DynamoDB 那种原生 TTL,quota / daily_spend 的过期行
//      得自己扫。**放在最前面**——它是一个 batch 的事,而排在几十趟周扫后面的话,
//      整趟撞上预算就永远轮不到它,于是那张全站最热的写入表一直长下去。
//   1. 遍历**所有有档案的用户**,逐个:
//        runWeeklyScan  跑周扫并落库
//        settleWeek     复查 + 与上一次比 + **把跨周结论落库**
//        sendDoorbell   发门铃邮件(退订 / 没配凭证 / 已发过就不发)
//
// **落库和发信是两件不同重要程度的事**(2026-09-01 上线前终审):结论必须落库
// ——跨周状态是这个产品相对一个 Claude Code skill 的全部存在理由,而信发不发得
// 出去取决于一组 AWS 凭证和收件人有没有退订。让后者的失败带走前者,就是那一轮
// 修的第一个 bug 的形状(settleWeek 的函数头有完整论证)。
//
// **串行,绝不并发**(决策 T5)。这不是保守:GitHub 的 PAT 是**账号级共享桶**,
// search 30 次/分钟,而每人 12-16 次查询。`Promise.all(users.map(...))` 会在第 3 个
// 用户就开始吃 403,而 403 之后继续打会被 GitHub 拉进**更长的惩罚窗口**——一个人
// 的并发代价落在全站头上。
//
// 而且光串行还不够:github.ts 的双桶退避是**按响应头**记在 client 上的,每个用户
// 各 new 一个 client 的话,新 client 的 remaining 是 null、throttle() 直接放行,
// 于是每个用户开头都把退避归零一次 —— 写了等于没写。所以整趟共用**一份额度状态**
// (newRateState → RunScanDeps.rateState → GithubClientOptions.rateState),
// 而 deadline / signal / 调用计数仍然按用户各算各的(每人一份台账、每人一份预算)。
//
// 相对 import 一律带 `.ts` 后缀,理由同 guard.ts 顶部(node --test 的 ESM
// 解析器不补后缀,cron.test.ts 要直接 import 这个文件)。

import { Hono } from "hono";
import { renderTeardownEmail, sendTeardownEmail, unsubToken, verifyUnsubToken } from "../shared/email.ts";
import type { TeardownEmailCandidate } from "../shared/email.ts";
import { GithubClient, hardStopKind, newRateState } from "../shared/github.ts";
import type { RateState } from "../shared/github.ts";
import { EMPTY_RECHECK, diffWeeks, foldRecheck } from "../shared/scan-diff.ts";
import type { RecheckOutcome, RepoSnapshot, WeekDiff } from "../shared/scan-diff.ts";
import {
	claimWeeklyEmail,
	getWeeklyScan,
	isOptedOut,
	listDossiers,
	listRecentScans,
	listScanCandidates,
	markWeeklyEmail,
	optOutEmail,
	putWeeklyChange,
	resubscribeEmail,
	sweepExpired,
	weeklyScanId,
} from "../shared/store.ts";
import type { Dossier, ScanCandidate, WeeklyScanBundle } from "../shared/store.ts";
import type { EmailPrefs, PutEmailPrefsRequest } from "../shared/types.ts";
import { cronBudgetMs, cronScanBudgetMs, githubApiBase } from "./env.ts";
import type { AppEnv } from "./env.ts";
import { appUrl, userGuard } from "./guard.ts";
import type { Guarded } from "./guard.ts";
import { runWeeklyScan } from "./scan.ts";

/** 一次 cron 最多遍历多少个档案。超出的部分下一趟也扫不到,所以要记一条日志。 */
const CRON_MAX_USERS = 500;

// ---------------------------------------------------------------------------
// 复查:上一周清单上的那些仓,这一周怎么样了(阶段 9,站长 2026-09-01 拍板)
// ---------------------------------------------------------------------------

/**
 * 一趟复查最多打几次 GET /repos。
 *
 * 正常是 ≤5(决策 4 每周挑 5 个),申诉能把清单撑大(types.ts SCAN_PICK_LIMIT),
 * 所以要有上限:core 桶匿名档只有 60 次/小时,一个人申诉了 30 个仓、cron 又要
 * 串行给 N 个人跑,这一条能把整趟的额度吃光,而**周扫本身**才是这一趟的正事。
 * 超出上限的那些记 unchecked 并说明理由,不假装查过。
 */
export const RECHECK_MAX = 10;

/** 一趟复查的墙钟上限。≤10 次 core 调用,正常一两秒;60 秒是留给退避的,不是留给等的。 */
const RECHECK_BUDGET_MS = 60_000;

/**
 * 复查这一趟自己的 GithubClient。
 *
 * **共用整趟的 rateState,独立的 deadline/signal。**共用额度状态是必须的
 * (它和周扫打同一个账号级共享桶,不共享就等于这几发绕过了退避);而 deadline
 * 独立是因为复查是锦上添花 —— 给它一分钟,超了就在账上记「没查成」,不该拿着
 * 整趟剩下的十分钟去等一个退避窗口,把后面用户的周扫挤掉。
 *
 * 两头都夹住:`min(现在 + 1 分钟, 整趟截止)`,而且至少留 1 秒(不然整趟快到点时
 * deadline 会落在过去,第一发就 RateBudgetError —— 那也没错,只是白建一个 client)。
 */
function newRecheckClient(env: AppEnv, rateState: RateState, now: number, tripDeadline: number): GithubClient {
	const budget = Math.max(1_000, Math.min(RECHECK_BUDGET_MS, tripDeadline - now));
	return new GithubClient({
		pat: env.GITHUB_PAT,
		apiBase: githubApiBase(env),
		deadline: now + budget,
		signal: AbortSignal.timeout(budget),
		rateState,
	});
}

/**
 * 复查要的唯一能力:按名字问一个仓今天什么样。
 *
 * **窄到只有一个方法**,不是直接收 GithubClient:一是测试能三行造一个假的
 * (造一个完整的 GithubRepo 要填 12 个字段,其中 10 个这条路根本不看),二是
 * 这条路**只被允许做这一件事** —— 它拿到整个 client 的话,下一个人就能顺手在
 * 复查里加一次 search,而 search 是另一个桶、另一套退避,那正是决策 T5 要防的。
 *
 * `null` = 404 / 410 / 451(GithubClient.getRepo 的口径),抛异常 = 别的都算。
 * **这两者的区别就是「仓没了」和「我没查成」的全部依据**,别在实现里把它们合并。
 */
export interface RecheckProbe {
	getRepo(fullName: string): Promise<RepoSnapshot | null>;
}

/** GithubClient → RecheckProbe。只取 diff 关心的四个字段,其余原样丢掉。 */
export function probeFromClient(client: GithubClient): RecheckProbe {
	return {
		async getRepo(fullName) {
			const r = await client.getRepo(fullName);
			return r ? { fullName: r.fullName, stars: r.stars, archived: r.archived, license: r.license } : null;
		},
	};
}

/**
 * 复查停在这里的理由;null = 只是这一个仓没查成,循环该继续。
 *
 * 判据和门 1 是同一份(github.ts hardStopKind),措辞是复查场景自己的。限流
 * 之后必须立刻停:403 之后继续打会被 GitHub 拉进更长的惩罚窗口,而那个桶是
 * 全站共用的(决策 T5)—— 为了几条「上周那个仓怎么样了」把下一个用户的周扫
 * 拖垮,是本末倒置。
 */
function recheckStopReason(err: unknown): string | null {
	const why = err instanceof Error ? err.message : String(err);
	switch (hardStopKind(err)) {
		case "budget":
			return `复查的预算不够了(${why})`;
		case "ratelimit":
			return `复查撞上 GitHub 限流(${why}),停在这里 —— 继续打只会换来更长的惩罚窗口`;
		case "aborted":
			return `复查被整趟的预算掐断了(${why})`;
		default:
			return null;
	}
}

/**
 * 逐个复查上一周清单上的仓。**这是本条改动唯一做 I/O 的地方。**
 *
 * 三件事必须分开,合并任何两件都会让邮件说一句没发生过的话:
 *
 *   200        → ok,拿它和上周的快照比
 *   404/410/451 → gone。**仓被删/改名/下架本身就是一种「死了」,值得报。**
 *   其余(5xx / 403 / 超时 / 网络抖)→ unchecked。**我们不知道它怎么样了。**
 *
 * 阶段 4/5 评审的必须修 2 就是栽在把后两者混成一栏:那次是门 1 的一个光秃秃的
 * catch 把「GitHub 全挂」记成了「9 个仓不存在」,页面把事故渲染成一份正常的空
 * 结果。这里从一开始就分开,而且分法不是靠猜状态码 —— GithubClient.getRepo 已经
 * 把 404/410/451 翻成 `null`、别的翻成抛异常,这一层只是照着它的口径转述。
 *
 * **「停更断崖」这一类没有做**,这是想清楚之后的决定不是漏掉:
 *
 * 1. `pushed_at` 只会变新不会变旧,所以「断崖」不可能是一次比较的结果,它的真实
 *    含义只能是「上周之后一次提交都没有」——**那是一件没有发生的事**,而另外三类
 *    (归档 / 换许可证 / 仓没了)全都是作者主动按下的、有字段作证的状态跃迁。
 * 2. 一周没提交对一个健康项目是常态,不是信号。按这条报出去,就是每周一早准时
 *    送达一条「XX 停更了」的假警报 —— docs/01 风险 1 说的「每周准时被误导一次」,
 *    这次是我们自己造的。
 * 3. 真正说得出口的形态是「连续 N 周(N 至少 8)一次提交都没有」,而这需要 N 周的
 *    历史。**那份历史正在攒,但它有洞,而且洞的形状要说准**(2026-09-01 上线前
 *    终审改了这一条 —— 原来这里只写「那份历史正在攒」,那句话对成熟项目成立,
 *    对新项目不成立):
 *
 *      · `scan_candidate` 一周只装 ≤5 个。一个开始停更的小项目**会先掉出清单**
 *        ——它的 pushed_at 历史恰好断在它开始停更的那一刻,而那正是最需要历史的
 *        那一类项目。只靠候选行的话,这条规则永远只能抓到「一直排在前 5 的大仓
 *        突然不动了」,而那种事本来就看得见。
 *      · 所以终审给**排除行也加了 `pushed_at`**(migrations/0001_init.sql):一周
 *        ~385 条排除行里带着这个字段,数据本来就在手上,不多打一次 API。
 *      · **仍然有洞**:一个仓这一周压根没被 search 返回(排名掉出 1000 条上限、
 *        检索词改过、这一趟提前收工),它这一周就一行都没有。所以那条规则的判据
 *        只能写成「**有记录的那几周里连续没动过**」,不能写成「连续 N 周」的字面
 *        意思——不区分的话,一个「我们没看见」的星期会被读成「它没提交」,那就是
 *        我们自己造出来的假警报,和上面第 2 条要防的是同一件事。
 * 4. 而且规则层已经有一条诚实版的「停更」:`pushed_at` 超过 18 个月直接排除
 *    (scan-rules 的 stale)。那条线拉得很长,长到不会误伤,这是有意的。
 */
export async function recheckPrevious(
	probe: RecheckProbe,
	prev: readonly RepoSnapshot[],
): Promise<Map<string, RecheckOutcome>> {
	const out = new Map<string, RecheckOutcome>();
	// 非 null 之后,剩下的仓一律记 unchecked 并带上同一个理由(**不是静默跳过**:
	// 「没轮到」和「查过了、一切正常」在邮件里是完全不同的两句话)。
	let stopped: string | null = null;

	for (let i = 0; i < prev.length; i++) {
		const name = prev[i]!.fullName;
		if (stopped) {
			out.set(name, { kind: "unchecked", why: stopped });
			continue;
		}
		if (i >= RECHECK_MAX) {
			out.set(name, {
				kind: "unchecked",
				why: `这一周只复查了清单上的前 ${RECHECK_MAX} 个(上限,免得把周扫的 GitHub 额度吃光)`,
			});
			continue;
		}
		try {
			const now = await probe.getRepo(name);
			// null = 404/410/451。**这是答案,不是失败**(见函数头)。
			out.set(name, now ? { kind: "ok", repo: now } : { kind: "gone" });
		} catch (err) {
			const hard = recheckStopReason(err);
			const why = hard ?? (err instanceof Error ? err.message : String(err));
			out.set(name, { kind: "unchecked", why });
			// 硬停:后面的仓一个都不再打,但每一个都要在账上留下「没查成」。
			if (hard) stopped = hard;
		}
	}
	return out;
}

// ---------------------------------------------------------------------------
// 门铃邮件
// ---------------------------------------------------------------------------

/**
 * 一封信的结局。**每一种都要能在日志里数出来**——「这一趟发了几封、跳过几封、
 * 失败几封」是站长判断这条链路死没死的唯一依据,而门铃邮件恰恰是 docs/01 风险 2
 * 说的那个「功能全做完了但产品是死的」最容易发生的地方。
 */
export type DoorbellOutcome =
	| "sent"
	/** 这一周这个人已经发过了(cron 重试 / 站长补跑)。**这就是幂等。** */
	| "duplicate"
	| "optout"
	/** 没配 EMAIL_UNSUB_SECRET 或 AWS 凭证:正文渲染出来记进日志,不发。 */
	| "unconfigured"
	/** 认领了但 SES 报错。**不重试、不删认领行**,理由见 sendDoorbell。 */
	| "failed";

/**
 * 一个用户这一周的**结算**:那一整包周扫,和跨周比出来的那份 diff。
 *
 * 为什么把它拎成一个类型、并且和发信分成两个函数(2026-09-01 上线前终审):
 * 落库和发信是**两件不同重要程度的事**。结论必须落库(它是这个产品相对
 * skill 的全部存在理由),而信发不发得出去取决于一组 AWS 凭证和收件人有没有
 * 退订 —— 让后者的失败带走前者,就是这条改动要修的那个 bug 的形状。
 *
 * 复查的账在 `diff.recheck` 里,不另放一份:cron 收工那一行要说出全体用户的
 * 合计,而「同一件事有两个出处」在这个仓里一律按 bug 处理。
 */
export interface WeekSettlement {
	bundle: WeeklyScanBundle;
	diff: WeekDiff;
}

/** 发信要的三样凭证齐了没有。缺任何一样都发不出信,而缺哪一样都不该让整趟崩掉。 */
function emailConfigured(env: AppEnv): boolean {
	return Boolean(env.EMAIL_UNSUB_SECRET && env.AWS_ACCESS_KEY_ID && env.AWS_SECRET_ACCESS_KEY);
}

/** ScanCandidate → diff 只关心的那四个字段。 */
const toSnapshot = (c: ScanCandidate): RepoSnapshot => ({
	fullName: c.fullName,
	stars: c.stars,
	archived: c.archived,
	license: c.license,
});

/** ScanCandidate → 邮件里那一行。**没有一个字段来自报告**(email.ts 文件头)。 */
const toEmailLine = (c: ScanCandidate): TeardownEmailCandidate => ({
	fullName: c.fullName,
	stars: c.stars,
	archived: c.archived,
	oneLiner: c.oneLiner,
	// 「你捞回来的」那枚徽记的来源。它是 getWeeklyScan **读的时候 join** 出来的,
	// 所以下面必须用整包读回来的候选,不能用 runWeeklyScan 手上那一份
	// (那一份的 appealedFrom 恒为 null,徽记会安静消失)。
	appealedFrom: c.appealedFrom,
});

/**
 * 与上一次跑过的那一周做 diff。
 *
 * 「上一周」取的是 `listRecentScans` 里**除本周之外最新的那一条**,而不是
 * 「本周减 7 天」:cron 挂过一次、或者这个人是上上周才建的档,中间就会有空档。
 * 拿一个根本没跑过的周去比只会得出「五个全是新的」这种假增量,而按「上一次」
 * 比至少每一条变化都是真的——邮件里那句话因此写的是「与上一次(2026-W35)比」,
 * 把口径直接印在读者眼前。
 */
export async function diffAgainstPrevious(
	db: D1Database,
	dossierId: string,
	weekOf: string,
	current: ScanCandidate[],
	probe: RecheckProbe | null = null,
): Promise<WeekDiff> {
	// 取 2 条:第一条正常是本周(刚落库),第二条才是上一次。
	const recent = await listRecentScans(db, dossierId, 2);
	const prev = recent.find((s) => s.weekOf !== weekOf) ?? null;
	if (!prev) return diffWeeks(null, { weekOf, repos: current.map(toSnapshot) });
	// **只读候选不读排除**:diff 要的是 ≤5 行,而整包会把上周那 386 行排除一起
	// 拉出来(listScanCandidates 的注释有完整论证)。
	const prevCandidates = await listScanCandidates(db, prev.id);
	const prevRepos = prevCandidates.map(toSnapshot);
	// 复查(阶段 9):**对上一周清单上的每一个仓打一次真的 GET /repos**,不是
	// 只查这周还在清单里的那些 —— 归档的仓会被规则筛掉、根本进不了本周清单,
	// 只查还在的那些等于永远报不出「掉出清单 + 已归档」,而那正是要报的事。
	// probe 为 null(没传 / 第一周)时不做复查,账上如实是 0,邮件里一个字不提。
	const recheck = probe
		? foldRecheck(prevRepos, await recheckPrevious(probe, prevRepos), new Set(current.map((c) => c.fullName)))
		: EMPTY_RECHECK;
	return diffWeeks({ weekOf: prev.weekOf, repos: prevRepos }, { weekOf, repos: current.map(toSnapshot) }, recheck);
}

/**
 * 一个用户这一周的**结算**:读回整包周扫 → 跨周比一次(含复查)→ **落库**。
 *
 * ## 为什么它必须和发信分开(2026-09-01 上线前终审,站长拍板)
 *
 * 在这条改动之前,这段逻辑长在 `sendDoorbell` 里,而 `sendDoorbell` 第一件事是
 * 检查退订、最后一件事是发信。于是这一周算出来的跨周结论只有一个去处——**那封
 * 信的正文**。它带来两个后果,都在本地库里留下了实物:
 *
 * 1. **发失败 = 结论丢了。** `weekly_email` 里躺着一行
 *    `sent_at = NULL, error = 'SES send failed (HTTP 403)'`。按阶段 8 定下的取舍
 *    (认领行不删、不重试),那一周的门铃**永远不会补发**,而那一趟的候选换血和
 *    复查结论在 D1 里一个字都没有。
 * 2. **docs/01 风险 4 的判据没法执行。** 原话是「如果站长从不去翻上一周的结果,
 *    那就该退回 skill 形态」——而产品里**没有「翻上一周」这个动作可翻**。而跨周
 *    状态是这个产品相对一个 Claude Code skill 的全部存在理由。
 *
 * 所以顺序改成:**先结算落库,再发信**。发信失败、没配凭证、收件人退订,三件事
 * 一件都不该带走结论。
 *
 * ## 退订的人照算照落库
 *
 * 退订是「别给我发邮件」,不是「别帮我看了」。所以退订的那道门搬到了
 * `sendDoorbell` 里,这里不看它。代价是复查那 ≤10 次 GitHub 调用退订的人也照花
 * (阶段 9 原来的注释写着「退订的人一次都不查」,这条被终审推翻了),换回来的是
 * 「你上周在看的那个项目死了」这件事在库里有记录 —— 而它恰恰是退订之后网页上
 * 唯一还能看见它的地方(那个仓已经不在清单上了)。
 */
export async function settleWeek(
	env: AppEnv,
	dossier: Dossier,
	weekOf: string,
	now: number,
	probe: RecheckProbe | null = null,
): Promise<WeekSettlement> {
	const db = env.TEARDOWN_DB;
	// **整包读回来**,不是用 runWeeklyScan 手上那一份:一是 appealedFrom 只有
	// 这条路上有(见 toEmailLine),二是这样邮件和网页读的是同一份数据、同一个
	// 函数,两边在结构上不可能对不上(和 honestyOf 是同一个立场)。
	const bundle = await getWeeklyScan(db, dossier.id, weekOf);
	if (!bundle) throw new Error(`跨周结算读不到刚落库的周扫(${dossier.id} ${weekOf})`);

	const diff = await diffAgainstPrevious(db, dossier.id, weekOf, bundle.candidates, probe);
	// **算完就落库,发信之前。**这一行是 2026-09-01 上线前终审的第一条改动:
	// 在它之前,这份 diff 唯一的去处是下面那封信,而信发失败(SES 403)时
	// 那一周的换血和复查结论就没了 —— 认领行不删也不重试,所以永远不会补发。
	await putWeeklyChange(db, { dossierId: dossier.id, weekOf, diff, createdAt: now });
	return { bundle, diff };
}

/**
 * 给一个用户发这一周的门铃邮件。**只管发信**——结论已经由 settleWeek 落库了。
 *
 * 退订的处置在这里,而不是在 settleWeek 里:退订是「**别给我发邮件**」,不是
 * 「别帮我看了」。原来这道门在最前面,于是退订之后跨周变化连算都不算、更不用说
 * 落库,而网页上「这一周和上一次比变了什么」是照常要给他看的(周扫本来就照跑,
 * 排除理由、清单一行不少)。代价是复查那 ≤10 次 GitHub 调用退订的人也照花 ——
 * 这是站长 2026-09-01 拍板接受的:那几发换回来的是「你上周在看的那个项目死了」
 * 这件事在库里有没有记下来,而它恰恰是退订的人在网页上唯一看不到别处去的东西。
 *
 * **幂等靠一条语句**:`claimWeeklyEmail` 是 `INSERT ... ON CONFLICT DO NOTHING
 * RETURNING`,抢到行的那一趟才发信。为什么不能写成「先查 weekly_email 有没有行,
 * 没有就发」:cron 会重试,两趟重试交错进来会同时读到「还没发过」,信就发两封。
 * 判断和写入必须是同一次原子写(和 store.ts 的 reserveQuota 防的是同一类竞态)。
 *
 * **先抢再发,不是先发再记**:先发后记的话,发成功但写库失败就会在下次重试时
 * 重发;而先抢后发,最坏是「抢到了但没发成」——那时我们**不删认领行、也不重试**。
 * 这是一个明知的取舍:丢一封 vs 发两封,选丢一封。理由是邮件只是门铃——这一周的
 * 清单已经安全落在 D1 里、网页上一行不少,**跨周结论从 2026-09-01 起也一样**
 * (settleWeek 在这个函数之前就把它落库了;在那之前这句话对结论并不成立,那正是
 * 上线前终审修的第一条)。而一封重复的信是收件人唯一会记住的那种错误,也是被标
 * 垃圾的最快路径(会连累后面每一封)。发失败的那些站长查得到:
 * `SELECT * FROM weekly_email WHERE sent_at IS NULL`。
 */
export async function sendDoorbell(
	env: AppEnv,
	dossier: Dossier,
	weekOf: string,
	now: number,
	settled: WeekSettlement,
): Promise<DoorbellOutcome> {
	const db = env.TEARDOWN_DB;
	const { bundle, diff } = settled;
	// 退订只关掉邮件:周扫跑完落库了、跨周结论也落库了,网页照常能看。
	if (await isOptedOut(db, dossier.userEmail)) return "optout";

	const secret = env.EMAIL_UNSUB_SECRET;
	const configured = emailConfigured(env);
	// 没配凭证时也要有一个占位链接:模板里那一句退订文案不该因为本地没凭证就
	// 长得和线上不一样(下面会把整封正文打进日志给人看)。
	const unsubUrl = secret ? `${appUrl(env, "unsub")}?token=${await unsubToken(secret, dossier.userEmail)}` : "(未配置 EMAIL_UNSUB_SECRET,线上这里是一键退订链接)";
	const mail = renderTeardownEmail({
		domain: dossier.domain,
		weekOf,
		// **全部候选,不截断**(申诉能让 admitted > 5,见 TeardownEmailInput 的注释)。
		candidates: bundle.candidates.map(toEmailLine),
		diff,
		stopped: bundle.scan.stopped,
		openUrl: appUrl(env, "app"),
		unsubUrl,
	});

	if (!configured) {
		// **优雅降级**:没有 SES 凭证不是错误,是一种配置状态(fork 的人拿不到
		// 这组凭证,整个产品的其余部分对他们照常可用)。正文原样打进日志,好让
		// 本地 `wrangler dev --test-scheduled` 能真的看见这封信长什么样。
		console.log(
			`[cron] 邮件未配置(EMAIL_UNSUB_SECRET / AWS 凭证缺一),没发。下面是本该发给 ${dossier.userEmail} 的正文:\n` +
				`--- subject ---\n${mail.subject}\n--- text ---\n${mail.text}\n--- html(${mail.html.length} 字符,略) ---`,
		);
		return "unconfigured";
	}

	const scanId = weeklyScanId(dossier.id, weekOf);
	const claimed = await claimWeeklyEmail(
		db,
		{ scanId, dossierId: dossier.id, weekOf, userEmail: dossier.userEmail },
		now,
	);
	if (!claimed) {
		console.log(`[cron] ${dossier.userEmail} ${weekOf} 这一周的门铃信已经发过了,跳过`);
		return "duplicate";
	}

	try {
		await sendTeardownEmail(
			{
				region: env.AWS_REGION ?? "us-east-1",
				accessKeyId: env.AWS_ACCESS_KEY_ID!,
				secretAccessKey: env.AWS_SECRET_ACCESS_KEY!,
				from: env.EMAIL_FROM ?? "teardown@nanisle.com",
			},
			dossier.userEmail,
			mail,
			unsubUrl,
		);
		await markWeeklyEmail(db, scanId, { sentAt: now });
		console.log(`[cron] 门铃信已发:${dossier.userEmail} ← ${mail.subject}`);
		return "sent";
	} catch (err) {
		const why = err instanceof Error ? err.message : String(err);
		// 认领行留着(见函数头的取舍),只把原因盖上去。这一步再失败也只是少一条
		// 记录,不该把整趟拖下水。
		await markWeeklyEmail(db, scanId, { error: why }).catch((e) => console.error("[cron] 回写发信失败原因也失败了", e));
		console.error(`[cron] 门铃信发送失败:${dossier.userEmail} — ${why}`);
		return "failed";
	}
}

// ---------------------------------------------------------------------------
// 一趟 cron
// ---------------------------------------------------------------------------

export interface CronOutcome {
	weekOf: string;
	/** 这一趟看到的档案数(= 有档案的用户数)。 */
	users: number;
	/** 周扫真的跑完并落库的人数。 */
	scanned: number;
	/** 各种结局各几个人。 */
	email: Record<DoorbellOutcome, number>;
	/** **抛异常被吞掉的人数**。非 0 就说明这一趟有人这周什么都没拿到。 */
	failed: number;
	/** 撞上整趟预算、根本没轮到的人数。 */
	notReached: number;
	/**
	 * 复查的合计账(阶段 9)。**三个数要能直接读成一句人话**:
	 * 「这一趟复查了 checked 个仓,changed 个有变化,unchecked 个没查成」。
	 *
	 * unchecked 不是错误计数,是**诚实度计数**:它非 0 说明这一趟对那几个仓
	 * 什么都没说 —— 而「没说」和「说了没变化」在一封写着「与上一次比」的邮件里
	 * 是完全不同的两件事。
	 */
	recheck: { checked: number; changed: number; unchecked: number };
	sweep: { quota: number; spend: number };
	/**
	 * **整趟炸了的原因**;null = 整趟本身跑到了收工(个别用户失败看 `failed`)。
	 *
	 * 为什么要单独一个字段而不是让异常往外抛(2026-09-01 上线前终审的 A3):
	 * cron 没有上游能处理这个异常 —— `scheduled()` 里抛出去只会变成一条运行时的
	 * 未捕获错误,而 Cloudflare 的 cron 触发器**不重试**。它非 null 的含义是
	 * 「这一周一个用户都没扫到」,和 `failed`(某几个人没扫到)是两件事,不能
	 * 混成一个数。
	 */
	tripError: string | null;
}

export interface CronDeps {
	/** 注入时钟是为了让测试能钉住 weekOf 和预算;生产不传。 */
	clock?: () => number;
	/** 触发它的那条 cron 表达式,只进日志。 */
	cron?: string;
}

/**
 * 每周一 08:00 UTC 的那一趟。
 *
 * **一个用户失败不能拖垮整趟**:每个人的整段(周扫 + 落库 + diff + 发信)包在
 * 一个 try 里,异常吞掉、记一条 error 日志、`failed += 1`,继续下一个。吞掉但要
 * **数得出来**——一个安静吞异常的循环和一个跑通了的循环在日志里长得一模一样,
 * 而这一趟每周只跑一次,没数出来就要等一周才有第二次机会发现。
 *
 * **跳过没有档案的用户**是免费的:`listDossiers` 查的就是 dossier 表,没建档的人
 * 压根不在里面。这顺带补上了 store.ts deleteDossierCascade 记的那个窄窗口
 * ——「读到档案 id 之后、批删之前刚写进来的那一周」需要有人在删档的同时给这个
 * 档案写周扫,而 cron 的名单是删档之前的一次快照,下一趟就不再包含他了。
 *
 * **整趟也包一个 try,而且这个函数不抛异常**(2026-09-01 上线前终审的 A3)。
 * 在这之前,起手的 `sweepExpired` 和 `listDossiers` 在任何 try 之外:周一早上
 * D1 抖一下,整趟就从 `scheduled()` 里抛出去,**「起跑」和「收工」两条日志都
 * 不会有,一个用户都没扫**,而 Cloudflare 的 cron 触发器**不重试** —— 这一周
 * 对所有人就这么过去了,而唯一的痕迹是没有痕迹。这跟这个函数自己的立场是
 * 矛盾的:每个用户的失败都被数了(`failed`),整趟的失败反倒没有。
 *
 * 所以:①「起跑」那条日志排在任何一次库操作**之前**;②`sweepExpired` 单独
 * 包一层(清理是顺手做的事,它挂了不该让所有人这周收不到东西);③整段包一个
 * try,异常记进 `tripError` 并照常打「收工」;④不再往外抛 —— cron 没有上游可以
 * 处理这个异常,能做的只有「留下痕迹」,而痕迹已经留了。
 */
export async function runWeeklyCron(env: AppEnv, deps: CronDeps = {}): Promise<CronOutcome> {
	const clock = deps.clock ?? Date.now;
	const started = clock();
	const tripDeadline = started + cronBudgetMs(env);
	const db = env.TEARDOWN_DB;

	const out: CronOutcome = {
		weekOf: "",
		users: 0,
		scanned: 0,
		email: { sent: 0, duplicate: 0, optout: 0, unconfigured: 0, failed: 0 },
		failed: 0,
		notReached: 0,
		recheck: { checked: 0, changed: 0, unchecked: 0 },
		sweep: { quota: 0, spend: 0 },
		tripError: null,
	};

	// **第一件事就是留下「我起跑了」。** 排在任何一次库操作之前:D1 在起手那两次
	// 读上挂掉时,这条日志是「这一趟到底有没有被触发」的唯一证据。
	console.log(`[cron] ${deps.cron ?? "(手动)"} 起跑,预算 ${cronBudgetMs(env)}ms`);

	try {
		// 先扫过期行(见文件头):一个 batch 的事,不能让它排在几十趟周扫后面。
		// **单独包一层**:它是顺手做的清理,挂了只是让 quota 表多留几天垃圾,
		// 不该因此让所有人这一周什么都收不到。
		try {
			out.sweep = await sweepExpired(db, started);
		} catch (err) {
			console.error("[cron] 清过期行失败(不拦路,这一趟照跑):", err);
		}

		// 整趟共用一份额度状态(见文件头)。**必须在循环外面建**——建在循环里面
		// 和不共享完全一样。
		const rateState = newRateState();
		const dossiers = await listDossiers(db, CRON_MAX_USERS);
		out.users = dossiers.length;
		if (dossiers.length >= CRON_MAX_USERS) {
			console.error(
				`[cron] 档案数达到单趟上限 ${CRON_MAX_USERS},超出的部分这一趟没扫到。` +
					`该按 docs/02 决策 T5 分片到多个 cron 时刻了(不是改成并发 —— 共享桶的约束不会因为并发消失)。`,
			);
		}
		console.log(`[cron] 名单:档案 ${dossiers.length} 份,清掉过期行 quota=${out.sweep.quota} spend=${out.sweep.spend}`);

		await runDossiers(env, dossiers, out, { clock, rateState, tripDeadline });
	} catch (err) {
		// 走到这里 = 起手那两次库操作挂了,或者循环外面有东西炸了。**一个用户都
		// 没扫到**,而 cron 不重试。能做的只有把它记成一个数得出来的结局。
		out.tripError = err instanceof Error ? err.message : String(err);
		console.error(`[cron] 整趟失败(cron 触发器不重试,这一周对所有人就这么过去了):`, err);
	}

	console.log(
		`[cron] 收工:档案 ${out.users} 份,扫完 ${out.scanned},失败 ${out.failed},没轮到 ${out.notReached};` +
			`信 sent=${out.email.sent} duplicate=${out.email.duplicate} optout=${out.email.optout} ` +
			`unconfigured=${out.email.unconfigured} failed=${out.email.failed};` +
			// 复查这三个数必须进收工日志:它是站长判断「上周那些仓到底有没有被
			// 看过一眼」的唯一依据,而复查静默失败和复查没做过在别处长得一模一样。
			`复查 checked=${out.recheck.checked} changed=${out.recheck.changed} unchecked=${out.recheck.unchecked};` +
			`${out.tripError ? `整趟异常=${out.tripError};` : ""}` +
			`耗时 ${clock() - started}ms`,
	);
	return out;
}

/** runWeeklyCron 的主循环。拎出来只为了让上面那个 try 收得干净,没有别的语义。 */
async function runDossiers(
	env: AppEnv,
	dossiers: Dossier[],
	out: CronOutcome,
	ctx: { clock: () => number; rateState: RateState; tripDeadline: number },
): Promise<void> {
	const { clock, rateState, tripDeadline } = ctx;

	for (const dossier of dossiers) {
		const now = clock();
		// 剩下的时间不够跑一趟像样的周扫就别开新的:开了也只会在退避里被信号
		// 掐断,留下一份 stopped 的残缺清单外加一封说不清楚的信。
		const remaining = tripDeadline - now;
		if (remaining <= 0) {
			out.notReached += 1;
			continue;
		}
		try {
			// **每个用户单独一趟预算,但不许超过整趟剩下的时间。**没有这个 min,
			// 排在前面的一个慢用户能把后面所有人挤到运行时的硬上限之外,而那种
			// 掐断不会留下任何计数。
			const perUser = Math.min(cronScanBudgetMs(env), remaining);
			const scanEnv: AppEnv = { ...env, SCAN_BUDGET_MS: String(perUser) };
			// now 逐个用户现取,不是整趟共用一个:runWeeklyScan 拿它算 GithubClient
			// 的 deadline(now + budget - 5s),沿用起跑时刻的话,第二个用户的
			// deadline 就已经在过去了,整趟从第二个人起全部立刻 RateBudgetError。
			const outcome = await runWeeklyScan({ env: scanEnv, email: dossier.userEmail, dossier, now, rateState });
			out.scanned += 1;
			out.weekOf = outcome.scan.weekOf;
			console.log(
				`[cron] ${dossier.userEmail} ${outcome.scan.weekOf} 台账 returned=${outcome.scan.returned} ` +
					`admitted=${outcome.scan.admitted} excluded=${outcome.scan.excluded} fetchFailed=${outcome.scan.fetchFailed}` +
					`${outcome.scan.stopped ? ` stopped=${outcome.scan.stopped}` : ""}`,
			);
			// 复查用**独立的一个 client**,但**共用整趟那份额度状态**(rateState):
			// 它和周扫打的是同一个账号级共享桶,不共享的话这几发就绕过了退避
			// (github.ts GithubClientOptions.rateState 有完整论证)。
			// deadline / signal 是复查自己的,而且被整趟剩余时间夹住 —— 复查是
			// 锦上添花,不该把下一个用户的周扫挤掉。
			// **先结算落库,再发信**(2026-09-01 上线前终审):跨周结论不该被一封
			// 发不出去的信带走(settleWeek 的函数头有完整论证)。
			const settled = await settleWeek(
				env,
				dossier,
				outcome.scan.weekOf,
				clock(),
				probeFromClient(newRecheckClient(env, rateState, clock(), tripDeadline)),
			);
			const recheck = settled.diff.recheck;
			out.recheck.checked += recheck.checked;
			out.recheck.changed += recheck.changed;
			out.recheck.unchecked += recheck.unchecked;
			if (recheck.checked > 0) {
				console.log(
					`[cron] ${dossier.userEmail} 复查上一周清单上的 ${recheck.checked} 个仓:` +
						`${recheck.changed} 个有变化,${recheck.unchecked} 个没查成` +
						`${recheck.changes.map((c) => `;${c.fullName} ${c.kind}${c.stillListed ? "" : "(已掉出清单)"}`).join("")}` +
						`${recheck.unavailable.map((u) => `;${u.fullName} 没查成 —— ${u.why}`).join("")}`,
				);
			}
			const outcomeEmail = await sendDoorbell(env, dossier, outcome.scan.weekOf, clock(), settled);
			out.email[outcomeEmail] += 1;
		} catch (err) {
			// 吞掉,但数得出来(见函数头)。这里刻意不区分是周扫挂了还是发信挂了:
			// 对这一趟来说两者的后果一样——这个人这周没拿到东西,而下一个人该继续。
			out.failed += 1;
			console.error(`[cron] ${dossier.userEmail} 这一趟失败(已跳过,继续下一个):`, err);
		}
	}
}

// ---------------------------------------------------------------------------
// 一键退订
// ---------------------------------------------------------------------------

export const emailRoutes = new Hono<Guarded>();

/**
 * 退订。**免登录**——收信的人可能在一台没登录过的手机上点这个链接,而退订权
 * 不该被登录挡住(Gmail 的一键退订更是直接从服务器发 POST,那里没有 cookie)。
 * 身份由 token 的 HMAC 保证:签不出来就伪造不了别人的退订。
 *
 * 退订只写 `email_optout` 一行,**不删档案、不停周扫**:关掉的是门铃,不是产品。
 */
async function unsubscribe(env: AppEnv, token: string): Promise<{ ok: boolean; status: 200 | 400 | 503 }> {
	const secret = env.EMAIL_UNSUB_SECRET;
	// 没配密钥的实例本来就发不出信,也就没有退订这回事。503 而不是 400:
	// 这是服务端没开这个功能,不是用户拿了个坏链接。
	if (!secret) return { ok: false, status: 503 };
	const email = await verifyUnsubToken(secret, token);
	if (!email) return { ok: false, status: 400 };
	await optOutEmail(env.TEARDOWN_DB, email);
	return { ok: true, status: 200 };
}

emailRoutes.get("/unsub", async (c) => {
	const r = await unsubscribe(c.env, c.req.query("token") ?? "");
	const body = r.ok
		? "<p>已退订领域拆解的每周门铃邮件。</p><p>周扫照常每周跑,清单和排除理由随时能在网页上看 —— 只是不再给你发信了。</p>"
		: r.status === 503
			? "<p>这个实例没有开启邮件功能。</p>"
			: "<p>退订链接无效或已损坏。</p>";
	return c.html(
		`<!doctype html><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>领域拆解</title>
<div style="max-width:480px;margin:80px auto;padding:0 20px;font-family:-apple-system,'PingFang SC','Microsoft YaHei',sans-serif;color:#1a1a1a;line-height:1.8;">
<p style="font-size:12px;letter-spacing:0.08em;color:#999;">领域拆解</p>${body}
<p><a href="${appUrl(c.env, "app")}" style="color:#1a1a1a;">打开领域拆解 →</a></p></div>`,
		r.status,
	);
});

// Gmail 的一键退订(List-Unsubscribe-Post)打的是 POST,而且不带 cookie、不看
// 返回的 HTML。两条路走同一个函数,免得哪天只改了其中一条。
emailRoutes.post("/unsub", async (c) => {
	const r = await unsubscribe(c.env, c.req.query("token") ?? "");
	return c.json({ ok: r.ok }, r.status);
});

// ---------------------------------------------------------------------------
// 订阅开关(阶段 9,站长 2026-09-01 拍板)
// ---------------------------------------------------------------------------
//
// 阶段 8 之后 `email_optout` 只有一个写入方 —— 邮件里那条一键退订链接。也就是说
// **退订是一条单行道**:退了就再也回不来,除非站长手工删库。(而「删档重建」
// 故意不删这一行,所以它也不是一条出路,那是 store.ts deleteDossierCascade 里
// 写死的取舍。)这两条路由把它补成双向。
//
// **和 /unsub 写的是同一张表、同一行**(store.ts resubscribeEmail 的注释有完整
// 论证)。这不是巧合而是唯一的一致性保证:两处状态之所以不会分叉,是因为它们
// 结构上就是同一个状态,而不是靠谁去同步谁。

/** 现在的订阅状态。**读的是 isOptedOut——和 cron 发信前问的是同一个函数。** */
async function readPrefs(env: AppEnv, email: string): Promise<EmailPrefs> {
	return {
		email,
		optedOut: await isOptedOut(env.TEARDOWN_DB, email),
		configured: emailConfigured(env),
	};
}

/**
 * 现在是在收还是已退订。**开关必须先知道当前值再画**:一个不知道当前状态的
 * 按钮,用户点下去之前不知道自己会得到什么(docs/01 的立场:页面要说实话,
 * 不能让人猜)。
 */
emailRoutes.get("/api/email", userGuard, async (c) => c.json(await readPrefs(c.env, c.get("email"))));

/**
 * 改订阅状态。回的是**改完之后重新读一遍库**的结果,不是把请求体回显一遍:
 * 回显的话,写入静默失败时页面会显示一个根本没生效的状态 —— 而那正是这个
 * 产品最怕的那种错(docs/01 风险 1「错得很安静」)。
 */
emailRoutes.put("/api/email", userGuard, async (c) => {
	let body: unknown;
	try {
		body = await c.req.json();
	} catch {
		return c.json({ error: "请求体不是合法的 JSON。" }, 400);
	}
	const wanted = (body as Partial<PutEmailPrefsRequest> | null)?.optedOut;
	// **只认真正的布尔**:漏传 / 传 "false" 字符串时不猜一个方向 —— 猜错的后果
	// 是把一个想重新订阅的人又退订一次,而他看到的是「保存成功」。
	if (typeof wanted !== "boolean") return c.json({ error: "optedOut 必须是 true 或 false。" }, 400);
	const email = c.get("email");
	if (wanted) await optOutEmail(c.env.TEARDOWN_DB, email);
	else await resubscribeEmail(c.env.TEARDOWN_DB, email);
	return c.json(await readPrefs(c.env, email));
});
