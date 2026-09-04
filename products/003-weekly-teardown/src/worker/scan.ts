// 阶段 4 · 发现层(docs/01 决策 4、docs/02 决策 T3 / T5)。
//
//   POST /api/scan            手动跑一次周扫(cron 是阶段 8,复用 runWeeklyScan)
//   GET  /api/scan?weekOf=…   取某一周的结果(不传取最近一周)
//   GET  /api/scan/history    最近 N 周的台账(只要台账不要明细)
//   GET  /api/scan/changes    这一周和上一次比变了什么(cron 算完落的那一份)
//
// 一趟的链路:档案的 queries → GitHub Search 双路 → 合并去重 → 规则过滤 →
// 名次 → 门 1(GET /repos 拿 200)→ 一次 flash 问形态描述 → 台账 → putWeeklyScan。
//
// **这一层几乎不用 LLM。**唯一一处模型产出是每个进清单的仓的一句话形态描述
// (scan_candidate.one_liner),而且**只是描述不是判断**——它不决定谁进清单、
// 谁被排除,那两件事全部由 GitHub 的真实返回和 scan-rules.ts 的纯函数决定。
// 模型这一步失败了,清单一个字都不变,只是少一句话。
//
// 相对 import 一律带 `.ts` 后缀,理由同 guard.ts 顶部(node --test 的 ESM
// 解析器不补后缀)。

import { Hono } from "hono";
import { complete } from "../shared/ai.ts";
import { AiConfigError, AiError, resolveProvider } from "../shared/ai.ts";
import { collectRepos, rankSurvivors } from "../shared/discovery.ts";
import type { DiscoveredRepo } from "../shared/discovery.ts";
import { GithubClient, GithubError, RateBudgetError, SEARCH_RESULT_CAP, hardStopKind } from "../shared/github.ts";
import type { GithubRepo, RateState } from "../shared/github.ts";
// rankedOutReason 住在 scan-groups.ts:造这句理由的地方,和第一屏按这句理由
// 分组的地方,必须挨着。措辞一改而分组没跟上时,153 条会集体掉进「其他」组,
// 页面照样好看——那正是 docs/01 风险 1 说的「错得很安静」。
import { notReachedReason, rankedOutReason } from "../shared/scan-groups.ts";
import { excludeReason } from "../shared/scan-rules.ts";
import { SCAN_PICK_LIMIT } from "../shared/types.ts";
import type {
	AppealResponse,
	GetScanChangesResponse,
	GetScanResponse,
	RunScanResponse,
	ScanCandidate,
	ScanExclusion,
	ScanHistoryResponse,
	ScanHonesty,
	WeeklyChange,
	WeeklyChangeCounts,
	WeeklyScan,
} from "../shared/types.ts";
import { WEEK_OF_RE, isoWeek } from "../shared/week.ts";
import {
	appealExclusion,
	getDossier,
	getScanExclusion,
	getWeeklyChange,
	getWeeklyScan,
	latestScanWeek,
	latestWeeklyChange,
	listRecentScans,
	listScanAppeals,
	putWeeklyScan,
	recordWeekView,
	weeklyScanId,
} from "../shared/store.ts";
import type {
	Dossier,
	NewScanCandidate,
	NewScanExclusion,
	ScanCandidate as StoreScanCandidate,
	ScanExclusion as StoreScanExclusion,
	WeeklyChange as StoreWeeklyChange,
	WeeklyChangeCounts as StoreWeeklyChangeCounts,
	WeeklyScan as StoreWeeklyScan,
} from "../shared/store.ts";
import { fastAiConfigFor, githubApiBase, scanBudgetMs } from "./env.ts";
import type { AppEnv } from "./env.ts";
import { reserveOrDeny, userAiGuard, userGuard } from "./guard.ts";
import type { Guarded } from "./guard.ts";

/**
 * 编译期钉死三份周扫类型不许分叉(同 dossier.ts 顶部的 _wireMatchesStore):
 * `shared/types.ts` 那份给前端(不带 D1 类型),`shared/store.ts` 那份是 D1 行
 * 映射出来的。任何一边加减字段,`npm run check` 当场编译不过——比「前端读一个
 * 后端没给的字段,页面上安静地空着」好找一万倍。
 */
type _ScanBothWays = [
	StoreWeeklyScan extends WeeklyScan ? true : never,
	WeeklyScan extends StoreWeeklyScan ? true : never,
	StoreScanCandidate extends ScanCandidate ? true : never,
	ScanCandidate extends StoreScanCandidate ? true : never,
	StoreScanExclusion extends ScanExclusion ? true : never,
	ScanExclusion extends StoreScanExclusion ? true : never,
	// 跨周变化那一份也钉上(2026-09-01 上线前终审):它是网页和邮件「读同一份」
	// 那条保证的载体,两边的形状分叉了,分叉的两个数就会各自理直气壮地印出来。
	StoreWeeklyChange extends WeeklyChange ? true : never,
	WeeklyChange extends StoreWeeklyChange ? true : never,
	StoreWeeklyChangeCounts extends WeeklyChangeCounts ? true : never,
	WeeklyChangeCounts extends StoreWeeklyChangeCounts ? true : never,
];
const _scanWireMatchesStore: _ScanBothWays = [true, true, true, true, true, true, true, true, true, true];
void _scanWireMatchesStore;

/** history 默认回多少周,以及上限。第二周的 diff 只要 2 条,给宽一点也不贵。 */
const HISTORY_DEFAULT = 8;
const HISTORY_MAX = 52;

// ---------------------------------------------------------------------------
// 一句话形态描述:整层唯一的模型调用
// ---------------------------------------------------------------------------

/**
 * **只描述形态,不做判断。**这条界线是 003 全部可信度的来源,所以提示词里
 * 写死了「不要说好不好、值不值得看、比谁强」——一旦模型在这里开始下判断,
 * 用户就会拿它当选择依据,而它做这个判断时手里只有一段 description 和几个
 * topic,连 README 都没读过。真正的判断在深度报告里(阶段 7),那时候它
 * 读过源码,而且每句话都要挂逐字引文。
 *
 * 「≤5 个仓批量一次调用问完,别发 5 次」(docs/02 决策 T7 的分档表):5 次
 * 调用要 5 倍的钱和 5 倍的墙钟,而这是个已经在等 GitHub 的端点。
 */
const ONE_LINER_SYSTEM = `你给几个 GitHub 仓库各写一句**形态描述**。

只输出一个 JSON 对象,键是仓库全名,值是那句话:
{"owner/repo": "...", "owner2/repo2": "..."}

每句话的要求:
- ≤30 个汉字,一句话,不要句号以外的标点堆砌;
- 只说**它是什么形态**:是库还是完整应用、跑在哪(CLI / 网页 / 桌面 / 服务端)、给谁用、靠什么跑起来(要不要 key、要不要自己部署);
- **不要下判断**:不要说好不好、成不成熟、值不值得看、和谁比更强、有没有前景;
- 只用我给你的资料(名字、简介、主题词、语言)。**资料里没有的别猜**——不知道就写你确实知道的那部分,宁可短。

给谁看:一个已经决定要在这个领域里挑项目的人,他要的是「这几个东西分别是什么形状」,不是「你推荐哪个」。`

/** 喂给模型的那几行资料。**只有这些**——它看不到 star 数,免得顺嘴排名次。 */
function oneLinerPrompt(repos: GithubRepo[]): string {
	const lines = repos.map((r) => {
		const bits = [
			`- ${r.fullName}`,
			`  简介:${r.description?.slice(0, 300) ?? "(仓库没写简介)"}`,
			`  主题词:${r.topics.slice(0, 12).join(", ") || "(无)"}`,
			`  主要语言:${r.language ?? "(未标注)"}`,
		];
		if (r.isFork) bits.push("  这是一个 fork");
		return bits.join("\n");
	});
	return `给下面这些仓库各写一句形态描述:\n\n${lines.join("\n\n")}`;
}

/** 这次调用的输出预算下限。5 条中文 + JSON 结构,1024 顶得紧(同 dossier.ts 的理由)。 */
const ONE_LINER_TOKEN_FLOOR = 1024;

/**
 * mock 档的形态描述。**只有这一句是假的**(docs/02 决策 T5「PAT 是可选的」):
 * 发现层在 mock 下跑的仍然是真 GitHub、真检索、真规则、真台账,这是 003
 * 相对 001/002 的一个优势——它们的 mock 是回放固定样本,而这里只有措辞是假的。
 *
 * 带 `[mock]` 前缀,和 ai.ts / dossier.ts 的 mock 同款:这句话会落进 D1、
 * 印在第一屏上,不标出来的话,几个月后没人分得清它是模型写的还是假的。
 */
function mockOneLiner(r: GithubRepo): string {
	const shape = r.topics[0] ?? r.language ?? "开源项目";
	return `[mock] ${r.fullName.split("/")[1]},${shape} 方向,${r.description ? "仓库写了简介" : "仓库没写简介"}`;
}

/**
 * 模型返回的那个 JSON 对象 → fullName → 一句话。**导出是为了能单测**:
 * 下面那个 fetchOneLiners 要真的调模型,而这里的两条规矩都是纯字符串逻辑。
 *
 * 规矩一:键对不上就留空。少一句话是「没问出来」,页面上有专门的降级文案。
 *
 * 规矩二(2026-09-01 阶段 4/5 评审):**模型把键写成裸仓名时的兜底,只在这一批
 * 里裸名唯一时才启用。**模型按裸名返回正是这条兜底存在的前提,而
 * `A/youtube_summarizer` 和 `B/youtube_summarizer` 同时进这一批,在「长视频总结」
 * 这种领域里毫不稀奇 —— 那时两个候选会拿到**同一句**描述,其中一句必然挂在错的
 * 仓上。宁可两个都留空:少一句话是可见的降级,挂错了是这一屏唯一一处模型产出
 * 在骗人,而且看不出来。
 */
export function assignOneLiners(repos: GithubRepo[], parsed: Record<string, unknown>): Map<string, string> {
	const out = new Map<string, string>();
	/** 裸仓名 → 这一批里有几个仓叫这个名字。 */
	const bareCount = new Map<string, number>();
	for (const r of repos) {
		const bare = r.fullName.split("/")[1] ?? "";
		bareCount.set(bare, (bareCount.get(bare) ?? 0) + 1);
	}
	for (const r of repos) {
		const v = parsed[r.fullName];
		const bare = r.fullName.split("/")[1] ?? "";
		const alt = bareCount.get(bare) === 1 ? parsed[bare] : undefined;
		const text = typeof v === "string" ? v : typeof alt === "string" ? alt : "";
		const clean = text.replace(/\s+/g, " ").trim().slice(0, 120);
		if (clean) out.set(r.fullName, clean);
	}
	return out;
}

/**
 * 给这一批(≤5 个)仓拿一句话形态描述。**失败不影响清单**——返回空表,
 * one_liner 落 null,页面上少一句话而已。
 *
 * 为什么不让它失败就整趟失败:这一层唯一的模型调用挂在这里,而清单本身
 * 完全由 GitHub 的真实返回和纯函数规则决定。让一句可有可无的描述有权毁掉
 * 一整周的发现结果,等于把 003 最不可靠的那一环放在了承重位上。
 */
async function fetchOneLiners(
	env: AppEnv,
	email: string,
	repos: GithubRepo[],
	signal: AbortSignal,
): Promise<Map<string, string>> {
	const out = new Map<string, string>();
	if (repos.length === 0) return out;
	try {
		const base = fastAiConfigFor(env, email);
		const cap = Number.parseInt(base.maxOutputTokens ?? "", 10);
		const cfg = {
			...base,
			maxOutputTokens: String(Number.isFinite(cap) && cap >= ONE_LINER_TOKEN_FLOOR ? cap : ONE_LINER_TOKEN_FLOOR),
		};
		if (resolveProvider(cfg) === "mock") {
			for (const r of repos) out.set(r.fullName, mockOneLiner(r));
			return out;
		}
		const res = await complete(cfg, {
			prompt: oneLinerPrompt(repos),
			system: ONE_LINER_SYSTEM,
			json: true,
			// 形态描述不需要 thinking(docs/02 决策 T7):它是复述不是推理,
			// 而 thinking 在这里要吃输出预算和几十秒,端点已经在等 GitHub 了。
			reasoning: "none",
			signal,
		});
		for (const [k, v] of assignOneLiners(repos, JSON.parse(res.text) as Record<string, unknown>)) out.set(k, v);
	} catch (err) {
		// AiConfigError 的报文是写给站长的英文配置报文,不能进用户可见的地方;
		// 这里本来就只进日志,原样记全(dossier.ts aiFailure 同款立场)。
		const why = err instanceof AiConfigError || err instanceof AiError ? err.message : String(err);
		console.error("scan: one-liner 调用失败,候选清单照常出,只是少一句描述 —", why);
	}
	return out;
}

// ---------------------------------------------------------------------------
// 一趟周扫
// ---------------------------------------------------------------------------

export interface RunScanDeps {
	env: AppEnv;
	email: string;
	dossier: Dossier;
	/** 注入是为了测试能钉住 weekOf(跨年那一周的边界),生产传 Date.now()。 */
	now?: number;
	/**
	 * 整趟 cron 共用的额度状态(阶段 8)。不传 = 这一趟自己一份(交互路径就该这样)。
	 *
	 * cron 串行给 N 个用户各跑一趟,每趟各建一个 GithubClient;不把额度状态传下去,
	 * 每个用户开头的 remaining 都是 null,throttle() 直接放行,退避跨用户等于没写
	 * (github.ts GithubClientOptions.rateState 有完整论证)。
	 */
	rateState?: RateState;
}

export interface RunScanOutcome {
	scan: WeeklyScan;
	candidates: ScanCandidate[];
	exclusions: ScanExclusion[];
	honesty: ScanHonesty;
	/** 这一趟对「上次在这一周申诉过的仓」做了什么(见 types.ts RunScanResponse.appeals)。 */
	appeals: RunScanResponse["appeals"];
	trace: RunScanResponse["trace"];
	rate: RunScanResponse["rate"];
	// 提前收工的原因在 `scan.stopped` 里(它落库了)。**这里不再另放一份**:
	// 同一件事有两个出处,迟早只有一个是对的 —— 阶段 4 的那一份就只挂在 POST
	// 响应上,刷新一次警示就没了,而清单还是残的。
}

/**
 * 门 1 连续吃到几次 GitHub 侧错误就收工。
 *
 * 为什么是「连续」而不是「累计」:单个仓偶发一次 5xx 是 GitHub 的日常,为它
 * 停掉整周太脆;而**连着三个仓都 5xx** 只有一种解释——不是这几个仓的问题。
 * 3 这个数字是拍的,但它要挡的东西很具体:一次 `GET /repos` 全线 503 的事故里,
 * 旧代码会把 240 个幸存者一个一个试过去,最后写下 `fetchFailed: 240`。
 */
const GATE_ERROR_STREAK = 3;

/**
 * 门 1 抓一个仓时抛出来的这个错,是不是「整趟该停了」?
 *
 * 2026-09-01 阶段 4/5 评审的第二个 bug:原来这里是一个光秃秃的 catch,把
 * **所有**异常(5xx、403 限流、AbortError、RateBudgetError)都记成 `fetchFailed += 1`
 * ——也就是记成「这个仓不存在」。实测把假 GitHub 的 `GET /repos` 全改成 503,
 * 拿到的是一份 **HTTP 200 的「这周什么都没有」**:
 *
 *   status 200
 *   台账 { returned: 9, admitted: 0, excluded: 0, fetchFailed: 9 }
 *   stopped undefined   coreCalls 9
 *
 * 台账信誓旦旦说「9 个仓抓不通」,`stopped` 是空的,页面把「GitHub 全挂」渲染成
 * 一份正常的空结果。这正是 docs/01 风险 1「错得很安静」。
 *
 * 限流(403/429)单独拎出来立刻停,而不是等凑够 GATE_ERROR_STREAK:决策 T5 写得
 * 很清楚,**403 之后继续打会被 GitHub 拉进更长的惩罚窗口**,而那个桶是所有用户
 * 共用的。一个人手滑的代价会落在全站头上。
 *
 * @returns 非 null = 这趟停在这里,字符串是写进台账的原因;null = 只是这一个仓抓不通。
 */
function gateStopReason(err: unknown): string | null {
	// 「该不该停」这个判断只有一份(github.ts hardStopKind),这里只负责把类别
	// 翻成门 1 场景下的那句话。阶段 9 的复查(cron.ts)问的是同一个问题、用的是
	// 同一个判据,但说的是另一句话。
	switch (hardStopKind(err)) {
		case "budget":
			return (err as RateBudgetError).message;
		case "ratelimit":
			return `门 1 撞上 GitHub 限流(HTTP ${(err as GithubError).status}),这一趟停在这里 —— 继续打只会换来更长的惩罚窗口`;
		case "aborted":
			// 整趟的预算信号响了。**不含**单发请求自己的 12 秒超时:那一发超时只
			// 说明这一个仓抓不通,下一个仓完全可能正常,按普通失败走
			// GATE_ERROR_STREAK 那条线。
			return `这一趟的预算用完了(${(err as Error).message})`;
		default:
			return null;
	}
}

/**
 * 一次周扫的申诉恢复结果。`moved` 是给台账用的,`restored` / `missing` 是给人看的。
 */
export interface AppealRestore {
	/** 这一趟真的从排除搬进候选的条数(台账要拿它做 admitted +N / excluded -N)。 */
	moved: number;
	/** 搬回来的、以及本来就还在清单上的仓名。 */
	restored: string[];
	/** **没搬回来的**。理由写在 types.ts RunScanResponse.appeals 上。 */
	missing: string[];
	/** 搬回来的那几个仓的实况,拿去一起问 one-liner(顺带,不多花一次调用)。 */
	movedRepos: GithubRepo[];
}

/**
 * 重跑之后,把这一周申诉过的仓重新搬进候选清单。
 *
 * ## 它修的是什么
 *
 * `putWeeklyScan` 第一件事就是 `DELETE FROM scan_candidate/scan_exclusion WHERE
 * scan_id = ?`,而 scan_id 是 (档案, 周) 算出来的 —— 同一周必然撞上。用户申诉过
 * 三个仓(每个花掉一次 `ai` 额度 + 一次 GitHub 调用),点一下「现在重跑这一周」,
 * 「你捞回来的」那一节连同三行候选一起消失。**而台账是重新算的,所以四个数照样
 * 自洽,没有一处会报错,页面看起来完全正常** —— 这是这个产品最怕的那种错。
 * 更难受的是台账对不上时页面给的提示原文就是「请把这一周重跑一次」。
 *
 * ## 恢复不了的那些,以及为什么不硬恢复
 *
 * 只有**这一趟又搜到了它、而且它又被规则筛掉**的仓才搬得回来。这一趟压根没搜到
 * 它(排名掉出 search 的 1000 条上限、检索词改过、这一趟提前收工),就不搬:
 * 它不在 `returned` 里,凭空加进 `admitted` 会让台账那条划分等式
 * `returned = admitted + excluded + fetchFailed` 说谎,而那句诚实声明是这个产品
 * 对「残缺但看起来完整」唯一的正面回应。**不搬,但要说出来**(`missing` 上响应、
 * 进日志),而 `scan_appeal` 那一行留着 —— 下一次搜到它的重跑会自动把它搬回来。
 *
 * ## 门 1 照旧
 *
 * 每个要搬的仓都真的打一次 `GET /repos`。理由是 0001_init.sql 写死的表不变量:
 * 「scan_candidate 每一行都是真的 GET /repos 拿到 200 的」。拿 search 索引里那份
 * 凑数会让一个昨天刚删掉的仓靠一条一周前的申诉记录重新出现在清单上,而索引里
 * 它还活着。抓不通 → 记 `missing`,不硬塞。
 *
 * **规则层故意不重跑**:申诉的全部意思就是「我知道它被规则筛了,我还是要它」
 * (同 POST /api/scan/appeal 的立场)。
 *
 * 限流/预算撞上时**当场停**,剩下的一律记 missing(判据走 hardStopKind,和门 1、
 * 和复查共用同一份)—— 继续打只会换来更长的惩罚窗口,而那个桶是全站共用的。
 *
 * `candidates` / `exclusions` **就地改**:调用点在 putWeeklyScan 之前,改的是还没
 * 落库的那两个数组。回执里的 `moved` 是台账要减的那个数。
 */
export async function restoreAppeals(
	client: Pick<GithubClient, "getRepo">,
	appeals: ReadonlyMap<string, number>,
	candidates: NewScanCandidate[],
	exclusions: NewScanExclusion[],
): Promise<AppealRestore> {
	const out: AppealRestore = { moved: 0, restored: [], missing: [], movedRepos: [] };
	if (appeals.size === 0) return out;

	const listed = new Set(candidates.map((c) => c.fullName));
	// 名字 → 这一趟排除清单里的下标。就地盖 appealedAt 要用它。
	const excludedAt = new Map(exclusions.map((e, i) => [e.fullName, i]));
	/** 非 null 之后一律记 missing 并带同一个理由(不静默跳过,同复查那条立场)。 */
	let stopped: string | null = null;

	for (const [fullName, at] of appeals) {
		// 这一趟它凭实力进了清单:什么都不用做,但它确实还在,算恢复。
		if (listed.has(fullName)) {
			out.restored.push(fullName);
			continue;
		}
		const idx = excludedAt.get(fullName);
		if (idx === undefined) {
			// 这一趟根本没搜到它。硬搬会让台账说谎(见函数头)。
			out.missing.push(fullName);
			console.error(`scan: 申诉过的 ${fullName} 这一趟没搜到,没能搬回清单(scan_appeal 里那一行留着,下次搜到就会恢复)`);
			continue;
		}
		if (stopped) {
			out.missing.push(fullName);
			continue;
		}
		let fresh: GithubRepo | null = null;
		try {
			fresh = await client.getRepo(fullName);
		} catch (err) {
			const hard = gateStopReason(err);
			if (hard) stopped = hard;
			out.missing.push(fullName);
			console.error(`scan: 恢复申诉时抓 ${fullName} 出错${hard ? `,剩下的不再试(${hard})` : ""}`, err);
			continue;
		}
		if (!fresh) {
			// 404/410/451:它真的不在了。这正是门 1 要挡的东西 —— 一条一周前的
			// 申诉记录不该让一个已经没了的仓重新出现在清单上。
			out.missing.push(fullName);
			console.error(`scan: 申诉过的 ${fullName} 现在 GitHub 上抓不到(删了/改名/下架),没能搬回清单`);
			continue;
		}
		exclusions[idx] = { ...exclusions[idx]!, appealedAt: at };
		candidates.push({
			fullName: fresh.fullName,
			stars: fresh.stars,
			pushedAt: fresh.pushedAt,
			archived: fresh.archived,
			license: fresh.license,
			repoCreatedAt: fresh.createdAt,
			oneLiner: null, // 下面那次批量调用填
			topics: fresh.topics,
			// 不是搜出来的(同 POST /api/scan/appeal:排除行没落 route,填另外
			// 三个值里的任何一个都是在库里写一件我们不知道的事)。
			sourceRoute: "appealed",
			rank: candidates.length + 1,
		});
		out.moved += 1;
		out.restored.push(fullName);
		out.movedRepos.push(fresh);
	}
	if (out.restored.length + out.missing.length > 0) {
		console.log(`scan: 上次的申诉 —— 恢复 ${out.restored.length} 个(其中搬回 ${out.moved} 个),没恢复 ${out.missing.length} 个`);
	}
	return out;
}

/**
 * 跑一趟并落库。**阶段 8 的 cron 直接复用这个函数**,所以它不认识 Hono 的
 * Context——闸门、配额、HTTP 状态码全在路由那一层。
 *
 * 台账四个数的口径,以及它们为什么必须对得上:
 *
 *   returned      双路 search 合并**去重后**的仓数(不是 12 次请求返回的条数
 *                 之和 —— 那个数会把同一个仓数十几遍,分母虚高)
 *   excluded      规则筛掉的 + 通过规则但排在 5 名之外的 + **提前收工时没轮到验证的**
 *   admitted      真的进了清单的(算法挑 ≤5,申诉能让它更多,且每一个都过了门 1)
 *   fetchFailed   门 1 试过但没过的(GET /repos 拿不到 200)
 *
 * **等式是一个划分,不是三个独立的计数器。**每一个 returned 进来的仓恰好落进
 * 一栏,所以「提前收工」这件事不能让谁凭空消失:门 1 走到一半停下时,剩下那些
 * 既没进清单、也没被规则排除、更没被抓过 —— 它们进 excluded,理由是一句诚实的
 * 「这一趟提前收工了,没轮到验证它」(kind = not-reached,和 ranked-out 分开:
 * 后者说的是「它排第 9,而每周只挑 5 个」,那是一句完整的解释;前者的真相是
 * 「我根本没走到它」)。
 *
 * **returned = admitted + excluded + fetchFailed,一个不多一个不少。**这不是
 * 洁癖:诚实声明那句话的字面意思就是「拿回 M 个,筛掉 K 个,剩下 5 个」,
 * 三个数对不上的话那句话就是假的,而它恰恰是这个产品对「残缺但看起来完整」
 * 唯一的正面回应。下面有一句 console.error 把对不上的情况记出来(不抛错:
 * 台账略有出入不该让用户什么都看不到),scan.test.ts 里有用例钉着它相等。
 *
 * **四个数全部由代码统计,模型永远不接触**——沿用 001 types.ts 那条家法:
 * computed in code, never written by the model。模型在这一趟里只被问过一次
 * 「这几个仓分别是什么形状」,连仓的名字都是我们给它的。
 */
export async function runWeeklyScan(deps: RunScanDeps): Promise<RunScanOutcome> {
	const { env, email, dossier } = deps;
	const now = deps.now ?? Date.now();
	// 提到最前面(原来在台账那一段):下面「把申诉搬回来」那一步要拿它去
	// scan_appeal 里查这一周,而那一步必须发生在 putWeeklyScan 之前。
	const weekOf = isoWeek(now);
	const db = env.TEARDOWN_DB;
	const budget = scanBudgetMs(env);
	const signal = AbortSignal.timeout(budget);
	const client = new GithubClient({
		pat: env.GITHUB_PAT,
		apiBase: githubApiBase(env),
		// deadline 比信号早 5 秒收手:让「退避要睡过头」变成一条能写进台账的
		// stopped,而不是一个从 fetch 里抛出来的 AbortError。
		deadline: now + Math.max(1_000, budget - 5_000),
		signal,
		// cron 传的是整趟共用的那一份;交互路径不传,自己一份。
		...(deps.rateState ? { rateState: deps.rateState } : {}),
	});

	// ---- 召回:双路检索 ----
	const collected = await collectRepos(client, dossier.queries);
	const returned = collected.repos.length;

	// ---- 规则层:模型不接触的那部分 ----
	const survivors: DiscoveredRepo[] = [];
	const exclusions: NewScanExclusion[] = [];
	for (const d of collected.repos) {
		const hit = excludeReason(d.repo, now);
		if (hit) {
			exclusions.push({
				fullName: d.repo.fullName,
				reason: hit.reason,
				// kind 由**造理由的那个函数**给出,不是在这里认文案(见 types.ts
				// ExclusionKind)。第一屏按它分组,中文 reason 只负责显示。
				reasonKind: hit.kind,
				reasonSource: "rule",
				appealedAt: null,
				// 排除行也存 pushed_at(2026-09-01 上线前终审):候选一周只装 ≤5 个,
				// 一个开始停更的项目会先掉出清单,「停更断崖」那条将来的规则在最该
				// 抓到的那类项目上永远攒不出历史。数据就在手上,不多打一次 API。
				pushedAt: d.repo.pushedAt,
			});
		} else survivors.push(d);
	}

	// ---- 名次 + 门 1 ----
	const ranked = rankSurvivors(survivors);
	const candidates: NewScanCandidate[] = [];
	const admittedRepos: GithubRepo[] = [];
	let fetchFailed = 0;
	/** 门 1 自己的提前收工原因(限流 / 预算 / GitHub 连着挂)。 */
	let gateStopped: string | undefined;
	/** **连续**几次 GitHub 侧错误。抓通一个就清零 —— 偶发不该攒成一次收工。 */
	let gateErrors = 0;
	let cursor = 0;
	for (; cursor < ranked.length && candidates.length < SCAN_PICK_LIMIT; cursor++) {
		const d = ranked[cursor]!;
		let fresh: GithubRepo | null = null;
		try {
			// 门 1(docs/02「结构性防捏造」):必须真的拿到 200 才显示。
			//
			// 003 的召回本来就来自 Search 的真实返回、**模型不列举项目名**,
			// 所以这道门在这里更多是兜底而非主力防线——真正的防线是「模型不做
			// 回忆」这条架构选择本身(dossier.ts 的 DRAFT_SYSTEM 明写了不许写
			// 仓库名)。它兜的是另外几种情况:search 索引里还留着但仓已经删了
			// / 改名了 / 被 DMCA 下架了。
			fresh = await client.getRepo(d.repo.fullName);
			gateErrors = 0;
		} catch (err) {
			// **「这个仓不存在」和「GitHub 挂了 / 限流了 / 预算到了」必须分开。**
			// getRepo 很用心地把 404/410/451 回 null、5xx 抛错(github.ts 的注释
			// 写着「两件事必须分开」),而阶段 4 的这个 catch 把两者又拌回了一起。
			const stop = gateStopReason(err);
			if (stop) {
				// 限流 / 整趟预算:立刻收手。这个仓没被验证过,不计 fetchFailed,
				// 由下面那个循环连同它后面的一起记成 not-reached。
				console.error(`scan: 门 1 停在 ${d.repo.fullName} —— ${stop}`);
				gateStopped = stop;
				break;
			}
			// 剩下的是「这一发没打通」(5xx、单发超时、网络抖动)。这一个确实
			// 没过门 1,照旧计数;但连着 GATE_ERROR_STREAK 次就不是仓的问题了。
			console.error(`scan: 门 1 抓 ${d.repo.fullName} 出错`, err);
			fetchFailed += 1;
			gateErrors += 1;
			if (gateErrors >= GATE_ERROR_STREAK) {
				gateStopped = `门 1 连续 ${gateErrors} 次抓不通(GitHub 侧错误),剩下的仓一个都没验证过`;
				console.error(`scan: ${gateStopped}`);
				// 这个仓已经计进 fetchFailed 了,游标要跨过它,免得下面再记一次
				cursor += 1;
				break;
			}
			continue;
		}
		if (!fresh) {
			// 真的 404/410/451:仓删了 / 改名了 / 被 DMCA 下架了。**这一栏只装这个。**
			fetchFailed += 1;
			continue;
		}
		// **用 REST 返回的字段,不是 search 返回的**:search 走的是索引,可能
		// 落后几小时到几天,一个昨天刚归档的仓在索引里还是活的。规则也重跑一遍
		// ——两处判据必须来自同一份数据,否则清单上会出现一个理由说不通的仓。
		const hit = excludeReason(fresh, now);
		if (hit) {
			exclusions.push({
				fullName: fresh.fullName,
				reason: hit.reason,
				reasonKind: hit.kind,
				reasonSource: "rule",
				appealedAt: null,
				// REST 返回的那一份,不是 search 索引里的(同下面 candidates 的理由)
				pushedAt: fresh.pushedAt,
			});
			continue;
		}
		admittedRepos.push(fresh);
		candidates.push({
			fullName: fresh.fullName,
			stars: fresh.stars,
			pushedAt: fresh.pushedAt,
			archived: fresh.archived,
			license: fresh.license,
			repoCreatedAt: fresh.createdAt,
			oneLiner: null, // 下面那次调用填;失败就一直是 null
			// 决策 8 那条 topic 规则的原料(0001_init.sql 那一列的注释)。
			// **用 REST 返回的 topics**,和上面几个字段同一份数据。
			topics: fresh.topics,
			sourceRoute: d.route,
			rank: candidates.length + 1,
		});
	}
	// 游标之后的那些:通过了规则,只是没进清单。**每一条都要落一行**,
	// 因为「你没给我看的那些去哪了」正是这个产品要回答的问题。
	//
	// **这会让排除清单很长**(实测:8 条检索词 → 390 个仓 → 排除 ~385 行)。
	// 逐条写而不是记一个数字,是为了让 returned = admitted + excluded +
	// fetchFailed 这条等式在库里也成立——诚实声明说「拿回 390 个、筛掉 385 个、
	// 剩下 5 个」,而读者点开排除清单时,那 385 条必须真的在那儿。记成一个
	// 数字就等于让分母有据、分子无据,那正是这句话想反对的东西。
	//
	// **两种理由,取决于这一趟是怎么停的**(2026-09-01 阶段 4/5 评审):
	//   正常跑完 → ranked-out:「它排第 9,而每周只挑 5 个」,一句完整的解释;
	//   提前收工 → not-reached:「我根本没走到它」。
	// 写成同一句是在撒谎——一份只列出 3 行的清单配着一句「每周只挑 5 个」,
	// 读者无从知道差额在哪。
	for (let i = cursor; i < ranked.length; i++) {
		exclusions.push({
			fullName: ranked[i]!.repo.fullName,
			reason: gateStopped ? notReachedReason(i + 1, ranked.length, gateStopped) : rankedOutReason(i + 1, ranked.length),
			reasonKind: gateStopped ? "not-reached" : "ranked-out",
			reasonSource: "rule",
			appealedAt: null,
			pushedAt: ranked[i]!.repo.pushedAt,
		});
	}

	// ---- 把这一周申诉过的仓搬回来(2026-09-01 上线前终审的 A2)----
	//
	// **放在 one-liner 之前**:搬回来的仓也该有一句形态描述,而这一批是一次
	// 调用问完的(多一个成员不多一次调用、不多一份钱)。放在后面就得为它们
	// 单独再问一次,或者让它们永远没有描述。
	const appeals = await restoreAppeals(client, await listScanAppeals(db, dossier.id, weekOf), candidates, exclusions);
	for (const repo of appeals.movedRepos) admittedRepos.push(repo);

	// ---- 唯一一次模型调用 ----
	const oneLiners = await fetchOneLiners(env, email, admittedRepos, signal);
	for (const c of candidates) c.oneLiner = oneLiners.get(c.fullName) ?? null;

	// ---- 台账 ----
	/** 真的拿回了结果的那几路(没有 error)。诚实声明的 queryCount / routeCount 只数它们。 */
	const doneTraces = collected.trace.filter((t) => !t.error);
	// **搬回来的那几个仓不再计进 excluded**(口径抄 store.ts appealExclusion:
	// admitted +1、excluded -1、returned 不动)。排除行本身留着——「你把一个没有
	// 许可证的仓捞进来了」正是申诉这个动作最该留下的痕迹,只是它不再被数进
	// excluded,否则同一个仓会在划分里占两格,而那句诚实声明的两个数就都是假的。
	const excludedCount = exclusions.length - appeals.moved;
	if (returned !== candidates.length + excludedCount + fetchFailed) {
		// 不抛错:台账对不上时让用户看到清单,比让他什么都看不到强。但必须响。
		console.error(
			`scan: 台账对不上 —— returned=${returned} admitted=${candidates.length} ` +
				`excluded=${excludedCount} fetchFailed=${fetchFailed}`,
		);
	}
	// NewWeeklyScan(= 不带 id)是 putWeeklyScan 的入参类型:id 由它按
	// (dossierId, weekOf) 算出来,调用方**给不了**——store.ts 用类型把
	// 「第二条造 id 的路径」堵死了,这里照着来,不自己拼一个再传进去。
	const newScan = {
		dossierId: dossier.id,
		weekOf,
		dossierRev: dossier.rev,
		// **真的跑通的那几条**,不是 dossier.queries(2026-09-01 阶段 4/5 评审)。
		// 退避提前收工时两者不一样,而 0001_init.sql 那一列的注释、诚实声明那句
		// 「我用 N 条查询去取」说的都是实际发生的事。写档案里的条数就是在说一件
		// 没发生过的事——而且这不是边角:匿名档下每个用户手动触发都会残缺(8 条
		// 词要等 112 秒,SCAN_BUDGET_MS 默认 75 秒)。
		//
		// **只数没出错的那些路**:一条 RateBudgetError 的路根本没发出去(throttle
		// 在 fetch 之前就抛了),一条 422 的路发出去了但一个仓都没带回来。两种都
		// 没有为 `returned` 贡献任何东西,数进去就是在虚报覆盖面。出错的那几路
		// 一条不少地留在 trace 里(第 03 节整表列出),外加一句 stopped。
		//
		// 用 Set 去重并**保持首次出现的顺序**:一条词发两路,trace 里有两行。
		queries: [...new Set(doneTraces.map((t) => t.query))],
		returned,
		admitted: candidates.length,
		excluded: excludedCount,
		fetchFailed,
		routeCount: new Set(doneTraces.map((t) => t.sort)).size,
		// 各条词 total_count 的**最大值**,不是求和(理由见 honestyOf)。
		claimedTotal: collected.trace.reduce((m, t) => Math.max(m, t.totalCount), 0),
		// 两个阶段都可能提前收工:召回那一段(额度不够)和门 1 那一段(限流 /
		// GitHub 挂了)。两句都要说 —— 只说一句会让读者以为另一段是完整的。
		stopped: [collected.stopped, gateStopped].filter(Boolean).join(";") || null,
		createdAt: now,
	};
	const scanId = await putWeeklyScan(db, newScan, candidates, exclusions);
	const scan: WeeklyScan = { id: scanId, ...newScan };

	// 「你捞回来的」那枚徽记 + 当初的排除理由。**规则和 getWeeklyScan 的 join 一模
	// 一样**(申诉过的仓同时出现在两张表里,理由记在排除行上)。
	//
	// 原来这里写的是「appealedFrom 恒为 null:这条路上的候选全是算法挑的」——
	// 加了「重跑恢复申诉」之后那句话不再成立,而它一旦不成立,症状就是**重跑之后
	// 那一行还在、徽记却没了**,看起来像「系统把我捞回来的东西降级成了普通候选」。
	// 刷新一次(走 GET)它又会回来,这种「同一份数据两条路径长得不一样」正是
	// 阶段 4/5 评审必须修 3 那个 bug 的形状。
	const appealedFrom = new Map(
		exclusions.filter((e) => e.appealedAt !== null).map((e) => [e.fullName, e.reason] as const),
	);
	return {
		scan,
		candidates: candidates.map((c) => ({ ...c, scanId, appealedFrom: appealedFrom.get(c.fullName) ?? null })),
		exclusions: exclusions.map((e) => ({ ...e, scanId })),
		// 这一趟对上次的申诉做了什么(见 types.ts RunScanResponse.appeals)。
		appeals: { restored: appeals.restored, missing: appeals.missing },
		// **和 GET 那一路调的是同一个函数、喂的是同一个 scan 对象**,所以两条
		// 路径印出来的那句诚实声明在结构上不可能不一样(见 honestyOf)。
		honesty: honestyOf(scan),
		trace: collected.trace,
		rate: {
			authenticated: client.rate.authenticated,
			searchCalls: client.calls.search,
			coreCalls: client.calls.core,
			searchRemaining: client.rate.search.remaining,
			coreRemaining: client.rate.core.remaining,
			waitedMs: client.waitedMs,
		},
	};
}

/**
 * 诚实声明那句话要的数字(docs/02「诚实声明的措辞」)。
 *
 * **入参只有台账一个,没有 trace**(2026-09-01 阶段 4/5 评审改的)。原来它接
 * 一个可选的 trace,于是同一周有两种算法:刚跑完那次用 trace 算出诚实的
 * 「7 条查询、claimedTotal 81234」,刷新之后没有 trace,退回「档案里 8 条、
 * claimedTotal 0」,而 stopped 干脆消失了——同一份数据,两条路径,三个数不一样,
 * 页面把一份残缺扫描渲染成了正常结果。
 *
 * 修法不是「让 GET 也想办法凑出 trace」,是**把只有『刚跑完』才知道的那几个数
 * 落库**(queries 写实际发出的、route_count、claimed_total、stopped)。于是这个
 * 函数退化成一次字段搬运:没有分支,就没有两条路径分叉的余地。
 *
 * `claimedTotal` 取各条检索词 total_count 的**最大值**而不是求和:同一个领域
 * 的几条词高度重叠,求和会得出一个比 GitHub 上真实存在的仓还大的数,而这句话
 * 是用来说「我给你看的只是九牛一毛」的,分母虚报会把诚实变成表演。
 */
export function honestyOf(scan: WeeklyScan): ScanHonesty {
	return {
		searchCap: SEARCH_RESULT_CAP,
		queryCount: scan.queries.length,
		routeCount: scan.routeCount,
		returned: scan.returned,
		excluded: scan.excluded,
		admitted: scan.admitted,
		fetchFailed: scan.fetchFailed,
		claimedTotal: scan.claimedTotal,
	};
}

// ---------------------------------------------------------------------------
// 路由
// ---------------------------------------------------------------------------

export const scanRoutes = new Hono<Guarded>();

/** 还没有档案就没有检索词,而检索词是召回的全部入口(docs/01 决策 3)。 */
const NO_DOSSIER_MSG = "还没有档案,先建一份。";

/**
 * 手动跑一次周扫。cron 是阶段 8,那一路复用 runWeeklyScan,不复用这个 handler
 * (它认 Hono 的 Context,而 cron 没有请求)。
 *
 * **闸:userAiGuard + reserveOrDeny(c, "ai")。** 这一趟会打几十个 GitHub 请求
 * (12 次 search + 最多 8 次 REST)加一次 flash 调用,不设闸的话一个人按住
 * 刷新就能把账号级的 search 共享桶抽干,而那个桶是**所有用户共用**的
 * (docs/02 决策 T5)——一个人手滑,全站当周的周扫一起挂。
 *
 * **不过花费闸**(estUsd 传默认 0):一次 flash 调用约 $0.002,GitHub 不要钱。
 * 每趟都去 daily_spend 占位只会让它变成一张高频写入表,而它拦不住任何东西
 * ——要 1500 趟才凑够 $3,而 ai 30 次/天的闸在第 30 趟就满了。理由原文在
 * guard.ts reserveOrDeny 的函数头。
 */
scanRoutes.post("/api/scan", userAiGuard, async (c) => {
	const email = c.get("email");
	const dossier = await getDossier(c.env.TEARDOWN_DB, email);
	// 档案检查在占位**之前**:没有档案是一次注定跑不动的请求,不该扣额度
	// (dossier.ts 的空句子 400 同款位置,那条评审 ⑤ 说的就是这个顺序)。
	if (!dossier) return c.json({ error: NO_DOSSIER_MSG }, 400);

	const denied = await reserveOrDeny(c, "ai");
	if (denied) return denied;

	try {
		const out = await runWeeklyScan({ env: c.env, email, dossier });
		const body: RunScanResponse = {
			scan: out.scan,
			candidates: out.candidates,
			exclusions: out.exclusions,
			honesty: out.honesty,
			trace: out.trace,
			rate: out.rate,
			// **重跑会保留申诉**(2026-09-01 上线前终审的 A2),但不是每一条都
			// 保得住 —— 这个回执把「哪几条搬回来了、哪几条没搬回来」摆到页面上,
			// 而不是让用户自己发现少了一行。
			appeals: out.appeals,
		};
		return c.json(body);
	} catch (err) {
		// 到这里只剩「整趟都没跑起来」:GitHub 全挂、D1 写失败、预算耗尽在
		// batch 之前。额度已经在 reserveOrDeny 那步真花掉了,文案要说出来
		// (dossier.ts DRAFT_TIMEOUT_MSG 同款立场:不说的话用户会连点五次)。
		console.error("scan: 整趟失败", err);
		return c.json(
			{ error: "这次周扫没跑起来(GitHub 或数据库暂时不通)。这一次已经计入今天的额度,过几分钟再试一次。" },
			502,
		);
	}
});

/** `?weekOf=` 形状不对时的文案。不直接拿它去查库——脏串进 SQL 没有意义。 */
const BAD_WEEK_MSG = "weekOf 的格式应该是 2026-W36 这样。";

/**
 * 取某一周的结果。不传 weekOf 取**最近一周**(按 week_of 倒序,不是 created_at
 * ——补跑的那一周 created_at 是补跑当天,拿它排序会把上上周排到最新)。
 *
 * 没有那一周时回 `{ scan: null }` + 200,不是 404:前端要拿它区分「这个人
 * 还没跑过周扫,该显示那个『跑一次』按钮」和「出错了,该显示错误」,而 404
 * 两种都像(GET /api/dossier 同款理由)。
 *
 * ## ⚠ 不传 `weekOf` 时,它和 `GET /api/scan/changes` 指的**可能不是同一周**
 *
 * 这一条取的是「最近一次**周扫**」(`weekly_scan`),`GET /api/scan/changes`
 * 取的是「最近一条**跨周记录**」(`weekly_change`)。两者可以不同,而且不是理论上
 * 的:一周有周扫、但那一周跑在跨周落库上线之前(或者那一次 cron 在 diff 之前就
 * 挂了),它就有周扫没有跨周记录 —— 那一周就是活样本。
 *
 * 后果:两条都不传 `weekOf` 的话,页面会把 **A 周的结论**和 **B 周的清单**并排
 * 摆着,**不报错,只是说的不是同一件事**。这正是这个产品反复在防的那种错。
 *
 * **调用方二选一,没有第三条路**:要么两条都显式带同一个 `weekOf`(网页就是这么
 * 做的 —— `App.tsx` 的 `loadWeek` 先读 history 定出那一周,再并发打两条,两条都
 * 带上它),要么明确接受这个不一致。**将来的门铃邮件直链 `?view=changes` 是第一个
 * 会踩到它的地方**:那条链接不带周次,页面拿默认值去取,两条端点各自"最近"一次。
 *
 * 为什么不干脆把两边的默认统一成一个:那要么让这一条去查 `weekly_change`
 * (于是「看这一周的清单」被一张跨周表决定,而清单本来和跨周无关),要么让那一条
 * 回一份「这一周没有跨周记录」的 200 + null(它已经是这么回的了)。真正的修法是
 * 调用方别吃默认值,所以这里把代价写在门口,而不是在两条端点之间造一条隐式耦合。
 */
scanRoutes.get("/api/scan", userGuard, async (c) => {
	const db = c.env.TEARDOWN_DB;
	const empty: GetScanResponse = { scan: null, candidates: [], exclusions: [], honesty: null };

	// **形状校验排在取档案之前**(2026-09-01 冻结前最后一轮)。原来它排在
	// `getDossier` 的早退之后,于是 `?weekOf=nope` 在**没有档案**时回 200、有档案时
	// 回 400 —— 一道「有时候才检查」的门。它不咬人(脏串反正没被拿去查库),但一道
	// 时灵时不灵的校验会让调用方按运气总结规律,而那种规律迟早在另一条路上失效。
	const asked = c.req.query("weekOf")?.trim();
	if (asked && !WEEK_OF_RE.test(asked)) return c.json({ error: BAD_WEEK_MSG }, 400);

	const dossier = await getDossier(db, c.get("email"));
	if (!dossier) return c.json(empty);

	let weekOf = asked;
	if (!weekOf) {
		const recent = await listRecentScans(db, dossier.id, 1);
		if (recent.length === 0) return c.json(empty);
		weekOf = recent[0]!.weekOf;
	}

	// **只有显式带了 `weekOf` 才算一次「翻」**(风险 4 的仪器,见 store.ts
	// recordWeekView)。不带 weekOf 的那一路是第一屏(清单屏)进屏时的默认加载,
	// 它和跨周一点关系都没有 —— 记进去就是往这份数据里灌噪声,而这份数据将来要
	// 回答的是一个"要不要把产品退回 skill 形态"的问题,噪声在那里的代价是把
	// 一个该退的结论说成不该退。跨周屏取那一周清单时**一定**带 weekOf
	// (App.tsx loadWeek),所以真正的「翻」一次都不会漏。
	if (asked) {
		await recordWeekView(db, {
			dossierId: dossier.id,
			weekOf: asked,
			surface: "scan",
			explicit: true,
			latestWeekOf: await latestScanWeek(db, dossier.id),
		});
	}

	const bundle = await getWeeklyScan(db, dossier.id, weekOf);
	if (!bundle) return c.json(empty);
	const body: GetScanResponse = {
		scan: bundle.scan,
		candidates: bundle.candidates,
		exclusions: bundle.exclusions,
		// 和 POST 那一路**同一个函数、同一份台账**:刷新之后那句诚实声明里的
		// 每一个数(包括被截断时诚实的 queryCount 和那句 stopped)一字不差。
		honesty: honestyOf(bundle.scan),
	};
	return c.json(body);
});

/**
 * 最近 N 周的台账,**只要台账不要明细**。
 *
 * 阶段 8 的跨周 diff(docs/01 决策 8:清单变了是因为你改了档案,还是这周真有
 * 新东西)要靠它取相邻两周;本阶段先把读取路径建好并验证,免得那一天同时
 * 调试 diff 逻辑和一条从没跑过的读路径。
 */
/**
 * **这一周和上一次比,变了什么**(2026-09-01 上线前终审,站长拍板)。
 *
 * 不传 `weekOf` 取最近一周(按 week_of 倒序,同 GET /api/scan)。
 *
 * ## 为什么这条端点必须存在
 *
 * 跨周状态是这个产品相对一个 Claude Code skill 的**全部存在理由**(docs/01
 * 「为什么不做成 skill」)。而在这条改动之前,跨周 diff 算完只进了一封
 * **可能发不出去的**邮件:SES 一个 403,那一周的候选换血和复查结论在库里
 * 一个字都没有,而认领行不删也不重试(阶段 8 的取舍),所以那封信永远不会补发。
 *
 * 连带后果更重:docs/01 风险 4 的判据是「如果站长从不去翻上一周的结果,就该
 * 退回 skill 形态」——**而产品里根本没有「翻上一周」这个动作可翻**。一条判据
 * 如果连执行都执行不了,它就不是判据。
 *
 * ## 200 + null 是什么意思
 *
 * `{ change: null }` = **这一周没有跨周记录**,不是「没有变化」。三种可能:
 * 还没跑过周扫、那一周跑在这条改动上线之前、或者那一行的明细坏了(store 层
 * 记了 error 日志并当它不存在)。「记了、没变化」是另一件事,那时 change 非 null
 * 而 `counts.changed === false`。回 200 不回 404 的理由同 GET /api/scan:
 * 前端要拿它区分「还没有」和「出错了」,而 404 两种都像。
 *
 * **前端不要自己再算一遍 diff**:这里回的就是邮件正文用的那一份(cron 算完
 * 落库,网页读同一行)。两边各算一遍就是同一件事有两个算法。
 *
 * ## ⚠ 不传 `weekOf` 时,它和 `GET /api/scan` 指的**可能不是同一周**
 *
 * 这一条取的是「最近一条**跨周记录**」(`weekly_change` 里 week_of 最大的那行),
 * `GET /api/scan` 取的是「最近一次**周扫**」(`weekly_scan`)。有周扫而没有跨周
 * 记录的那一周(跑在跨周落库上线之前,或者那趟 cron 在 diff 之前就挂了)就是
 * 两者分叉的活样本。
 *
 * 都不传的话,页面会把**这一条给的 A 周结论**和 **`GET /api/scan` 给的 B 周清单**
 * 并排摆着,不报错,只是说的不是同一件事。调用方要么两条都显式带同一个 `weekOf`
 * (网页的 `loadWeek` 就是这么做的),要么明确接受这个不一致。完整论证写在
 * `GET /api/scan` 的 docblock 里,两处是同一件事的两个入口,别只读一边。
 *
 * ## 每一次调用都会记一行 `week_view`
 *
 * 那是 docs/01 风险 4 的仪器(「如果站长从不去翻上一周的结果,就该退回 skill
 * 形态」),不上页面,只为第二个月的复盘。**首次自动加载也记**,理由见下面的
 * 行内注释。
 */
scanRoutes.get("/api/scan/changes", userGuard, async (c) => {
	const db = c.env.TEARDOWN_DB;
	const empty: GetScanChangesResponse = { change: null };

	// **形状校验排在取档案之前**(2026-09-01 冻结前最后一轮):原来它在
	// `getDossier` 的早退之后,于是 `?weekOf=nope` 在没有档案时回 200 而有档案时
	// 回 400。理由同 GET /api/scan 里那段注释 —— 一道「有时候才检查」的门。
	const asked = c.req.query("weekOf")?.trim();
	// 脏串不拿去查库(同 GET /api/scan)
	if (asked && !WEEK_OF_RE.test(asked)) return c.json({ error: BAD_WEEK_MSG }, 400);

	const dossier = await getDossier(db, c.get("email"));
	if (!dossier) return c.json(empty);

	const change = asked ? await getWeeklyChange(db, dossier.id, asked) : await latestWeeklyChange(db, dossier.id);

	// 记一次「翻」(风险 4 的仪器)。**这条端点只有跨周那一屏会打**,所以每一次
	// 调用都是一次真实的翻阅 —— 包括不带 weekOf 的那一次:他得点那个入口才到得了
	// 这一屏,这个动作确实发生了,记成 `explicit = 0` 而不是不记。判据要的分辨率
	// 由另外两列给:`week_of < latest_week_of` 才是「回头翻旧的」,而首次加载落到
	// 的是最新那一周,天然被归进「只看了本周」那一类,不会把判据灌成假阳性。
	//
	// **那一周没有记录也照记**(change 为 null):他翻了,只是那一周没东西。
	// 只在有内容时记的话,这份数据会答成「他从来没翻过」——把一次没找到东西的
	// 翻阅算成没翻过,恰好是这条判据最不能出的那种错。
	const latestWeekOf = await latestScanWeek(db, dossier.id);
	const viewed = asked ?? change?.weekOf ?? latestWeekOf;
	if (viewed) {
		await recordWeekView(db, {
			dossierId: dossier.id,
			weekOf: viewed,
			surface: "changes",
			explicit: Boolean(asked),
			latestWeekOf,
		});
	}
	return c.json({ change } satisfies GetScanChangesResponse);
});

scanRoutes.get("/api/scan/history", userGuard, async (c) => {
	const dossier = await getDossier(c.env.TEARDOWN_DB, c.get("email"));
	if (!dossier) return c.json({ scans: [] } satisfies ScanHistoryResponse);
	const raw = Number.parseInt(c.req.query("n") ?? "", 10);
	const n = Number.isFinite(raw) ? Math.min(HISTORY_MAX, Math.max(1, raw)) : HISTORY_DEFAULT;
	const scans = await listRecentScans(c.env.TEARDOWN_DB, dossier.id, n);
	return c.json({ scans } satisfies ScanHistoryResponse);
});

// ---------------------------------------------------------------------------
// 申诉:「这个该进来」(docs/01 决策 4)
// ---------------------------------------------------------------------------

/**
 * `fullName` 的形状。**这是一道安全门,不是格式洁癖。**
 *
 * 申诉是**第一个把用户输入送进 GitHub URL 路径的调用方**(GithubClient.getRepo
 * 之前一直只吃 GitHub 自己回的名字)。不校验的话 `a/b/../../users/x` 会被 URL
 * 规范化到另一个端点,`a/b?per_page=1` 能往查询串里塞参数——请求语义被别人
 * 改写了。github.ts 里还有一道逐段 encodeURIComponent 兜底,两道都留着:
 * 那一道防「将来第三个调用方忘了抄这条正则」,这一道让非法输入连 fetch 都不发。
 *
 * 故意比 GitHub 的真实规则还严一点(GitHub 的 owner/repo 就是这个字符集)。
 */
const APPEAL_NAME_RE = /^[A-Za-z0-9._-]+\/[A-Za-z0-9._-]+$/;

const APPEAL_BAD_BODY = "请求里要有 weekOf(2026-W36 这样)和 fullName(owner/repo)。";
const APPEAL_NOT_EXCLUDED = "这一周的排除清单里没有这个仓 —— 它要么已经在候选清单上,要么根本没被这周的检索捞到过。";
const APPEAL_GONE = "GitHub 上抓不到这个仓(删了 / 改名了 / 被下架了),所以捞不回来。这正是门 1 要挡的东西。";

/**
 * 强制把一条排除搬进候选清单,**只重跑受影响的那一点点**。
 *
 * 这一趟真正做的事,一件不多:
 *   1. `GET /repos/{owner}/{repo}` **一次**——门 1 照旧,抓不通就不许进清单。
 *      顺带把 star / license / 归档态刷新成此刻的真值,而不是沿用一周前的快照。
 *   2. 一次 flash 调用,只问这一个仓的形态描述。失败就留 null,清单照常。
 *   3. 一个 batch 的 D1 写(见 store.ts appealExclusion 的等式与幂等论证)。
 *
 * **整周的 16 路 GitHub 搜索一次都不重跑**(响应里的 `rerun.searchRerun` 是
 * 字面量 false,改成会重跑的实现编译不过)。理由:搜索是这条链上唯一贵的东西
 * ——匿名档 16 路要等 112 秒、还要占账号级共享桶,而申诉一个字都不会改变搜索
 * 的输入(档案没变、检索词没变),重跑只可能得到同一批仓外加一周的自然漂移,
 * 却把「这一周的清单」变成了另一周的清单。
 *
 * **它的边界(必须说清楚)**:申诉只影响**这一周这一份**清单。它不会写回档案、
 * 不会让下周自动放行同一个仓——下周照样按规则筛,照样被筛掉,照样要再点一次。
 * 「学会用户的口味」是另一件事(001 那条捞回回路),不在这个端点里。
 *
 * **闸**:userAiGuard + reserveOrDeny(c, "ai")。它确实要花一次模型调用。占位放在
 * 所有校验之后——没有档案 / 不在排除清单里 / 已经申诉过,这三种都是注定跑不动
 * 或者不用跑的请求,不该扣额度(同 POST /api/scan 的顺序)。
 */
scanRoutes.post("/api/scan/appeal", userAiGuard, async (c) => {
	const email = c.get("email");
	const db = c.env.TEARDOWN_DB;

	let body: unknown = null;
	try {
		body = await c.req.json();
	} catch {
		return c.json({ error: APPEAL_BAD_BODY }, 400);
	}
	const raw = (body ?? {}) as { weekOf?: unknown; fullName?: unknown };
	const weekOf = typeof raw.weekOf === "string" ? raw.weekOf.trim() : "";
	const fullName = typeof raw.fullName === "string" ? raw.fullName.trim() : "";
	if (!WEEK_OF_RE.test(weekOf)) return c.json({ error: BAD_WEEK_MSG }, 400);
	if (!APPEAL_NAME_RE.test(fullName)) return c.json({ error: APPEAL_BAD_BODY }, 400);

	const dossier = await getDossier(db, email);
	if (!dossier) return c.json({ error: NO_DOSSIER_MSG }, 400);

	// scanId 由**这个人自己的** dossier.id 算出来,所以拿别人的 weekOf 也只会
	// 查到自己那一周:越权在结构上不成立,不需要另写一道 owner 检查。
	const scanId = weeklyScanId(dossier.id, weekOf);
	const excl = await getScanExclusion(db, scanId, fullName);
	if (!excl) return c.json({ error: APPEAL_NOT_EXCLUDED }, 404);

	/** 读回整包 + 拼响应。申诉这条路没有 trace,honestyOf 退回台账里的 queries。 */
	const bundleBody = async (appealedName: string | null, rerun: AppealResponse["rerun"]): Promise<Response> => {
		const bundle = await getWeeklyScan(db, dossier.id, weekOf);
		if (!bundle) return c.json({ error: APPEAL_NOT_EXCLUDED }, 404);
		const out: AppealResponse = {
			scan: bundle.scan,
			candidates: bundle.candidates,
			exclusions: bundle.exclusions,
			honesty: honestyOf(bundle.scan),
			// 从**读回来的那一包**里挑,不是把刚才手上那份拼回去:名次是 SQL
			// 现算的,手上那份根本不知道它排第几。
			appealed: appealedName ? (bundle.candidates.find((x) => x.fullName === appealedName) ?? null) : null,
			rerun,
		};
		return c.json(out);
	};

	// 已经捞回过:一次网络都不发,一次额度都不扣,原样把当前这一包回给他。
	// (双击、刷新后再点一次,都会走到这里。)
	if (excl.appealedAt !== null) {
		return bundleBody(null, { repoFetched: false, oneLiner: false, searchRerun: false });
	}

	const denied = await reserveOrDeny(c, "ai");
	if (denied) return denied;

	const now = Date.now();
	// 预算比整周扫小得多:这里只有 1 次 REST + 1 次 flash,给 60 秒绰绰有余,
	// 而 CF 的 100 秒线还得留给响应本身。
	const signal = AbortSignal.timeout(60_000);
	const client = new GithubClient({
		pat: c.env.GITHUB_PAT,
		apiBase: githubApiBase(c.env),
		deadline: now + 25_000,
		signal,
	});

	let fresh: GithubRepo | null = null;
	try {
		// 门 1 照旧(docs/02「结构性防捏造」)。**规则层故意不重跑**——申诉的
		// 全部意思就是「我知道它被规则筛了,我还是要它」。门 1 拦的是另一件事:
		// 这个仓此刻还在不在。这两者不能混为一谈。
		fresh = await client.getRepo(fullName);
	} catch (err) {
		console.error(`scan/appeal: 抓 ${fullName} 出错`, err);
		return c.json({ error: "GitHub 这会儿不通,没能把这个仓捞回来。这一次已经计入今天的额度,过几分钟再试。" }, 502);
	}
	if (!fresh) return c.json({ error: APPEAL_GONE }, 404);

	// 只问这一个仓。**批量只有一个成员时,scan.ts 那个「键写成 repo 而不是
	// owner/repo」的兜底不可能张冠李戴**(候选就它一个,兜底再怎么错也只能
	// 落回它自己)。将来谁把这条路改成批量申诉,必须回来把兜底那一支去掉。
	const liners = await fetchOneLiners(c.env, email, [fresh], signal);
	const oneLiner = liners.get(fresh.fullName) ?? null;

	const candidate: Omit<NewScanCandidate, "rank"> = {
		fullName: fresh.fullName,
		stars: fresh.stars,
		pushedAt: fresh.pushedAt,
		archived: fresh.archived,
		license: fresh.license,
		repoCreatedAt: fresh.createdAt,
		oneLiner,
		// 决策 8 那条 topic 规则的原料。申诉进来的仓也要有,否则「这个 topic 连续
		// N 周进清单」在捞回来的那些仓上永远数不到(0001_init.sql topics 那一列)。
		topics: fresh.topics,
		// 不是搜出来的。排除行没落 route,填 stars/updated/both 里的任何一个都是
		// 在库里写一件我们不知道的事(types.ts SourceRoute 的注释)。
		sourceRoute: "appealed",
	};

	let moved = false;
	try {
		// 收 { dossierId, weekOf } 而不是拼好的 scanId:这一趟要写两张表,
		// scan_appeal 那张按 (档案, 周) 记账(store.ts appealExclusion 的注释)。
		moved = await appealExclusion(db, { dossierId: dossier.id, weekOf }, candidate, now);
	} catch (err) {
		console.error("scan/appeal: 落库失败", err);
		return c.json({ error: "数据库这会儿不通,没能把它记进这一周的清单。这一次已经计入今天的额度,过几分钟再试。" }, 502);
	}

	// moved=false 只可能是并发点了两下,后到的那趟。它没搬东西,就别报喜。
	return bundleBody(moved ? fullName : null, { repoFetched: true, oneLiner: oneLiner !== null, searchRerun: false });
});
