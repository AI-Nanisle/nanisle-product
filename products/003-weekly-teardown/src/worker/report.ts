// 阶段 7 · 深度报告两节 + SSE(docs/01 决策 6/7,docs/02 决策 T1/T4/T6/T7)。
//
//   POST /api/report            跑一份报告。**SSE 流式**,除非命中去重(那时回 JSON)
//   GET  /api/report/inflight   刷新之后接回进度
//   GET  /api/report?id=…       取一份已经生成的报告(或 ?weekOf=&fullName=)
//
// 这个文件里有四件事,顺序不能换,换了整套可信度就没了:
//
//   ① **先抓后写**。所有材料(repo 字段、releases.atom、HN 帖与评论、文件树、
//      ≤5 份源码正文)必须先抓到手,再喂给模型,最后用抓到的原文校验模型的引文。
//      反过来做(模型先写、再去找证据)在结构上就是「带引用生成」,而那正是
//      docs/01 决策 6 要防的东西 —— 引用本身也会幻觉。
//   ② **锚定在模型之外做**,纯字符串,一分钱 token 不花(shared/anchor.ts)。
//   ③ **事实层灰显、判断层丢弃**(anchor.ts 的注释里有完整论证,别顺手统一)。
//   ④ **SSE + 10 秒心跳**,四个组成部分一个都不能少(见 POST 那段注释)。
//
// 相对 import 一律带 `.ts` 后缀,理由同 guard.ts 顶部(node --test 的 ESM 解析器
// 不补后缀)。

import { Hono } from "hono";
import { AiConfigError, AiError, complete, resolveProvider } from "../shared/ai.ts";
import { anchorAcross, anchoredRatio, describeGate, gateTakeaways } from "../shared/anchor.ts";
import type { AnchorHit, Evidence, SourceId, Takeaway } from "../shared/anchor.ts";
import { changelogPermalink, changelogSource, parseReleasesAtom } from "../shared/changelog.ts";
import type { ChangelogEntry } from "../shared/changelog.ts";
import { GITHUB_WEB_BASE, GithubClient, GithubError, RateBudgetError } from "../shared/github.ts";
import type { GithubRepo } from "../shared/github.ts";
import { HN_COMMENT_CANDIDATES, HnClient, hnPermalink } from "../shared/hn.ts";
import type { HnComment, HnCommentOrder, HnStory } from "../shared/hn.ts";
import { MAX_PICKED_FILES, pickFiles } from "../shared/source-pick.ts";
import {
	HISTORY_TAKEAWAY_LIMIT,
	HN_PICK_LIMIT,
	REPORT_CALL_EST_USD,
	REPORT_EST_USD,
	TAKEAWAY_LIMIT,
	TIMELINE_MAX_NODES,
} from "../shared/types.ts";
import type {
	GetReportResponse,
	HistorySection,
	ReportCommentOrder,
	ReportEvent,
	ReportEvidence,
	ReportInflightResponse,
	ReportNote,
	ReportPhase,
	ReportSourceFile,
	ReportTakeaway,
	SourceSection,
	TeardownReport,
	TimelineNode,
} from "../shared/types.ts";
import { WEEK_OF_RE } from "../shared/week.ts";
import {
	addSpend,
	clearInflight,
	findReport,
	getDossier,
	getInflight,
	getReport,
	getWeeklyScan,
	latestReport,
	putInflight,
	putReport,
	recordCandidateOpen,
	weeklyScanId,
} from "../shared/store.ts";
import type { Dossier, Report } from "../shared/store.ts";
import { aiConfigFor, githubBases, reportBudgetMs, reportPingMs } from "./env.ts";
import type { AppEnv } from "./env.ts";
import { reserveOrDeny, userAiGuard, userGuard } from "./guard.ts";
import type { Guarded } from "./guard.ts";

/**
 * 编译期钉死两份类型不许分叉(同 scan.ts / dossier.ts 顶部的做法):
 * `shared/anchor.ts` 那份是算法层的定义(anchorAcross / gateTakeaways 的入参),
 * `shared/types.ts` 那份是给前端的线上契约。任何一边加减字段,`npm run check`
 * 当场编译不过 —— 比「锚定按一个形状算、页面按另一个形状渲染」好找一万倍。
 */
type _ReportBothWays = [
	Evidence extends ReportEvidence ? true : never,
	ReportEvidence extends Evidence ? true : never,
	Takeaway extends ReportTakeaway ? true : never,
	ReportTakeaway extends Takeaway ? true : never,
	// 抓取层的「候选池是按什么排的」和线上契约的同名字段:多一个取值、少一个
	// 取值都会让页面在一种情况下说另一种情况的话(hn.ts HnCommentOrder 的论证)
	HnCommentOrder extends ReportCommentOrder ? true : never,
	ReportCommentOrder extends HnCommentOrder ? true : never,
];
const _reportWireMatchesAnchor: _ReportBothWays = [true, true, true, true, true, true];
void _reportWireMatchesAnchor;

export const reportRoutes = new Hono<Guarded>();

// ---------------------------------------------------------------------------
// 文案与常量
// ---------------------------------------------------------------------------

/**
 * `fullName` 的形状。**和 scan.ts 的 APPEAL_NAME_RE 是同一条规矩、同一个理由**
 * (阶段 5 立的):这是第二个把用户输入送进 GitHub URL 路径的端点。不校验的话
 * `a/b/../../users/x` 会被 URL 规范化到另一个端点,`a/b?per_page=1` 能往查询串
 * 里塞参数。github.ts 里还有一道逐段 encodeURIComponent 兜底,两道都留着。
 *
 * **不合法时一次网络都不发**,连 getDossier 都不查 —— 这条正则是整个端点的
 * 第一句话。
 */
const REPORT_NAME_RE = /^[A-Za-z0-9._-]+\/[A-Za-z0-9._-]+$/;

const BAD_BODY_MSG = "请求里要有 weekOf(2026-W36 这样)和 fullName(owner/repo)。";
const BAD_WEEK_MSG = "weekOf 的格式应该是 2026-W36 这样。";
const NO_DOSSIER_MSG = "还没有档案,先建一份。";
const NO_SCAN_MSG = "这一周还没跑过周扫,先在第一屏跑一次。";
const NOT_A_CANDIDATE_MSG =
	"这个仓不在这一周的候选清单上。深度报告只拆你清单上的东西 —— 被排除的先点「这个该进来」捞回来。";
const REPO_GONE_MSG = "GitHub 上抓不到这个仓(删了 / 改名了 / 被下架了),拆不了。";
const EMPTY_REPO_MSG = "这个仓一个提交都没有(或者默认分支没了),没有源码可读。";
const BUSY_MSG = "你已经有一份报告在跑,等它跑完再来 —— 同时只能跑一份(一份要 1-2 分钟,$0.4-0.6)。";
const GITHUB_DOWN_MSG = "GitHub 这会儿不通,材料没抓齐。这一次已经计入今天的额度,过几分钟再试。";
const FAILED_MSG = "这份报告没跑成(上游或数据库暂时不通)。这一次已经计入今天的额度,过几分钟再试一次。";

/**
 * 在跑的一单多久之后当它已经死了。
 *
 * 为什么必须有这条线:`inflight` 是一人一行(user_email 主键),而写它的那趟
 * 活在 `waitUntil` 里 —— Worker 被回收、D1 那一下写失败、进程崩掉,都会留下
 * 一行永远清不掉的记录,那个人从此再也发不出请求。**一个防重复提交的机制
 * 不该有「把用户永久锁死」这种失败模式。**10 分钟远大于一份报告的 1-2 分钟。
 */
const INFLIGHT_STALE_MS = 10 * 60_000;

/** delta 事件的节流:1 秒最多推一次,只报字符数不报内容。 */
const DELTA_MS = 1_000;

/**
 * 同一个 phase 内最多多久报一次活。**phase 变了必写。**
 * 002 的做法原样搬过来:别把库当日志——一份报告能推几百个 delta,
 * 每个都落一次 D1 的话,inflight 这一行会被写成一条高频写入流。
 */
const TOUCH_MS = 20_000;

/** 节 1 / 节 2 各自的输出预算下限。V4 Pro 的 thinking 也占输出预算(docs/02 决策 T7)。 */
const REPORT_TOKEN_FLOOR = 16_384;

// ---------------------------------------------------------------------------
// 材料:先抓后写的「抓」
// ---------------------------------------------------------------------------

interface FetchedFile {
	path: string;
	size: number;
	score: number;
	why: string;
	text: string;
}

interface Material {
	repo: GithubRepo;
	commitSha: string;
	commitDate: string;
	/** 全部比对底本。SourceId 的命名规矩见 types.ts 的 ReportSourceId。 */
	sources: Map<SourceId, string>;
	releases: ChangelogEntry[];
	changelogRanges: { from: number; to: number; link: string; title: string }[];
	story: HnStory | null;
	comments: HnComment[];
	/** 候选池按什么排的。一路传到提示词、时间线标签和页面文案上。 */
	commentOrder: HnCommentOrder;
	/** `kids` 里有、正文没对上的条数。 */
	commentsMissing: number;
	readmePath: string | null;
	files: FetchedFile[];
	treeTruncated: boolean;
	notes: ReportNote[];
}

/** 仓库字段快照的底本。时间线上「建立 / 最后一次 push / 归档」三个节点引的就是它。 */
function repoSourceText(repo: GithubRepo, sha: string, date: string): string {
	return [
		`full_name: ${repo.fullName}`,
		`html_url: ${repo.htmlUrl}`,
		`description: ${repo.description ?? "(仓库没写简介)"}`,
		`created_at: ${repo.createdAt}`,
		`pushed_at: ${repo.pushedAt}`,
		`archived: ${repo.archived}`,
		`stargazers_count: ${repo.stars}`,
		`license: ${repo.license ?? "null"}`,
		`language: ${repo.language ?? "null"}`,
		`topics: ${repo.topics.join(", ") || "(无)"}`,
		`default_branch: ${repo.defaultBranch}`,
		`head_commit: ${sha}`,
		`head_commit_date: ${date}`,
	].join("\n");
}

/** 一条 HN 帖的底本。 */
function storySourceText(s: HnStory): string {
	return [
		s.title,
		`by ${s.author} on ${s.createdAt}`,
		`points: ${s.points} | comments: ${s.numComments}`,
		`url: ${s.url ?? "(自帖,没有外链)"}`,
	].join("\n");
}

/**
 * 抓齐一份报告要的全部材料。**这个函数不调模型,一次都不调。**
 *
 * 它做的每一件事都可能失败,而失败的处理方式只有两种:
 *   - 「这一块没有」(HN 上查不到、这个仓没有 release、文件树被截断)→ 记一条
 *     `ReportNote`,继续。报告里会如实写「这个项目在 HN 上没有记录」,**不假装有**。
 *   - 「GitHub 整个不通」→ 抛出去,由路由那层收场。
 *
 * 两者必须分开的理由和 scan.ts 门 1 那条评审完全一样:混在一起的话,一次
 * GitHub 全线 503 会被渲染成一份「这个项目什么记录都没有」的**正常报告**。
 */
async function fetchMaterial(
	gh: GithubClient,
	hn: HnClient,
	repo: GithubRepo,
	commit: { sha: string; date: string },
	caresAbout: readonly string[],
): Promise<Material> {
	const notes: ReportNote[] = [];
	const sources = new Map<SourceId, string>();
	sources.set("repo", repoSourceText(repo, commit.sha, commit.date));

	// --- changelog(不吃 API 额度)---
	const atom = await gh.getReleasesAtom(repo.fullName).catch((err) => {
		console.error("report: releases.atom 取不到", err);
		return null;
	});
	const releases = atom ? parseReleasesAtom(atom) : [];
	const cl = changelogSource(releases);
	if (releases.length > 0) sources.set("changelog", cl.text);
	else notes.push({ kind: "no-changelog", text: "这个仓没有发布过 release,时间线上没有 changelog 节点。" });

	// --- HN(节 1 的主体语料)---
	const story = await hn.findStory(repo.fullName);
	let comments: HnComment[] = [];
	// 没有 story 时这两个值不会被读到,但要有个确定的初值:`kids` 是「我们知道
	// HN 怎么排的」,拿不到 story 谈不上排序,所以初值取降级那一档
	let commentOrder: HnCommentOrder = "chronological";
	let commentsMissing = 0;
	if (!story) {
		notes.push({
			kind: "hn-no-record",
			// docs/02 的开放问题:中文项目在 HN 上覆盖为零。查不到就这么说,不假装有。
			text: "这个项目在 HN 上没有记录 —— 节 1 里没有当年的一手反应,只有 GitHub 自己的字段和 changelog。",
		});
	} else {
		sources.set(`hn:${story.id}`, storySourceText(story));
		const pool = await hn.fetchComments(story.id, HN_COMMENT_CANDIDATES);
		comments = pool.comments;
		commentOrder = pool.order;
		commentsMissing = pool.missing;
		for (const c of comments) sources.set(`hn:${c.id}`, c.text);
		if (comments.length === 0) {
			notes.push({ kind: "hn-no-comments", text: "找到了 HN 上的帖子,但它底下一条评论都没有。" });
		} else if (pool.order !== "kids") {
			// **降级要说出来,不许偷偷退回一个我们说不出口径的顺序**(hn.ts 的
			// HnCommentOrder)。这条 note 一出现,提示词和页面上关于「排在第几」
			// 的措辞会同时改口——三处必须一起动,少一处就有人在页面上读到假话。
			notes.push({
				kind: "hn-no-ranking",
				text: "拿不到 HN 官方的评论排序(它的 item 接口这会儿没给出 kids),所以候选评论是按发表时间从早到晚给的 —— 这不是 HN 自己的排序,下面那几条不代表当年被顶得最高。",
			});
		} else if (pool.missing > 0) {
			notes.push({
				kind: "hn-no-ranking",
				text: `HN 把 ${pool.missing} 条评论排进了前面,但它们的正文在 Algolia 索引里取不到(删了 / 没索引),这几条就如实少给了 —— 没有拿后面的评论补上来充数。`,
			});
		}
	}

	// --- 节 2:文件树 → 挑文件 → 取正文 ---
	const readme = await gh.getReadme(repo.fullName, commit.sha);
	let readmePath: string | null = null;
	if (readme) {
		readmePath = readme.path;
		sources.set("readme", readme.text);
	}

	const tree = await gh.getTree(repo.fullName, commit.sha);
	let treeTruncated = false;
	const files: FetchedFile[] = [];
	if (!tree) {
		notes.push({ kind: "tree-unavailable", text: "GitHub 没给出这个仓的文件树,节 2 只读了 README。" });
	} else if (tree.truncated) {
		// **不做分层递归拉取**(docs/02 的开放问题写明了)。截断意味着 GitHub
		// 少给了一批条目,而少给的那批没有任何标记 —— 在一份残缺的树上挑「最值得
		// 读的 5 个文件」,挑出来的是「前一截里最值得读的 5 个」,而报告不会
		// 这么说。退化成只读 README,并且**在报告里标注**。
		treeTruncated = true;
		notes.push({
			kind: "tree-truncated",
			text: "这个仓太大,GitHub 的文件树接口只给了一部分(truncated)。节 2 因此只读了 README,没有挑源码文件。",
		});
	} else {
		const picked = pickFiles(tree.entries, {
			caresAbout,
			readmePath,
			// README 单独拿,所以这里只挑剩下的名额
			limit: MAX_PICKED_FILES - (readmePath ? 1 : 0),
		});
		for (const p of picked) {
			const text = await gh.getRawFile(repo.fullName, commit.sha, p.path);
			if (text === null || text.trim() === "") continue;
			files.push({ path: p.path, size: p.size, score: p.score, why: p.why, text });
			sources.set(`raw:${p.path}`, text);
		}
	}
	if (!readmePath && files.length === 0) {
		notes.push({ kind: "no-source-files", text: "一份源码正文都没取到,节 2 没有可读的东西。" });
	}

	return {
		repo,
		commitSha: commit.sha,
		commitDate: commit.date,
		sources,
		releases,
		changelogRanges: cl.ranges,
		story,
		comments,
		commentOrder,
		commentsMissing,
		readmePath,
		files,
		treeTruncated,
		notes,
	};
}

// ---------------------------------------------------------------------------
// 永久回链:「永久」两个字的全部含义
// ---------------------------------------------------------------------------

/**
 * 一段引文落在原文的第几行到第几行 → `#L12-L28`。拿不到下标就返回空串。
 *
 * 拿不到下标的唯一情形是 `anchorAcross` 的逐字映射失效(希腊语词尾 Σ 那种,
 * 见 anchor.ts 的 normalizeWithMap)。那时候**回链降级成不带行号的**,
 * 不许猜一个 —— 一个猜出来的行号点开是别的代码,而它旁边写着「逐字引文」。
 */
function lineAnchor(text: string, hit: AnchorHit): string {
	if (hit.startChar === undefined || hit.endChar === undefined) return "";
	const startLine = text.slice(0, hit.startChar).split("\n").length;
	const endLine = startLine + text.slice(hit.startChar, hit.endChar).split("\n").length - 1;
	return endLine > startLine ? `#L${startLine}-L${endLine}` : `#L${startLine}`;
}

/**
 * 一条证据的永久回链。
 *
 * **`blob/<sha>/...` 里必须是 commit sha,不是分支名。**`blob/main/foo.ts#L12`
 * 会在对方下一次提交之后指向完全不同的代码 —— 读者点开看到的是别的东西,
 * 而我们在旁边写着「这就是我引的那几行」。`blob/<sha>/foo.ts#L12` 永远指向
 * 我们当时读到的那几行。**这就是「永久回链」里「永久」两个字的全部含义**,
 * 不是修辞,也不是可以「顺手简化一下」的地方。report.test.ts 有一条正则断言
 * 钉着:任何 blob 链接里那一段必须是 40 位十六进制。
 *
 * 宿主写死 `https://github.com` 而不是用测试注入的 webBase:回链是给**人**点的,
 * 一个指向本地假服务器的链接在报告里没有任何意义,而它会让「回链里是 sha
 * 不是分支名」这条断言在测试里失去被验证的对象。
 */
function permalinkFor(m: Material, source: SourceId, hit: AnchorHit): string {
	const web = `${GITHUB_WEB_BASE}/${m.repo.fullName}`;
	if (source === "repo") return web;
	if (source === "changelog") return changelogPermalink(m.changelogRanges, hit.startChar, `${web}/releases`);
	if (source.startsWith("hn:")) return hnPermalink(source.slice(3));
	if (source === "readme" && m.readmePath) {
		return `${web}/blob/${m.commitSha}/${encodeRepoPath(m.readmePath)}${lineAnchor(m.sources.get("readme") ?? "", hit)}`;
	}
	if (source.startsWith("raw:")) {
		const path = source.slice(4);
		return `${web}/blob/${m.commitSha}/${encodeRepoPath(path)}${lineAnchor(m.sources.get(source) ?? "", hit)}`;
	}
	return web;
}

/**
 * 路径逐段编码。**和 github.ts 取同一个文件时用的是同一条规矩**——那边是
 * `filePath.split("/").map(encodeURIComponent).join("/")`,这边不编码的话,
 * 路径里带 `#` 或 `?` 的文件(罕见但合法)拼出来的回链会断在错的地方:
 * `#` 之后被浏览器当成 fragment,我们精心算出来的 `#L12-L28` 直接失效。
 *
 * 斜杠必须留着当路径分隔,所以是逐段编码不是整串编码(同 encodePath)。
 */
function encodeRepoPath(path: string): string {
	return path.split("/").map(encodeURIComponent).join("/");
}

/** 一份文件在报告里的坐标(不带行号那一段)。 */
function blobUrl(m: Material, path: string): string {
	return `${GITHUB_WEB_BASE}/${m.repo.fullName}/blob/${m.commitSha}/${encodeRepoPath(path)}`;
}

// ---------------------------------------------------------------------------
// 确定性拼装:先抓后写的「写完之后」
// ---------------------------------------------------------------------------

/**
 * 证据表。**同一条(source, quote)只造一次证据**,两节共用一张表。
 *
 * 为什么要去重:节 1 和节 2 都可能引到 README 的同一句话,而 `anchoredRatio`
 * 是「已锚定证据 / 全部证据」——同一条证据数两遍会让这个比例静静地偏掉,
 * 而它是要印在页面上的数字。
 */
class EvidenceTable {
	private readonly byKey = new Map<string, ReportEvidence>();
	readonly list: ReportEvidence[] = [];
	private seq = 0;
	private readonly m: Material;

	// 参数属性(`constructor(private readonly m)`)在这里写不得:node 的
	// `--experimental-strip-types` 是「只擦类型」模式,它擦不掉参数属性
	// (那要生成赋值语句),`npm test` 会当场 ERR_UNSUPPORTED_TYPESCRIPT_SYNTAX。
	constructor(m: Material) {
		this.m = m;
	}

	/** 造一条(或复用一条)证据,返回它的 id。锚定就在这里发生,一次都不少。 */
	add(quote: string, source: SourceId): string {
		const key = `${source} ${quote}`;
		const seen = this.byKey.get(key);
		if (seen) return seen.id;
		// **只在 claimedSource 那一份里比对。跨源命中判为失败,不判为成功。**
		// 理由见 anchor.ts 的 anchorAcross:一条挂错来源的引文比一条没有引文的
		// 结论更危险,它带着假凭证。
		const hit = anchorAcross(quote, this.m.sources, source);
		const ev: ReportEvidence = {
			id: `ev-${++this.seq}`,
			quote,
			source,
			anchored: hit.anchored,
			permalink: permalinkFor(this.m, source, hit),
			...(hit.context ? { context: hit.context } : {}),
		};
		this.byKey.set(key, ev);
		this.list.push(ev);
		return ev.id;
	}
}

/** 模型给的一条 takeaway 的原始形状(还没锚定、还没过门)。 */
interface RawTakeaway {
	text: string;
	quotes: { source: string; quote: string }[];
	caresAboutIndex: number;
}

/**
 * 从模型返回的 JSON 里把 takeaway 捞出来。**这一层只做形状归一,不做判断**——
 * 判断全在 `gateTakeaways` 里,而那是纯代码的硬门。
 *
 * 故意不在这里过滤「source 不认识」这种情况:让它照常造一条证据,
 * `anchorAcross` 会因为 `sources.get(source) === undefined` 判 false,
 * 于是这条 takeaway 走**同一条**丢弃路径(unanchored-evidence),在
 * `dropped` 里留下痕迹。在这里悄悄扔掉的话,页面上那句「模型给了 8 条」
 * 的分母就少了一条,而少掉的那条恰好是模型编来源的证据。
 */
function parseTakeaways(raw: unknown, limit: number): RawTakeaway[] {
	const arr = Array.isArray((raw as { takeaways?: unknown })?.takeaways) ? ((raw as { takeaways: unknown[] }).takeaways) : [];
	const out: RawTakeaway[] = [];
	// **上限按节给,不是两节共用一个数**(2026-09-01 阶段 7 评审建议修 6):
	// 节 1 的提示词写的是「最多 3 条发展史判断」,docs/01 决策 7 也是 ≤3。
	// 两节都按 5 截的话,模型给 5 条就留 5 条 —— 那条「≤3」就只是一句建议,
	// 而它是站长定的产品约束,不是模型的自由度。
	for (const item of arr.slice(0, Math.max(0, limit))) {
		const o = (item ?? {}) as { text?: unknown; quotes?: unknown; caresAboutIndex?: unknown; basedOn?: unknown };
		const text = typeof o.text === "string" ? o.text.trim() : "";
		if (!text) continue;
		const quotesRaw = Array.isArray(o.quotes) ? o.quotes : [];
		const quotes: RawTakeaway["quotes"] = [];
		for (const q of quotesRaw) {
			const qq = (q ?? {}) as { source?: unknown; quote?: unknown };
			const source = typeof qq.source === "string" ? qq.source.trim() : "";
			const quote = typeof qq.quote === "string" ? qq.quote.trim() : "";
			if (source && quote) quotes.push({ source, quote });
		}
		// 非整数 / 字符串数字一律原样带下去,由 gateTakeaways 判越界:
		// 判据只有一处,这里再判一次就是第二份口径
		const idx = typeof o.caresAboutIndex === "number" ? o.caresAboutIndex : Number.NaN;
		out.push({ text: text.slice(0, 400), quotes, caresAboutIndex: idx });
	}
	return out;
}

interface GatedSection {
	takeaways: ReportTakeaway[];
	dropped: SourceSection["dropped"];
	gateNote: string;
}

/**
 * 判断层硬门。模型返回之后、落库之前跑,**纯代码,零模型**。
 *
 * 四条丢弃条件全在 `gateTakeaways` 里(basedOn 为空 / 引用了不存在的证据 /
 * 依据的证据没锚上 / caresAboutIndex 越界)。这里只负责把模型给的引文变成
 * 证据 id,然后把丢弃的那些**如实报出来** —— 硬门的对价就是把删了多少、
 * 为什么删说清楚,不藏。
 */
function gateSection(raws: readonly RawTakeaway[], table: EvidenceTable, caresAboutCount: number): GatedSection {
	const takeaways: ReportTakeaway[] = raws.map((r) => ({
		text: r.text,
		basedOn: r.quotes.map((q) => table.add(q.quote, q.source)),
		caresAboutIndex: r.caresAboutIndex,
	}));
	const result = gateTakeaways(takeaways, table.list, caresAboutCount);
	return {
		takeaways: result.kept,
		dropped: result.dropped.map((d) => ({ text: d.item.text, kind: d.kind, reason: d.reason })),
		gateNote: describeGate(result),
	};
}

// ---------------------------------------------------------------------------
// 节 1 的时间线:代码建,模型不接触
// ---------------------------------------------------------------------------

/**
 * 时间线节点。**除了 HN 评论那三条(模型挑的),每一个节点都是代码从原始字段
 * 里造出来的** —— 排序、取数、措辞全部由代码决定。
 *
 * 节点超过 12 个时先砍中间那些 release:仓库建立 / 最后一次 push / 归档 /
 * HN 发布帖 / 模型挑的三条评论是骨架,而 release 是可以只留首尾的。
 */
function buildTimeline(m: Material, table: EvidenceTable, picks: TimelineNode[]): TimelineNode[] {
	const must: TimelineNode[] = [];
	const push = (kind: TimelineNode["kind"], at: string, label: string, quote: string, source: SourceId, into: TimelineNode[]) => {
		if (!at) return;
		into.push({ kind, at, label, evidenceId: table.add(quote, source) });
	};

	push("created", m.repo.createdAt, "仓库建立", `created_at: ${m.repo.createdAt}`, "repo", must);
	if (m.story) {
		push("hn-story", m.story.createdAt, `HN 发布帖(${m.story.points} 分 / ${m.story.numComments} 条评论)`, m.story.title, `hn:${m.story.id}`, must);
	}
	must.push(...picks);
	push("last-push", m.repo.pushedAt, "最后一次 push", `pushed_at: ${m.repo.pushedAt}`, "repo", must);
	if (m.repo.archived) {
		// GitHub 的 REST 里**没有归档日期**这个字段,只有一个布尔位。所以这个
		// 节点挂在最后一次 push 的时间上,并且在标签里把这件事说破 —— 编一个
		// 归档日期比不给这个节点糟得多。
		push("archived", m.repo.pushedAt, "已归档(GitHub 只给了布尔位,没有归档日期,这里挂在最后一次 push 上)", "archived: true", "repo", must);
	}

	const releaseNodes: TimelineNode[] = [];
	const sorted = [...m.releases].sort((a, b) => a.updated.localeCompare(b.updated));
	sorted.forEach((r, i) => {
		const label = i === 0 ? `首个 release:${r.title}` : `release:${r.title}`;
		push("release", r.updated, label, `## ${r.title}\nupdated: ${r.updated}`, "changelog", releaseNodes);
	});

	const room = Math.max(0, TIMELINE_MAX_NODES - must.length);
	// 留首尾:第一个 release 是「它什么时候开始正经发版」,最后几个是「它现在
	// 还在发什么」。中间那些在一条 12 格的时间线上换不来信息。
	const keptReleases =
		releaseNodes.length <= room
			? releaseNodes
			: room === 0
				? []
				: [releaseNodes[0]!, ...releaseNodes.slice(releaseNodes.length - (room - 1))].slice(0, room);

	return [...must, ...keptReleases]
		.sort((a, b) => a.at.localeCompare(b.at))
		.slice(0, TIMELINE_MAX_NODES);
}

// ---------------------------------------------------------------------------
// 提示词
// ---------------------------------------------------------------------------

const HISTORY_SYSTEM = `你在读一个开源项目**当年的一手材料**,写它的发展史判断。

给你的材料只有三种,除此之外你**什么都不知道**:仓库字段快照、release notes、HN 上那条发布帖和它底下的评论。你没有联网,也不许回忆你训练时见过的关于这个项目的任何事。

只输出一个 JSON 对象:

{
  "picks": [{"commentId": "候选评论的 id", "quote": "那条评论里的一句原话,逐字复制", "why": "为什么这条值得读,≤40 字"}],
  "takeaways": [{"text": "一条发展史判断", "quotes": [{"source": "材料的 id", "quote": "逐字原话"}], "caresAboutIndex": 0}]
}

**picks**:从候选评论里挑最多 3 条。判据是「当年的人在担心什么、在质疑什么、在指出什么别人没看见的东西」,不是「谁说话最好听」。**commentId 必须是我给你的候选里的那个 id,编一个出来这条就会被丢掉。**

**takeaways**:最多 3 条发展史判断。每一条:
- 说的必须是**这个项目自己走过的路**(它从哪儿来、经历了什么、现在处在什么状态),不是「开源项目一般都……」;
- \`quotes\` 里每一段都要**逐字**来自我给你的材料,一个字都不能改、不能补、不能顺;
- \`source\` 必须是我在材料标题里写的那个 id 原文(比如 \`repo\`、\`changelog\`、\`hn:38291043\`);
- \`caresAboutIndex\` 是这条判断对应「他在意什么」列表里的第几条(从 0 数)。**对不上任何一条就别写这条判断** —— 对不上说明它跟这个人无关。

引文引错来源、引一句材料里没有的话,这条判断会被代码当场丢掉,而且丢掉这件事会显示给用户看。所以宁可少写一条,也不要凑。`;

const SOURCE_SYSTEM = `你在读一个开源项目的源码,回答一个问题:**它源码里有什么值得这个人抄。**

给你的是这个项目的 README 和最多 4 份源码正文(每份可能被截断到前 12KB)。除此之外你什么都不知道。

只输出一个 JSON 对象:

{
  "takeaways": [{"text": "一条值得抄的东西", "quotes": [{"source": "材料的 id", "quote": "逐字原话"}], "caresAboutIndex": 0}]
}

最多 5 条。每一条:
- 说的是**具体做法**(它怎么解决了一个问题、它的哪个结构值得学),不是「代码写得很规范」这类评语;
- \`quotes\` 里每一段都要**逐字**来自我给你的材料,一个字都不能改;
- \`source\` 必须是我在材料标题里写的那个 id 原文(比如 \`readme\`、\`raw:src/index.ts\`);
- \`caresAboutIndex\` 是这条对应「他在意什么」列表里的第几条(从 0 数)。

**「这个项目用了 zod 做校验」这类话不要写。**它可能是真的,但它对这个人下周写什么代码没有任何影响 —— 而这正是这一节唯一要回答的问题。对不上「他在意什么」里任何一条的观察,不要写,写了也会被丢掉。`;

function caresBlock(caresAbout: readonly string[]): string {
	if (caresAbout.length === 0) return "他没有写「在意什么」。";
	return ["他在意什么(caresAboutIndex 从 0 数):", ...caresAbout.map((c, i) => `  ${i}. ${c}`)].join("\n");
}

/** 节 1 的提示词。**材料的 id 和锚定用的 SourceId 是同一个字符串**,中间没有翻译表。 */
function historyPrompt(m: Material, dossier: Dossier): string {
	const parts: string[] = [`项目:${m.repo.fullName}`, "", caresBlock(dossier.caresAbout), ""];
	parts.push(`### 材料 \`repo\`(仓库字段快照)\n\n${m.sources.get("repo")}`);
	const cl = m.sources.get("changelog");
	if (cl) parts.push(`### 材料 \`changelog\`(release notes)\n\n${cl}`);
	if (m.story) {
		parts.push(`### 材料 \`hn:${m.story.id}\`(HN 发布帖)\n\n${m.sources.get(`hn:${m.story.id}`)}`);
		if (m.comments.length > 0) {
			// **这里写的每一句都必须是真的。**原来这一段写着「按分数排好了」,而
			// 给模型的每一行都是 `points=0` —— HN 不公开评论分数(2026-09-01 实测)。
			// 提示词是产品对模型说的话,它撒谎的代价和页面撒谎一样大:模型会按
			// 「这是最高分的几条」去写判断,而那个前提根本不存在。
			const list = m.comments
				.map((c, i) => {
					const where = c.rank === null ? `at=${c.createdAt}` : `hnRank=${c.rank} at=${c.createdAt}`;
					return `#${i + 1} commentId=${c.id} source=\`hn:${c.id}\` ${where}\n${c.text}`;
				})
				.join("\n\n");
			// 两种口径两句话。合成一句「按顺序给你」的话就等于把降级藏起来,
			// 而模型会照着「这是最靠前的几条」去写判断(hn.ts HnCommentOrder)。
			const head =
				m.commentOrder === "kids"
					? `### 候选评论(这是 HN 自己排在最前面的 ${m.comments.length} 条,hnRank 就是它在 HN 上的位次;从中挑 3 条)`
					: `### 候选评论(共 ${m.comments.length} 条,**按发表时间从早到晚**排的 —— 这不是 HN 的排序,我们这次拿不到;从中挑 3 条)`;
			parts.push(`${head}\n\n${list}`);
		}
	} else {
		// 查不到就明说,别让模型自己脑补一段 HN 讨论出来
		parts.push("### HN\n\n这个项目在 HN 上没有记录。**不要编造任何 HN 上的讨论**,picks 直接留空数组。");
	}
	return parts.join("\n\n");
}

/** 节 2 的提示词。 */
function sourcePrompt(m: Material, dossier: Dossier): string {
	const parts: string[] = [`项目:${m.repo.fullName}(commit ${m.commitSha.slice(0, 8)})`, "", caresBlock(dossier.caresAbout), ""];
	const readme = m.sources.get("readme");
	if (readme) parts.push(`### 材料 \`readme\`(${m.readmePath})\n\n${readme}`);
	for (const f of m.files) parts.push(`### 材料 \`raw:${f.path}\`\n\n${f.text}`);
	if (!readme && m.files.length === 0) parts.push("### (一份正文都没取到)\n\ntakeaways 返回空数组。");
	return parts.join("\n\n");
}

// ---------------------------------------------------------------------------
// mock 档:**抓取、锚定、硬门全部是真的,只有措辞是 mock**
// ---------------------------------------------------------------------------

/**
 * mock 档的节 1 产出。这是 003 相对 001/002 的优势(docs/02 决策 T5):
 * 001/002 的 mock 是回放固定样本,而这里跑的是真 GitHub、真 HN、真锚定、
 * 真硬门 —— **只有措辞是假的**,而且带 `[mock]` 前缀标出来。
 *
 * 引文是从真的材料里**切**出来的,不是编的:切出来的字必然能锚定,于是
 * 「零 key 端到端跑通」验的是整条链路真的通,不是一个恰好不会失败的假结果。
 */
function mockHistory(m: Material, caresCount: number): { picks: { commentId: string; quote: string; why: string }[]; takeaways: RawTakeaway[] } {
	const picks = m.comments.slice(0, HN_PICK_LIMIT).map((c) => ({
		commentId: c.id,
		quote: firstSentence(c.text),
		// mock 的措辞是假的,但它说的**事实**不许是假的:原来这里写「这条当年
		// 拿了 0 分」,那是一个我们根本拿不到的数字(HN 不公开评论分数)。
		why: c.rank === null ? "[mock] 从候选池里挑的第一条" : `[mock] HN 把它排在第 ${c.rank} 条`,
	}));
	// mock 档也走同一个上限:两档口径不一样的话,「零 key 端到端」验的就不是
	// 真档的行为了(mockHistory 至多产出 2 条,天然在 3 以内,这里只是把
	// 「哪个数管着节 1」写在同一个地方)
	const takeaways: RawTakeaway[] = [];
	if (caresCount > 0) {
		takeaways.push({
			text: `[mock] ${m.repo.fullName} 从 ${m.repo.createdAt.slice(0, 10)} 走到 ${m.repo.pushedAt.slice(0, 10)},这中间发生的事全在上面的时间线里。`,
			quotes: [{ source: "repo", quote: `created_at: ${m.repo.createdAt}` }],
			caresAboutIndex: 0,
		});
		if (m.releases.length > 0) {
			const r = m.releases[0]!;
			takeaways.push({
				text: `[mock] 它最近一次发版是 ${r.title}。`,
				quotes: [{ source: "changelog", quote: `## ${r.title}\nupdated: ${r.updated}` }],
				caresAboutIndex: 0,
			});
		}
	}
	return { picks, takeaways };
}

/** mock 档的节 2 产出。每份读过的文件出一条,引文从正文里真的切出来。 */
function mockSource(m: Material, caresCount: number): RawTakeaway[] {
	if (caresCount === 0) return [];
	const out: RawTakeaway[] = [];
	const entries: { source: SourceId; text: string; label: string }[] = [];
	const readme = m.sources.get("readme");
	if (readme) entries.push({ source: "readme", text: readme, label: m.readmePath ?? "README" });
	for (const f of m.files) entries.push({ source: `raw:${f.path}`, text: f.text, label: f.path });
	entries.slice(0, TAKEAWAY_LIMIT).forEach((e, i) => {
		out.push({
			text: `[mock] ${e.label} 里有值得看的东西。`,
			quotes: [{ source: e.source, quote: meatyLine(e.text) }],
			caresAboutIndex: i % caresCount,
		});
	});
	return out;
}

/** 一段文本里的第一句(≤160 字)。mock 的引文从这里切,切出来的必然能锚定。 */
function firstSentence(text: string): string {
	const t = text.trim();
	const cut = t.search(/[。.!?\n]/);
	return (cut > 20 ? t.slice(0, cut + 1) : t.slice(0, 160)).trim();
}

/** 文件里第一条「有肉」的行(≥40 字符)。找不到就取前 120 字符。 */
function meatyLine(text: string): string {
	for (const line of text.split("\n")) {
		const t = line.trim();
		if (t.length >= 40) return t.slice(0, 200);
	}
	return text.trim().slice(0, 120);
}

// ---------------------------------------------------------------------------
// 跑一份报告
// ---------------------------------------------------------------------------

interface RunDeps {
	env: AppEnv;
	email: string;
	dossier: Dossier;
	repo: GithubRepo;
	commit: { sha: string; date: string };
	/** SSE 的 phase 事件。 */
	onPhase: (phase: ReportPhase) => void;
	/** SSE 的 delta 事件(已生成字符数)。 */
	onDelta: (chars: number) => void;
	/**
	 * 补记一笔已经花掉、但闸口没占过位的钱(闸不拦但账要有)。两种来源:
	 * 回落到自费 provider、以及 JSON 形状不对的整发重试(ai.ts 的
	 * `onFallback` / `onRetry`)。
	 */
	onExtraSpend: (usd: number, why: string) => void;
	/**
	 * 整趟的截止时刻(epoch ms)。**必须传**,而且必须和 `signal` 是同一趟预算
	 * 算出来的两个面。
	 *
	 * 2026-09-01 阶段 7 评审逮到的洞:这里原来只传 `signal` 不传 `deadline`,
	 * 而 `signal` 只能掐断 fetch —— `github.ts` 的退避是裸 `setTimeout`,
	 * `assertRoomToWait()` 第一行又是「没有 deadline 就当没有预算」。两条真会
	 * 出错的路:①二次限流 403/429 + `retry-after`,值由上游给,4 份源码各撞一次
	 * 60 秒就是 +240 秒,撞一次 3600 就是一小时;②匿名档 core 桶 60 次/小时,
	 * 主限流的 `waitMs` 最大接近一小时。后果是一趟报告在 `waitUntil` 里挂几十
	 * 分钟,SSE 每 10 秒照发心跳(页面一直转圈、看不出卡住了),`inflight` 前
	 * 10 分钟挡着重试,而 `gen` 额度已经扣掉了。
	 */
	deadline: number;
	signal: AbortSignal;
}

/**
 * 抓 → 两次 pro 调用 → 锚定 → 硬门 → 拼装。**不认识 Hono 的 Context**,
 * 闸门、配额、HTTP 状态码全在路由那一层(同 scan.ts 的 runWeeklyScan)。
 */
export async function runReport(deps: RunDeps): Promise<TeardownReport> {
	const { env, email, dossier, repo, commit, signal, deadline } = deps;
	const bases = githubBases(env);
	// **deadline 和 signal 一起传,一个都不能少**(RunDeps.deadline 的注释里有
	// 完整的失败路径)。路由那一层解析 commit 用的客户端一直是这么建的,
	// 这一处漏了 —— 而节 2 要发 ≤4 次 raw、节 1 要发 1 次 atom,恰恰全落在
	// 这个客户端上。
	const gh = new GithubClient({ pat: env.GITHUB_PAT, ...bases, signal, deadline });
	const hn = new HnClient({
		signal,
		deadline,
		...(bases.apiBase ? { apiBase: `${bases.apiBase}/__hn`, firebaseBase: `${bases.apiBase}/__hnfb` } : {}),
	});

	deps.onPhase("fetching");
	const m = await fetchMaterial(gh, hn, repo, commit, dossier.caresAbout);
	const notes = [...m.notes];

	const table = new EvidenceTable(m);
	const caresCount = dossier.caresAbout.length;

	// 两次调用共用一个基础配置。**判断层用基础档(pro),不是 fast 档**
	// (docs/02 决策 T7):节 1 要读 30 条评论,节 2 要读 5 份源码正文。
	const base = aiConfigFor(env, email);
	const cap = Number.parseInt(base.maxOutputTokens ?? "", 10);
	const cfg = {
		...base,
		// V4 Pro 的 thinking 也占输出预算:002 实测一小时视频用到 14896/16384
		// 其中 thinking 11812,只剩 9% 余量。003 节 2 要读 5 份源码正文,思考量
		// 只会更大 —— 预算不够时 finish=length,拿回来的是半截 JSON。
		maxOutputTokens: String(Number.isFinite(cap) && cap >= REPORT_TOKEN_FLOOR ? cap : REPORT_TOKEN_FLOOR),
	};
	const isMock = resolveProvider(cfg) === "mock";
	if (isMock) {
		notes.push({
			kind: "mock",
			text: "这个实例没有配 AI key,跑的是 mock 档:抓取、锚定、丢弃门全都是真的,只有措辞是假的(带 [mock] 前缀)。",
		});
	}

	let chars = 0;
	let lastPush = 0;
	const bumpDelta = (d: string) => {
		chars += d.length;
		const now = Date.now();
		if (now - lastPush > DELTA_MS) {
			lastPush = now;
			deps.onDelta(chars);
		}
	};
	// 两条「已经花掉但闸口没占过位」的路,记账口径完全一样(store.ts addSpend):
	//   ① 专线挂了回落到自费 provider —— 阶段 3 遗留的那半个洞
	//   ② 产出不是合法 JSON,原样整发重来 —— 阶段 7 评审建议修 7
	// 两者都发生在**那一发发出去之前**:失败的那一发 token 一样烧掉了。
	const onFallback = () => deps.onExtraSpend(REPORT_CALL_EST_USD, "回落到自费 provider");
	const onRetry = () => deps.onExtraSpend(REPORT_CALL_EST_USD, "产出不是合法 JSON,整发重试");
	/** 这一趟有没有回落过。回落过就要在报告里说(ai.ts CompleteResult.fellBack)。 */
	let fellBack = false;

	// --- 节 1 ---
	deps.onPhase("history");
	let historyRaw: { picks: { commentId: string; quote: string; why: string }[]; takeaways: RawTakeaway[] } = { picks: [], takeaways: [] };
	let historyModel = "mock";
	if (isMock) {
		historyRaw = mockHistory(m, caresCount);
	} else {
		try {
			const res = await complete(cfg, {
				prompt: historyPrompt(m, dossier),
				system: HISTORY_SYSTEM,
				json: true,
				onDelta: bumpDelta,
				onFallback,
				onRetry,
				signal,
			});
			historyModel = res.model;
			fellBack = fellBack || res.fellBack === true;
			const parsed = JSON.parse(res.text) as Record<string, unknown>;
			historyRaw = { picks: parsePicks(parsed), takeaways: parseTakeaways(parsed, HISTORY_TAKEAWAY_LIMIT) };
		} catch (err) {
			// 一节挂了不该毁掉另一节和整条时间线:时间线是代码建的,它照常出。
			console.error("report: 节 1 调用失败 —", err instanceof AiConfigError || err instanceof AiError ? err.message : err);
			notes.push({ kind: "history-model-failed", text: "节 1 的模型调用没成功,时间线照常(它是代码建的),但没有发展史判断。" });
		}
	}

	// 模型挑的评论 → 时间线上的 hn-comment 节点。**id 必须在候选池里**:
	// 编一个 id 出来就当没挑过(不是造一个空节点),因为那条节点会挂着一个
	// 指向不存在条目的永久回链。
	const byId = new Map(m.comments.map((c) => [c.id, c]));
	const pickNodes: TimelineNode[] = [];
	for (const p of historyRaw.picks.slice(0, HN_PICK_LIMIT)) {
		const c = byId.get(p.commentId);
		if (!c) {
			console.error(`report: 模型挑了一个不在候选池里的评论 id(${p.commentId}),忽略`);
			continue;
		}
		pickNodes.push({
			kind: "hn-comment",
			at: c.createdAt,
			// **印我们真的知道的那个数。**这里原来印的是 `(${c.points} 分)`,而
			// HN 不公开评论分数,那个值恒等于 0 —— 在一个把反捏造写进立场 4 的
			// 产品里,那是页面上唯一一个凭空来的数字。名次是 `kids` 的下标,
			// 是 HN 自己给的;拿不到 `kids` 那一档就一个字都不提排序。
			label: c.rank === null ? `HN 评论 · ${c.author}` : `HN 评论 · ${c.author}(HN 排在第 ${c.rank} 条)`,
			evidenceId: table.add(p.quote, `hn:${c.id}`),
			pickedWhy: p.why.slice(0, 120),
		});
	}

	const timeline = buildTimeline(m, table, pickNodes);
	const historyGate = gateSection(historyRaw.takeaways, table, caresCount);

	// --- 节 2 ---
	deps.onPhase("source");
	let sourceRaw: RawTakeaway[] = [];
	let sourceModel = "mock";
	const haveSource = m.sources.has("readme") || m.files.length > 0;
	if (!haveSource) {
		// 一份正文都没有时不发这一次调用:钱照花、产出必然为空
		console.error("report: 节 2 没有任何正文,跳过模型调用");
	} else if (isMock) {
		sourceRaw = mockSource(m, caresCount);
	} else {
		try {
			const res = await complete(cfg, {
				prompt: sourcePrompt(m, dossier),
				system: SOURCE_SYSTEM,
				json: true,
				onDelta: bumpDelta,
				onFallback,
				onRetry,
				signal,
			});
			sourceModel = res.model;
			fellBack = fellBack || res.fellBack === true;
			sourceRaw = parseTakeaways(JSON.parse(res.text) as Record<string, unknown>, TAKEAWAY_LIMIT);
		} catch (err) {
			console.error("report: 节 2 调用失败 —", err instanceof AiConfigError || err instanceof AiError ? err.message : err);
			notes.push({ kind: "source-model-failed", text: "节 2 的模型调用没成功,读过哪几个文件照常列出,但没有 takeaway。" });
		}
	}

	deps.onPhase("anchoring");
	const sourceGate = gateSection(sourceRaw, table, caresCount);

	if (fellBack) {
		// `ai.ts` 的 CompleteResult.fellBack 注释里写着「调用方据此在报告里如实
		// 标注」,而阶段 7 评审发现全仓没有一个地方读它 —— 一句没兑现的承诺。
		// 兑现在这里:标注和别的降级标注同一条路(notes,页面上不许折叠)。
		notes.push({
			kind: "ai-fell-back",
			text: "这一趟里有调用打在站长专线上失败了,回落到备用 provider 重跑了一次 —— 产出照常,但这一份的措辞不是专线那个模型写的。",
		});
	}

	const files: ReportSourceFile[] = [];
	if (m.readmePath) {
		files.push({
			path: m.readmePath,
			size: 0,
			score: 999,
			why: "README —— 每份报告都读它",
			chars: (m.sources.get("readme") ?? "").length,
			blobUrl: blobUrl(m, m.readmePath),
		});
	}
	for (const f of m.files) {
		files.push({ path: f.path, size: f.size, score: f.score, why: f.why, chars: f.text.length, blobUrl: blobUrl(m, f.path) });
	}

	const history: HistorySection = {
		timeline,
		hnStory: m.story
			? {
					id: m.story.id,
					title: m.story.title,
					url: m.story.url,
					points: m.story.points,
					numComments: m.story.numComments,
					permalink: hnPermalink(m.story.id),
				}
			: null,
		commentCandidates: m.comments.length,
		commentOrder: m.commentOrder,
		commentsMissing: m.commentsMissing,
		...historyGate,
	};
	const source: SourceSection = { commitSha: m.commitSha, files, treeTruncated: m.treeTruncated, ...sourceGate };

	return {
		id: crypto.randomUUID(),
		fullName: repo.fullName,
		commitSha: m.commitSha,
		dossierRev: dossier.rev,
		// **快照,不是引用**:用户改完档案再打开旧报告,caresAboutIndex 会指到
		// 另一条上去,而页面上没有任何东西会报错(types.ts 的注释)。
		caresAbout: [...dossier.caresAbout],
		generatedAt: Date.now(),
		history,
		source,
		evidence: table.list,
		anchoredRatio: anchoredRatio(table.list),
		notes,
		estUsd: REPORT_EST_USD,
		model: { provider: resolveProvider(cfg), historyModel, sourceModel },
	};
}

/** picks 的形状归一。和 parseTakeaways 一样:只归一形状,判断在别处。 */
function parsePicks(raw: unknown): { commentId: string; quote: string; why: string }[] {
	const arr = Array.isArray((raw as { picks?: unknown })?.picks) ? ((raw as { picks: unknown[] }).picks) : [];
	const out: { commentId: string; quote: string; why: string }[] = [];
	for (const item of arr) {
		const o = (item ?? {}) as { commentId?: unknown; quote?: unknown; why?: unknown };
		const commentId = typeof o.commentId === "string" ? o.commentId.trim() : "";
		const quote = typeof o.quote === "string" ? o.quote.trim() : "";
		if (!commentId || !quote) continue;
		out.push({ commentId, quote, why: typeof o.why === "string" ? o.why.trim() : "" });
	}
	return out;
}

// ---------------------------------------------------------------------------
// 路由
// ---------------------------------------------------------------------------

/** 落库。payload 整份存 JSON blob(docs/02 决策 T2 的取舍论证)。 */
async function saveReport(db: D1Database, dossierId: string, r: TeardownReport): Promise<void> {
	const row: Report = {
		id: r.id,
		dossierId,
		fullName: r.fullName,
		commitSha: r.commitSha,
		dossierRev: r.dossierRev,
		payloadJson: JSON.stringify(r),
		estUsd: r.estUsd,
		anchoredRatio: r.anchoredRatio,
		createdAt: r.generatedAt,
	};
	await putReport(db, row);
}

function parseStored(row: Report): TeardownReport | null {
	try {
		return JSON.parse(row.payloadJson) as TeardownReport;
	} catch (err) {
		console.error(`report: payload_json 解析不了(id=${row.id})`, err);
		return null;
	}
}

/**
 * 跑一份深度报告。**SSE 流式**(docs/02 决策 T1),四个组成部分一个都不能少:
 *
 *   | 组成                          | 作用                | 不要它会怎样            |
 *   |-------------------------------|--------------------|------------------------|
 *   | TransformStream + `data: …`   | 边生成边推          | 100 秒后 524           |
 *   | 10 秒 ping                    | thinking 阶段保活    | 模型思考 100 秒照样 524 |
 *   | waitUntil 包整段              | 页面关了照跑完       | 用户切走一次就白烧 $0.5 |
 *   | inflight 落 D1                | 刷新能接回进度       | 002 踩过「刷新丢进度」  |
 *
 * 100 秒那条线是**实测**不是文档:002 线上撞过,注释原文在
 * `002/src/worker/index.ts:224`「100 秒无字节会被 524 掐断——必须边生成边推」。
 * 更麻烦的是 DeepSeek V4 Pro 默认开 thinking,**思考阶段一个 content 字节都不
 * 产出**,所以光靠转发模型输出不够,必须另加一路心跳。
 *
 * **闸口顺序**(docs/02 决策 T6):校验 → 档案 → 在跑的一单 → GitHub 解析 sha
 * → **去重** → `reserveOrDeny(c, "gen", REPORT_EST_USD)` → 开跑。
 * 去重排在占位之前是有意的:同一个 commit 已经跑过就直接返回旧的,**一次额度
 * 都不扣** —— 用户点两次同一行是最常见的操作,而一份报告 $0.4-0.6。
 *
 * 解析 sha 那两次 GitHub 调用发生在占位之前。它们不花钱(GitHub 免费),而
 * 不这么排的话「命中去重」这件事就必须扣一次额度才知道 —— 那正好把去重的
 * 全部意义抵消掉。
 */
reportRoutes.post("/api/report", userAiGuard, async (c) => {
	const email = c.get("email");
	const db = c.env.TEARDOWN_DB;

	let body: unknown = null;
	try {
		body = await c.req.json();
	} catch {
		return c.json({ error: BAD_BODY_MSG }, 400);
	}
	const raw = (body ?? {}) as { weekOf?: unknown; fullName?: unknown };
	const weekOf = typeof raw.weekOf === "string" ? raw.weekOf.trim() : "";
	const fullName = typeof raw.fullName === "string" ? raw.fullName.trim() : "";
	// **这两条在任何网络之前**:畸形的 fullName 一次 fetch 都不该发出去
	if (!WEEK_OF_RE.test(weekOf)) return c.json({ error: BAD_WEEK_MSG }, 400);
	if (!REPORT_NAME_RE.test(fullName)) return c.json({ error: BAD_BODY_MSG }, 400);

	const dossier = await getDossier(db, email);
	if (!dossier) return c.json({ error: NO_DOSSIER_MSG }, 400);

	// 只拆**这个人自己那一周清单上**的仓。scanId 由他自己的 dossier.id 算出来,
	// 所以越权在结构上不成立(同 scan.ts 申诉端点的论证)。这道门还顺带挡住了
	// 「拿这个端点当一个通用的 GitHub 报告代理用」。
	const bundle = await getWeeklyScan(db, dossier.id, weekOf);
	if (!bundle) return c.json({ error: NO_SCAN_MSG }, 400);
	if (!bundle.candidates.some((x) => x.fullName === fullName)) return c.json({ error: NOT_A_CANDIDATE_MSG }, 400);

	// **「他点了这一行」——记在这里,不记在下面任何一个分支里**(2026-09-01
	// 上线前终审)。这个数是两条判据的唯一数据源(docs/01 决策 8 的「点击数为 0」
	// 和风险 2 的「点开的报告少于 2 份」),而 report 表答不了:去重命中时它
	// 什么都不写,于是第二周点同一个仓等于没点过;它也没有 week_of。
	//
	// 位置的三条理由:
	// ① 在候选校验**之后** —— 不在这一周清单上的仓不该被记成一次点击(那不是
	//    需求信号,是一次坏请求);
	// ② 在去重、配额、GitHub 之**前** —— 记的是「他想看这个」这个动作。配额
	//    拒了、GitHub 不通、正在跑另一单,都不改变这件事,而这三种失败恰恰是
	//    最该被看见的需求信号(想看却没看成);
	// ③ 失败不拦路:少一条统计不该让人看不成报告。但要响。
	await recordCandidateOpen(db, weeklyScanId(dossier.id, weekOf), fullName).catch((e) =>
		console.error("report: 记点击失败(不拦路)", e),
	);

	// 一人同时至多一趟。**过期的那一行不算数**(见 INFLIGHT_STALE_MS)。
	const busy = await getInflight(db, email);
	if (busy && Date.now() - busy.updatedAt < INFLIGHT_STALE_MS) {
		return c.json({ error: BUSY_MSG, refresh: true }, 409);
	}

	const budget = reportBudgetMs(c.env);
	const signal = AbortSignal.timeout(budget);
	// **一趟预算的两个面,算一次,两处都用。**signal 掐得断 fetch,掐不断退避
	// 的 sleep;deadline 管的是「睡完还来得及打一发吗」。少传哪一个,另一个都
	// 补不上(RunDeps.deadline 的注释里有两条真会出错的路)。留 5 秒收尾:
	// 落库、清 inflight、把 SSE 的 result 推出去都发生在预算之内。
	const deadline = Date.now() + Math.max(1_000, budget - 5_000);
	const bases = githubBases(c.env);
	const gh = new GithubClient({ pat: c.env.GITHUB_PAT, ...bases, signal, deadline });

	let repo: GithubRepo | null;
	let commit: { sha: string; date: string } | null;
	try {
		// 门 1 照旧:抓不通就不拆(docs/02「结构性防捏造」)
		repo = await gh.getRepo(fullName);
		if (!repo) return c.json({ error: REPO_GONE_MSG }, 404);
		commit = await gh.resolveCommit(fullName, repo.defaultBranch);
	} catch (err) {
		console.error("report: 解析 commit 失败", err);
		const status = err instanceof RateBudgetError || (err instanceof GithubError && (err.status === 403 || err.status === 429)) ? 429 : 502;
		return c.json({ error: "GitHub 这会儿不通(或者额度用完了),先没法拆。稍后再试 —— 这一次没有计入额度。" }, status);
	}
	if (!commit) return c.json({ error: EMPTY_REPO_MSG }, 404);

	// **去重:同一个 commit 已经跑过就直接返回旧的,不重跑、不扣额度。**
	// 回的是 JSON 不是 SSE —— 前端按 content-type 分支(002 的前端就是这么做的),
	// 而一份已经存好的报告没有任何进度可以流式推送。
	// **dossier.rev 在键里**(站长 2026-09-01 拍板):改过档案再拆同一个仓 =
	// 新报告。理由与代价见 store.ts findReport 的注释。
	const existing = await findReport(db, dossier.id, fullName, commit.sha, dossier.rev);
	if (existing) {
		const parsed = parseStored(existing);
		if (parsed) return c.json({ report: parsed, cached: true });
		// payload 坏了当没有,照常重跑(下面的 putReport 会按新 id 存一份)
		console.error(`report: 命中去重但 payload 解析不了,重跑(id=${existing.id})`);
	}

	// 先占位后干活(docs/02 决策 T6):占位失败即 429,模型报错不退还。
	// **estUsd 按低缓存命中的上限估**(types.ts REPORT_EST_USD 的注释)。
	const denied = await reserveOrDeny(c, "gen", REPORT_EST_USD);
	if (denied) return denied;

	const { readable, writable } = new TransformStream<Uint8Array, Uint8Array>();
	const writer = writable.getWriter();
	const enc = new TextEncoder();
	const send = (obj: ReportEvent) => writer.write(enc.encode(`data: ${JSON.stringify(obj)}\n\n`)).catch(() => {});

	const startedAt = Date.now();
	let phase: ReportPhase = "fetching";
	let lastTouch = 0;
	/** 报活:phase 变了必写,同一 phase 内最多 20 秒一次,别把库当日志。 */
	const touch = async (next: ReportPhase) => {
		const now = Date.now();
		if (next === phase && now - lastTouch < TOUCH_MS) return;
		phase = next;
		lastTouch = now;
		await putInflight(db, email, { fullName, phase: next, startedAt, updatedAt: now }).catch((e) =>
			console.error("report: 报活写失败(不拦路)", e),
		);
	};
	/** 报活不拦路,但它的写要被等到 —— 别让它排在 clearInflight 后面落地。 */
	const queueTouch = (next: ReportPhase) => {
		touchWrites.push(touch(next));
	};

	/** 补记账的写。收集起来在 finally 里等,别让它被回收掉。 */
	const spendWrites: Promise<unknown>[] = [];
	/**
	 * 报活的写。**和 spendWrites 同一个道理,而且多一条**:`touch` 原来是
	 * `void touch(p)` 的 fire-and-forget,和 finally 里 `await clearInflight`
	 * 没有任何顺序保证 —— DELETE 先落地的话,后到的那次 UPSERT 会重新插一行,
	 * 留下一条 10 分钟(INFLIGHT_STALE_MS)清不掉的 inflight,那个人这 10 分钟
	 * 里再也发不出请求。同一个文件里两处写法不一致本身就是个信号
	 * (2026-09-01 阶段 7 评审的提醒 1)。
	 */
	const touchWrites: Promise<unknown>[] = [];

	c.executionCtx.waitUntil(
		(async () => {
			await putInflight(db, email, { fullName, phase: "fetching", startedAt, updatedAt: startedAt }).catch(() => {});
			// thinking 阶段一个 content 字节都没有 —— 这是那几十秒里唯一的字节
			const ping = setInterval(() => void send({ type: "ping" }), reportPingMs(c.env));
			try {
				const report = await runReport({
					env: c.env,
					email,
					dossier,
					repo,
					commit,
					signal,
					deadline,
					onPhase: (p) => {
						void send({ type: "phase", phase: p });
						queueTouch(p);
					},
					onDelta: (chars) => void send({ type: "delta", chars }),
					onExtraSpend: (usd, why) => {
						// 闸不拦但账要有(store.ts addSpend 的注释)。两种来源:
						// ①专线配好、网关挂了时 ai.ts 拿 base 配置重试,钱落回我们
						//   自己的 DeepSeek 账上,而这一趟在闸口已经被
						//   spendsOffOurAccount 放过了;
						// ②产出不是合法 JSON 时整发重来,而 REPORT_EST_USD 是按
						//   两次调用估的(阶段 7 评审建议修 7)。
						// 两者都**不退还、不拦路**:钱已经花了,保险丝烧断之后电表
						// 不能跟着停。
						console.error(`report: ${why},补记 $${usd} 到今天的花费`);
						spendWrites.push(addSpend(db, usd).catch((e) => console.error("report: 补记花费失败", e)));
					},
				});
				await saveReport(db, dossier.id, report);
				await send({ type: "result", report, cached: false });
			} catch (err) {
				console.error("report: 整趟失败", err);
				const known = err instanceof RateBudgetError || err instanceof GithubError;
				await send({ type: "error", error: known ? GITHUB_DOWN_MSG : FAILED_MSG });
			} finally {
				clearInterval(ping);
				await Promise.all(spendWrites).catch(() => {});
				// **必须在 clearInflight 之前等干净**:一次晚到的报活 UPSERT 会把
				// 刚删掉的那一行重新插回来(见 touchWrites 的注释)。
				await Promise.all(touchWrites).catch(() => {});
				await clearInflight(db, email).catch((e) => console.error("report: 清 inflight 失败", e));
				await writer.close().catch(() => {});
			}
		})(),
	);

	return new Response(readable, {
		headers: { "content-type": "text/event-stream", "cache-control": "no-cache", "x-accel-buffering": "no" },
	});
});

/**
 * 刷新之后接回进度。**没有它,SSE 断线就等于进度没了**——浏览器内存里的
 * 转圈撑不过一次刷新,而那一趟还在 `waitUntil` 里花着钱跑(002 踩过一次)。
 *
 * 过期的那一行按「没有」回:一行永远清不掉的 inflight 会让页面上永远转着圈。
 */
reportRoutes.get("/api/report/inflight", userGuard, async (c) => {
	const rec = await getInflight(c.env.TEARDOWN_DB, c.get("email"));
	const fresh = rec && Date.now() - rec.updatedAt < INFLIGHT_STALE_MS ? rec : null;
	const body: ReportInflightResponse = { inflight: fresh };
	return c.json(body);
});

/**
 * 取一份已经生成的报告。两种问法:
 *   `?id=<报告 id>`               —— 直接取那一份
 *   `?weekOf=&fullName=`          —— 取这个仓**最近一次**的报告(不管 commit)
 *
 * 后一种故意不带 commitSha:页面上那个「上次拆的结果」入口只知道仓名,
 * 而 `findReport` 的 commit 口径是给**去重**用的(同一个 commit 别重跑),
 * 两件事不是一回事。
 *
 * 没有那份报告时回 `{ report: null }` + 200,不是 404:前端要拿它区分
 * 「还没拆过,该显示那个按钮」和「出错了,该显示错误」(同 GET /api/scan)。
 */
reportRoutes.get("/api/report", userGuard, async (c) => {
	const db = c.env.TEARDOWN_DB;
	const empty: GetReportResponse = { report: null };
	const dossier = await getDossier(db, c.get("email"));
	if (!dossier) return c.json(empty);

	const id = c.req.query("id")?.trim();
	if (id) {
		const row = await getReport(db, id);
		// **别人的报告一律当不存在**:id 是 uuid 猜不到,但「猜不到」不是授权
		if (!row || row.dossierId !== dossier.id) return c.json(empty);
		return c.json({ report: parseStored(row) } satisfies GetReportResponse);
	}

	const fullName = c.req.query("fullName")?.trim() ?? "";
	if (!REPORT_NAME_RE.test(fullName)) return c.json({ error: BAD_BODY_MSG }, 400);
	const row = await latestReport(db, dossier.id, fullName);
	return c.json({ report: row ? parseStored(row) : null } satisfies GetReportResponse);
});

// latestReport 搬去 store.ts 了(2026-09-01 上线前终审):它是全仓唯一一处写在
// store 之外的 SQL,而 store.ts 第一行就写着「全部 SQL 收在这一个文件里」,
// 理由是配额和花费闸的正确性全靠单条语句的原子性 —— 一旦路由层能自己写 SQL,
// 迟早会出现一段「先 SELECT 看看够不够,再 UPDATE」。规矩破一次和没有规矩一样。
