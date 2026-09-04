// 前后端共用的线上契约(wire types)。**只放类型和常量,不放逻辑。**
//
// 为什么不直接从 store.ts 复用 Dossier:store.ts 的签名里带 D1Database,
// 前端那个 tsconfig(tsconfig.app.json)没有 @cloudflare/workers-types,
// 从 react-app 里 import 它会解析不出 D1 的类型而整片飘红。所以这里另写一份
// **结构完全相同**的 Dossier,而两份不许分叉这件事不靠自觉——worker 侧的
// dossier.ts 顶部有一对双向 extends 断言钉着,任何一边加减字段都会在
// `npm run check` 里编译不过(见 dossier.ts 的 _WireMatchesStore)。
//
// 字段一律 camelCase;D1 里是 snake_case,两者的互转只发生在 store.ts 的
// map* 函数里,这一层和前端都看不见 snake_case。

/** 用户那份可见可改的关注定义。v1 每人一份。 */
export interface Dossier {
	id: string;
	userEmail: string;
	/** 用户原话。AI 永不改写,保存时也不许改(要换句子只能删档重建)。 */
	sentence: string;
	domain: string;
	caresAbout: string[];
	notCaresAbout: string[];
	/** 发给 GitHub Search 的检索词。用户可改,改完下次周扫就用新的。 */
	queries: string[];
	/** 服务端独占,客户端传什么都不算数(见 PutDossierRequest)。 */
	rev: number;
	createdAt: number;
	updatedAt: number;
}

/**
 * 档案里**会影响下一次周扫产出**的那四个字段。
 * 起草、保存、比对(要不要涨 rev)三处都只认这一组,不多不少。
 */
export interface DossierFields {
	domain: string;
	caresAbout: string[];
	notCaresAbout: string[];
	queries: string[];
}

/** POST /api/dossier/draft 的请求体。 */
export interface DraftRequest {
	sentence: string;
}

/**
 * POST /api/dossier/draft 的响应。**不落库**——用户看过、改过之后再 PUT。
 * sentence 原样回显,是为了让前端能当场证明「我没有改你的话」。
 */
export interface DraftResponse extends DossierFields {
	sentence: string;
}

/**
 * 删档确认框要在**按下之前**就知道会删掉多少东西,所以 counts 挂在
 * GET /api/dossier 上,而不是等 DELETE 回来才说(那时候已经删完了)。
 * 没有档案时全 0。
 */
export interface DossierCounts {
	scans: number;
	reports: number;
}

/** GET /api/dossier 的响应。没有档案时 dossier 为 null(200,不是 404)。 */
export interface GetDossierResponse {
	dossier: Dossier | null;
	counts: DossierCounts;
}

/**
 * PUT /api/dossier 的请求体。**故意没有 rev**:客户端带回旧 rev 会让版本号
 * 倒退,而 weekly_scan.dossier_rev 一旦在内容不同的两版档案上重复,
 * 「清单变了是因为你改了档案,还是这周真有新东西」这个归因就会安静地答错。
 * 多传的 rev 会被服务端忽略(不是报错),前端不必费劲把它摘掉。
 */
export interface PutDossierRequest extends DossierFields {
	sentence: string;
}

/**
 * PUT /api/dossier 的响应。revBumped 为 true 时前端提示「档案已更新到 vN,
 * 下次周扫会用新版本」;为 false 说明这次编辑没碰到那四个字段(比如只调了
 * 顺序),周扫的结果不会因此改变,也就不该让用户以为改变了。
 */
export interface PutDossierResponse {
	dossier: Dossier;
	revBumped: boolean;
}

/**
 * DELETE /api/dossier 的响应。deleted 里是**顺手清掉的孤儿行数**:
 * schema 没有外键,删档案不连带删周扫和报告的话,它们会永远留在库里
 * 且没有任何代码路径读得到。数字回给前端是为了让「删掉重来」这个动作
 * 有一个可见的后果,而不是一句轻飘飘的 ok。
 */
export interface DeleteDossierResponse {
	ok: true;
	deleted: { scans: number; reports: number };
}

// ---------------------------------------------------------------------------
// 阶段 4 · 周扫(发现层)
// ---------------------------------------------------------------------------

/**
 * 双路检索里这个仓是哪条路捞到的(docs/02 决策 T3)。台账分栏依据。
 *
 * `"appealed"` 不是一条检索路,是「**这个仓不是搜出来的,是你自己捞回来的**」
 * (POST /api/scan/appeal)。它必须在这个联合里,因为申诉那条路根本不知道当初
 * 是哪一路发现了它——排除行只落了名字和理由,没落 route。缺了这个值,申诉
 * 就得在三个选项里挑一个填,那是在库里写一件我们并不知道的事。
 */
export type SourceRoute = "stars" | "updated" | "both" | "appealed";

/** 'rule' = 客观字段判的,'model' = 模型判的。**UI 分色依据,不许混成一色。** */
export type ReasonSource = "rule" | "model";

/**
 * 一条排除属于哪一类。**落库的一列(`scan_exclusion.reason_kind`),不是显示文案。**
 *
 * 为什么需要它(2026-09-01 阶段 4/5 评审):第一屏要把 293-386 条排除按类型
 * 分组,而在这之前分组只能**解析中文 `reason` 文案**,那是 scan-rules.ts 的显示
 * 字符串。文案改一个字,一大批条目就集体掉进「其他」组——不报错、不崩、页面
 * 照样好看,分组头上照样印着一个真实的数字。那正是 docs/01 风险 1 说的
 * 「错得很安静」。
 *
 * **命名故意和 `ExclusionGroupKey` 完全一致**(scan-groups.ts 的 key = 这个联合
 * 再加一个兜底的 `other`):落库的 kind 直接**就是**分组键,中间不许有翻译表。
 * 多一层映射就多一处能分叉的地方,而那正是这条改动要消灭的东西。
 *
 *   archived     作者自己按了归档
 *   stale        最后一次 push 超过 18 个月
 *   copyleft     AGPL 家族
 *   no-license   GitHub 返回 license: null
 *   tiny         不到 10 星且仓龄超过一年
 *   ranked-out   通过了全部规则,只是这周排在前 5 之外
 *   not-reached  这一趟提前收工了,门 1 根本没轮到验证它(和 ranked-out 是两件事)
 *   model        形态不同 / 目标用户不同,模型判的
 */
export type ExclusionKind =
	| "archived"
	| "stale"
	| "copyleft"
	| "no-license"
	| "tiny"
	| "ranked-out"
	| "not-reached"
	| "model";

/**
 * 一周一行的台账。四个计数字段是诚实声明那句话的全部数据来源,
 * **一律由代码统计,模型永远不接触**(沿用 001 types.ts 那条家法:
 * computed in code, never written by the model)。
 */
export interface WeeklyScan {
	id: string;
	dossierId: string;
	/** "2026-W36",字典序即时间序。 */
	weekOf: string;
	dossierRev: number;
	/**
	 * **当周实际发出去的**检索词原文,不是档案里写了几条。
	 *
	 * 两者在被截断的那一趟里不一样,而诚实声明说的是「我用 N 条查询去取」——
	 * 写档案里的条数就是在说一件没发生过的事(2026-09-01 阶段 4/5 评审:
	 * 匿名档下 8 条词要等 112 秒,而 SCAN_BUDGET_MS 默认 75 秒,所以**每个用户
	 * 手动触发都会拿到残缺扫描**,这是默认路径不是边角)。
	 */
	queries: string[];
	returned: number;
	admitted: number;
	excluded: number;
	fetchFailed: number;
	/**
	 * 这一趟实际用了几种排序(双路 = 2;被截断在第一路上 = 1)。
	 * 和 queries 一样落库,好让刷新之后的 GET 能算出**和 POST 一模一样**的
	 * 那句诚实声明,而不是退回一个「2」的猜测。
	 */
	routeCount: number;
	/**
	 * GitHub 自己报的匹配总数(取各条检索词的**最大值**,不是求和 —— 同一领域的
	 * 几条词高度重叠,求和会得出一个比 GitHub 上真实存在的仓还大的数)。
	 * 「可能有上万个」那句话的实据。落库是因为它只有「刚跑完」才知道,而刷新
	 * 之后那句话还得说得出口。
	 */
	claimedTotal: number;
	/**
	 * 提前收工的原因;null = 这一趟把所有检索词都跑完了、门 1 也走到底了。
	 *
	 * **必须落库**:被截断的那一趟刷新之后,POST 响应里那句诚实的警示不能消失
	 * ——残的清单和全的清单长得一模一样,不说就是我们自己在犯 docs/01 风险 1
	 * 说的那个错,而页面顶部还挂着一句理直气壮的诚实声明。
	 */
	stopped: string | null;
	createdAt: number;
}

export interface ScanCandidate {
	scanId: string;
	fullName: string;
	stars: number;
	pushedAt: string;
	archived: boolean;
	license: string | null;
	repoCreatedAt: string;
	/** 唯一一处模型产出,且**只是形态描述不是判断**。调用失败时为 null。 */
	oneLiner: string | null;
	/**
	 * GitHub 给这个仓打的主题词原文(没有就是空数组)。
	 *
	 * 落库是为了决策 8 那条「某个 topic 连续 N 周进清单且点击数为 0」的规则:
	 * 在这之前**那条规则连主语都没有**——库里根本没有 topic 这个东西。数据在
	 * 周扫时就拿在手上(one-liner 的提示词用的就是它),存下来不多打一次 API。
	 * 前端可以直接显示,但它不是判断,和 oneLiner 一样只是「这是什么」。
	 */
	topics: string[];
	sourceRoute: SourceRoute;
	rank: number;
	/**
	 * 申诉捞回来的那些:**当初被排除的理由原文**;不是申诉进来的就是 null。
	 *
	 * 它不是 `scan_candidate` 的一列,是 store 层 `getWeeklyScan` 在读取时按
	 * 名字 join 排除行拼上去的(理由见那个函数的注释)。
	 *
	 * 为什么值得挂在候选行上(2026-09-01 阶段 4/5 评审):第一屏靠同一个响应里
	 * 的 `exclusions` 做 join,那是安全的;但**阶段 8 的门铃邮件**如果只拿候选
	 * 清单渲染,那枚「你捞回来的」徽记和那句「原本因为 X 被排除」会安静地消失。
	 * 让读取侧保证 join 一定发生,下游就拿不到一份缺了这件事的候选清单。
	 */
	appealedFrom: string | null;
}

export interface ScanExclusion {
	scanId: string;
	fullName: string;
	/** 给人读的中文理由。**只负责显示**,分组看 reasonKind。 */
	reason: string;
	/** 给机器读的分组键。落库的一列,改中文文案不影响它。 */
	reasonKind: ExclusionKind;
	reasonSource: ReasonSource;
	/**
	 * 非空 = 站长捞回过。**这是投影不是正本**:重跑会把这一周的排除行整批删掉,
	 * 正本在 `scan_appeal` 表,重跑之后由它重新盖回来(store.ts listScanAppeals)。
	 */
	appealedAt: number | null;
	/**
	 * 这个仓最后一次 push 的时刻(ISO 原文)。前端目前不用,落库是为了
	 * 「停更断崖」那条将来的规则能攒到历史——候选清单一周只装 ≤5 个,而一个
	 * 开始停更的项目会先掉出清单(0001_init.sql 那一列的注释里连残留的限制
	 * 一起写了)。
	 */
	pushedAt: string;
}

/**
 * 诚实声明那句话要的全部数字(docs/02「诚实声明的措辞」)。
 *
 * **后端把数字算好,前端只拼字不算数。**这不是分工偏好:那句话是这个产品
 * 对「残缺但看起来完整」(docs/01 风险 1)唯一的正面回应,一旦前端自己拿
 * candidates.length 之类的东西凑分子分母,它就会在某次改版里和台账分叉,
 * 而分叉之后声明还是那么理直气壮地摆在页面顶部。
 *
 * 每个字段对应那句话里的一个空:
 *   「搜索接口每条查询最多只肯返回 {searchCap} 个,我用 {queryCount} 条查询、
 *     {routeCount} 种排序去取,实际拿回 {returned} 个,按规则筛掉 {excluded} 个,
 *     剩下 {admitted} 个在这里。」
 */
export interface ScanHonesty {
	searchCap: number;
	queryCount: number;
	routeCount: number;
	returned: number;
	excluded: number;
	admitted: number;
	/** 门 1 没过的(抓不通就不显示)。不在那句话里,但台账要露出来。 */
	fetchFailed: number;
	/** GitHub 声称的匹配总数(取各条检索词的最大值)。「可能有上万个」的实据。 */
	claimedTotal: number;
}

/** GET/POST /api/scan 的响应。没有那一周时 scan 为 null(200,不是 404)。 */
export interface GetScanResponse {
	scan: WeeklyScan | null;
	candidates: ScanCandidate[];
	exclusions: ScanExclusion[];
	honesty: ScanHonesty | null;
}

/** 一路检索的实况。台账里那一栏「哪条词捞回几个」就是它。 */
export interface ScanQueryTrace {
	query: string;
	sort: "stars" | "updated";
	returned: number;
	totalCount: number;
	error?: string;
}

/** POST /api/scan 的响应:GET 的一切,外加只有「刚跑完」才知道的那些。 */
export interface RunScanResponse extends GetScanResponse {
	trace: ScanQueryTrace[];
	/**
	 * 现在走的是哪一档配额(docs/02 决策 T5)。**匿名档跑的是真网络真数据**,
	 * 只是 REST 从 5000 次/小时掉到 60 次/小时;露出来是为了让「这周只捞回
	 * 12 个」有个能查的解释,而不是让人以为发现层坏了。
	 */
	rate: {
		authenticated: boolean;
		searchCalls: number;
		coreCalls: number;
		searchRemaining: number | null;
		coreRemaining: number | null;
		/** 因为额度不够真的等了多久(毫秒)。跑得慢时要说得清是谁的锅。 */
		waitedMs: number;
	};
	/**
	 * 这一趟把**上一次在这一周申诉过的仓**处理成了什么样(2026-09-01 上线前终审)。
	 *
	 * 为什么要有这个回执:重跑会把这一周的候选和排除整批删掉重灌,而用户自己
	 * 捞回来的那几行也在里面。现在 runWeeklyScan 会从 `scan_appeal` 把它们搬回来
	 * ——但**不是每一条都搬得回来**,而搬不回来这件事必须说出口,不能靠用户
	 * 自己发现少了一行。
	 *
	 * `restored` 搬回来了(这一趟又搜到它、又被规则筛掉,于是照当初那一下重新
	 * 搬进清单;或者这一趟它本来就凭实力进了清单)。
	 *
	 * `missing` 没搬回来:**这一趟根本没搜到它**(排名掉出 1000 条上限、检索词
	 * 改过、或者这一趟提前收工了)。硬搬的话台账等式
	 * `returned = admitted + excluded + fetchFailed` 就要说谎——它不在 returned
	 * 里,凭空加进 admitted 等于虚报了一个我们这一趟没拿回来的仓。所以选择
	 * 「不搬,但说出来」:`scan_appeal` 那一行仍然留着,下一次搜到它的重跑会
	 * 自动把它搬回来。
	 */
	appeals: {
		restored: string[];
		missing: string[];
	};
	// **这里故意没有 stopped**(2026-09-01 阶段 4/5 评审):它现在是
	// `WeeklyScan.stopped`,落了库,POST 和 GET 走的是同一个字段。原来那份
	// 只挂在 POST 响应上的副本正是 bug 的形状——刷新一次警示就没了,而清单
	// 还是残的。同一件事有两个出处,迟早只有一个是对的。
}

/**
 * POST /api/scan/appeal 的请求体(docs/01 决策 4「点『这个该进来』」)。
 *
 * `weekOf` 必传而不是「默认最近一周」:用户是在**某一周的那一屏**上点的按钮,
 * 而他点下去到请求发出之间,cron 完全可能刚跑完新的一周。默认取最近一周的话,
 * 那一下会把仓捞进一份他没看过的清单里,而他看着的那一周纹丝不动。
 */
export interface AppealRequest {
	weekOf: string;
	/** "owner/repo"。服务端按 `^[A-Za-z0-9._-]+/[A-Za-z0-9._-]+$` 校验后才敢拼进 URL。 */
	fullName: string;
}

/**
 * POST /api/scan/appeal 的响应:**整包刷新后的那一周**,前端直接替换状态。
 *
 * 为什么回整包而不是只回新增的那一行:台账的三个数在这一次里全都动了
 * (admitted +1、excluded -1、分组计数少一条),前端拿着旧的 scan 自己打补丁
 * 就等于让它算数——而页面顶部那句诚实声明的全部立场就是「前端不算数」。
 */
export interface AppealResponse extends GetScanResponse {
	/** 这次真的捞回来的那一行。已经在清单里(重复点)时为 null。 */
	appealed: ScanCandidate | null;
	/**
	 * 这一次**实际重跑了什么**。决策 4 说「只重跑受影响的部分,不重跑整周」,
	 * 而这种承诺写在文档里没人验得了,所以让它变成一个回执:页面上照着显示。
	 */
	rerun: {
		/** 门 1:GET /repos/{owner}/{repo},**1 次** core 调用。 */
		repoFetched: boolean;
		/** 形态描述:**1 次** flash 调用,只问这一个仓。失败时 false,清单照常。 */
		oneLiner: boolean;
		/**
		 * 整周的 GitHub 搜索(16 路)有没有重跑。**永远是 false**,类型上就写死:
		 * 改成会重跑的实现,编译当场不过。
		 */
		searchRerun: false;
	};
}

// ---------------------------------------------------------------------------
// 阶段 9 · 门铃邮件的订阅开关(站长 2026-09-01 拍板)
// ---------------------------------------------------------------------------

/**
 * GET/PUT `/api/email` 的响应。
 *
 * 为什么要回 `email` 和 `configured`,而不是只回一个布尔:
 *
 * - `email`:开关管的是**收信的那个地址**,而这个产品的账号是主站手递过来的。
 *   页面上不写清楚「关的是发给谁的信」,用户就只能猜 —— 而退订链接那条路
 *   (GET /unsub?token=)是按邮箱退的,两处说的必须是同一个地址。
 * - `configured`:这个实例配没配 SES 凭证。**没配的时候开关不能装作有用**:
 *   fork 的人拿不到那组凭证,他把开关打到「在收」也一封信都不会来。与其让他
 *   以为坏了,不如直接说这个实例没开邮件功能(和 /unsub 回 503 是同一个立场)。
 */
export interface EmailPrefs {
	/** 收信地址(= 登录的账号)。 */
	email: string;
	/** true = **已退订**,不再发门铃邮件。字段名跟着数据库那一行走,不取反。 */
	optedOut: boolean;
	/** 这个实例配齐发信凭证了没有。false = 开关照常读写,但本来就没有信会发。 */
	configured: boolean;
}

/**
 * PUT `/api/email` 的请求体。
 *
 * 用 `optedOut` 而不是 `subscribed`:**和数据库那一行、和退订链接那条路
 * 用同一个词、同一个方向**。中间任何一处取反都是一个迟早会被写反的地方,
 * 而写反的症状是「用户点了『开始收信』结果被退订了」——不报错,只是安静地
 * 做了相反的事。
 */
export interface PutEmailPrefsRequest {
	optedOut: boolean;
}

/** GET /api/scan/history 的响应:只要台账不要明细(翻周用的那一列)。 */
export interface ScanHistoryResponse {
	scans: WeeklyScan[];
}

// ---------------------------------------------------------------------------
// 上线前终审 · 跨周变化落库(站长 2026-09-01 拍板)
// ---------------------------------------------------------------------------

/**
 * diff 的明细类型直接从 `shared/scan-diff.ts` 转出去,**不在这里另抄一份**。
 *
 * 这是本文件顶部那条「另写一份结构相同的」规矩的一个例外,而例外的理由很具体:
 * 那条规矩是为了绕开 `store.ts` 签名里的 `D1Database`(前端那个 tsconfig 没有
 * workers-types,import 进来整片飘红)。`scan-diff.ts` 是**纯函数模块**,没有
 * D1、没有网络、没有 Hono,前端 import 它一点问题都没有。既然能共用一份,就
 * 不该手抄第二份——手抄的代价是两份会一起对、一起错,而这几个类型正是邮件和
 * 网页「读同一份」这条保证的载体。
 */
export type {
	LicenseChange,
	RecheckChange,
	RecheckChangeKind,
	RecheckOutcome,
	RecheckReport,
	RepoSnapshot,
	StarJump,
	WeekDiff,
	WeekSnapshot,
} from "./scan-diff.ts";
import type { WeekDiff } from "./scan-diff.ts";

/**
 * 一周跨周结论的**计数**部分(`weekly_change` 上那几列)。明细在 `diff` 里。
 *
 * **前端不要自己数明细数组的长度来画这几个数。**不是洁癖:这几个数是后端从
 * 同一个 WeekDiff 算出来落库的,而邮件正文里那句「复查了 N 个,M 个有变化」
 * 用的是同一组数。前端另算一遍就等于同一件事有两个算法,而两个算法迟早只有
 * 一个是对的(立场同 ScanHonesty)。
 */
export interface WeeklyChangeCounts {
	/** 本周新进清单的仓数。 */
	appeared: number;
	/** 由活转归档的仓数。 */
	archived: number;
	/** 换了许可证的仓数。 */
	licenseChanged: number;
	/** star 跃迁的仓数。 */
	starJumps: number;
	/**
	 * 复查:**本该查几个**(= 上一周清单的长度),不是查成了几个。
	 * **为 0 时页面上一个字都不要提复查**——说「复查了 0 个」是把「没做」
	 * 说成「做了没发现」(邮件模板里是同一条规矩)。
	 */
	recheckChecked: number;
	/** 复查:其中几个有变化(转归档 / 换许可证 / 没了)。一个仓最多算一次。 */
	recheckChanged: number;
	/** 复查:其中几个**没查成**。和「没了」是两件事,页面上要分两栏说。 */
	recheckUnchecked: number;
	/** 这一周到底有没有变化。**不等于上面四个数之和 > 0**(复查那几类不进那四栏)。 */
	changed: boolean;
}

/**
 * 某个档案某一周的跨周结论(`GET /api/scan/changes` 回的东西)。
 *
 * 它是 docs/01 风险 4 那条判据(「站长会不会去翻上一周」)在产品里的落点:
 * 在这条改动之前,跨周 diff 算完只进了一封**可能发不出去的**邮件,库里一个字
 * 都没有,于是「翻上一周」这个动作**在产品里根本不存在**——而跨周状态是这个
 * 产品相对一个 Claude Code skill 的全部存在理由(docs/01「为什么不做成 skill」)。
 */
export interface WeeklyChange {
	/** = `${dossierId}#${weekOf}`,和这一周的 WeeklyScan.id 是同一个值。 */
	scanId: string;
	dossierId: string;
	weekOf: string;
	/**
	 * 拿来比的是哪一周;**null = 这是第一周,没有可比的上一周**。
	 *
	 * 它不一定是「本周减 7 天」:cron 挂过一周、或者这个人上上周才建的档,中间
	 * 就会有空档,所以取的是「除本周之外最新的那一条」。页面上那句话因此要写
	 * 「与上一次(2026-W35)比」而不是「与上周比」——把口径印在读者眼前。
	 * 恒等于 `diff.prevWeekOf`(同一份 diff 写出来的两处投影)。
	 */
	prevWeekOf: string | null;
	counts: WeeklyChangeCounts;
	/** 明细:四类变化各是哪几个仓、从什么变成什么、复查逐条的结局。 */
	diff: WeekDiff;
	/** 这条结论是什么时候算出来的(周扫跑完、发信之前)。 */
	createdAt: number;
}

/**
 * `GET /api/scan/changes?weekOf=…` 的响应。不传 weekOf 取**最近一周**。
 *
 * `change` 为 null + 200(不是 404)有三种可能,页面上都该说同一句「这一周
 * 没有跨周记录」而不是「没有变化」:①这个人还没跑过周扫;②那一周是在这条
 * 改动上线之前跑的(库里没有这一行);③那一行的明细坏了(后端记了 error 日志
 * 并当它不存在)。**「没记过」和「记了、没变化」是两句不同的话**——后者由
 * `change.counts.changed === false` 表达,那时 `change` 是非 null 的。
 */
export interface GetScanChangesResponse {
	change: WeeklyChange | null;
}

/**
 * 一次周扫**算法挑**几个候选(docs/01 决策 4)。前端的空态文案也用它。
 *
 * **`admitted` 可以大于它,别把它当成候选清单长度的上限。**申诉(阶段 5 的
 * `POST /api/scan/appeal`)是硬把一条排除搬进清单:admitted +1、excluded -1、
 * returned 不动,于是一周被捞回三个仓时清单就有 8 行。任何假设「候选恰好 ≤5」
 * 的下游都要按这条改——**阶段 8 的门铃邮件是第一个**,别在模板里写死五行,
 * 也别拿 slice(0, 5) 把用户自己捞回来的东西悄悄截掉。
 */
export const SCAN_PICK_LIMIT = 5;

/**
 * 所有 4xx/5xx 的统一形状。error 是**可以直接显示给用户**的中文文案
 * (上游报文永远不透传)。
 * - loginUrl:401 时带,前端据此把人送回主站登录,别自己猜地址。
 * - scope:429 时带,区分是账号额度、同 IP 合计、还是全站当日预算。
 * - refresh:**重试没有出路,只能刷新页面**。前端据此把「再试一次」换成
 *   「刷新页面」。为什么需要这个字段:两个标签页各开一份草稿时,B 先保存,
 *   A 再保存会撞「原话不许改」的 400,而 A 手里那份草稿**每一次重试都是
 *   同一个 400**——草稿态下页面上又没有删档按钮,「再试一次」这句话叫用户
 *   做一件他做不到的事。这类失败必须由后端标出来:状态码分不出来
 *   (同是 400,校验失败那种重试就有意义),只有 handler 知道。
 */
export interface ApiError {
	error: string;
	loginUrl?: string;
	scope?: "account" | "ip" | "global";
	refresh?: true;
}

/**
 * GET /api/health 的响应(公开端点,不需要登录)。
 *
 * 放在这里而不是 App.tsx 里自己声明一份:types.ts 是前后端契约的唯一真源,
 * health 曾经是唯一的例外——前端一份 `interface Health`、Worker 里一个字面量
 * 对象,两边靠人眼对齐。阶段 5 要往 health 里加 email / loginUrl,那时两份
 * 定义会分叉,而症状是「前端读一个后端没给的字段,页面上安静地空着」。
 */
/**
 * D1 到底能不能用。**四种,不是两种**(2026-09-01 上线前终审的 C3)。
 *
 *   ok          真跑了一次轻量查询并拿到结果:库接上了、迁移也跑过了。
 *   no-binding  `env.TEARDOWN_DB` 根本不在(wrangler.jsonc 的 d1_databases 没配 /
 *               配错了 binding 名)。
 *   no-tables   binding 在,但查不到表 —— **首次部署最可能踩的那个坑**:
 *               `wrangler d1 migrations apply --remote` 忘了跑。
 *   error       别的错(D1 这会儿不通)。和 no-tables 分开:一个要跑迁移,
 *               一个只能等,处置动作完全不同。
 */
export type DbHealth = "ok" | "no-binding" | "no-tables" | "error";

export interface HealthResponse {
	ok: true;
	/** 实际生效的 provider(deepseek / mock / anthropic / gateway;配错时 "invalid")。 */
	provider: string;
	hasPat: boolean;
	/**
	 * 库真的能用吗。**这不再是「binding 存不存在」**(2026-09-01 上线前终审):
	 * 原来它是 `Boolean(env.TEARDOWN_DB)`,忘了跑迁移的话它照样回 true,然后
	 * 每一个真端点 500 —— 一个只在「什么都没坏」时才说真话的健康检查,恰好在
	 * 最需要它的那一刻(首次部署)说假话。现在它 = `db === "ok"`,而 `db` 说清
	 * 是哪一种坏。保留这个布尔是因为前端已经在用它显示「没建库」的提示。
	 */
	hasDb: boolean;
	/** 上面那个布尔的细分。见 DbHealth。 */
	db: DbHealth;
}

/**
 * 周扫的排期。**真源是 `wrangler.jsonc` 的 `triggers.crons`**——这里是它的
 * 一份人话副本,给前端的回执用(「下一次周扫会按它去搜」)。
 *
 * 为什么不能让前端自己写死一句「下周一 08:00 UTC」:那句话在 App.tsx 里,
 * 而排期在 wrangler.jsonc 里,改 cron 的人不会想到去改一句回执文案,于是
 * 产品会开始对用户说一个假的时间,而且没有任何东西会报错。
 *
 * 两处仍然是两处(Worker 运行时读不到 wrangler.jsonc),但 `npm test` 有一条
 * 用例读 wrangler.jsonc 把 cron 和这里钉在一起(worker/dossier.test.ts),
 * 改了一边不改另一边测试当场红。
 */
export const WEEKLY_SCAN_SCHEDULE = {
	cron: "0 8 * * 1",
	/** 给人读的说法。改 cron 时这一句要跟着改。 */
	human: "每周一 08:00 UTC",
} as const;

/**
 * 前后端共用的边界值。前端拿它做输入框的 maxlength 和「还能加几条」的提示,
 * 后端拿它做校验——**同一份常量**,免得两边各写一个数然后慢慢分叉
 * (前端允许 6 条、后端截到 5 条,用户看着自己写的第 6 条消失且无人报错)。
 */
export const DOSSIER_LIMITS = {
	/** 一句话的长度上限(trim 之后)。超了 400。 */
	sentenceMax: 500,
	/** caresAbout / notCaresAbout 各自的条数上限。超出的部分被截断,不报错。 */
	listMax: 5,
	/** queries 的条数上限。超出的部分被截断,不报错。 */
	queriesMax: 8,
	/** queries 的条数下限。低于它 = 这份档案捞不回东西,保存直接 400。 */
	queriesMin: 3,
	/** 单条 caresAbout / notCaresAbout / queries 的字数上限。超了截断。 */
	itemMax: 120,
	/** domain 的字数上限。超了截断。 */
	domainMax: 200,
} as const;

// ---------------------------------------------------------------------------
// 阶段 7 · 深度报告(docs/01 决策 6 / 7,docs/02 决策 T1 / T4 / T7)
// ---------------------------------------------------------------------------

/**
 * 一份比对底本的身份。**命名必须能对上永久回链**,这是它唯一的设计约束:
 *
 *   "repo"              GET /repos/{o}/{r} 的字段快照(created_at / pushed_at / …)
 *   "readme"            README 正文
 *   "changelog"         releases.atom 解析出来的全部 release
 *   "raw:src/index.ts"  某一份源码正文,冒号后面就是仓内路径
 *   "hn:38291043"       HN 上的一条 story 或 comment,冒号后面就是 objectID
 *
 * 为什么这么严:`anchorAcross` 只在 `claimedSource` 那一份里比对,而证据上挂着
 * 的永久回链是**另一段代码**按 source 拼出来的。两者对不上时,症状是「引文
 * 真的锚定成功了,链接点开却没有那句话」——一条带着硬凭证的假证据,比没有
 * 凭证更危险(docs/02 决策 T4)。名字里带上路径 / objectID,让拼链接那一步
 * 拿得到它需要的一切,不必再去别处查表。
 *
 * 结构上与 shared/anchor.ts 的 SourceId 是同一个类型;那边是算法层的定义,
 * 这里是线上契约的定义,report.ts 顶部有双向 extends 断言钉着两边不许分叉。
 */
export type ReportSourceId = string;

/** 证据 id。模型的 `basedOn` 只能引用这个表里已有的 id,编一个出来就整条丢弃。 */
export type ReportEvidenceId = string;

/** 一条证据:逐字引文 + 它出自哪一份材料 + 永久回链 + 锚定结果。 */
export interface ReportEvidence {
	id: ReportEvidenceId;
	quote: string;
	source: ReportSourceId;
	/** anchorAcross 的产出。事实层 false 会灰显,判断层引用到 false 的会被丢弃。 */
	anchored: boolean;
	/**
	 * 永久回链。节 2 形如 `https://github.com/{o}/{r}/blob/{sha}/{path}#L12-L28`
	 * ——**是 commit sha 不是分支名**。`blob/main/...#L12` 会在对方下次提交后
	 * 指向完全不同的代码,而 `blob/<sha>/...#L12` 永远指向我们当时读到的那几行。
	 * 这是「永久回链」里「永久」两个字的全部含义。
	 */
	permalink: string;
	/** 命中处前后各 150 字的原文。没锚上时没有。 */
	context?: string;
}

/** 判断层的一条结论。两节共用一个形状。 */
export interface ReportTakeaway {
	text: string;
	/** 非空,且每个 id 对应的证据必须 anchored === true,否则这条被丢弃。 */
	basedOn: ReportEvidenceId[];
	/**
	 * 它对应档案 `caresAbout` 的第几条(0 起)。标不出来即丢弃。
	 *
	 * 这不是形式主义:它是滤掉「这个项目用了 zod 做校验」这类**真但无用**的
	 * 观察的唯一手段(docs/01 风险 3)。
	 */
	caresAboutIndex: number;
}

/** 判断层被丢弃的一条,以及为什么。**不藏**——硬门的对价就是把删了什么说清楚。 */
export interface ReportDropped {
	text: string;
	kind: "no-basis" | "unknown-evidence" | "unanchored-evidence" | "cares-about-out-of-range";
	reason: string;
}

/**
 * 候选评论池的顺序口径。**结构上与 shared/hn.ts 的 `HnCommentOrder` 是同一个
 * 类型**;那边是抓取层的定义,这里是线上契约的定义,report.ts 顶部有双向
 * extends 断言钉着两边不许分叉(同 SourceId / Evidence 的做法)。
 */
export type ReportCommentOrder = "kids" | "chronological";

/** 时间线节点的类型。渲染层按它选图标/分色,不解析中文文案。 */
export type TimelineKind = "created" | "release" | "hn-story" | "hn-comment" | "last-push" | "archived";

/**
 * 节 1 的一个时间线节点。**事实层:锚不上灰显,不删**(docs/02 决策 T4)。
 *
 * 每个节点都挂 evidenceId,证据表里有它的引文、回链和锚定结果。节点本身不重复
 * 存引文,免得两处分叉。
 */
export interface TimelineNode {
	kind: TimelineKind;
	/** ISO 日期原文。时间线按它升序排,代码排,模型不接触。 */
	at: string;
	/** 一句话标签,**由代码生成**(「仓库建立」「v1.0.0 发布」…),不是模型写的。 */
	label: string;
	evidenceId: ReportEvidenceId;
	/** 只有 hn-comment 有:模型为什么挑这一条(唯一一处模型在节 1 的措辞)。 */
	pickedWhy?: string;
}

/** 节 1:它当年怎么走到今天。 */
export interface HistorySection {
	/** ≤12 个节点,按时间升序。 */
	timeline: TimelineNode[];
	/** HN 上的发布帖;没找到时为 null,页面要如实说「这个项目在 HN 上没有记录」。 */
	hnStory: { id: string; title: string; url: string | null; points: number; numComments: number; permalink: string } | null;
	/** 代码取回来的候选评论条数(模型从这些里挑)。0 = 没有记录。 */
	commentCandidates: number;
	/**
	 * 候选池的顺序口径(2026-09-01 实测修订)。
	 *
	 * `kids` = HN 官方 API 给的排序,页面上可以说「HN 排在第 N 条」;
	 * `chronological` = 那一跳没成,只知道发表时间——页面**必须改口**,
	 * 一个字都不能提排序。这个字段存在的唯一理由就是不让页面在两种情况下
	 * 说同一句话(shared/hn.ts 的 HnCommentOrder 有完整论证)。
	 */
	commentOrder: ReportCommentOrder;
	/** `kids` 里有、正文没对上的条数。如实少给,不拿别的顺序补。 */
	commentsMissing: number;
	takeaways: ReportTakeaway[];
	dropped: ReportDropped[];
	/** describeGate 的一句话:「模型给了 8 条,5 条挂得上原文,3 条挂不上已丢弃」。 */
	gateNote: string;
}

/** 节 2 里真的读过的一份文件。**读了哪几个文件是可复述的**,所以理由也落库。 */
export interface ReportSourceFile {
	path: string;
	/** 仓内字节数(README 走 contents API 时为 0,GitHub 那条路不给 size)。 */
	size: number;
	/** 打分,以及一句话「凭什么挑了它」。source-pick.ts 算的。 */
	score: number;
	why: string;
	/** 真正喂给模型的字符数(截断到 12KB 之后的)。 */
	chars: number;
	/** `https://github.com/{o}/{r}/blob/{sha}/{path}` —— 不带行号的那一段。 */
	blobUrl: string;
}

/** 节 2:它源码里值得抄什么。 */
export interface SourceSection {
	/** 解析永久回链的那个 commit sha(全长 40 位)。 */
	commitSha: string;
	files: ReportSourceFile[];
	/** 文件树是不是被 GitHub 截断了(10 万条目 / 7MB 上限)。true 时只读了 README。 */
	treeTruncated: boolean;
	takeaways: ReportTakeaway[];
	dropped: ReportDropped[];
	gateNote: string;
}

/**
 * 一条降级标注。**页面必须原样显示,不许折叠**——它们记录的正是「这份报告
 * 缺了什么」,而藏起来之后残的报告和全的报告长得一模一样(docs/01 风险 1)。
 */
export type ReportNoteKind =
	| "hn-no-record"
	| "hn-no-comments"
	/** 拿不到 HN 官方的 `kids` 排序,候选池退成时间序。**降级必须说出来。** */
	| "hn-no-ranking"
	| "tree-truncated"
	| "tree-unavailable"
	| "no-source-files"
	| "no-changelog"
	| "history-model-failed"
	| "source-model-failed"
	/** 站长专线挂了、这一趟回落到自费 provider 跑完的。**回落过就要说**。 */
	| "ai-fell-back"
	| "mock";

export interface ReportNote {
	kind: ReportNoteKind;
	/** 给人读的中文。分组和判断看 kind,不解析这句话(同 ExclusionKind 的家法)。 */
	text: string;
}

/** 一份深度报告的完整形状。整份以 JSON 存进 `report.payload_json`。 */
export interface TeardownReport {
	id: string;
	fullName: string;
	/** 永久回链的锚点,也是去重键的一部分。 */
	commitSha: string;
	/** 基于哪一版档案跑的。档案改过之后同一个仓值得重跑一次。 */
	dossierRev: number;
	/**
	 * 跑这份报告时档案里 `caresAbout` 的快照。takeaway 的 `caresAboutIndex`
	 * 指的是**它**,不是用户现在那一份 —— 用户改完档案再打开旧报告,下标
	 * 会指到另一条上去,而页面上没有任何东西会报错。
	 */
	caresAbout: string[];
	generatedAt: number;
	history: HistorySection;
	source: SourceSection;
	/** 两节合起来的全部证据。takeaway.basedOn / timeline.evidenceId 都指向它。 */
	evidence: ReportEvidence[];
	/** 已锚定证据 / 全部证据。产品要在页面上公开,不藏。 */
	anchoredRatio: number;
	notes: ReportNote[];
	/** 这一趟按上限估的花费(不是实付)。闸口占位用的就是它。 */
	estUsd: number;
	/** 实际用了哪个 provider / 型号。mock 时是 "mock"。 */
	model: { provider: string; historyModel: string; sourceModel: string };
}

/** POST /api/report 的请求体。 */
export interface RunReportRequest {
	/** 哪一周的清单上点的。"2026-W36"。 */
	weekOf: string;
	/** "owner/repo"。服务端按 `^[A-Za-z0-9._-]+/[A-Za-z0-9._-]+$` 校验后才敢拼进 URL。 */
	fullName: string;
}

/**
 * SSE 的事件。**用 `fetch` + 手工读流消费,不是 `EventSource`**——
 * EventSource 只会发 GET,而这个端点是 POST(002 的前端也是这么读的,
 * `002/src/react-app/App.tsx` 的 readFastStream)。
 */
export type ReportEvent =
	| { type: "phase"; phase: ReportPhase }
	| { type: "delta"; chars: number }
	| { type: "ping" }
	| { type: "result"; report: TeardownReport; cached: boolean }
	| { type: "error"; error: string; quota?: true };

/**
 * 报告跑到哪一步了。**这四个值同时是 `inflight.phase` 落库的值**,刷新之后
 * `GET /api/report/inflight` 回的就是它——两处用同一个联合,免得页面上
 * 「接回来的进度」和「跑着时看到的进度」是两套词。
 */
export type ReportPhase = "fetching" | "history" | "source" | "anchoring";

/** GET /api/report/inflight 的响应。没有在跑的一单时 inflight 为 null(200)。 */
export interface ReportInflightResponse {
	inflight: { fullName: string; phase: ReportPhase | string; startedAt: number; updatedAt: number } | null;
}

/** GET /api/report 的响应。没有那份报告时 report 为 null(200,不是 404)。 */
export interface GetReportResponse {
	report: TeardownReport | null;
}

/**
 * 一份深度报告按**上限**估多少钱(美元)。闸口 `reserveOrDeny(c, "gen", 它)`
 * 在真正开跑之前拿它占位。
 *
 * 算术(docs/02 决策 T7 末段):两次 `deepseek-v4-pro`,节 1 吃 30 条 HN 评论 +
 * changelog,节 2 吃 5 份各 12KB 的源码正文;两次的输出预算都是 32768,而
 * **V4 Pro 的 thinking 也占输出预算**。docs/02 给的区间是 $0.4-0.6。
 *
 * **取上限 0.6,不取中间值。**理由是前缀缓存在 003 大概率失效:002 那 94% 的
 * 命中率来自「同一份转录稿反复当前缀」,而 003 节 2 读的是 5 个不同项目的不同
 * 源文件,前缀跨候选之间天然不共享。按低命中算是这个估值唯一诚实的算法——
 * 估低了的后果不是「省了钱」,是全局 $3 的保险丝在真实花费到 $4 时还没响。
 *
 * 顺带对上 docs/02 决策 T6 的算术:$3 ÷ $0.6 = 5 份/天,它说的是「约 5-7 份」。
 */
export const REPORT_EST_USD = 0.6;

/** 两次 pro 调用各占一半。回落到自费 provider 时按它补记一笔 daily_spend。 */
export const REPORT_CALL_EST_USD = REPORT_EST_USD / 2;

/** 节 1 时间线最多几个节点(docs/01 决策 7:≤12)。 */
export const TIMELINE_MAX_NODES = 12;

/** 模型从候选评论里最多挑几条(docs/01 决策 7:3 条)。 */
export const HN_PICK_LIMIT = 3;

/** 节 2 最多几条 takeaway(docs/01 决策 7:≤5)。 */
export const TAKEAWAY_LIMIT = 5;

/**
 * 节 1 最多几条发展史判断(docs/01 决策 7:≤3)。
 *
 * 单独一个常量而不是两节共用 TAKEAWAY_LIMIT:提示词里写的是「最多 3 条」,
 * 而模型给 4 条时**代码必须真的拦**——不拦的话「≤3」就只是一句建议,
 * 而这一节的判断条数是站长在决策 7 里定的,不是模型的自由度
 * (2026-09-01 阶段 7 评审建议修 6)。
 */
export const HISTORY_TAKEAWAY_LIMIT = 3;
