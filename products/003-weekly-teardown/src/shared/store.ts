// 003 · D1 store 层(docs/02-技术方案.md 决策 T2 / T6)。
//
// 全部 SQL 收在这一个文件里,路由层只调函数、不拼 SQL。理由不是洁癖:配额和
// 花费闸的正确性**全靠单条语句的原子性**,一旦路由层能自己写 SQL,总有一天
// 会出现一段「先 SELECT 看看够不够,再 UPDATE」的代码,而那正是这里要防的东西。
//
// 与 001 的差别:001 是 DynamoDB(Worker 与 Lambda 共用,所以要接缝 + 两个实现),
// 003 全部逻辑都在 Worker 内,没有第二个运行时要读同一份数据,所以不做接缝,
// 直接对着 D1 写。少一层抽象,也少一整套 SigV4 手签代码和一组 IAM 凭证。
//
// 表结构见 migrations/0001_init.sql,字段注释在那边,这里不重复。
//
// import 全是 `import type`(ExclusionKind 那一列的取值域,以及 WeekDiff ——
// weekly_change.changes_json 里存的就是它)。正本分别在 shared/types.ts 和
// shared/scan-diff.ts,这里不另抄一份:两份手抄的类型会一起对、一起错,而
// reason_kind 那一列的全部意义就是「分组不许再靠猜中文文案」,changes_json
// 的全部意义就是「网页和邮件读同一份,谁都不许再算一遍」。类型 import 编译后
// 被擦除,这个文件在运行时仍然只依赖 D1。

import type { WeekDiff } from "./scan-diff.ts";
import type { ExclusionKind } from "./types.ts";

// ---------------------------------------------------------------------------
// 日期口径
// ---------------------------------------------------------------------------

/**
 * 配额和花费闸的「今天」,一律 UTC 的 YYYY-MM-DD。
 *
 * 用 UTC 而不是用户所在时区,是因为额度桶是**服务端共享资源**:同一个 IP 桶
 * 下可能坐着东八区和美东两个人,按谁的本地时间跨天都会让另一个人的额度在
 * 半夜莫名其妙被重置或提前用完。UTC 至少是所有人都一样的、可解释的一条线。
 * (001 的简报日期用的是 America/New_York,那是**内容**的日期——「今天这一期」
 * 要跟读者的早晨对齐;这里是**闸门**的日期,两件事不该用同一个口径。)
 *
 * 收成一个函数是为了不在各处散落 `new Date().toISOString().slice(0,10)`:
 * 只要有两处写法,迟早有一处会被改成本地时区,然后额度在跨天那一刻出现
 * 「占位成功但读回来是 0」这种查半天的怪事。
 */
export function todayUtc(at: number = Date.now()): string {
	return new Date(at).toISOString().slice(0, 10);
}

/** todayUtc 往前推 n 天,给 sweepExpired 算保留窗口用。 */
function dayUtcBefore(days: number, at: number = Date.now()): string {
	return todayUtc(at - days * 86_400_000);
}

// ---------------------------------------------------------------------------
// 领域类型(camelCase)。D1 里是 snake_case,转换只在本文件的 map* 函数里发生。
// ---------------------------------------------------------------------------

/** 用户那份可见可改的关注定义。v1 每人一份(user_email UNIQUE)。 */
export interface Dossier {
	id: string;
	userEmail: string;
	/** 用户原话。AI 永不改写——它是这份档案的宪法。 */
	sentence: string;
	domain: string;
	caresAbout: string[];
	notCaresAbout: string[];
	/** 发给 GitHub Search 的检索词,5-8 条,用户可改。 */
	queries: string[];
	rev: number;
	createdAt: number;
	updatedAt: number;
}

/** 一周一行的周扫快照。四个计数字段是诚实声明那句话的数据来源。 */
export interface WeeklyScan {
	/** 确定性 id:`${dossierId}#${weekOf}`,由 weeklyScanId() 算出,没有随机来源。 */
	id: string;
	dossierId: string;
	/** "2026-W36",字典序即时间序。 */
	weekOf: string;
	dossierRev: number;
	/** 当周**实际发出**的检索词原文(不是档案里写了几条 —— 被截断的那一趟两者不一样)。 */
	queries: string[];
	returned: number;
	admitted: number;
	excluded: number;
	fetchFailed: number;
	/** 这一趟实际用了几种排序(双路 = 2)。 */
	routeCount: number;
	/** GitHub 报的匹配总数(取各条检索词的最大值)。 */
	claimedTotal: number;
	/** 提前收工的原因;null = 全部跑完了。 */
	stopped: string | null;
	createdAt: number;
}

/**
 * 双路检索里这个仓是哪条路捞到的(docs/02 决策 T3),台账分栏依据。
 * `"appealed"` = 不是搜出来的,是用户申诉捞回来的(见 appealExclusion)。
 * 与 shared/types.ts 那份同形,scan.ts 顶部的双向 extends 断言钉着不许分叉。
 */
export type SourceRoute = "stars" | "updated" | "both" | "appealed";

export interface ScanCandidate {
	scanId: string;
	/** "owner/repo"。 */
	fullName: string;
	stars: number;
	/** GitHub 返回的 ISO 字符串原文,不转毫秒。 */
	pushedAt: string;
	archived: boolean;
	/** SPDX id;无许可证为 null(这本身就是一条排除理由)。 */
	license: string | null;
	repoCreatedAt: string;
	/** 唯一一处模型产出,且只是形态描述不是判断。 */
	oneLiner: string | null;
	/**
	 * GitHub 给这个仓打的主题词原文(没有就是空数组)。
	 *
	 * 存它是为了决策 8 那条「某个 topic 连续 N 周进清单且点击数为 0」的规则:
	 * 在这之前库里根本没有 topic 这个东西,那条规则**连主语都没有**。数据在
	 * 周扫时就拿在手上(one-liner 的提示词用的就是它),不多打一次 API。
	 */
	topics: string[];
	sourceRoute: SourceRoute;
	rank: number;
	/**
	 * 申诉捞回来的那些:当初被排除的理由原文;不是申诉进来的就是 null。
	 *
	 * **不是 scan_candidate 的一列**,是 getWeeklyScan 读的时候 join 排除行拼上
	 * 去的(理由见那个函数)。所以它不出现在 NewScanCandidate 里,写入方给不了。
	 */
	appealedFrom: string | null;
}

/** 'rule' = 客观字段判的,'model' = 模型判的。UI 分色依据,不许混成一色。 */
export type ReasonSource = "rule" | "model";

/** 排除的分组键(`scan_exclusion.reason_kind` 那一列)。正本在 shared/types.ts。 */
export type { ExclusionKind };

export interface ScanExclusion {
	scanId: string;
	fullName: string;
	/** 给人读的中文理由。**只负责显示**,分组看 reasonKind。 */
	reason: string;
	/** 给机器读的分组键(scan_exclusion.reason_kind)。改中文文案不影响它。 */
	reasonKind: ExclusionKind;
	reasonSource: ReasonSource;
	/**
	 * 非空 = 站长捞回过这一条。**这是投影不是正本**:重跑会整批删掉排除行,
	 * 正本在 `scan_appeal`(见 listScanAppeals),重跑之后由那张表重新盖回来。
	 */
	appealedAt: number | null;
	/**
	 * 这个仓最后一次 push 的时刻(ISO 原文)。
	 *
	 * 候选行上早就有这一列;排除行也存是为了「停更断崖」那条将来的规则能攒到
	 * 历史 —— 候选一周只装 ≤5 个,一个开始停更的小项目会先掉出清单,它的历史
	 * 恰好断在最需要历史的那一刻(migrations/0001_init.sql 那一列的注释里连
	 * 残留的限制一起写了)。
	 */
	pushedAt: string;
}

/**
 * 落库用:scanId 由 putWeeklyScan 统一盖章,调用方不用自己对齐。
 * `appealedFrom` 也不在里面 —— 它是读取时 join 出来的,不是写进去的一列。
 */
export type NewScanCandidate = Omit<ScanCandidate, "scanId" | "appealedFrom">;
export type NewScanExclusion = Omit<ScanExclusion, "scanId">;

/**
 * 落库用的台账:**不带 id**。id 由 (dossierId, weekOf) 算得出来(weeklyScanId),
 * 让调用方再生成一个只会多出一条造 id 的路径,而两条路径迟早会分叉。
 */
export type NewWeeklyScan = Omit<WeeklyScan, "id">;

/**
 * weekly_scan 的主键。**确定性**——同一 (档案, 周) 永远算出同一个 id,
 * 不掷骰子、不查库。
 *
 * 这不是为了好看,是 putWeeklyScan 的并发正确性所依赖的东西(2026-09-01 评审):
 * id 一旦要靠「先查一次库看看这周有没有跑过」才知道,那次查询就必然落在
 * batch 事务之外,两趟重扫就能把台账和候选拆散(详见 putWeeklyScan 的注释)。
 * 算得出来的 id 让「删旧子行 + 覆盖台账 + 重灌新子行」整个落进一个 batch。
 *
 * `#` 做分隔符:dossier id 和 weekOf("2026-W36")里都不会出现它,拼出来的
 * id 反过来能唯一切回两段(虽然目前没有代码需要切)。
 */
export function weeklyScanId(dossierId: string, weekOf: string): string {
	return `${dossierId}#${weekOf}`;
}

/** 第一屏要的一整包:台账 + 候选 + 排除。 */
export interface WeeklyScanBundle {
	scan: WeeklyScan;
	candidates: ScanCandidate[];
	exclusions: ScanExclusion[];
}

/**
 * 一份深度报告。payload 整份存 JSON 字符串,store 层不解析——报告的形状
 * (Evidence / Takeaway / 两节结构)要到阶段 6-7 才定下来,现在把它解析成
 * 具体类型只会逼着后面改 store。真正需要类型的是消费它的那一层。
 */
export interface Report {
	id: string;
	dossierId: string;
	fullName: string;
	/** 永久回链的锚点。同一个 sha 已经跑过就别重跑(findReport)。 */
	commitSha: string;
	/**
	 * 基于哪一版档案跑的。**它也是去重键的一部分**(2026-09-01 阶段 7 评审
	 * 必须修 3):档案改过之后同一个仓值得重跑一次,而 types.ts 里这个字段的
	 * 注释一直这么写着,代码里却没有任何实现路径。
	 */
	dossierRev: number;
	payloadJson: string;
	estUsd: number;
	/** 锚定成功率,产品要在页面上公开,不藏。 */
	anchoredRatio: number;
	createdAt: number;
}

/**
 * 在跑的那一单。存在的唯一理由是「刷新能接回进度」——002 踩过一次,
 * 浏览器内存里的转圈撑不过一次刷新,SSE 断了就没有东西可以接回。
 */
export interface InflightRecord {
	fullName: string;
	phase: string;
	startedAt: number;
	updatedAt: number;
}

// ---------------------------------------------------------------------------
// 行 → 领域类型
// ---------------------------------------------------------------------------

type Row = Record<string, unknown>;

const num = (v: unknown): number => (typeof v === "number" ? v : Number(v ?? 0));
const str = (v: unknown): string => (typeof v === "string" ? v : String(v ?? ""));

/** JSON 列解析。存进去的必然是我们自己 stringify 的数组,但库里的脏数据不该炸掉整个页面。 */
function jsonArray(v: unknown): string[] {
	try {
		const parsed = JSON.parse(str(v));
		return Array.isArray(parsed) ? parsed.map(String) : [];
	} catch {
		return [];
	}
}

function mapDossier(r: Row): Dossier {
	return {
		id: str(r.id),
		userEmail: str(r.user_email),
		sentence: str(r.sentence),
		domain: str(r.domain),
		caresAbout: jsonArray(r.cares_about),
		notCaresAbout: jsonArray(r.not_cares_about),
		queries: jsonArray(r.queries),
		rev: num(r.rev),
		createdAt: num(r.created_at),
		updatedAt: num(r.updated_at),
	};
}

function mapScan(r: Row): WeeklyScan {
	return {
		id: str(r.id),
		dossierId: str(r.dossier_id),
		weekOf: str(r.week_of),
		dossierRev: num(r.dossier_rev),
		queries: jsonArray(r.queries),
		returned: num(r.returned),
		admitted: num(r.admitted),
		excluded: num(r.excluded),
		fetchFailed: num(r.fetch_failed),
		routeCount: num(r.route_count),
		claimedTotal: num(r.claimed_total),
		stopped: r.stopped == null ? null : str(r.stopped),
		createdAt: num(r.created_at),
	};
}

function mapCandidate(r: Row): ScanCandidate {
	return {
		scanId: str(r.scan_id),
		fullName: str(r.full_name),
		stars: num(r.stars),
		pushedAt: str(r.pushed_at),
		// SQLite 没有 BOOLEAN,存的是 0/1
		archived: num(r.archived) === 1,
		license: r.license == null ? null : str(r.license),
		repoCreatedAt: str(r.repo_created_at),
		oneLiner: r.one_liner == null ? null : str(r.one_liner),
		topics: jsonArray(r.topics),
		sourceRoute: str(r.source_route) as SourceRoute,
		rank: num(r.rank),
		// 读取侧 join 补的(见 getWeeklyScan);这里先给 null,不是「没申诉过」的意思,
		// 是「这个函数手上没有排除清单」。
		appealedFrom: null,
	};
}

function mapExclusion(r: Row): ScanExclusion {
	return {
		scanId: str(r.scan_id),
		fullName: str(r.full_name),
		reason: str(r.reason),
		reasonKind: str(r.reason_kind) as ExclusionKind,
		reasonSource: str(r.reason_source) as ReasonSource,
		appealedAt: r.appealed_at == null ? null : num(r.appealed_at),
		pushedAt: str(r.pushed_at),
	};
}

function mapReport(r: Row): Report {
	return {
		id: str(r.id),
		dossierId: str(r.dossier_id),
		fullName: str(r.full_name),
		commitSha: str(r.commit_sha),
		dossierRev: num(r.dossier_rev),
		payloadJson: str(r.payload_json),
		estUsd: num(r.est_usd),
		anchoredRatio: num(r.anchored_ratio),
		createdAt: num(r.created_at),
	};
}

// ---------------------------------------------------------------------------
// 档案
// ---------------------------------------------------------------------------

export async function getDossier(db: D1Database, email: string): Promise<Dossier | null> {
	const row = await db.prepare("SELECT * FROM dossier WHERE user_email = ?1").bind(email).first<Row>();
	return row ? mapDossier(row) : null;
}

/**
 * 这份档案底下挂了多少周扫、多少报告。
 *
 * 存在的理由是**删档确认框要在按下之前就知道后果**:DELETE 的响应里已经有
 * 一份 deleted 计数(deleteDossierCascade),但那是删完之后才说的,而
 * 「删掉重来」是这个产品里唯一不可逆的动作(docs/01 决策 3:换句子只能删档
 * 重建)。一个说「确定要删吗」却说不出要删掉什么的确认框,等于没有确认。
 *
 * 两条 COUNT 打成一个 batch:一次往返而不是两次。数的是行不是「用户理解的
 * 单位」这一点和 deleteDossierCascade 保持一致——候选/排除是周扫的内部结构,
 * 不单独报数,否则确认框会变成一张让人看不懂的四行表。
 */
export async function countDossierChildren(db: D1Database, dossierId: string): Promise<{ scans: number; reports: number }> {
	const [scans, reports] = await db.batch<Row>([
		db.prepare("SELECT COUNT(*) AS n FROM weekly_scan WHERE dossier_id = ?1").bind(dossierId),
		db.prepare("SELECT COUNT(*) AS n FROM report WHERE dossier_id = ?1").bind(dossierId),
	]);
	return { scans: num(scans?.results?.[0]?.n), reports: num(reports?.results?.[0]?.n) };
}

/**
 * 一份档案的四个字段(会影响下一次周扫产出的那些)。**store 层不认 rev**——
 * 见下面两个函数的注释:rev 只有两个写入口,而且都在 SQL 里算,轮不到调用方给。
 */
export interface DossierContent {
	domain: string;
	caresAbout: string[];
	notCaresAbout: string[];
	queries: string[];
}

/** 新建一份档案要给的东西。rev 不在里面:第一版永远是 1,由这一层写死。 */
export interface NewDossier extends DossierContent {
	id: string;
	userEmail: string;
	sentence: string;
	createdAt: number;
	updatedAt: number;
}

/**
 * **新建**一份档案(v1 每人一份)。这个人已经有档案了 → 什么都不写,返回 null。
 *
 * 为什么是 INSERT + `DO NOTHING` 而不是原来那个 upsert(2026-09-01 第二轮评审
 * ②③,这是整个档案写入路径的核心改动):
 *
 * - 原来 handler 的写法是「先 getDossier 看有没有 → 再 putDossier 整存」。那次
 *   读和那次写之间有一个窗口,而这个窗口有**两个方向**都会出事:
 *   ① 读到 null(新用户)→ 另一个标签页在这中间存了 S1 → 这次 upsert 走冲突
 *      分支,把 `sentence` 直接改写成 S2。产品文档管 sentence 叫「基准」,
 *      结果被一次竞态安静换掉,而且 rev 因为 existing === null 也不涨。
 *   ② 读到一份档案 → 另一个标签页在这中间点了「删掉重建」→ 这次 upsert 走
 *      INSERT 分支,拿着 `existing.id` / `existing.createdAt` 把一份**已经被
 *      删掉的档案原地复活**,而它名下的周扫和报告已经删干净了。
 * - `DO NOTHING` 把①堵死在数据库里:并发的第二趟一行都改不到,返回 null,
 *   路由层回 409 让他刷新看那一份,而不是替他把基准换掉。
 * - ② 由下面的 updateDossier 堵:更新走 UPDATE,行没了就是没了,复活不了。
 *
 * `rev` 在 SQL 里写死 1,不从入参来:这是这个字段的第一个写入口,第二个(也是
 * 最后一个)是 updateDossier 里的 `rev = rev + ?`。**一个字段两条写路径是上一轮
 * 评审判定的根因**,这次拆函数没有再多造第三条——原来的 bumpDossierRev 已经
 * 并进 updateDossier 那条 UPDATE 里(它不再单独存在)。
 */
export async function createDossier(db: D1Database, d: NewDossier): Promise<Dossier | null> {
	const row = await db
		.prepare(
			`INSERT INTO dossier (id, user_email, sentence, domain, cares_about, not_cares_about, queries, rev, created_at, updated_at)
			 VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, 1, ?8, ?9)
			 ON CONFLICT(user_email) DO NOTHING
			 RETURNING *`,
		)
		.bind(
			d.id,
			d.userEmail,
			d.sentence,
			d.domain,
			JSON.stringify(d.caresAbout),
			JSON.stringify(d.notCaresAbout),
			JSON.stringify(d.queries),
			d.createdAt,
			d.updatedAt,
		)
		.first<Row>();
	// 没有行 = ON CONFLICT DO NOTHING 命中了,这个人已经有档案。不是错误,
	// 是「别人先到了」,由调用方决定怎么说
	return row ? mapDossier(row) : null;
}

/**
 * **更新**一份已有档案的内容,顺带按需涨版本。**一条语句,不是两条。**
 *
 * 这是 2026-09-01 第二轮评审 ② 的落点。原来是 `await putDossier(...)` 之后
 * `await bumpDossierRev(...)`,两句之间没有事务:用户点完保存立刻刷新(Worker
 * 请求被取消),或者第二句撞上 D1 瞬时错误,库里就是「内容已经是新版、rev 还是
 * 旧值」。之后 weekly_scan.dossier_rev 会**在内容不同的两版档案上出现同一个
 * rev**,正是上一轮判定必须修的那个归因错误换了个触发源回来。而且**救不回来**:
 * 用户再点一次保存,内容已经相同,changed = false,这一版永远补不上 rev。
 *
 * 为什么是一条 UPDATE 而不是评审建议的 `db.batch([put, bump])`:batch 能保证
 * 原子,但它仍然是两条写 rev 的路径并存(一条 INSERT/UPSERT 里的 rev、一条
 * 单独的 bump),而「两条写路径并存才是根因」是上一轮的结论。把 `rev = rev + ?`
 * 直接写进这条 UPDATE,原子性由**单条语句**给(比事务更强的保证),写路径
 * 也就只剩下 createDossier 的初值和这里的自增两处。
 *
 * `bumpRev` 传 0/1 而不是布尔:SQLite 没有布尔,而且 `rev + 0` 正好就是
 * 「这次编辑不算一次版本变更」的语义(只调了顺序,见 dossier.ts
 * sameDossierFields),不需要为它另开一条语句。
 *
 * **WHERE 里带 sentence 是有意的第二道门**:原话不许改这件事,handler 那边
 * 已经用 getDossier 比过一次,但那是 TOCTOU 读——两个标签页各自 draft 出一句
 * 不同的话时,B 的比对是在 A 落库之前做的。带上它之后,「库里那句话已经不是
 * 你以为的那句」在数据库层就更新不到任何行,返回 null。
 *
 * 返回 null 有两种可能(**这一层分不出来,也不该分**:再查一次就又是 TOCTOU):
 * 档案被删了,或者 sentence 对不上。调用方在失败路径上读一次库来分类——那次
 * 读只影响措辞,不影响是否写入,晚一步读到的结果最多让文案指错方向一次。
 *
 * 刻意**不更新** id / user_email / created_at / sentence:前三个是历史(被
 * weekly_scan.dossier_id 和 report.dossier_id 引着,换掉等于把这个人过去所有
 * 周扫和报告变成孤儿行),sentence 是基准(docs/01 决策 3:要换句子只能删档重建)。
 */
export async function updateDossier(
	db: D1Database,
	args: DossierContent & { userEmail: string; sentence: string; updatedAt: number; bumpRev: boolean },
): Promise<Dossier | null> {
	const row = await db
		.prepare(
			`UPDATE dossier SET
			   domain = ?1,
			   cares_about = ?2,
			   not_cares_about = ?3,
			   queries = ?4,
			   updated_at = ?5,
			   rev = rev + ?6
			 WHERE user_email = ?7 AND sentence = ?8
			 RETURNING *`,
		)
		.bind(
			args.domain,
			JSON.stringify(args.caresAbout),
			JSON.stringify(args.notCaresAbout),
			JSON.stringify(args.queries),
			args.updatedAt,
			args.bumpRev ? 1 : 0,
			args.userEmail,
			args.sentence,
		)
		.first<Row>();
	return row ? mapDossier(row) : null;
}

/**
 * 「删掉重来」:删档案,**并把这个档案挂着的一切一起删掉**。
 *
 * schema 里没有外键(docs/02「待站长拍板」里那条还没定),数据库不会替我们
 * 级联,所以孤儿必须在代码里清。不清的后果不是占空间那么轻:weekly_scan /
 * scan_candidate / scan_exclusion / report 全部按 dossier_id(或 scan_id)关联,
 * 档案一删,它们就再也没有任何代码路径读得到、也没有路径删得掉
 * (sweepExpired 只扫 quota 和 daily_spend)。而下一份档案会拿到**新的 id**,
 * 所以旧数据也不会「自动接上」——它只是永远躺在那儿。
 *
 * inflight 也一并清:它按 user_email 主键,不带 dossier_id。留着的话,用户删档
 * 重建之后打开页面,会看到一条指向已经不存在的档案的「正在生成…」,而那趟
 * SSE 早就结束了,前端只能一直转圈。
 *
 * **删除顺序:子行先于父行**,而且整批放进一个 `batch()`(同一个隐式事务)。
 * 分几次 await 的话,中间断一次就会留下「档案没了、周扫还在」的半截状态,
 * 那正是这个函数要消灭的东西。子行先删是因为它们要靠父行的 id 找到自己
 * (`scan_id IN (SELECT id FROM weekly_scan WHERE dossier_id = ?)`)——父行先没了,
 * 子查询就查不出任何 id,子行原地变孤儿。
 *
 * 档案不存在时返回 null(而不是抛错):删一份不存在的档案是**幂等成功**,
 * 不是失败——用户双击「删掉重来」不该在第二下看到一个红色错误。
 *
 * **quota 和 daily_spend 故意不删。**它们不是这份档案的数据,是这个人(和这个 IP)
 * 今天的用量。跟着删就等于「删档案 = 额度清零」,一条免费重置额度的通道,
 * 而且是用户点得到的那种。它们自己会过期(sweepExpired)。
 *
 * 返回值只报 scans / reports 两个数,不报候选和排除的行数:那两张表是周扫的
 * 内部结构,对用户来说「删掉了 3 周的扫描结果和 2 份报告」才是他理解的单位。
 */
export async function deleteDossierCascade(
	db: D1Database,
	email: string,
): Promise<{ dossierId: string; scans: number; reports: number } | null> {
	const existing = await getDossier(db, email);
	if (!existing) return null;
	const id = existing.id;
	// 这次读发生在 batch 之外,但它不构成 putWeeklyScan 那种竞态:两趟并发的
	// 删除会读到同一个 id、发出同样的 DELETE,第二趟只是删了个空(changes=0)。
	// 唯一会被它错过的是「读到 id 之后、批删之前刚写进来的那一周」,而那一周
	// 只可能来自同一个人正在跑的周扫——阶段 3 还没有周扫,阶段 8 接 cron 时
	// 要么让 cron 跳过没有档案的用户(它本来就要这么做),要么把这一条收进
	// 同一个 batch(需要 D1 支持带子查询的 DELETE 拿档案 id,可行但现在没必要)。
	// 语句先拼成一个数组,再按**名字**取回执(下面的 indexOf),不按下标数格子:
	// 2026-09-01 上线前终审往这一批里插了三条新语句,而原来那句
	// `.then((out) => [out[2], out[3]])` 会安静地把「删了几周」读成别的语句的行数
	// ——返回给用户的那句「删掉了 3 周的扫描结果」于是变成一个假数字,没有一处会报错。
	const scanDelete = db.prepare("DELETE FROM weekly_scan WHERE dossier_id = ?1").bind(id);
	const reportDelete = db.prepare("DELETE FROM report WHERE dossier_id = ?1").bind(id);
	const stmts = [
		db
			.prepare("DELETE FROM scan_candidate WHERE scan_id IN (SELECT id FROM weekly_scan WHERE dossier_id = ?1)")
			.bind(id),
		db
			.prepare("DELETE FROM scan_exclusion WHERE scan_id IN (SELECT id FROM weekly_scan WHERE dossier_id = ?1)")
			.bind(id),
		// 点击台账只认 scan_id,所以**必须排在删 weekly_scan 之前**:batch 是顺序
		// 执行的,周扫行先没了的话这条子查询就一行都选不出来,留下一批谁也读不到、
		// 谁也删不掉的孤儿(sweepExpired 只扫 quota 和 daily_spend)。
		db
			.prepare("DELETE FROM candidate_open WHERE scan_id IN (SELECT id FROM weekly_scan WHERE dossier_id = ?1)")
			.bind(id),
		scanDelete,
		// 这两张按 dossier_id 记账,不依赖周扫行还在不在。
		// **scan_appeal 跟着档案走**(不像 email_optout 那样刻意留下):它记的是
		// 「这个档案的这一周,你把哪个仓捞回来了」,档案没了这句话就没有主语,
		// 而且删档重建之后档案 id 是新的,旧行永远不会再被读到 —— 留着只是垃圾。
		db.prepare("DELETE FROM scan_appeal WHERE dossier_id = ?1").bind(id),
		db.prepare("DELETE FROM weekly_change WHERE dossier_id = ?1").bind(id),
		reportDelete,
		db.prepare("DELETE FROM inflight WHERE user_email = ?1").bind(email),
		// 门铃邮件的发信台账跟着档案走:它按 scan_id 记账,而周扫行马上就没了。
		// **email_optout 故意不删**——退订是用户对「别给我发信」这件事的表态,
		// 删档不该把它一并抹掉,否则「删档重建」会变成一条谁都没想到的重新订阅路径。
		// 代价是目前没有重新订阅的入口(见 docs/02 开放问题),这是明知的取舍。
		db.prepare("DELETE FROM weekly_email WHERE dossier_id = ?1").bind(id),
		db.prepare("DELETE FROM dossier WHERE id = ?1").bind(id),
	];
	const out = await db.batch(stmts);
	// 按名字取回执:两条语句对象就是上面数组里的那两个,indexOf 找的是同一性,
	// 插一条新语句进去也不会把回执错位(见上面那段注释)。
	const scanDel = out[stmts.indexOf(scanDelete)];
	const reportDel = out[stmts.indexOf(reportDelete)];
	return {
		dossierId: id,
		scans: scanDel?.meta?.changes ?? 0,
		reports: reportDel?.meta?.changes ?? 0,
	};
}

// ---------------------------------------------------------------------------
// 周扫
// ---------------------------------------------------------------------------

/**
 * 一次事务写入三张表(台账 + 候选 + 排除)。
 *
 * 必须用 `db.batch()`:D1 把一个 batch 里的语句放进**同一个隐式事务**,
 * 要么全成要么全不成。分几次 await 的话,中间任何一次网络抖动都会留下
 * 「有台账没候选」的半截周扫,而页面顶部那句诚实声明的分母正是从台账读的
 * ——分母在、分子没了,声明就成了假话。
 *
 * **重跑幂等**(ux_scan 那条 UNIQUE 的用途):cron 失败重试、站长手动补跑、
 * 用户改完档案重扫,三个触发源都会打到同一个 (dossier_id, week_of) 上。id 由
 * weeklyScanId() 从这两个值算出来,所以重跑天然落在同一行:先删这个 scan_id 的
 * 子行、再 upsert 台账、再重灌新子行,**全部在一个 batch 里**。
 *
 * **为什么 id 必须是算出来的,不能是查出来的**(2026-09-01 评审,这是这个函数
 * 唯一一处非显然的设计):早先的写法是先 `SELECT id` 认出已有行、复用旧 id。
 * 那次 SELECT 只能待在 batch 之外,于是两趟重扫会这样交错——
 *
 *   A: SELECT → 没有这一周 → (await 让出) │ B: SELECT → **还是**没有(A 没提交)
 *   A: batch 写入 id=a、计数 87、候选 X   │ B: batch:DELETE scan_id=b(空转)、
 *                                          │      台账 ON CONFLICT 命中 A 那一行,
 *                                          │      只 SET 计数=91(**id 仍是 a**),
 *                                          │      候选 Y 却按 scan_id=b 插进去
 *
 * **申诉过的那些仓也会被这次删除清掉,恢复是调用方的事**(2026-09-01 上线前
 * 终审的 A2):`DELETE FROM scan_candidate/scan_exclusion WHERE scan_id = ?` 一视
 * 同仁,而用户捞回来的那几行正躺在里面。恢复不能放在这个函数里做——它只拿到
 * 「这一趟的结果」,而恢复要的是那个仓**此刻**的 star / license / topics,那份
 * 数据在 worker/scan.ts 的 `collected.repos` 里(这一趟真的搜回来了它),不在
 * 这里。所以这个函数保持「整批换掉」的语义不变,由 runWeeklyScan 在调它之前
 * 读 `scan_appeal`(listScanAppeals)把申诉重新拌进 candidates/exclusions。
 * 这也解释了为什么 scan_appeal 必须是独立的一张表:它是唯一一样**不被这次
 * 删除波及**的申诉记录。
 *
 * 结果:台账行是 A 的 id、B 的计数,getWeeklyScan 按 A 的 id 取子行拿到候选 X。
 * **页面顶部那句诚实声明的分母来自 B 这一趟,分子来自 A 这一趟**——正是下面
 * 那段注释说要防的「分母在、分子对不上」,只是换了个更难看出来的形状。B 的
 * 候选/排除则成为永久孤儿:没有代码路径读得到,也没有路径删得掉
 * (sweepExpired 只扫 quota 和 daily_spend)。
 *
 * 这里曾经写着「触发源只有两个、不会真的并发」为自己辩护。那句话是错的:
 * 上面自己就列了三个,第三个「用户改完档案重扫」是用户点出来的,双击就并发,
 * 还能和周一早上的 cron 撞上。所以不是靠「不会撞」,是靠**结构上撞不出问题**:
 * id 算得出来 → 两趟写的是同一个 scan_id → 后到的那趟把台账和子行整体覆盖,
 * 分子分母永远来自同一趟。
 *
 * 返回实际生效的 scan id(= weeklyScanId(...)),调用方拿它做后续关联。
 */
export async function putWeeklyScan(
	db: D1Database,
	scan: NewWeeklyScan,
	candidates: NewScanCandidate[],
	exclusions: NewScanExclusion[],
): Promise<string> {
	// 算出来的,不是查出来的。这一行是上面那整段注释的全部结论:batch 之前
	// 一次库都不用读,竞态就没有落脚的地方。
	const scanId = weeklyScanId(scan.dossierId, scan.weekOf);

	const stmts: D1PreparedStatement[] = [
		// 先清子行:重跑时旧候选/旧排除必须整批换掉,不能和新的混在一起
		db.prepare("DELETE FROM scan_candidate WHERE scan_id = ?1").bind(scanId),
		db.prepare("DELETE FROM scan_exclusion WHERE scan_id = ?1").bind(scanId),
		// 冲突目标仍是 (dossier_id, week_of) 而不是 id:id 现在由这两列算出来,
		// 两个约束永远同时命中同一行,换目标没有区别;留着原样是因为它更直白地
		// 说明「一个档案一周只有一行」这条业务约束,而 ux_scan 就是为它建的。
		db
			.prepare(
				`INSERT INTO weekly_scan (id, dossier_id, week_of, dossier_rev, queries, returned, admitted, excluded, fetch_failed,
				                          route_count, claimed_total, stopped, created_at)
				 VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8, ?9, ?10, ?11, ?12, ?13)
				 ON CONFLICT(dossier_id, week_of) DO UPDATE SET
				   dossier_rev = excluded.dossier_rev,
				   queries = excluded.queries,
				   returned = excluded.returned,
				   admitted = excluded.admitted,
				   excluded = excluded.excluded,
				   fetch_failed = excluded.fetch_failed,
				   route_count = excluded.route_count,
				   claimed_total = excluded.claimed_total,
				   stopped = excluded.stopped,
				   created_at = excluded.created_at`,
			)
			.bind(
				scanId,
				scan.dossierId,
				scan.weekOf,
				scan.dossierRev,
				JSON.stringify(scan.queries),
				scan.returned,
				scan.admitted,
				scan.excluded,
				scan.fetchFailed,
				scan.routeCount,
				scan.claimedTotal,
				// 重跑时 stopped 必须跟着覆盖成 NULL:上一趟残了、这一趟跑全了,
				// 警示还挂着就是在说一件没发生的事。
				scan.stopped,
				scan.createdAt,
			),
	];

	const insCandidate = db.prepare(
		`INSERT INTO scan_candidate (scan_id, full_name, stars, pushed_at, archived, license, repo_created_at, one_liner, topics, source_route, "rank")
		 VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8, ?9, ?10, ?11)`,
	);
	for (const c of candidates) {
		stmts.push(
			insCandidate.bind(
				scanId,
				c.fullName,
				c.stars,
				c.pushedAt,
				c.archived ? 1 : 0,
				c.license,
				c.repoCreatedAt,
				c.oneLiner,
				JSON.stringify(c.topics),
				c.sourceRoute,
				c.rank,
			),
		);
	}

	const insExclusion = db.prepare(
		`INSERT INTO scan_exclusion (scan_id, full_name, reason, reason_kind, reason_source, appealed_at, pushed_at)
		 VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7)`,
	);
	for (const e of exclusions) {
		stmts.push(insExclusion.bind(scanId, e.fullName, e.reason, e.reasonKind, e.reasonSource, e.appealedAt, e.pushedAt));
	}

	// 量级(2026-09-01 阶段 4 **实测**修正,原来这里写的「候选 ~30、排除 ~50」
	// 是拍脑袋的):scripts/recall-check.ts 用 8 条检索词跑真实 GitHub,去重后
	// 拿回 **390** 个仓,于是这一批是「候选 ≤5 + 排除 ~385」,batch 里 390 条
	// INSERT 左右。每条 INSERT 只有 5-10 个绑定参数(D1 的限制是**每条语句**
	// 100 个参数,不是每个 batch),仍在可用范围内,但离「几十行」差了一个数量级,
	// 这一点必须写在这儿而不是留着那句好听的旧话。
	//
	// **这个量级已经在真 D1 上跑过了**(2026-09-01 阶段 4/5 评审):在
	// `wrangler dev --local`(miniflare 的 D1 是真 SQLite,不是测试里那个
	// node:sqlite 假 D1)上落了一批 393 条语句的 batch,没有报错,整条端点
	// 的墙钟和只落 8 行的那一趟没有可测差别 —— 也就是说这一步不是瓶颈。
	// docs/02「技术风险 1」里那条「D1 单次 batch() 的行数上限」因此从「未验证」
	// 变成「在这个量级上验过」;真正的上限仍然不知道,只知道 390 够用。
	//
	// 真到了需要分批的规模,也不能简单拆成两个 batch——那就把原子性拆没了,
	// 得先想清楚半截周扫怎么处理(而「半截周扫」正是这个函数存在的理由)。
	await db.batch(stmts);
	return scanId;
}

/**
 * 某个档案某一周的一整包(台账 + 候选 + 排除)。没有那一周就是 null。
 *
 * **候选行上的 `appealedFrom` 在这里 join 出来**(2026-09-01 阶段 4/5 评审)。
 *
 * 场景:申诉捞回来的仓,候选行上要有一枚「你捞回来的」徽记和一句「它原本因为
 * X 被排除」——而「因为什么」只记在排除行上(申诉不删排除行,只盖 appealed_at,
 * 那句理由正是这个动作最该留下的痕迹)。阶段 5 的第一屏是在**同一个响应**里按
 * 名字 join 的,那是安全的;但阶段 8 的门铃邮件如果只拿候选清单去渲染,徽记和
 * 那句理由会**安静地消失**——页面上有、邮件里没有,而没有任何东西会报错。
 *
 * **为什么选「读取侧保证 join」而不是给 scan_candidate 加一列存理由**:
 * ① 那句理由已经在同一个 scan_id 的排除行上了,再存一份就是同一件事有两个出处,
 *    而两个出处迟早只有一个是对的(申诉的 upsert 要记得写、重跑的 putWeeklyScan
 *    写不出来只能填 NULL);
 * ② 这个函数本来就要把排除行整批读出来(第一屏要显示全部 293-386 条),join 是
 *    一个 Map 查表,不多一次往返、不多一条语句;
 * ③ 加一列意味着**写入路径**多一个必须维护的不变量,而读取侧 join 是一个没有
 *    写入路径的派生值 —— 它不可能和源头分叉。
 */
export async function getWeeklyScan(
	db: D1Database,
	dossierId: string,
	weekOf: string,
): Promise<WeeklyScanBundle | null> {
	const scanRow = await db
		.prepare("SELECT * FROM weekly_scan WHERE dossier_id = ?1 AND week_of = ?2")
		.bind(dossierId, weekOf)
		.first<Row>();
	if (!scanRow) return null;
	const scanId = str(scanRow.id);
	// 两条子查询打包成一个 batch:一次往返而不是两次(D1 的每次往返都要过网络)
	const [cands, excls] = await db.batch<Row>([
		db.prepare('SELECT * FROM scan_candidate WHERE scan_id = ?1 ORDER BY "rank" ASC').bind(scanId),
		db.prepare("SELECT * FROM scan_exclusion WHERE scan_id = ?1 ORDER BY full_name ASC").bind(scanId),
	]);
	const exclusions = (excls?.results ?? []).map(mapExclusion);
	// 申诉过的那些:fullName → 当初的理由。只有申诉过的仓才会同时出现在两张表里。
	const appealedFrom = new Map<string, string>();
	for (const e of exclusions) {
		if (e.appealedAt !== null) appealedFrom.set(e.fullName, e.reason);
	}
	return {
		scan: mapScan(scanRow),
		candidates: (cands?.results ?? []).map((r) => {
			const c = mapCandidate(r);
			return { ...c, appealedFrom: appealedFrom.get(c.fullName) ?? null };
		}),
		exclusions,
	};
}

/** 某一周里某一个仓的排除行。申诉端点先拿它做校验,不用为此读整包 293 行。 */
export async function getScanExclusion(
	db: D1Database,
	scanId: string,
	fullName: string,
): Promise<ScanExclusion | null> {
	const row = await db
		.prepare("SELECT * FROM scan_exclusion WHERE scan_id = ?1 AND full_name = ?2")
		.bind(scanId, fullName)
		.first<Row>();
	return row ? mapExclusion(row) : null;
}

/**
 * 申诉:把一条排除强制搬进候选清单(docs/01 决策 4「点『这个该进来』」)。
 *
 * ## 台账等式怎么保住
 *
 * 站长 2026-09-01 拍板 `returned = admitted + excluded + fetchFailed` 必须成立。
 * 这条等式的含义是「拿回来的每一个仓,恰好落进一个去处」——它是一个**划分**,
 * 不是三个各自独立的计数器。所以申诉只能是**搬运**:admitted +1、excluded -1,
 * 总数不动。
 *
 * 为什么不另记一栏 `appealed`:那样等式要变成四项,而诚实声明那句话
 * (docs/02 写死的措辞)只有三个空——「拿回 M 个,筛掉 K 个,剩下 N 个在这里」。
 * 页面上会同时出现「筛掉 293 个」和一行摆在候选清单里、理由写着「没有许可证」
 * 的仓,那句话的两个数就都是假的:清单上有 6 行却说 5,293 里有一个正躺在
 * 清单上。**记账口径必须跟着事实走,而事实是它进来了。**
 *
 * 为什么不把排除行删掉:删了就没人知道它当初是**因为什么**被筛掉的,而
 * 「你把一个没有许可证的仓捞进来了」正是申诉这个动作最该留下的痕迹。所以行
 * 留着、`appealed_at` 盖上时间戳,只是不再被 excluded 数进去(读取侧
 * groupExclusions 把已申诉的摘出来单列,分组计数之和仍然等于 excluded)。
 *
 * ## 幂等:重复点两下不能把等式点坏
 *
 * 三条语句都写成「只在没申诉过时才动」:计数那条挂 EXISTS(appealed_at IS NULL),
 * 盖戳那条挂 WHERE appealed_at IS NULL,候选那条是 upsert。**顺序不能换**——
 * 计数必须在盖戳之前跑,否则它自己的 EXISTS 会被同一个 batch 里前一句刚盖上的
 * 戳判假,一次真申诉的计数就悄悄丢了。batch 是单事务顺序执行,这个顺序有保证。
 *
 * 并发点两下:后到的那趟 EXISTS 判假,计数不动,upsert 空转。等式仍然成立。
 *
 * `rank` 用 `MAX(rank)+1` 在 SQL 里现算,不由调用方先读一次再传进来——读进来的
 * 值和写下去的时刻之间隔着一次 await,两趟并发申诉会拿到同一个名次。算在
 * 语句里就没有这个缝。(`WHERE true` 不是凑数:SQLite 的 INSERT…SELECT 后面直接
 * 跟 ON CONFLICT 会被解析成 SELECT 的一部分,官方给的消歧写法就是它。)
 *
 * ## 永久台账:`scan_appeal`(2026-09-01 上线前终审)
 *
 * 同一个 batch 里多写一行 `scan_appeal(dossier_id, week_of, full_name, at)`。
 * 它和上面三条语句在**同一个事务**里,所以「排除行盖了戳」和「台账有这一行」
 * 不可能只发生一半。
 *
 * 为什么需要它,而 `scan_exclusion.appealed_at` 不够:重跑(`putWeeklyScan`)
 * 的第一件事就是 `DELETE FROM scan_exclusion WHERE scan_id = ?`,而 scan_id 是
 * (dossier_id, week_of) 算出来的,同一周必然撞上。于是那一列能数出来的只有
 * 「在没被重跑覆盖过的那些周里」发生过的申诉——而决策 8 的第三条规则
 * (「某个被排除的仓被站长申诉过两次」)数的正是跨周的次数。这张表还是重跑
 * 之后把申诉搬回来的唯一依据(见 putWeeklyScan 的注释)。
 *
 * 因此签名收的是 `{ dossierId, weekOf }` 而不是拼好的 scanId:两张表要写的键
 * 不一样(一个要 scan_id,一个要那两段),让调用方传一个已经拼好的 id 就得在
 * 这里把它切回去,而那是 weeklyScanId 那段注释一直在避免的第二条造 id 路径。
 *
 * @returns true = 这一次真的搬了;false = 早就申诉过了(前端据此不重复道贺)
 */
export async function appealExclusion(
	db: D1Database,
	where: { dossierId: string; weekOf: string },
	/** **不带 rank**:名次由下面那条 SQL 现算,调用方给的任何值都是错的。 */
	candidate: Omit<NewScanCandidate, "rank">,
	at: number,
): Promise<boolean> {
	const scanId = weeklyScanId(where.dossierId, where.weekOf);
	const name = candidate.fullName;
	const res = await db.batch([
		db
			.prepare(
				`UPDATE weekly_scan SET admitted = admitted + 1, excluded = excluded - 1
				 WHERE id = ?1
				   AND EXISTS (SELECT 1 FROM scan_exclusion
				               WHERE scan_id = ?1 AND full_name = ?2 AND appealed_at IS NULL)`,
			)
			.bind(scanId, name),
		db
			.prepare("UPDATE scan_exclusion SET appealed_at = ?3 WHERE scan_id = ?1 AND full_name = ?2 AND appealed_at IS NULL")
			.bind(scanId, name, at),
		db
			.prepare(
				`INSERT INTO scan_candidate (scan_id, full_name, stars, pushed_at, archived, license, repo_created_at, one_liner, topics, source_route, "rank")
				 SELECT ?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8, ?9, ?10,
				        (SELECT COALESCE(MAX("rank"), 0) + 1 FROM scan_candidate WHERE scan_id = ?1)
				 WHERE true
				 ON CONFLICT(scan_id, full_name) DO UPDATE SET
				   stars = excluded.stars,
				   pushed_at = excluded.pushed_at,
				   archived = excluded.archived,
				   license = excluded.license,
				   repo_created_at = excluded.repo_created_at,
				   one_liner = COALESCE(excluded.one_liner, scan_candidate.one_liner),
				   topics = excluded.topics,
				   source_route = excluded.source_route`,
			)
			.bind(
				scanId,
				name,
				candidate.stars,
				candidate.pushedAt,
				candidate.archived ? 1 : 0,
				candidate.license,
				candidate.repoCreatedAt,
				candidate.oneLiner,
				JSON.stringify(candidate.topics),
				candidate.sourceRoute,
			),
		// 永久台账(见函数头)。**幂等靠 DO NOTHING**:重复点两下保留第一次的时刻,
		// 那才是真正发生的事(同 optOutEmail)。这一行不随重跑消失,所以「这个仓
		// 被申诉过几周」和「重跑之后把申诉搬回来」都有据可依。
		db
			.prepare(
				`INSERT INTO scan_appeal (dossier_id, week_of, full_name, at) VALUES (?1, ?2, ?3, ?4)
				 ON CONFLICT(dossier_id, week_of, full_name) DO NOTHING`,
			)
			.bind(where.dossierId, where.weekOf, name, at),
	]);
	// 第一条语句改了几行 = 这次到底搬没搬。0 行 = 之前已经申诉过。
	return (res[0]?.meta?.changes ?? 0) > 0;
}

/**
 * 这个档案在这一周申诉过哪些仓(名字 → 第一次申诉的时刻)。
 *
 * **唯一的消费者是 runWeeklyScan 的「重跑之后把申诉搬回来」**(2026-09-01 上线前
 * 终审的 A2)。在这之前,重跑会静默清掉用户自己捞回来的仓:`putWeeklyScan` 第一件
 * 事就是按 scan_id 删光候选和排除,而 scan_id 是 (档案, 周) 算出来的,同一周必然
 * 撞上。用户花掉三次 ai 额度加三次 GitHub 调用捞回来的三行,点一下重跑就没了
 * ——而台账是重新算的,所以四个数照样自洽,页面看起来完全正常。**而且页面在
 * 台账对不上时给的提示原文就是「请把这一周重跑一次」。**
 *
 * 用 Map 而不是数组:调用方要的是「这个名字在不在里面、当初盖的是哪个时刻」,
 * 那是一次查表,不是一次遍历。
 */
export async function listScanAppeals(
	db: D1Database,
	dossierId: string,
	weekOf: string,
): Promise<Map<string, number>> {
	const out = await db
		.prepare("SELECT full_name, at FROM scan_appeal WHERE dossier_id = ?1 AND week_of = ?2")
		.bind(dossierId, weekOf)
		.all<Row>();
	return new Map((out.results ?? []).map((r) => [str(r.full_name), num(r.at)]));
}

/**
 * 「他点开了这一行」。**一次点击一行,只增不改。**
 *
 * 存在的理由是两条判据没有数据源(2026-09-01 上线前终审):
 *   docs/01 决策 8 —— 某个 topic 连续 N 周进清单且**点击数为 0**;
 *   docs/01 风险 2 —— 第二周结束时**点开的深度报告少于 2 份**就停下来复盘形态。
 *
 * 为什么 `report` 表答不了:①去重命中时它**什么都不写**(report.ts 直接 return
 * 旧那一份),于是第二周点同一个仓等于没点过——而「他又点了一次」恰恰是最强的
 * 需求信号;②它没有 week_of / scan_id,只能拿 created_at 反推是哪一周的清单,
 * 而补跑和跨周重拆都会让这个反推出错。
 *
 * 记的是**动作**不是**结果**:配额拒了、GitHub 不通、正在跑另一单,都不改变
 * 「他想看这个」这件事。所以调用点在「确认这个仓真的在这一周的清单上」之后、
 * 一切闸门和网络之前(report.ts 有同款注释)。
 */
export async function recordCandidateOpen(
	db: D1Database,
	scanId: string,
	fullName: string,
	at: number = Date.now(),
): Promise<void> {
	await db
		.prepare(
			`INSERT INTO candidate_open (scan_id, full_name, at) VALUES (?1, ?2, ?3)
			 ON CONFLICT(scan_id, full_name, at) DO NOTHING`,
		)
		.bind(scanId, fullName, at)
		.run();
}

// ---------------------------------------------------------------------------
// 「他有没有去翻上一周」(站长 2026-09-01 拍板,migration 冻结前的最后一轮)
// ---------------------------------------------------------------------------

/** 哪条端点记的这一次翻阅。**一次翻阅落两行**(跨周屏并发打两条),见下面的 docblock。 */
export type WeekViewSurface = "changes" | "scan";

export interface WeekViewNote {
	dossierId: string;
	/** 翻到的是**哪一周**(不是翻的时候是哪一周)。 */
	weekOf: string;
	surface: WeekViewSurface;
	/** 调用方显式带了 `?weekOf=` 吗。false = 页面进屏时默认取最新那一周。 */
	explicit: boolean;
	/** 这一刻库里最新的那一周(取自 weekly_scan)。null = 一次周扫都没跑过。 */
	latestWeekOf: string | null;
	at?: number;
}

/**
 * 记一次「翻」。**docs/01 风险 4 的仪器,不是功能。**
 *
 * 那条判据的原话是「第二个月诚实复盘一次:如果站长从不去翻上一周的结果,那就该
 * 把这个产品退回 skill 形态」。上一轮把「翻上一周」这个动作造出来了(跨周那一屏),
 * 但没有任何东西记录他有没有真的去翻 —— 于是复盘时能拿出来的证据只有记忆,而人对
 * 自己行为的回忆偏向乐观,**而这条判据的全部意义就是在你不想承认时逼你承认**。
 *
 * **它不上页面**(站长明确的意思):一个实时显示的「你这个月翻了 3 次」会反过来
 * 改变行为,而判据要量的恰恰是没人看着时的真实行为。落库、可查即可,复盘 SQL 在
 * docs/03。
 *
 * **写失败不往外抛。** 这是全仓唯一一个吞异常的写入,理由很具体:它是量「翻」这个
 * 动作的仪器,而把仪器的故障变成 500 就等于**仪器坏了的时候连被量的行为本身也
 * 不让发生** —— 站长点进跨周屏看到一屏红色错误,那一次「翻」就没了,而我们本来
 * 只是想数它。代价是这份历史可能有洞,所以失败要 console.error 响出来:
 * 洞可以接受,悄悄的洞不行。
 */
export async function recordWeekView(db: D1Database, v: WeekViewNote): Promise<void> {
	try {
		await db
			.prepare(
				`INSERT INTO week_view (dossier_id, week_of, surface, at, latest_week_of, explicit)
				 VALUES (?1, ?2, ?3, ?4, ?5, ?6)
				 ON CONFLICT(dossier_id, week_of, surface, at) DO NOTHING`,
			)
			.bind(v.dossierId, v.weekOf, v.surface, v.at ?? Date.now(), v.latestWeekOf, v.explicit ? 1 : 0)
			.run();
	} catch (err) {
		console.error(`store: 记不下这一次翻阅(风险 4 的仪器,不拦请求) dossier=${v.dossierId} week=${v.weekOf}`, err);
	}
}

/**
 * 这个档案**最新的那一周**是哪一周(取自 weekly_scan)。没跑过就是 null。
 *
 * 为什么参照系是 weekly_scan 而不是 weekly_change:一周可以有周扫而没有跨周记录
 * (那一周跑在跨周落库上线之前),反过来不可能 —— 周扫是那个更全的参照系,
 * 而「最新的那一周」必须对两条端点是同一个定义,否则同一次翻阅在两行上会被判成
 * 一行「翻本周」一行「翻上一周」。
 */
export async function latestScanWeek(db: D1Database, dossierId: string): Promise<string | null> {
	const row = await db
		.prepare("SELECT week_of FROM weekly_scan WHERE dossier_id = ?1 ORDER BY week_of DESC LIMIT 1")
		.bind(dossierId)
		.first<Row>();
	return row ? str(row.week_of) : null;
}

// ---------------------------------------------------------------------------
// 跨周变化(站长 2026-09-01 拍板,上线前终审)
// ---------------------------------------------------------------------------

/**
 * 一周跨周结论的**计数**部分。明细在 `WeeklyChange.diff` 里。
 *
 * 这几个数落成列(而不是每次去解析 changes_json)是给 SQL 聚合用的:决策 8 的
 * 规则要问「最近连续几周有没有变化」这类问题,而那不该拉出每一周几 KB 的 JSON。
 * **它们和明细不会分叉**——写入只有 putWeeklyChange 一个函数,列和 JSON 都是它
 * 从同一个 WeekDiff 算出来的,调用方连传一组自相矛盾的数的机会都没有。
 */
export interface WeeklyChangeCounts {
	/** 本周新进清单的仓数。 */
	appeared: number;
	/** 由活转归档的仓数(复查已经给出答案的那些不重复计,见 scan-diff.ts)。 */
	archived: number;
	/** 换了许可证的仓数。 */
	licenseChanged: number;
	/** star 跃迁的仓数(阈值见 scan-diff.ts starJumpThreshold)。 */
	starJumps: number;
	/** 复查:**本该查几个**(= 上一周清单的长度),不是查成了几个。 */
	recheckChecked: number;
	/** 复查:其中几个有变化。 */
	recheckChanged: number;
	/** 复查:其中几个没查成。**和「没了」是两件事。** */
	recheckUnchecked: number;
	/**
	 * 这一周到底有没有变化。
	 *
	 * **不是上面四个数之和 > 0**:复查报出来的变化(转归档 / 换许可证 / 仓没了)
	 * 不进那四栏,漏掉它的话,一个「上周那个仓这周归档了、别的什么都没动」的
	 * 星期会被算成「没有变化」——而那正是复查这一整条改动要报的事。
	 */
	changed: boolean;
}

/**
 * 一周的跨周结论:diff 的四类 + 复查的账 + 明细。
 *
 * **网页和邮件读的是这同一份**(家法同 ScanHonesty:后端把数字算好,前端只拼字
 * 不算数)。让网页自己再算一遍 diff 的话,同一周会有两条算法——邮件里那份是
 * cron 当时的输入算的,网页那份是此刻的库算的,两者在「上一周是哪一周」「复查
 * 查成了几个」这些地方必然分叉,而分叉之后两边都会理直气壮地印出一个数。
 */
export interface WeeklyChange {
	/** = weeklyScanId(dossierId, weekOf),和 weekly_scan 同键。 */
	scanId: string;
	dossierId: string;
	weekOf: string;
	/**
	 * 拿来比的那一周;**null = 第一周,没有可比的上一周**。
	 * 恒等于 `diff.prevWeekOf`(同一个 WeekDiff 写出来的),列存一份是为了
	 * 不解析 JSON 就能翻「上一周是哪一周」。
	 */
	prevWeekOf: string | null;
	counts: WeeklyChangeCounts;
	/** 明细。四类变化各是哪几个仓、从什么变成什么、复查逐条的结局。 */
	diff: WeekDiff;
	createdAt: number;
}

/** WeekDiff → 那几个计数列。**唯一一处**,读写两侧都不许再算第二遍。 */
function countsOf(diff: WeekDiff): WeeklyChangeCounts {
	return {
		appeared: diff.appeared.length,
		archived: diff.archivedNow.length,
		licenseChanged: diff.licenseChanged.length,
		starJumps: diff.starJumps.length,
		recheckChecked: diff.recheck.checked,
		recheckChanged: diff.recheck.changed,
		recheckUnchecked: diff.recheck.unchecked,
		changed: diff.changed,
	};
}

/**
 * 落一周的跨周结论。**一周一行,重跑覆盖**(主键就是 scan_id)。
 *
 * 调用点在 cron 里 diff 算完、**发信之前**:发信失败不该把这一周的结论一起丢掉。
 * 在这条改动之前,跨周 diff 算完只进了一封可能发不出去的邮件,而 SES 一个 403
 * 就等于那一周的候选换血和复查结论**在库里一个字都没有**——认领行不删也不重试
 * (阶段 8 的取舍),所以那封信永远不会补发。
 *
 * 入参只收一个 `diff`,不收计数:计数由 countsOf 现算。让调用方传数就等于开一条
 * 「数和明细对不上」的路,而这个产品对那种错的立场写在 ScanHonesty 上面。
 */
export async function putWeeklyChange(
	db: D1Database,
	rec: { dossierId: string; weekOf: string; diff: WeekDiff; createdAt: number },
): Promise<string> {
	const scanId = weeklyScanId(rec.dossierId, rec.weekOf);
	const c = countsOf(rec.diff);
	await db
		.prepare(
			`INSERT INTO weekly_change (scan_id, dossier_id, week_of, prev_week_of, appeared_count, archived_count,
			                            license_count, star_jump_count, recheck_checked, recheck_changed,
			                            recheck_unchecked, changed, changes_json, created_at)
			 VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8, ?9, ?10, ?11, ?12, ?13, ?14)
			 ON CONFLICT(scan_id) DO UPDATE SET
			   prev_week_of = excluded.prev_week_of,
			   appeared_count = excluded.appeared_count,
			   archived_count = excluded.archived_count,
			   license_count = excluded.license_count,
			   star_jump_count = excluded.star_jump_count,
			   recheck_checked = excluded.recheck_checked,
			   recheck_changed = excluded.recheck_changed,
			   recheck_unchecked = excluded.recheck_unchecked,
			   changed = excluded.changed,
			   changes_json = excluded.changes_json,
			   created_at = excluded.created_at`,
		)
		.bind(
			scanId,
			rec.dossierId,
			rec.weekOf,
			rec.diff.prevWeekOf,
			c.appeared,
			c.archived,
			c.licenseChanged,
			c.starJumps,
			c.recheckChecked,
			c.recheckChanged,
			c.recheckUnchecked,
			c.changed ? 1 : 0,
			JSON.stringify(rec.diff),
			rec.createdAt,
		)
		.run();
	return scanId;
}

/**
 * 行 → WeeklyChange。**changes_json 解析不了时返回 null**(调用方当这一周没有
 * 跨周记录),而不是拿一份空明细配着一组完整的计数回去:那样页面会印出
 * 「4 个仓有变化」然后底下一行都不列,正是 docs/01 风险 1 说的「错得很安静」。
 * 处置口径抄的是 report.ts 的 parseStored(payload 坏了就当没有,并且要响)。
 */
function mapWeeklyChange(r: Row): WeeklyChange | null {
	let diff: WeekDiff;
	try {
		diff = JSON.parse(str(r.changes_json)) as WeekDiff;
		// 只做一次形状体检:四个数组任缺一个,下游 .map/.length 就会当场炸,
		// 而那时错误看起来会像页面的 bug,不像库里那一行的问题。
		//
		// `recheck.unchanged` 也在体检里(2026-09-01 冻结前最后一轮):它是这一轮
		// 新加的字段,而下游(网页的「查过,没事」那一栏、将来的邮件模板)会直接
		// `.map` 它。**故意不做「缺了就当空数组」的兜底** —— 那会让一份 5 个仓
		// 全都平安的复查渲染成「查过没事:0 个」,字面不报错,读起来却像什么都
		// 没查到。宁可当这一行不存在并响一声(口径同下面那句 console.error)。
		if (!Array.isArray(diff.appeared) || !Array.isArray(diff.archivedNow) || !Array.isArray(diff.licenseChanged) || !Array.isArray(diff.starJumps) || !diff.recheck || !Array.isArray(diff.recheck.unchanged)) {
			throw new Error("changes_json 的形状不是 WeekDiff");
		}
	} catch (err) {
		console.error(`store: weekly_change 的明细解析不了,当这一周没有跨周记录(scan_id=${str(r.scan_id)})`, err);
		return null;
	}
	return {
		scanId: str(r.scan_id),
		dossierId: str(r.dossier_id),
		weekOf: str(r.week_of),
		prevWeekOf: r.prev_week_of == null ? null : str(r.prev_week_of),
		counts: {
			appeared: num(r.appeared_count),
			archived: num(r.archived_count),
			licenseChanged: num(r.license_count),
			starJumps: num(r.star_jump_count),
			recheckChecked: num(r.recheck_checked),
			recheckChanged: num(r.recheck_changed),
			recheckUnchecked: num(r.recheck_unchecked),
			changed: num(r.changed) === 1,
		},
		diff,
		createdAt: num(r.created_at),
	};
}

/**
 * 某个档案某一周的跨周结论。没有那一周(第一周之前、或者那一周是在这条改动
 * 上线之前跑的)就是 null —— 网页据此显示「这一周没有跨周记录」,而不是编一个
 * 「没有变化」出来:**「没记过」和「记了、没变化」是两句不同的话。**
 */
export async function getWeeklyChange(
	db: D1Database,
	dossierId: string,
	weekOf: string,
): Promise<WeeklyChange | null> {
	const row = await db
		.prepare("SELECT * FROM weekly_change WHERE dossier_id = ?1 AND week_of = ?2")
		.bind(dossierId, weekOf)
		.first<Row>();
	return row ? mapWeeklyChange(row) : null;
}

/**
 * 最近一周的跨周结论(不传 weekOf 时走它)。
 *
 * 按 week_of 倒序而不是 created_at:补跑的那一周 created_at 是补跑当天,拿它
 * 排序会把上上周排到最新(同 listRecentScans 的理由)。
 */
export async function latestWeeklyChange(db: D1Database, dossierId: string): Promise<WeeklyChange | null> {
	const row = await db
		.prepare("SELECT * FROM weekly_change WHERE dossier_id = ?1 ORDER BY week_of DESC LIMIT 1")
		.bind(dossierId)
		.first<Row>();
	return row ? mapWeeklyChange(row) : null;
}

/**
 * 最近 n 周的台账,新的在前。第二周的 diff 靠它:取最近两条,比对候选清单。
 * 按 week_of 排序而不是 created_at —— 补跑的那一周 created_at 是补跑当天,
 * 拿它排序会把 2026-W35 的补跑排到 W36 后面去。
 */
export async function listRecentScans(db: D1Database, dossierId: string, n: number): Promise<WeeklyScan[]> {
	const out = await db
		.prepare("SELECT * FROM weekly_scan WHERE dossier_id = ?1 ORDER BY week_of DESC LIMIT ?2")
		.bind(dossierId, Math.max(1, Math.floor(n)))
		.all<Row>();
	return (out.results ?? []).map(mapScan);
}

// ---------------------------------------------------------------------------
// 报告
// ---------------------------------------------------------------------------

export async function putReport(db: D1Database, r: Report): Promise<void> {
	await db
		.prepare(
			`INSERT INTO report (id, dossier_id, full_name, commit_sha, dossier_rev, payload_json, est_usd, anchored_ratio, created_at)
			 VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8, ?9)
			 ON CONFLICT(id) DO UPDATE SET
			   payload_json = excluded.payload_json,
			   est_usd = excluded.est_usd,
			   anchored_ratio = excluded.anchored_ratio,
			   created_at = excluded.created_at`,
		)
		.bind(r.id, r.dossierId, r.fullName, r.commitSha, r.dossierRev, r.payloadJson, r.estUsd, r.anchoredRatio, r.createdAt)
		.run();
}

export async function getReport(db: D1Database, id: string): Promise<Report | null> {
	const row = await db.prepare("SELECT * FROM report WHERE id = ?1").bind(id).first<Row>();
	return row ? mapReport(row) : null;
}

/**
 * 同一个档案 + 同一个仓 + 同一个 commit + **同一版档案**已经跑过就直接返回
 * 旧报告,不重跑。这是省钱的主力:一份报告 $0.4-0.6,而用户点两次同一行是
 * 最常见的操作。commit_sha 进键是因为仓有新提交时报告就该重跑——沿用它做
 * 去重键,「什么时候该重跑」就有了一个客观判据,不用猜。
 *
 * **dossier_rev 也在键里**(站长 2026-09-01 拍板,阶段 7 评审必须修 3)。
 * 少了它,失败场景正好是 docs/01 风险 3 的缓解动作本身:用户看到一堆「真但
 * 无用」的 takeaway,回去改 `caresAbout`(rev + 1),再点同一个仓 —— 拿回的
 * 是按**旧** `caresAbout` 跑的旧报告,`caresAboutIndex` 指的是旧快照,而
 * `Report.tsx` 只印「档案 v3」不和当前 rev 比对,页面上没有任何东西说这一份
 * 过时了。代价是改过档案再拆同一个仓要再扣一份额度,所以清单页那句代价说明
 * 必须同步写上(Scan.tsx)。
 */
export async function findReport(
	db: D1Database,
	dossierId: string,
	fullName: string,
	commitSha: string,
	dossierRev: number,
): Promise<Report | null> {
	const row = await db
		.prepare(
			`SELECT * FROM report
			 WHERE dossier_id = ?1 AND full_name = ?2 AND commit_sha = ?3 AND dossier_rev = ?4
			 ORDER BY created_at DESC LIMIT 1`,
		)
		.bind(dossierId, fullName, commitSha, dossierRev)
		.first<Row>();
	return row ? mapReport(row) : null;
}

/**
 * 某个仓**最近一次**的报告,不限 commit(第一屏那个「上次拆的结果」入口)。
 *
 * 和 findReport 是两件事,别合并:findReport 的 commit + rev 是**去重**口径
 * (同一个 commit 别重烧 $0.4-0.6),而这里要回答的是「我上次看到的那份在哪」
 * ——页面上那个入口只知道仓名,它不知道也不该知道当时是哪个 commit。
 *
 * 走 `ix_report_latest`(dossier_id, full_name, created_at DESC),索引就是为这条
 * 查询建的。**2026-09-01 上线前终审从 report.ts 搬过来的**:那边是全仓唯一一处
 * 写在 store 之外的 SQL,而这个文件第一行就写着 SQL 全收在这里,理由是配额和
 * 花费闸的正确性全靠单条语句的原子性——一旦路由层能自己写 SQL,迟早会出现
 * 一段「先 SELECT 看看够不够,再 UPDATE」。规矩破一次和没有规矩是一回事。
 */
export async function latestReport(db: D1Database, dossierId: string, fullName: string): Promise<Report | null> {
	const row = await db
		.prepare("SELECT * FROM report WHERE dossier_id = ?1 AND full_name = ?2 ORDER BY created_at DESC LIMIT 1")
		.bind(dossierId, fullName)
		.first<Row>();
	return row ? mapReport(row) : null;
}

// ---------------------------------------------------------------------------
// 在跑的一单
// ---------------------------------------------------------------------------

/** 一人同时至多一趟,整存整取覆盖写(user_email 就是主键)。 */
export async function putInflight(db: D1Database, email: string, rec: InflightRecord): Promise<void> {
	await db
		.prepare(
			`INSERT INTO inflight (user_email, full_name, phase, started_at, updated_at) VALUES (?1, ?2, ?3, ?4, ?5)
			 ON CONFLICT(user_email) DO UPDATE SET
			   full_name = excluded.full_name,
			   phase = excluded.phase,
			   started_at = excluded.started_at,
			   updated_at = excluded.updated_at`,
		)
		.bind(email, rec.fullName, rec.phase, rec.startedAt, rec.updatedAt)
		.run();
}

export async function getInflight(db: D1Database, email: string): Promise<InflightRecord | null> {
	const row = await db.prepare("SELECT * FROM inflight WHERE user_email = ?1").bind(email).first<Row>();
	if (!row) return null;
	return {
		fullName: str(row.full_name),
		phase: str(row.phase),
		startedAt: num(row.started_at),
		updatedAt: num(row.updated_at),
	};
}

export async function clearInflight(db: D1Database, email: string): Promise<void> {
	await db.prepare("DELETE FROM inflight WHERE user_email = ?1").bind(email).run();
}

// ---------------------------------------------------------------------------
// 配额(docs/02 决策 T2 末段 / T6)
// ---------------------------------------------------------------------------

/**
 * 两种花钱的动作,各记一个日计数器:
 *   gen  一份深度报告 —— 抓十几份材料 + 两次 pro 调用(带 thinking),$0.4-0.6
 *   ai   编辑侧的单次调用 —— 一句话拆档案、改字段,flash,~$0.002
 *
 * 粗到按请求而不是按 token,是因为这道闸防的是失控脚本,不是正常人的手速。
 */
export type QuotaKind = "gen" | "ai";

/** 当日已用次数。没有当天的条目 = 全 0。 */
export interface QuotaUsed {
	gen: number;
	ai: number;
}

/**
 * 每人每日上限。
 *
 * **gen 是 2 不是 001 的 5**:001 的一次 gen 是一期简报(几分钱),003 的一次 gen
 * 是一份 $0.4-0.6 的深度报告。照抄 001 的 5 就是单人每天最多 $3,一个人就能把
 * DAILY_SPEND_CAP_USD 打满。2 份/天配上 $3 的全局闸,要 3 个人同一天各自打满
 * 才碰得到全局那道保险丝(docs/02 决策 T6 的算术)。
 */
export const QUOTA_LIMITS: Record<QuotaKind, number> = { gen: 2, ai: 30 };

/**
 * 每个出口 IP 每日上限。登录是开放的南屿账号,按账号的额度挡不住开小号;
 * 这一层把同一 IP 下所有账号合计封顶。
 *
 * gen 取 3 而不是账号上限的 2 倍(4):003 的 gen 太贵,宁可让「家里两个人
 * 同时用」这种罕见场景轻微误伤(误伤了来找站长,提额只要改一个常数),
 * 也不给小号留出整整两倍的空间。ai 便宜,仍沿用 001 的 2 倍。
 */
export const IP_QUOTA_LIMITS: Record<QuotaKind, number> = { gen: 3, ai: 60 };

/** 按 IP 计数的额度主体。IP 地址里没有 @,和邮箱主体天然不冲突。 */
export const ipQuotaSubject = (ip: string) => `ip#${ip}`;

/**
 * 占一次额度:**先占位,后干活**。
 *
 * 自增与判上限必须落在**同一句 SQL** 里。直觉写法是
 *   SELECT used → 在 JS 里判断够不够 → UPDATE used = used + 1
 * 三步之间有两个 await,同一个人两个标签页同时点「拆开看看」时,两个请求
 * 都读到 1、都判断没超 2、都写成 2 —— 实际跑了两份、烧了 $1,而计数器说
 * 只用了 2 次。这不是理论风险,双击就能复现。
 *
 * 所以用 SQLite 的条件 upsert:`DO UPDATE ... WHERE quota.used < ?4`。
 * `RETURNING` **无行返回 = 占位失败 = 调用方必须返回 429**,一行代码都别往下走。
 *
 * 三条配套的规矩(与 001 一致,别在调用点自己发明):
 *   1. 先占位后干活。占完位才去调模型。
 *   2. 占位失败直接 429,不重试、不降级。
 *   3. **模型报错不退还**。它跑过了,token 可能已经花掉;退还等于给
 *      「失败就疯狂重试」开一条免费通道。只有确定一个 token 都没花的路径
 *      (例如被后一道闸拦下)才用 refundQuota。
 */
export async function reserveQuota(
	db: D1Database,
	subject: string,
	kind: QuotaKind,
	limit: number = QUOTA_LIMITS[kind],
	day: string = todayUtc(),
): Promise<{ ok: boolean; used: number }> {
	// 上限 < 1 时那句 SQL 拦不住:没有冲突行的话走的是 INSERT 分支,而 WHERE
	// 只挂在 DO UPDATE 上,第一次占位会带着 used=1 直接插进去。所以在这里挡掉。
	// (limit >= 1 时这个洞不存在:第一次占位本来就该放行。)
	if (limit < 1) return { ok: false, used: 0 };
	const row = await db
		.prepare(
			`INSERT INTO quota(subject, day, kind, used) VALUES (?1, ?2, ?3, 1)
			   ON CONFLICT(subject, day, kind) DO UPDATE SET used = used + 1
			   WHERE quota.used < ?4
			 RETURNING used`,
		)
		.bind(subject, day, kind, limit)
		.first<Row>();
	// 无行 = 条件不成立 = 已经到上限。到上限时用量必然正好等于 limit。
	if (!row) return { ok: false, used: limit };
	return { ok: true, used: num(row.used) };
}

/**
 * 退还一次额度。**只用在确定一个 token 都没花的失败路径上**——典型是账号额度
 * 占位成功但随后的 IP 闸或花费闸把请求拦下了,那一步之前什么都没跑。
 * 模型报错不在此列(见 reserveQuota 的规矩 3)。
 */
export async function refundQuota(
	db: D1Database,
	subject: string,
	kind: QuotaKind,
	day: string = todayUtc(),
): Promise<void> {
	// used > 0 的条件挡住把计数写成负数(重复退还、或者根本没占过位就退)
	await db
		.prepare("UPDATE quota SET used = used - 1 WHERE subject = ?1 AND day = ?2 AND kind = ?3 AND used > 0")
		.bind(subject, day, kind)
		.run();
}

/** 当日两个计数器的已用量,给前端的额度读数用。 */
export async function getQuota(db: D1Database, subject: string, day: string = todayUtc()): Promise<QuotaUsed> {
	const out = await db
		.prepare("SELECT kind, used FROM quota WHERE subject = ?1 AND day = ?2")
		.bind(subject, day)
		.all<Row>();
	const used: QuotaUsed = { gen: 0, ai: 0 };
	for (const row of out.results ?? []) {
		const kind = str(row.kind);
		if (kind === "gen" || kind === "ai") used[kind] = num(row.used);
	}
	return used;
}

// ---------------------------------------------------------------------------
// 全局花费闸(docs/02 决策 T6)—— 001/002 都没有,003 是本仓第一个
// ---------------------------------------------------------------------------

/**
 * 全体用户每天合计的预估花费上限,美元。
 *
 * $3 的算术:单份报告 $0.4-0.6,账号上限 2 份 = 单人最多 $1.2,所以要 3 个人
 * 同一天各自打满才碰得到这道闸。碰到了是**好信号**(真有人在用),手动提额即可。
 * 打满时返回 429 并写「今天的预算用完了,明天再来」——把成本上限印在产品脸上,
 * 本身就是有限性最诚实的演示。
 */
export const DAILY_SPEND_CAP_USD = 3;

/**
 * 按**预估值**占一笔花费,原子。
 *
 * 两件事必须说清楚:
 *
 * 1. **必须在跑之前占位,不是跑完按实付累加。** 跑完才记账的话,10 个并发请求
 *    会同时看到「今天才花了 $0.1」然后一起放行,等它们跑完时账上已经 $5 了——
 *    而这道闸的全部意义就是不让那一刻发生。宁可按估高的值占,也不能事后补记。
 *
 * 2. **必须是一句 SQL。** 理由与 reserveQuota 完全相同:读出来再判断再写回,
 *    中间那两个 await 就是并发穿过去的门。
 *
 * 代价是估不准时会浪费额度(实付 $0.3 却占了 $0.5)。这是有意的偏保守——
 * 这道闸是保险丝不是账本,宁可早一点熔断,也不要晚一点。真实花费的对账
 * 留给 observability,不在这条路径上。
 */
export async function reserveSpend(
	db: D1Database,
	estUsd: number,
	cap: number = DAILY_SPEND_CAP_USD,
	day: string = todayUtc(),
): Promise<{ ok: boolean; spent: number }> {
	// 单笔就超过全天上限:那句 SQL 的 WHERE 只挂在 DO UPDATE 上,当天第一笔
	// 走 INSERT 分支会绕过它。在这里挡掉,否则一笔 $10 的估值能安静地进账。
	// NaN 也在这里被挡掉(!(NaN >= 0) 为真)——NaN 进了 SQL 会把整列污染成 NULL。
	if (!(estUsd >= 0) || estUsd > cap) return { ok: false, spent: await spendToday(db, day) };
	const row = await db
		.prepare(
			`INSERT INTO daily_spend(day, est_usd) VALUES (?1, ?2)
			   ON CONFLICT(day) DO UPDATE SET est_usd = daily_spend.est_usd + ?2
			   WHERE daily_spend.est_usd + ?2 <= ?3
			 RETURNING est_usd`,
		)
		.bind(day, estUsd, cap)
		.first<Row>();
	if (!row) return { ok: false, spent: await spendToday(db, day) };
	return { ok: true, spent: num(row.est_usd) };
}

/**
 * **无条件**记一笔花费,不看上限、不会失败(除了 D1 本身挂了)。
 *
 * 它补的是 2026-09-01 阶段 1-2 评审留下的那半个洞(guard.ts spendsOffOurAccount
 * 的函数头写着「等阶段 7 真有 AI 调用点了再做」):站长专线配好了、但网关那一刻
 * 挂了时,`ai.ts` 的 `complete()` 会拿 fallback(= base 配置)重试一次,钱同样
 * 落回我们自己的 DeepSeek 账上 —— 而这一趟在闸口早就被 `spendsOffOurAccount`
 * 放过了。
 *
 * **为什么不能在闸口补。** 占位必须发生在调用之前(否则 10 个并发会一起看到
 * 「今天才花了 $0.1」),而闸口那一层根本看不见后面会不会回落。结构上补不了。
 *
 * **为什么是 addSpend 而不是 reserveSpend。** 这笔钱**已经花掉了**——回落那次
 * 调用是真的发出去的。拿 reserveSpend 记的话,超过 $3 时它会返回 `ok: false`
 * 然后**什么都不写**,于是账上永远停在 $3,而真实花费还在往上走。这道闸是
 * 保险丝,而保险丝烧断之后电表不能跟着停:**闸不拦,但账要有。**
 *
 * 它的作用是让**下一个**请求撞到已经被顶高的当日花费上,从而真的被拦住。
 */
export async function addSpend(db: D1Database, usd: number, day: string = todayUtc()): Promise<number> {
	// NaN / 负数进了 SQL 会把整列污染成 NULL 或往回退,和 reserveSpend 同一道门
	if (!(usd > 0)) return spendToday(db, day);
	const row = await db
		.prepare(
			`INSERT INTO daily_spend(day, est_usd) VALUES (?1, ?2)
			   ON CONFLICT(day) DO UPDATE SET est_usd = daily_spend.est_usd + ?2
			 RETURNING est_usd`,
		)
		.bind(day, usd)
		.first<Row>();
	return row ? num(row.est_usd) : usd;
}

/** 今天已占位的预估花费。给 /api/health 和站长后台看用。 */
export async function spendToday(db: D1Database, day: string = todayUtc()): Promise<number> {
	const row = await db.prepare("SELECT est_usd FROM daily_spend WHERE day = ?1").bind(day).first<Row>();
	return row ? num(row.est_usd) : 0;
}

// ---------------------------------------------------------------------------
// 过期清理
// ---------------------------------------------------------------------------

/** 额度条目留 7 天:够回看这一周,再往前没有任何用途。 */
export const QUOTA_RETAIN_DAYS = 7;
/** 日花费留 30 天:够看一个月的成本曲线,判断要不要调 DAILY_SPEND_CAP_USD。 */
export const SPEND_RETAIN_DAYS = 30;

/**
 * 删掉过期的配额行和日花费行。
 *
 * 001 靠 DynamoDB 的原生 TTL,写入时带一个 ttl 属性就不用管了;**D1 没有这种
 * 东西**,不主动删就永远留着。留着的后果不只是占空间——quota 表会随天数和
 * 用户数线性膨胀,而它是全站最热的写入表,索引越大写越慢。
 *
 * 阶段 8 的 cron(每周一 08:00)顺手调一次即可:一周删一次,最多多留 7 天的
 * 垃圾,完全够用,不值得为它单开一个定时器。本阶段只写函数,不接 cron。
 *
 * 比较用字符串:day 是 YYYY-MM-DD,字典序即时间序,不需要日期函数。
 */
export async function sweepExpired(db: D1Database, at: number = Date.now()): Promise<{ quota: number; spend: number }> {
	const [q, s] = await db.batch([
		db.prepare("DELETE FROM quota WHERE day < ?1").bind(dayUtcBefore(QUOTA_RETAIN_DAYS, at)),
		db.prepare("DELETE FROM daily_spend WHERE day < ?1").bind(dayUtcBefore(SPEND_RETAIN_DAYS, at)),
	]);
	return { quota: q?.meta?.changes ?? 0, spend: s?.meta?.changes ?? 0 };
}

// ---------------------------------------------------------------------------
// 阶段 8:cron 要的读路径 + 门铃邮件的发信台账
// ---------------------------------------------------------------------------

/**
 * 全部档案,建档早的在前。**cron 每周一遍历的就是它。**
 *
 * 「遍历所有有档案的用户」而不是「遍历所有用户」,这句话在这里是一条 SQL 事实
 * 而不是一句自觉:没建档案的人在这张表里根本没有行,cron 想给他跑也跑不了。
 * 这顺带补上了 deleteDossierCascade 注释里记的那个窄窗口——「读到档案 id 之后、
 * 批删之前刚写进来的那一周」只可能来自还认得这个档案的 cron,而 cron 的用户
 * 名单就是这张表的一次快照,档案删掉之后的下一趟自然不再包含他。
 *
 * `limit` 是保险不是分页:用户长到几千人时,一次把几千行档案读进 Worker 内存
 * 是一件应该先被人看见的事(cron.ts 会在超过上限时记一条日志),而不是安静地
 * 变慢。真到那一天,解法是决策 T5 写的「按用户分片到多个 cron 时刻」。
 *
 * **排序是「建档早的在前」,而这在容量上是一条不公平的线**(2026-09-01 上线前
 * 终审记下,当前用户数下不咬人,所以留到上线后再改,见 docs/02「上线后再说」):
 * cron 的整趟预算是 13 分钟,撞上预算之后被记 `notReached` 的永远是**最后注册
 * 的那几个人**——每周同一个顺序,所以那不是「这周运气差」,是「他们每周什么
 * 都收不到」,而唯一的痕迹是收工日志里一个整数。真实容量:带 PAT 约 20-25 人、
 * 不带 PAT 约 6 人(不是这里 limit 写的 500)。改法不用动 schema:按「最久没
 * 扫到的排前面」排(`MAX(week_of)` 从 weekly_scan 现算),饿死就变成轮流。
 */
export async function listDossiers(db: D1Database, limit = 500): Promise<Dossier[]> {
	const out = await db
		.prepare("SELECT * FROM dossier ORDER BY created_at ASC, id ASC LIMIT ?1")
		.bind(Math.max(1, Math.floor(limit)))
		.all<Row>();
	return (out.results ?? []).map(mapDossier);
}

/**
 * 某一趟周扫的候选清单,**只要候选不要排除**。
 *
 * 存在的理由是跨周 diff 的成本:getWeeklyScan 会把排除行整批读出来(实测一周
 * 386 行),而 diff 只需要上一周的 ≤5 行候选。cron 一趟要给每个用户读一次上一周,
 * 用整包去换四个字段是把一件按用户数线性增长的读放大了 70 倍。
 *
 * **返回的 `appealedFrom` 恒为 null**——它是 getWeeklyScan 用排除行 join 出来的,
 * 这里没读排除行就给不出来。这不影响 diff(diff 只看名字、star、归档、许可证),
 * 但**别拿它去渲染邮件正文**:那条路要的是「你捞回来的」那枚徽记,必须走
 * getWeeklyScan(理由写在那个函数的注释里,它点名提醒过门铃邮件)。
 */
export async function listScanCandidates(db: D1Database, scanId: string): Promise<ScanCandidate[]> {
	const out = await db
		.prepare('SELECT * FROM scan_candidate WHERE scan_id = ?1 ORDER BY "rank" ASC')
		.bind(scanId)
		.all<Row>();
	return (out.results ?? []).map(mapCandidate);
}

/** 一封门铃邮件的发信台账行。 */
export interface WeeklyEmailRecord {
	scanId: string;
	dossierId: string;
	weekOf: string;
	userEmail: string;
	claimedAt: number;
	/** null = 认领了但没发成(见 cron.ts sendDoorbell:不重试、不删行)。 */
	sentAt: number | null;
	error: string | null;
}

function mapWeeklyEmail(r: Row): WeeklyEmailRecord {
	return {
		scanId: str(r.scan_id),
		dossierId: str(r.dossier_id),
		weekOf: str(r.week_of),
		userEmail: str(r.user_email),
		claimedAt: num(r.claimed_at),
		sentAt: r.sent_at === null || r.sent_at === undefined ? null : num(r.sent_at),
		error: r.error === null || r.error === undefined ? null : str(r.error),
	};
}

/**
 * 抢「这一周给这个人发信」这件事的所有权。**抢到返回 true,没抢到返回 false。**
 *
 * 整个「邮件只发一次」就是这一条语句:`ON CONFLICT DO NOTHING RETURNING` 让
 * 「有没有发过」和「登记我要发」变成同一次原子写。不这么写的话就得是
 * 「先查一次有没有,没有就发,发完再写一行」——cron 重试和站长手动补跑交错进来,
 * 两趟都会读到「还没发过」,信就发两封(和 reserveQuota 防的是同一类竞态,
 * 理由见本文件顶部那段注释)。
 *
 * 调用点的顺序必须是**先抢再发**:先发再登记的话,发成功后写库失败就会重发。
 */
export async function claimWeeklyEmail(
	db: D1Database,
	rec: { scanId: string; dossierId: string; weekOf: string; userEmail: string },
	at: number = Date.now(),
): Promise<boolean> {
	const out = await db
		.prepare(
			`INSERT INTO weekly_email (scan_id, dossier_id, week_of, user_email, claimed_at, sent_at, error)
			 VALUES (?1, ?2, ?3, ?4, ?5, NULL, NULL)
			 ON CONFLICT(scan_id) DO NOTHING
			 RETURNING scan_id`,
		)
		.bind(rec.scanId, rec.dossierId, rec.weekOf, rec.userEmail, at)
		.all<Row>();
	// 有行 = 这一趟插进去了 = 所有权归我;无行 = 已经有人抢过了
	return (out.results ?? []).length > 0;
}

/**
 * 给已认领的那一行盖结果。`error` 为 null 表示发出去了。
 *
 * **失败也只盖 error、不删行**:删了行下一次重试就会重发,而我们宁可丢一封
 * (清单本来就在网页上,邮件只是门铃)也不愿意发两封。站长要看哪几封没发成,
 * 就查 sent_at IS NULL 的行。
 */
export async function markWeeklyEmail(
	db: D1Database,
	scanId: string,
	result: { sentAt: number } | { error: string },
): Promise<void> {
	const sentAt = "sentAt" in result ? result.sentAt : null;
	const error = "error" in result ? result.error.slice(0, 500) : null;
	await db.prepare("UPDATE weekly_email SET sent_at = ?2, error = ?3 WHERE scan_id = ?1").bind(scanId, sentAt, error).run();
}

/** 某一周那封信的台账行(测试和排障用)。 */
export async function getWeeklyEmail(db: D1Database, scanId: string): Promise<WeeklyEmailRecord | null> {
	const row = await db.prepare("SELECT * FROM weekly_email WHERE scan_id = ?1").bind(scanId).first<Row>();
	return row ? mapWeeklyEmail(row) : null;
}

/**
 * 一键退订:只关掉**邮件**,周扫照跑、网页照常能看。
 *
 * 幂等(重复退订、Gmail 的一键退订 POST 和用户自己点的 GET 前后脚到)——
 * `ON CONFLICT DO NOTHING` 保留第一次退订的时刻,那才是真正发生的事。
 */
export async function optOutEmail(db: D1Database, email: string, at: number = Date.now()): Promise<void> {
	await db
		.prepare("INSERT INTO email_optout (user_email, at) VALUES (?1, ?2) ON CONFLICT(user_email) DO NOTHING")
		.bind(email, at)
		.run();
}

/**
 * 重新订阅:把退订那一行删掉(阶段 9,站长 2026-09-01 拍板)。
 *
 * **和 optOutEmail 写的是同一张表 `email_optout`,而且是唯一的另一个写入方。**
 * 这一条不是随口写的:退订有两条入口(邮件里的一键退订链接 GET/POST /unsub,
 * 和第一屏那个开关),而「两处状态必须一致」的唯一结构性保证,就是它们最终
 * 落在同一张表的同一行上 —— 而不是各写各的、再由某个地方去同步。开关如果写
 * 另一张表(比如 dossier 上加一列 email_on),就会出现「档案说在收、optout 说
 * 退订了」这种没有任何一层报错的分叉,而分叉之后 cron 读的是 isOptedOut,于是
 * 用户在页面上看着「在收」却永远收不到信。
 *
 * 幂等:没退订过的人调它是删了个空(changes = 0),不报错。
 *
 * **不恢复退订时刻**:重新订阅之后再退订会记新的时刻,那才是真正发生的事。
 */
export async function resubscribeEmail(db: D1Database, email: string): Promise<void> {
	await db.prepare("DELETE FROM email_optout WHERE user_email = ?1").bind(email).run();
}

/**
 * 这个人退订过没有。cron 发信前问一次,第一屏那个开关也问同一个函数。
 *
 * **两条路读的是同一个函数、同一张表**(见 resubscribeEmail):页面上显示的
 * 状态和 cron 实际据以决定发不发信的状态,在结构上不可能不一致。
 */
export async function isOptedOut(db: D1Database, email: string): Promise<boolean> {
	const row = await db.prepare("SELECT 1 AS x FROM email_optout WHERE user_email = ?1").bind(email).first<Row>();
	return row !== null;
}
