// 003 领域拆解 · 阶段 3 的唯一一屏:关注档案(docs/01 决策 3)。
//
// 这一页不是设置表单,是一条**信任链**:用户看得见系统是怎么理解他那句话的、
// 拿什么词去 GitHub 搜、将来会淘汰什么。四节的顺序有意义(见 Dossier.tsx)。
//
// 路由(阶段 5 起有两屏):主站登记里 003 的 landing 是 "app",SSO 完成后落到
// `/products/weekly-teardown/app`(worker/index.ts 的两处 302)。wrangler.jsonc 的
// assets 是 single-page-application fallback,挂载点下任何路径都会拿到同一份
// index.html —— 所以 `app`、裸挂载点都进得来。两屏之间靠查询串 `?view=scan` 切
// (view.ts 里有为什么不用路径段的理由),用 pushState 写、listen popstate 读,
// 于是:SSO 落到 app 没有查询串 → 按「有没有档案」选默认屏;刷新不丢(参数在
// 地址栏里);浏览器前进后退能来回。
//
// 分工:这个文件管**取/存/删和所有状态**,Dossier.tsx 管档案那四节怎么长,
// Scan.tsx 管本周清单那三块怎么长。
// 请求一律走 apiPath() —— 直接写 "/api/..." 会打到主站根,不会进产品 Worker。

import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import type { ReactNode } from "react";

import type {
	ApiError,
	AppealResponse,
	DeleteDossierResponse,
	Dossier,
	DossierFields,
	DraftResponse,
	EmailPrefs,
	GetDossierResponse,
	GetReportResponse,
	GetScanChangesResponse,
	GetScanResponse,
	HealthResponse,
	PutDossierResponse,
	ReportInflightResponse,
	ReportPhase,
	RunReportRequest,
	RunScanResponse,
	ScanHistoryResponse,
	TeardownReport,
	WeeklyChange,
	WeeklyScan,
} from "../shared/types.ts";
import { DOSSIER_LIMITS, REPORT_EST_USD, WEEKLY_SCAN_SCHEDULE } from "../shared/types.ts";
import ChangesView from "./Changes";
import DossierView, { EmailSwitch } from "./Dossier";
import ReportView, { ReportProgress } from "./Report";
import ScanView, { RerunBar, RerunReceipt } from "./Scan";
import type { RunExtras } from "./Scan";
import { SiteHeader } from "./SiteChrome";
import { blockers, fieldsEqual, sentenceIssue } from "./dossier-edit.ts";
import { apiPath } from "./paths";
import { IDLE, phaseIndex, reduceRun, shortSha, splitSse, startRun, streamCutOff } from "./report-run.ts";
import type { RunState } from "./report-run.ts";
import { defaultView, reportTargetInSearch, searchForView, viewInSearch, weekOfInSearch } from "./view.ts";
import type { ReportTarget, View } from "./view.ts";

// ---------------------------------------------------------------------------
// 取数:所有错误走同一条路
// ---------------------------------------------------------------------------

/**
 * 一次失败的全部可显示信息。
 * error 直接来自后端,**原样显示不改写**——那些文案是产品的一部分
 * (dossier.ts / guard.ts 里逐条写的中文),前端再包一层只会稀释它。
 */
interface Fail {
	/** 0 = 连网络层都没通(fetch 抛异常),此时 error 是前端自己的兜底文案。 */
	status: number;
	error: string;
	loginUrl?: string;
	scope?: "account" | "ip" | "global";
	/** 429 的 retry-after 秒数。 */
	retryAfter?: number;
	/** 后端说「重试没有出路,只能刷新」(types.ts ApiError.refresh)。 */
	refresh?: true;
}

type ApiResult<T> = { ok: true; data: T } | { ok: false; fail: Fail };

const OFFLINE: Fail = { status: 0, error: "连不上服务器。检查一下网络,或者过一会儿再试。" };

/**
 * 一个失败响应 → Fail。**单独抽出来是因为 SSE 那条路拿的是原始 Response**
 * (POST /api/report 可能回流也可能回 JSON,得先看 content-type 再决定怎么读),
 * 它不能走 api() 那条「先 res.json() 再说」的路。两条路的错误映射必须是同一份:
 * 分成两份的话,总有一条会漏掉 loginUrl 或 retry-after,而症状是「429 了但页面
 * 不说什么时候恢复」这种只在真出错时才看得见的东西。
 */
function toFail(res: Response, body: unknown): Fail {
	const e = (body ?? {}) as ApiError;
	const raw = Number.parseInt(res.headers.get("retry-after") ?? "", 10);
	return {
		status: res.status,
		error: typeof e.error === "string" && e.error ? e.error : `请求失败(HTTP ${res.status})。`,
		loginUrl: e.loginUrl,
		scope: e.scope,
		retryAfter: Number.isFinite(raw) ? raw : undefined,
		refresh: e.refresh,
	};
}

async function api<T>(path: string, init?: RequestInit): Promise<ApiResult<T>> {
	let res: Response;
	try {
		res = await fetch(apiPath(path), init);
	} catch {
		// 断网 / 被拦:这是唯一一句前端自己写的错误文案,因为后端根本没被打到
		return { ok: false, fail: OFFLINE };
	}
	let body: unknown = null;
	try {
		body = await res.json();
	} catch {
		// 非 JSON 响应(理论上只有边缘故障页)。下面按状态码兜底。
	}
	if (res.ok) return { ok: true, data: body as T };
	return { ok: false, fail: toFail(res, body) };
}

// ---------------------------------------------------------------------------
// 小件
// ---------------------------------------------------------------------------

function fmtDate(ms: number): string {
	const d = new Date(ms);
	if (Number.isNaN(d.getTime())) return "";
	const p = (n: number) => String(n).padStart(2, "0");
	return `${p(d.getMonth() + 1)}-${p(d.getDate())} ${p(d.getHours())}:${p(d.getMinutes())}`;
}

/** retry-after 是「到 UTC 零点还有多少秒」,直接显示秒数没人算得过来。 */
function fmtRetry(sec: number): string {
	if (sec < 60) return `${sec} 秒`;
	const m = Math.round(sec / 60);
	if (m < 60) return `${m} 分钟`;
	return `${Math.floor(m / 60)} 小时 ${m % 60} 分钟`;
}

const SCOPE_LABEL: Record<string, string> = {
	account: "这是你这个账号今天的额度",
	ip: "这是同一个网络下所有账号合计的额度",
	global: "这是全站今天的预算上限",
};

/**
 * 错误框。**每种状态码都要有一条出路**,不能只把一句红字丢在那儿:
 *   401 → 后端给的 loginUrl(不自己拼地址)
 *   409 / refresh → 刷新页面
 *   429 → 说清是哪一道闸、什么时候恢复
 *   502/503/0 → 能重来的给「再试一次」
 *
 * **refresh 那一条不能只看状态码**(2026-09-01 第二轮评审的「提醒」):两个
 * 标签页各开一份草稿时,B 先保存,A 再保存会撞「原话不许改」的 400,而 A 手里
 * 那份草稿**每一次重试都是同一个 400**——草稿态下页面上又没有删档按钮,
 * 「再试一次」是在叫他做一件他做不到的事,唯一的出路是刷新。同是 400,校验
 * 失败那种重试是有意义的,所以这件事只能由后端标出来(ApiError.refresh)。
 */
function FailBox({ fail, onRetry, onDismiss }: { fail: Fail; onRetry?: () => void; onDismiss?: () => void }) {
	return (
		<div className="error-box" role="alert">
			<p style={{ margin: 0 }}>{fail.error}</p>
			<div className="danger-row" style={{ marginTop: 10 }}>
				{fail.status === 401 && fail.loginUrl && (
					<a className="btn-line" href={fail.loginUrl}>
						去南屿登录 →
					</a>
				)}
				{(fail.status === 409 || fail.refresh) && (
					<button type="button" className="btn-line" onClick={() => window.location.reload()}>
						刷新页面
					</button>
				)}
				{fail.status === 429 && (
					<span className="char-count">
						{SCOPE_LABEL[fail.scope ?? ""] ?? "额度用完了"}
						{fail.retryAfter ? ` · 约 ${fmtRetry(fail.retryAfter)}后恢复` : " · 明天自动恢复"}
					</span>
				)}
				{onRetry && !fail.refresh && fail.status !== 401 && fail.status !== 409 && fail.status !== 429 && (
					<button type="button" className="btn-line" onClick={onRetry}>
						再试一次
					</button>
				)}
				{onDismiss && (
					<button type="button" className="btn-quiet" onClick={onDismiss}>
						知道了
					</button>
				)}
			</div>
		</div>
	);
}

/** 空档案的初始值:所有编辑都从它出发。 */
const EMPTY: DossierFields = { domain: "", caresAbout: [], notCaresAbout: [], queries: [] };

const pick = (d: Dossier): DossierFields => ({
	domain: d.domain,
	caresAbout: [...d.caresAbout],
	notCaresAbout: [...d.notCaresAbout],
	queries: [...d.queries],
});

/**
 * 页面处在哪一屏。
 * - locked 是 401 专用的锁屏,不是普通错误(「还没登录」不该长得像故障);
 * - error 是**拉取失败**专用的一屏。它必须和 seed 分开:GET 挂了不等于
 *   「这个人没有档案」,把他丢到种子屏会诱导他重打一句话,而那句话在
 *   PUT 时会撞上「原话不许改」的 400,他完全看不懂自己做错了什么。
 */
type Phase = "loading" | "locked" | "error" | "seed" | "editing";

/** 这次失败是哪个动作造成的 —— 决定「再试一次」重试什么。 */
type FailFrom = "load" | "draft" | "save" | "delete" | "scan" | "run" | "appeal" | "report" | "email" | "changes";

/**
 * 四屏之间的标签条。
 *
 * 「本周清单」在前:它是这个产品每周真正要看的东西,档案是为它服务的定义。
 * 没有已保存的档案时它是禁用的 —— 没有检索词就没有清单,让人点进一个空屏
 * 再自己找回来,不如在这里就说清楚为什么点不了。
 *
 * 「跨周变化」紧跟其后,而且**常驻**(不像报告那一格按需出现)。理由是
 * docs/01 风险 4 那条判据:「第二个月诚实复盘一次,如果站长从不去翻上一周的
 * 结果,就该把这个产品退回 skill 形态」——一个藏起来的入口会让那条判据测出来的
 * 不是「他不关心跨周」,而是「他没找到那个入口」,两者会得出完全相反的结论。
 * 它在第一周点进去也有意义:那一屏会如实说「这是第一周,没有可比的上一周」。
 *
 * 「深度报告」那一格**只有手上真有一份(或者正在跑一份)时才出现**:常驻一个
 * 点进去是空屏的标签,和「这个仓还没拆过」长得一模一样,而后者是个正常状态。
 */
function ViewTabs({
	view,
	onView,
	ready,
	report,
}: {
	view: View;
	onView: (v: View) => void;
	ready: boolean;
	/** 报告那一格显示什么;null = 这一格不出现。 */
	report: string | null;
}) {
	return (
		<nav className="view-tabs" aria-label="视图切换">
			<button
				type="button"
				className={`view-tab${view === "scan" ? " on" : ""}`}
				disabled={!ready}
				title={ready ? "这一周捞回了什么、筛掉了什么" : "先建一份档案 —— 没有检索词就没有清单"}
				onClick={() => onView("scan")}
			>
				本周清单
			</button>
			<button
				type="button"
				className={`view-tab${view === "changes" ? " on" : ""}`}
				disabled={!ready}
				title={ready ? "这一周和上一次比变了什么,以及翻回以前那几周" : "先建一份档案 —— 没有档案就没有任何一周的记录"}
				onClick={() => onView("changes")}
			>
				跨周变化
			</button>
			{report && (
				<button type="button" className={`view-tab${view === "report" ? " on" : ""}`} onClick={() => onView("report")}>
					{report}
				</button>
			)}
			<button type="button" className={`view-tab${view === "dossier" ? " on" : ""}`} onClick={() => onView("dossier")}>
				关注档案
			</button>
		</nav>
	);
}

// ---------------------------------------------------------------------------
// 主组件
// ---------------------------------------------------------------------------

export default function App() {
	const [phase, setPhase] = useState<Phase>("loading");
	const [health, setHealth] = useState<HealthResponse | null>(null);
	/** 库里那一份。null = 还没保存过(新用户,或刚 draft 出来的草稿)。 */
	const [saved, setSaved] = useState<Dossier | null>(null);
	const [sentence, setSentence] = useState("");
	const [fields, setFields] = useState<DossierFields>(EMPTY);
	const [verbatim, setVerbatim] = useState(false);
	const [seedText, setSeedText] = useState("");
	const [busy, setBusy] = useState<null | "draft" | "save" | "delete">(null);
	const [fail, setFail] = useState<Fail | null>(null);
	const [failFrom, setFailFrom] = useState<FailFrom | null>(null);
	/** 编辑被规则拦下的一句话(重复了 / 那栏满了)。一次一条,下一次操作即替换。 */
	const [notice, setNotice] = useState<string | null>(null);
	/** 保存/删除成功后的回执。说清「下次周扫会用哪一版」,不说「已保存」。 */
	const [receipt, setReceipt] = useState<string | null>(null);
	const [confirmDelete, setConfirmDelete] = useState(false);
	/**
	 * 门铃邮件的订阅状态(阶段 9)。null = 还没读到 —— **不给默认值**:
	 * 一个默认显示「在收」的开关,在真实状态是「已退订」时是一句谎话,
	 * 而这个产品对「安静地说错话」的容忍度是零(docs/01 风险 1)。
	 */
	const [emailPrefs, setEmailPrefs] = useState<EmailPrefs | null>(null);
	const [emailBusy, setEmailBusy] = useState(false);

	// ---------- 阶段 5:第二屏(本周清单) ----------
	// 初值只看地址栏。**不看有没有档案**——那时候还没拉回来,猜一个再改会让
	// 页面在加载完的一瞬间跳屏。没显式指定的话,load 拿到结果后再定(见 load)。
	const [view, setView] = useState<View>(() => viewInSearch(window.location.search) ?? "dossier");
	const [scan, setScan] = useState<GetScanResponse | null>(null);
	/** 只有「刚跑完」才知道的那些(trace / rate / stopped)。GET 回来的历史没有。 */
	const [extras, setExtras] = useState<RunExtras>({});
	const [scanBusy, setScanBusy] = useState<null | "load" | "run">(null);
	/** 正在申诉的那个仓名。一次只许一个,免得两条申诉在台账上打架。 */
	const [appealing, setAppealing] = useState<string | null>(null);
	/** 申诉失败时「再试一次」要重试哪一个。 */
	const [lastAppeal, setLastAppeal] = useState<string | null>(null);
	/**
	 * 清单屏那条回执。**类型是 ReactNode 不是 string**(上线前终审 A2):重跑的回执
	 * 里要分行说清「搬回来了哪几个」和「哪几个下次会自动回来」,而那两句必须是**组件
	 * 渲染出来的**才被渲染层测试抓得住 —— 一个返回字符串的纯函数正好是阶段 3 栽过的
	 * 那个形状(话算对了,但没有任何一层把它送到屏幕上)。
	 */
	const [scanReceipt, setScanReceipt] = useState<ReactNode>(null);
	/** 重跑前的二次确认(上线前终审 A2:在这之前它是一颗点下去就走的裸按钮)。 */
	const [confirmRerun, setConfirmRerun] = useState(false);

	// ---------- 上线前终审:第四屏(跨周变化) ----------
	// 这一屏是这个产品相对一个 Claude Code skill 的唯一存在理由(docs/01
	// 「为什么不做成 skill」),也是风险 4 那条判据(「站长会不会去翻上一周」)
	// 在产品里的落点 —— 在它出现之前,产品里根本没有「翻上一周」这个动作可翻。
	/** 翻周那一列(GET /api/scan/history)。null = 还没取过。 */
	const [weekList, setWeekList] = useState<WeeklyScan[] | null>(null);
	/**
	 * 在翻哪一周;null = 最近一周。初值只看地址栏 —— 门铃邮件将来链过来的是
	 * **那一封信说的那一周**,不是「你现在最近的那一周」。
	 */
	const [pickedWeek, setPickedWeek] = useState<string | null>(() => weekOfInSearch(window.location.search));
	/**
	 * 那一周的跨周记录。**null 有两种来源,而它们在页面上是两句完全不同的话**:
	 * 还没取到(看 changesBusy)、和后端明确回了 `change: null`(= 这一周没有跨周
	 * 记录,不是「没有变化」)。所以取数成功之后一定要 set 一次,哪怕值就是 null。
	 */
	const [change, setChange] = useState<WeeklyChange | null>(null);
	/** 那一周的整包清单(GET /api/scan?weekOf=)。 */
	const [weekScan, setWeekScan] = useState<GetScanResponse | null>(null);
	const [changesBusy, setChangesBusy] = useState<null | "history" | "week">(null);
	/**
	 * 翻周列取过没有(**成功或失败都算取过**)。同样用 ref 不用 state,理由同下面
	 * 那个 `loadedWeek`:它只是「别自动再发一次」的记号。取失败时如果不记一笔,
	 * `changesBusy` 归 null 会立刻把取数 effect 再点着一次,于是一次 500 变成一条
	 * 打不完的重试流。人工重试走「再试一次」(dropChangesCache 会把这两个记号一起清掉)。
	 */
	const historyTried = useRef(false);
	/**
	 * 已经取过哪一周了。用 ref 不用 state:它只是「别重复发请求」的记号,
	 * 进 state 会让取数 effect 的依赖变一遍再触发一次(同 `tried` 那个 ref 防的
	 * 死循环)。`""` = 一周都没有(空档案),也算取过。
	 */
	const loadedWeek = useRef<string | null>(null);

	// ---------- 阶段 7:第三屏(深度报告) ----------
	// 初值只看地址栏:`?id=` / `?repo=` 是给外部链接留的入口(阶段 8 的门铃邮件
	// 会链过来),所以刷新、分享、从邮件点进来走的是同一条路。
	const [reportTarget, setReportTarget] = useState<ReportTarget | null>(() => reportTargetInSearch(window.location.search));
	const [report, setReport] = useState<TeardownReport | null>(null);
	const [run, setRun] = useState<RunState>(IDLE);
	/** 正在从库里取一份已经生成的报告(不是在跑新的)。 */
	const [reportLoading, setReportLoading] = useState(false);
	const [reportReceipt, setReportReceipt] = useState<string | null>(null);
	/**
	 * 接回轮询的换代号。开新的一趟时 +1,老循环下一跳发现号变了就自己收场。
	 * 用计数而不是布尔:布尔那种写法在「刚接回又点了新的一趟」时会把新循环也停掉。
	 */
	const pollGen = useRef(0);

	// /api/health 是公开端点:provider 和 D1 绑没绑上直接影响用户看到的东西
	// (mock 拆出来的档案带 [mock] 前缀),不露出来的话没人分得清。
	useEffect(() => {
		void (async () => {
			const r = await api<HealthResponse>("health");
			if (r.ok) setHealth(r.data);
		})();
	}, []);

	// 订阅状态和 health 一起在挂载时读一次。**读失败就让它停在 null**,
	// 开关会显示「正在读订阅状态…」而不是编一个「在收」出来。
	useEffect(() => {
		void (async () => {
			const r = await api<EmailPrefs>("email");
			if (r.ok) setEmailPrefs(r.data);
		})();
	}, []);

	/**
	 * 改订阅状态。**用后端回的那一份覆盖本地状态,不是本地先改再发**:
	 * 乐观更新在这里是有害的 —— 写失败时页面会显示一个根本没生效的状态,
	 * 而下一个星期一才有人发现信没来(或者还在来)。
	 */
	const setEmailOptOut = useCallback(async (optedOut: boolean) => {
		setEmailBusy(true);
		setFail(null);
		setFailFrom(null);
		const r = await api<EmailPrefs>("email", {
			method: "PUT",
			headers: { "content-type": "application/json" },
			body: JSON.stringify({ optedOut }),
		});
		setEmailBusy(false);
		if (!r.ok) {
			setFail(r.fail);
			setFailFrom("email");
			if (r.fail.status === 401) setPhase("locked");
			return;
		}
		setEmailPrefs(r.data);
		setReceipt(r.data.optedOut ? "已退订 —— 下周一不再发信,网页照常。" : "已重新订阅 —— 下一次周扫跑完就会发信。");
	}, []);

	const load = useCallback(async () => {
		setPhase("loading");
		// 重试时先把上一次的错误框收掉,否则骨架屏和红框会同时挂在页面上,
		// 看起来像「又失败了一次」
		setFail(null);
		setFailFrom(null);
		const r = await api<GetDossierResponse>("dossier");
		if (!r.ok) {
			setFail(r.fail);
			setFailFrom("load");
			// 401 是「还没登录」,不是故障:走锁屏,不进错误框
			setPhase(r.fail.status === 401 ? "locked" : "error");
			return;
		}
		setFail(null);
		setFailFrom(null);
		// **null 不是 404**:后端用它区分「新用户」和「出错了」(dossier.ts)
		if (r.data.dossier === null) {
			setSaved(null);
			setSentence("");
			setFields(EMPTY);
			setPhase("seed");
			return;
		}
		setSaved(r.data.dossier);
		setSentence(r.data.dossier.sentence);
		setFields(pick(r.data.dossier));
		setVerbatim(false);
		setPhase("editing");
		// 地址栏没显式指定视图时(SSO 落点 `/app` 就是这一支),现在才有依据选:
		// 有档案 → 本周清单。顺手 replaceState 把它写进地址栏,于是刷新不丢、
		// 后退不会先跳回一个「没指定」的中间态。
		if (viewInSearch(window.location.search) === null) {
			const v = defaultView(true);
			setView(v);
			window.history.replaceState(null, "", `${window.location.pathname}${searchForView(v)}`);
		}
	}, []);

	useEffect(() => {
		void load();
	}, [load]);

	// ---------- 视图切换 ----------

	/**
	 * 切屏 = 推一条历史。后退键因此能在三屏之间来回,而不是直接离开产品。
	 *
	 * 报告屏必须把「是哪一份」一起写进地址栏(`?view=report&repo=owner/repo`),
	 * 否则刷新之后是一张空屏 —— 而空屏和「这个仓还没拆过」长得一模一样。
	 */
	const goView = useCallback((v: View, target?: ReportTarget | null, weekOf?: string | null) => {
		setView(v);
		if (v === "report" && target) setReportTarget(target);
		const t = v === "report" ? (target ?? reportTargetInSearch(window.location.search)) : null;
		// 切到跨周屏**默认回到最近一周**(w = null),而不是继承上一次翻到哪。
		// 继承的话地址栏和状态会分家:从 W35 切去清单屏再切回来,地址栏写着
		// `?view=changes`(没有 weekOf)而页面显示 W35 —— 刷新一次就跳周,
		// 而这一屏的全部意义就是「你现在看的是哪一周」要说得死死的。
		// 要看具体某一周走 pickWeek(它会把 weekOf 一起推进地址栏)。
		const w = v === "changes" ? (weekOf ?? null) : null;
		if (v === "changes") setPickedWeek(w);
		window.history.pushState(null, "", `${window.location.pathname}${searchForView(v, t, w)}`);
	}, []);

	/**
	 * 翻到某一周。**推一条历史**,所以后退键能在翻过的几周之间来回,
	 * 而且这一周的地址可以直接复制给别人(或者被门铃邮件链过来)。
	 */
	const pickWeek = useCallback((weekOf: string) => {
		setPickedWeek(weekOf);
		window.history.pushState(null, "", `${window.location.pathname}${searchForView("changes", null, weekOf)}`);
	}, []);

	useEffect(() => {
		const onPop = () => {
			setView(viewInSearch(window.location.search) ?? "dossier");
			// 后退回一份**别的**报告时,目标也要跟着回去,否则地址栏说 A、页面显示 B
			setReportTarget(reportTargetInSearch(window.location.search));
			// 跨周屏同理:后退回上一周时,「在翻哪一周」也得跟着回去
			setPickedWeek(weekOfInSearch(window.location.search));
		};
		window.addEventListener("popstate", onPop);
		return () => window.removeEventListener("popstate", onPop);
	}, []);

	// ---------- 本周清单:取 / 跑 / 申诉 ----------

	const loadScan = useCallback(async () => {
		setScanBusy("load");
		setFail(null);
		setFailFrom(null);
		const r = await api<GetScanResponse>("scan");
		setScanBusy(null);
		if (!r.ok) {
			setFail(r.fail);
			setFailFrom("scan");
			if (r.fail.status === 401) setPhase("locked");
			return;
		}
		setScan(r.data);
		// GET 那一路没有 trace / rate / stopped(它们只有「刚跑完」才知道)。
		// 清空而不是留着上一次的:留着的话,读一份历史周扫会看到另一周的配额
		// 实况挂在下面,而它长得就像这一周的。
		setExtras({});
	}, []);

	// 进到清单屏、还没有数据、且档案是**保存过的**(草稿没有周扫可看)时拉一次
	useEffect(() => {
		if (view !== "scan" || scan !== null || scanBusy !== null || saved === null) return;
		void loadScan();
	}, [view, scan, scanBusy, saved, loadScan]);

	// ---------- 跨周变化:翻周列 + 某一周的结论与清单 ----------

	/**
	 * 取翻周那一列。**只取台账不取明细**(后端 `GET /api/scan/history` 就是这么
	 * 设计的),所以这一条即使有 52 周也很轻。
	 */
	const loadHistory = useCallback(async () => {
		setChangesBusy("history");
		setFail(null);
		setFailFrom(null);
		const r = await api<ScanHistoryResponse>("scan/history");
		setChangesBusy(null);
		if (!r.ok) {
			setFail(r.fail);
			setFailFrom("changes");
			if (r.fail.status === 401) setPhase("locked");
			return;
		}
		setWeekList(r.data.scans);
	}, []);

	/**
	 * 取某一周的**跨周结论 + 那一周的整包清单**。
	 *
	 * 两条请求都**显式带上 weekOf**,不吃后端「不传取最近一周」那条默认。理由很具体:
	 * 两条端点各自取「最近一周」时取的不是同一个东西 —— `scan/changes` 取的是最近
	 * 一条**跨周记录**,`scan` 取的是最近一次**周扫**。一周有周扫但没有跨周记录
	 * (那一周跑在这条改动上线之前)时,两者就是两个不同的星期,而页面会把 W35 的
	 * 结论和 W36 的清单并排摆着,不报错,只是**说的不是同一件事**。
	 *
	 * 并发发出去:两条都是纯读,谁先回来都行,合起来只等一个往返。
	 */
	const loadWeek = useCallback(async (weekOf: string) => {
		setChangesBusy("week");
		// **先把手上那一份清掉**:留着的话,换周期间页面头上写着新的一周、底下摆着
		// 上一周的结论,两边都是真数据,没有一处会报错 —— 又一次「错得很安静」。
		setChange(null);
		setWeekScan(null);
		setFail(null);
		setFailFrom(null);
		const q = `?weekOf=${encodeURIComponent(weekOf)}`;
		const [c, b] = await Promise.all([
			api<GetScanChangesResponse>(`scan/changes${q}`),
			api<GetScanResponse>(`scan${q}`),
		]);
		setChangesBusy(null);
		const bad = !c.ok ? c.fail : !b.ok ? b.fail : null;
		if (bad) {
			// **失败时把记号留着**(不是清掉)。清掉的话:changesBusy 归 null 触发重渲染 →
			// 下面那个 effect 发现「这一周还没取过」→ 再发一次 → 再失败……一个后端 500
			// 会变成一条打不完的重试流,而页面上只是一直红着。人工重试走「再试一次」
			// (它调 dropChangesCache,那里会把记号清掉)。
			setFail(bad);
			setFailFrom("changes");
			if (bad.status === 401) setPhase("locked");
			return;
		}
		// **两个都要 set,哪怕值就是 null**:`change: null` 是后端明确说的
		// 「这一周没有跨周记录」,和「还没取到」是两句完全不同的话。
		setChange(c.ok ? c.data.change : null);
		setWeekScan(b.ok ? b.data : null);
	}, []);

	// 进到跨周屏、档案是保存过的、翻周列还没取过时拉一次
	useEffect(() => {
		if (view !== "changes" || saved === null || weekList !== null || changesBusy !== null || historyTried.current) return;
		historyTried.current = true;
		void loadHistory();
	}, [view, saved, weekList, changesBusy, loadHistory]);

	// 翻周列到手之后,按「地址栏说的那一周,没说就是最新那一周」取内容。
	// **一周都没有时也要记一笔**(loadedWeek = ""),否则这个 effect 每次渲染都
	// 会再算一遍目标、发现还是空、然后什么都不做 —— 不发请求,但也永远退不出
	// 「正在读」那个状态。
	useEffect(() => {
		if (view !== "changes" || saved === null || weekList === null || changesBusy !== null) return;
		const target = pickedWeek ?? weekList[0]?.weekOf ?? "";
		if (loadedWeek.current === target) return;
		loadedWeek.current = target;
		if (target === "") {
			setChange(null);
			setWeekScan(null);
			return;
		}
		void loadWeek(target);
	}, [view, saved, weekList, pickedWeek, changesBusy, loadWeek]);

	/**
	 * 这一周的东西刚被改过(重跑 / 申诉 / 删档),把跨周屏那一份缓存作废。
	 *
	 * 不作废的话:重跑完切到跨周屏,看到的是**重跑之前**那份清单和台账,而它长得
	 * 完全正常 —— 又一次「错得很安静」。跨周结论本身要等下一次 cron 才会重算,
	 * 所以这里只是让它重新去读,不是让它重新去算。
	 */
	const dropChangesCache = useCallback(() => {
		setWeekList(null);
		setChange(null);
		setWeekScan(null);
		historyTried.current = false;
		loadedWeek.current = null;
	}, []);

	const runScan = useCallback(async () => {
		setConfirmRerun(false);
		setScanBusy("run");
		setFail(null);
		setFailFrom(null);
		setScanReceipt(null);
		const r = await api<RunScanResponse>("scan", { method: "POST" });
		setScanBusy(null);
		if (!r.ok) {
			setFail(r.fail);
			setFailFrom("run");
			if (r.fail.status === 401) setPhase("locked");
			return;
		}
		setScan({ scan: r.data.scan, candidates: r.data.candidates, exclusions: r.data.exclusions, honesty: r.data.honesty });
		// **stopped 不在 extras 里**:它现在是台账的一列(WeeklyScan.stopped),
		// 落了库,刷新之后照样在。extras 只装真正「只有刚跑完才知道」的两样
		// (trace / rate)—— 那两样确实没落库,GET 回来的历史看不到。
		setExtras({ trace: r.data.trace, rate: r.data.rate });
		// 回执里最要紧的是 appeals 那两栏(上线前终审 A2):重跑把这一周的候选和
		// 排除整批换掉了,用户自己捞回来的那几个搬没搬回来,只有这里说得清。
		setScanReceipt(
			<RerunReceipt appeals={r.data.appeals} stopped={r.data.scan?.stopped ?? null} rate={r.data.rate} />,
		);
		// 这一周的清单刚被整批换掉,跨周屏手上那份缓存立刻过期
		dropChangesCache();
	}, [dropChangesCache]);

	/**
	 * 申诉:「这个该进来」(docs/01 决策 4)。
	 *
	 * `weekOf` 从**当前这一屏**的台账取,不让后端默认「最近一周」:用户是在
	 * 看着某一周点的按钮,而这中间 cron 完全可能刚跑出新的一周。
	 *
	 * 回来的是**整包刷新后的那一周**,直接整个替换 —— 台账三个数在这一次里
	 * 全都动了(进清单 +1、排除 -1、分组少一条),前端自己打补丁就等于让它
	 * 算数,而这一屏的全部立场就是「前端不算数」。
	 *
	 * `extras` 故意**不动**:trace / rate 说的是那一趟搜索的事,而申诉一路
	 * 搜索都没重跑,改它就是在编。
	 */
	const appeal = useCallback(
		async (fullName: string) => {
			const weekOf = scan?.scan?.weekOf;
			if (!weekOf || appealing !== null) return;
			setAppealing(fullName);
			setLastAppeal(fullName);
			setFail(null);
			setFailFrom(null);
			setScanReceipt(null);
			const r = await api<AppealResponse>("scan/appeal", {
				method: "POST",
				headers: { "content-type": "application/json" },
				body: JSON.stringify({ weekOf, fullName }),
			});
			setAppealing(null);
			if (!r.ok) {
				setFail(r.fail);
				setFailFrom("appeal");
				if (r.fail.status === 401) setPhase("locked");
				return;
			}
			setScan({ scan: r.data.scan, candidates: r.data.candidates, exclusions: r.data.exclusions, honesty: r.data.honesty });
			// 申诉动了这一周的候选和排除(admitted +1 / excluded -1),跨周屏那份也过期了
			dropChangesCache();
			setScanReceipt(
				r.data.appealed
					? `${fullName} 已经进了这一周的候选清单。只重跑了它一个仓的 GET /repos` +
						`${r.data.rerun.oneLiner ? " 和一次形态描述" : "(形态描述没拿到,不影响清单)"}` +
						" —— 整周的 GitHub 搜索一次都没重跑。下一周它照样按规则筛,要看还得再点一次。"
					: `${fullName} 之前就已经捞回来过了,这一次一个请求都没发,额度也没扣。`,
			);
		},
		[scan, appealing, dropChangesCache],
	);

	// ---------- 深度报告:跑 / 接回 / 取历史 ----------

	/**
	 * 已经试着取过哪一份了。**防的是一个死循环**:`GET /api/report` 取不到时回的是
	 * `{ report: null }` + 200(不是 404),而「没取到」这个状态本身会让取数的 effect
	 * 依赖变一遍再触发一次,于是页面会对着一个还没拆过的仓无限打请求。
	 */
	const tried = useRef("");

	/** 停掉可能在跑的接回轮询。换代号一加,老循环下一跳自己收场。 */
	const stopPolling = useCallback(() => {
		pollGen.current += 1;
	}, []);

	// 卸载时停掉轮询,**并且把「接回过了」这个标记也一起清掉**:StrictMode 在开发
	// 环境下会 mount → cleanup → mount 走一遍,只停不清的话第二次 mount 会因为标记
	// 还在而不再接回,于是开发时永远看不到接回那条路(线上不会,但会让人以为它坏了)。
	useEffect(
		() => () => {
			stopPolling();
			resumedOnce.current = false;
		},
		[stopPolling],
	);

	/** 从库里取一份已经生成的报告(直接链接进来、或者切回这一屏时)。 */
	const loadReport = useCallback(async (target: ReportTarget) => {
		setReportLoading(true);
		setFail(null);
		setFailFrom(null);
		const q = target.id
			? `report?id=${encodeURIComponent(target.id)}`
			: `report?fullName=${encodeURIComponent(target.repo ?? "")}`;
		const r = await api<GetReportResponse>(q);
		setReportLoading(false);
		if (!r.ok) {
			setFail(r.fail);
			setFailFrom("report");
			if (r.fail.status === 401) setPhase("locked");
			return;
		}
		// **null 不是 404**:后端用它区分「还没拆过」和「出错了」(同 GET /api/scan)
		setReport(r.data.report);
	}, []);

	useEffect(() => {
		if (view !== "report" || reportTarget === null || run.kind === "running" || reportLoading) return;
		const key = reportTarget.id ?? `repo:${reportTarget.repo ?? ""}`;
		// 手上这一份就是地址栏要的那一份时不用再取
		const matches = report && (reportTarget.id ? report.id === reportTarget.id : report.fullName === reportTarget.repo);
		if (matches || tried.current === key) return;
		tried.current = key;
		void loadReport(reportTarget);
	}, [view, reportTarget, report, reportLoading, run.kind, loadReport]);

	/**
	 * 接回的那一趟收场了(inflight 变成 null)。**这里必须分清「跑完了」和「跑挂了」**,
	 * 而这两者在库里长得一样:成功那一路是 saveReport → 推 result → 清 inflight,
	 * 失败那一路是推 error → 清 inflight,报告根本没落库。
	 *
	 * 所以判据是**时间戳**:取回来的那一份如果比这一趟的 startedAt 还老,它就是
	 * **上一次**拆的(`GET /api/report?fullName=` 给的是这个仓最近一份,不限 commit)。
	 * 不比这一下的话,页面会把一份旧报告当成刚跑出来的结果摆上去 —— 一次静悄悄的
	 * 张冠李戴,而且它带着一个看起来很硬的时间线。
	 */
	const finishResumed = useCallback(async (fullName: string, startedAt: number) => {
		const r = await api<GetReportResponse>(`report?fullName=${encodeURIComponent(fullName)}`);
		if (!r.ok) {
			setFail(r.fail);
			setFailFrom("report");
			if (r.fail.status === 401) setPhase("locked");
			setRun(IDLE);
			return;
		}
		const got = r.data.report;
		if (got && got.generatedAt >= startedAt) {
			setReport(got);
			setRun({ kind: "done", fullName, cached: false });
			setReportReceipt("跑完了。这一份是刷新之后接回来的 —— 那一趟一直在服务端跑着,和你这个页面在不在没有关系。");
			return;
		}
		if (got) {
			setReport(got);
			setReportReceipt(
				`下面这一份是 ${fullName} 之前拆的(commit ${shortSha(got.commitSha)}),不是刚才那一趟的结果 —— 刚才那一趟没有留下报告。`,
			);
		}
		setRun({
			kind: "failed",
			fullName,
			error:
				"刚才那一趟在服务端失败了(上游不通,或者跑到一半被中断),没有留下报告。" +
				"这一次已经计入今天的额度 —— 报告一开跑就占了额度,失败不退。过几分钟再试一次。",
			quota: false,
			refresh: false,
		});
	}, []);

	/**
	 * 接回进度靠**轮询 `/api/report/inflight`**,不是重连 SSE。
	 *
	 * 为什么不能重连:那条流的写端在服务端的 `waitUntil` 里,页面一刷新就拿不回来了
	 * (002 踩过同一个坑,它的 resumeFast 也是改成轮询同一份指针)。所以接回来的是
	 * **进度不是流**,页面上要照实说,而「已生成 N 字」这种只有流才知道的东西
	 * 在这一支里根本不会有。
	 *
	 * 为什么不选「给一句『跑完了刷新看』就完事」:那一趟要 1-2 分钟,让人自己猜什么
	 * 时候该刷新,等于把一个我们查得到的状态推给用户去人肉轮询。而且他多半会直接
	 * 再点一次「拆开看看」—— 那是当天两份额度里的第二份,而后端只会回 409。
	 *
	 * 复用同一个 `reduceRun`(喂合成的 phase / ping 事件)是有意的:接回来那一路和
	 * 跑着那一路要是各写一份状态推进,两者迟早只有一个是对的。
	 */
	const pollInflight = useCallback(
		async (fullName: string, startedAt: number) => {
			const gen = ++pollGen.current;
			for (;;) {
				await new Promise((r) => setTimeout(r, 3000));
				if (pollGen.current !== gen) return;
				const r = await api<ReportInflightResponse>("report/inflight");
				if (pollGen.current !== gen) return;
				if (!r.ok) {
					setFail(r.fail);
					setFailFrom("report");
					if (r.fail.status === 401) setPhase("locked");
					setRun(IDLE);
					return;
				}
				const live = r.data.inflight;
				if (live) {
					setRun((cur) => reduceRun(reduceRun(cur, { type: "phase", phase: live.phase as ReportPhase }), { type: "ping" }));
					continue;
				}
				await finishResumed(fullName, startedAt);
				return;
			}
		},
		[finishResumed],
	);

	/**
	 * 进页面先问一句:有没有还没收场的一单。
	 *
	 * 有的话**直接把人送到报告屏**。理由不是「顺手」:那一趟已经花掉了 $0.4-0.6,
	 * 而它的进度只有这一屏看得到;把它留在清单屏上不提,读者唯一能做的判断是
	 * 「刚才那一下没反应」,然后再点一次。
	 */
	const resumeInflight = useCallback(async () => {
		const r = await api<ReportInflightResponse>("report/inflight");
		if (!r.ok || !r.data.inflight) return;
		const live = r.data.inflight;
		const phase = phaseIndex(live.phase) >= 0 ? (live.phase as ReportPhase) : null;
		setReport(null);
		setRun(startRun(live.fullName, true, phase));
		goView("report", { repo: live.fullName });
		void pollInflight(live.fullName, live.startedAt);
	}, [goView, pollInflight]);

	/** 只在拉到档案之后问一次。放 effect 里(不放 load 里)是为了避开 useCallback 的定义顺序。 */
	const resumedOnce = useRef(false);
	useEffect(() => {
		if (phase !== "editing" || saved === null || resumedOnce.current) return;
		resumedOnce.current = true;
		void resumeInflight();
	}, [phase, saved, resumeInflight]);

	/** SSE:一帧一帧喂给 reduceRun。**分帧和状态机都在 report-run.ts 里,这里只搬字节。** */
	const readReportStream = useCallback(async (res: Response, fullName: string) => {
		const body = res.body;
		if (!body) {
			setRun(streamCutOff(startRun(fullName)));
			return;
		}
		const reader = body.getReader();
		const dec = new TextDecoder();
		let buf = "";
		try {
			for (;;) {
				const { done, value } = await reader.read();
				if (done) break;
				buf += dec.decode(value, { stream: true });
				const { events, rest } = splitSse(buf);
				buf = rest;
				for (const ev of events) {
					if (ev.type === "result") setReport(ev.report);
					setRun((cur) => reduceRun(cur, ev));
				}
			}
		} catch {
			// 读到一半断了。下面那一行统一按「流断了但没收到终态」处理。
		}
		// 收到过 result / error 的话状态已经是终态,streamCutOff 什么都不改。
		setRun((cur) => streamCutOff(cur));
	}, []);

	/**
	 * 点「拆开看看」。
	 *
	 * **同一条 POST 可能回 SSE 也可能回 JSON**,所以这里按 `content-type` 分支,
	 * 不按状态码猜:命中去重(同一个 commit 已经拆过)时后端回的是
	 * `{ report, cached: true }` + `application/json`,而一份已经存好的报告没有
	 * 任何进度可以流式推送。当成流去读的话,读出来的是一整块 JSON,一帧都分不出来,
	 * 页面会一直转到超时 —— 而后端其实早就把结果给了。
	 */
	const teardown = useCallback(
		async (fullName: string) => {
			const weekOf = scan?.scan?.weekOf;
			if (!weekOf || run.kind === "running") return;
			stopPolling();
			tried.current = "";
			setFail(null);
			setFailFrom(null);
			setReportReceipt(null);
			setReport(null);
			setRun(startRun(fullName));
			goView("report", { repo: fullName });

			const payload: RunReportRequest = { weekOf, fullName };
			let res: Response;
			try {
				res = await fetch(apiPath("report"), {
					method: "POST",
					headers: { "content-type": "application/json" },
					body: JSON.stringify(payload),
				});
			} catch {
				setRun(IDLE);
				setFail(OFFLINE);
				setFailFrom("report");
				return;
			}

			if (res.ok && (res.headers.get("content-type") ?? "").includes("text/event-stream")) {
				await readReportStream(res, fullName);
				return;
			}

			let body: unknown = null;
			try {
				body = await res.json();
			} catch {
				// 非 JSON:下面按状态码兜底
			}
			if (res.ok) {
				const d = (body ?? {}) as { report?: TeardownReport; cached?: boolean };
				if (d.report) {
					setReport(d.report);
					setRun({ kind: "done", fullName, cached: d.cached === true });
					setReportReceipt(
						"这个 commit 之前已经拆过,直接给你那一份 —— 没有重跑,也没有扣今天的额度。等它有了新提交再拆才会是新的。",
					);
					return;
				}
				setRun({
					kind: "failed",
					fullName,
					error: "服务端回了一个既不是事件流、也不带报告的响应。这一趟没有结果,刷新一下再看。",
					quota: false,
					refresh: true,
				});
				return;
			}

			const f = toFail(res, body);
			setRun(IDLE);
			setFail(f);
			setFailFrom("report");
			if (f.status === 401) setPhase("locked");
		},
		[scan, run.kind, goView, stopPolling, readReportStream],
	);

	// ---------- 一句话 → 草稿 ----------

	const draftIt = useCallback(async () => {
		const s = seedText.trim();
		// 前端先挡:省一次注定失败的往返,而且理由能直接显示在输入框旁边,
		// 不用等一个红框回来。
		// **不是为了省额度**——dossier.ts 里这两个 400(空句子 / 超长)发生在
		// reserveOrDeny 之前,后端拦下时同样不扣额度。这句话原来写的是
		// 「先占配额再调模型,一次注定 400 的请求照样吃掉一次 ai 额度」,是假的;
		// 下一个人照着它去动闸口顺序,才会真的把额度扣上(第二轮评审 ⑤)。
		const issue = sentenceIssue(s);
		if (issue) {
			setFail({ status: 400, error: issue });
			setFailFrom("draft");
			return;
		}
		setBusy("draft");
		setFail(null);
		setFailFrom(null);
		setNotice(null);
		setReceipt(null);
		const r = await api<DraftResponse>("dossier/draft", {
			method: "POST",
			headers: { "content-type": "application/json" },
			body: JSON.stringify({ sentence: s }),
		});
		setBusy(null);
		if (!r.ok) {
			setFail(r.fail);
			setFailFrom("draft");
			if (r.fail.status === 401) setPhase("locked");
			return;
		}
		setSaved(null);
		setSentence(r.data.sentence);
		// 契约说 sentence 原样回显 —— 当场核一遍,对上了才敢在页面上打「原样回显」
		setVerbatim(r.data.sentence === s);
		setFields({
			domain: r.data.domain,
			caresAbout: r.data.caresAbout,
			notCaresAbout: r.data.notCaresAbout,
			queries: r.data.queries,
		});
		setPhase("editing");
	}, [seedText]);

	// ---------- 保存 ----------

	const isNew = saved === null;
	const dirty = useMemo(() => (saved ? !fieldsEqual(pick(saved), fields) : true), [saved, fields]);
	const stops = useMemo(() => blockers(fields), [fields]);

	const save = useCallback(async () => {
		if (stops.length > 0) return;
		setBusy("save");
		setFail(null);
		setFailFrom(null);
		setNotice(null);
		const r = await api<PutDossierResponse>("dossier", {
			method: "PUT",
			headers: { "content-type": "application/json" },
			// 整份原样送回去是安全的:请求体里的 rev 会被服务端静默忽略
			// (types.ts PutDossierRequest 的注释)
			body: JSON.stringify({ sentence, ...fields }),
		});
		setBusy(null);
		if (!r.ok) {
			setFail(r.fail);
			setFailFrom("save");
			if (r.fail.status === 401) setPhase("locked");
			return;
		}
		const wasNew = isNew;
		setSaved(r.data.dossier);
		setSentence(r.data.dossier.sentence);
		setFields(pick(r.data.dossier));
		setVerbatim(false);
		setReceipt(
			wasNew
				? `档案已建立(v${r.data.dossier.rev})。下一次周扫(${WEEKLY_SCAN_SCHEDULE.human})会按它去 GitHub 上搜。`
				: r.data.revBumped
					? `档案已更新到 v${r.data.dossier.rev},下次周扫会用新版本。`
					: "已保存。这次的改动不会让周扫产出不同的东西(只调顺序也算),所以版本号没有变。",
		);
	}, [stops, sentence, fields, isNew]);

	// ---------- 删掉重建 ----------

	const remove = useCallback(async () => {
		setBusy("delete");
		setFail(null);
		setFailFrom(null);
		const r = await api<DeleteDossierResponse>("dossier", { method: "DELETE" });
		setBusy(null);
		if (!r.ok) {
			setFail(r.fail);
			setFailFrom("delete");
			if (r.fail.status === 401) setPhase("locked");
			return;
		}
		const { scans, reports } = r.data.deleted;
		setConfirmDelete(false);
		// 内存里那份周扫属于**刚被连根删掉的**档案(deleteDossierCascade 一起删了
		// 它名下全部 weekly_scan)。不清掉的话,切回清单屏会看到一份库里已经不存在
		// 的周扫,而且它顶上还挂着一句理直气壮的诚实声明。
		setScan(null);
		setExtras({});
		setScanReceipt(null);
		setConfirmRerun(false);
		// 跨周屏那几份同理:它们属于**刚被连根删掉的**档案,留着的话切过去会看到
		// 一份库里已经不存在的历史,而且顶上还挂着一句理直气壮的诚实声明
		dropChangesCache();
		goView("dossier");
		setSaved(null);
		setSentence("");
		setFields(EMPTY);
		setSeedText("");
		setNotice(null);
		setPhase("seed");
		setReceipt(`已删掉这份档案,连同 ${scans} 份历史周扫和 ${reports} 份报告。可以从一句新的话重新开始。`);
	}, [goView, dropChangesCache]);

	/** 节 01 的「换一句话」:草稿态只是回种子屏(什么都没存),已保存态要删档。 */
	const restate = useCallback(() => {
		if (isNew) {
			setSeedText(sentence);
			setPhase("seed");
			setReceipt(null);
			setFail(null);
			setFailFrom(null);
			return;
		}
		setConfirmDelete(true);
	}, [isNew, sentence]);

	// ---------- 报头 ----------

	// 只有「拉到了档案(或确认没有档案)」才敢说这个人登录着;拉取失败时身份是
	// 未知的,页眉就该保持占位而不是画一个圆标出来——那是在猜。
	const signedIn = phase === "loading" || phase === "error" ? null : phase !== "locked";
	const seedLen = seedText.trim().length;

	const statusLine =
		phase === "loading"
			? "读取档案…"
			: phase === "locked"
				? "未登录"
				: saved
					? `档案 v${saved.rev} · 更新于 ${fmtDate(saved.updatedAt)}`
					: phase === "editing"
						? "草稿 · 尚未保存"
						: "还没有档案";

	return (
		<>
			<SiteHeader signedIn={signedIn} loginUrl={fail?.loginUrl ?? null} />
			<main className="page">
				<header className="masthead">
					<div className="mast-top">
						<span className="mast-sig">
							<span className="dot dot-accent" />
							领域拆解 · WEEKLY TEARDOWN
						</span>
						{health?.provider === "mock" && (
							<span className="mock-chip" title="没配 AI key,拆出来的档案是确定性的假数据(带 [mock] 前缀)">
								mock 模式
							</span>
						)}
					</div>
					<h1>
						{view === "scan"
							? "本周清单"
							: view === "changes"
								? "跨周变化"
								: view === "report"
									? "深度报告"
									: "关注档案"}
					</h1>
					<div className="deck-line">
						{view === "report" ? (
							<>
								<span className="lead">逐字引文 · 永久回链</span>
								<span>→ 挂不上原文的判断,在落库之前就被丢掉了</span>
							</>
						) : view === "scan" ? (
							<>
								<span className="lead">候选 · 排除 · 台账</span>
								<span>→ 三块并列,不是主内容加附录</span>
							</>
						) : view === "changes" ? (
							<>
								<span className="lead">翻上一周</span>
								<span>→ 一个本地脚本给不了的东西:上一周它是什么样</span>
							</>
						) : (
							<>
								<span className="lead">一句话</span>
								<span>→ 四节看得见改得动的定义 → 每周一早的候选清单</span>
							</>
						)}
					</div>
					<div className="rule-double" style={{ height: 5 }} />
					{phase !== "loading" && phase !== "locked" && phase !== "error" && (
						<ViewTabs
							view={view}
							onView={goView}
							ready={saved !== null}
							report={
								run.kind === "running"
									? "深度报告 · 跑着"
									: report
										? `深度报告 · ${report.fullName.split("/")[1] ?? report.fullName}`
										: reportTarget || run.kind === "failed"
											? "深度报告"
											: null
							}
						/>
					)}
					<div className="status-row">
						<span className="mark">▸</span>
						<span>{statusLine}</span>
						{phase === "loading" && <span className="caret" />}
						{health && !health.hasDb && (
							<span className="right" style={{ color: "var(--accent)" }}>
								D1 未绑定 · 存不进去
							</span>
						)}
					</div>
				</header>

				{/* 回执与提示:成功的话留一句说清后果,不弹走 */}
				{receipt && <div className="receipt">{receipt}</div>}
				{notice && (
					<div className="banner" role="status">
						{notice}{" "}
						<button type="button" className="btn-quiet" onClick={() => setNotice(null)}>
							知道了
						</button>
					</div>
				)}
				{fail && phase !== "locked" && (
					<FailBox
						fail={fail}
						// 重试的是**造成这次失败的那个动作**。猜错了比不给重试更糟:
						// 在种子屏上把「拉取失败」重试成「拆解」,等于替用户花掉一次 AI 额度。
						onRetry={
							failFrom === "draft"
								? () => void draftIt()
								: failFrom === "save"
									? () => void save()
									: failFrom === "delete"
										? () => void remove()
										: failFrom === "scan"
											? () => void loadScan()
											: failFrom === "changes"
											? // 跨周屏两条读:把缓存作废,上面那两个 effect 会自己重新取一遍
												() => dropChangesCache()
											: failFrom === "run"
												? () => void runScan()
												: failFrom === "appeal"
													? () => {
															if (lastAppeal) void appeal(lastAppeal);
														}
													: failFrom === "email"
														? () => {
																// 重试的是**同一个方向**:开关现在显示的是哪一边,
																// 重试就还往哪一边推。猜反了的后果是「点了重试,
																// 结果被退订了」,而页面上写的是「保存成功」。
																if (emailPrefs) void setEmailOptOut(!emailPrefs.optedOut);
															}
														: failFrom === "report"
														? () => {
																// **重试的是「再取一次那一份」,不是「再跑一次」**:
																// 重跑是一次 $0.4-0.6、一天只有两次的动作,一个
																// 「再试一次」按钮不该悄悄替人花掉它。要重跑得
																// 回清单屏再点一次「拆开看看」。
																tried.current = "";
																if (reportTarget) void loadReport(reportTarget);
																else void load();
															}
														: () => void load()
						}
						// error 屏上没有别的东西可看,「知道了」会把页面变成一片空白
						onDismiss={phase === "error" ? undefined : () => setFail(null)}
					/>
				)}

				{/* ———————————— 拉取失败(不是 401) ———————————— */}
				{phase === "error" && (
					<p className="seed-hint">
						没能读到你的档案,所以这一页什么都没显示 —— 这不代表你没有档案。
						上面的「再试一次」会重新读一遍;一直失败的话,过几分钟再来。
					</p>
				)}

				{/* ———————————— 锁屏(401) ———————————— */}
				{phase === "locked" && fail && (
					<section className="console">
						<p style={{ margin: 0, fontSize: 14 }}>{fail.error}</p>
						<p className="seed-hint">这份档案是按账号存的,登录之后才看得到你自己那一份。</p>
						<div className="console-row">
							<a className="btn-ink" href={fail.loginUrl ?? "https://nanisle.com/api/launch/weekly-teardown"}>
								去南屿登录
							</a>
						</div>
					</section>
				)}

				{/* ———————————— 骨架(第一次拉取) ———————————— */}
				{phase === "loading" && (
					<div className="skeleton" aria-hidden>
						<div className="skeleton-bar" style={{ width: "30%" }} />
						<div className="skeleton-bar" style={{ width: "80%" }} />
						<div className="skeleton-bar" style={{ width: "62%" }} />
					</div>
				)}

				{/* ———————————— 种子屏(新用户 / 删档之后) ———————————— */}
				{phase === "seed" && (
					<section className="console">
						<label htmlFor="seed" style={{ display: "block", fontSize: 14, fontWeight: 600, marginBottom: 8 }}>
							用一句话说清你想跟踪什么
						</label>
						<textarea
							id="seed"
							value={seedText}
							maxLength={DOSSIER_LIMITS.sentenceMax}
							placeholder="我想跟踪 AI agent 的记忆与上下文工程"
							disabled={busy !== null}
							onChange={(e) => setSeedText(e.target.value)}
							onKeyDown={(e) => {
								// Ctrl/⌘+Enter 提交:多行框里的裸回车要留给换行
								if ((e.metaKey || e.ctrlKey) && e.key === "Enter") void draftIt();
							}}
						/>
						<div className="console-row">
							<button
								type="button"
								className="btn-stamp"
								disabled={busy !== null || seedLen === 0}
								onClick={() => void draftIt()}
							>
								<span className="mark">▸</span>
								{busy === "draft" ? "拆解中…" : "拆解"}
							</button>
							{busy === "draft" && (
								<span className="char-count">
									正在把这句话拆成四节(几秒) <span className="caret" />
								</span>
							)}
							{busy !== "draft" && (
								<span className={`char-count${seedLen > DOSSIER_LIMITS.sentenceMax ? " warn" : ""}`}>
									{seedLen}/{DOSSIER_LIMITS.sentenceMax} 字 · ⌘/Ctrl+Enter 也能提交
								</span>
							)}
						</div>
						<p className="seed-hint">
							拆出来的是一份<strong>四节的关注档案</strong>:我理解的领域、你在意 / 不在意什么、
							以及<code>我拿哪几个词去 GitHub 搜</code>。四节都摆在页面上给你改 ——
							这句原话除外,它永远只读。
						</p>
					</section>
				)}

				{/* ———————————— 本周清单(阶段 5 的第一屏) ———————————— */}
				{phase === "editing" && view === "scan" && (
					<>
						{scanReceipt && <div className="receipt">{scanReceipt}</div>}
						{saved === null ? (
							<p className="seed-hint">
								这份档案还没保存,所以还没有周扫。<strong>先回档案页保存</strong> —— 周扫用的是保存过的那一版检索词。
							</p>
						) : scanBusy === "load" && scan === null ? (
							<div className="skeleton" aria-hidden>
								<div className="skeleton-bar" style={{ width: "70%" }} />
								<div className="skeleton-bar" style={{ width: "45%" }} />
								<div className="skeleton-bar" style={{ width: "88%" }} />
							</div>
						) : scan?.scan && scan.honesty ? (
							<>
								<ScanView
									scan={scan.scan}
									candidates={scan.candidates}
									exclusions={scan.exclusions}
									honesty={scan.honesty}
									extras={extras}
									appeal={{
										// 正在跑周扫时不给申诉:那一趟会把这一周的候选/排除整批换掉
										// (putWeeklyScan 先 DELETE 子行),此刻申诉写进去的行会被它冲掉
										onAppeal: scanBusy === null ? (name) => void appeal(name) : null,
										pending: appealing,
									}}
									teardown={{
										// 正在跑周扫时同样不给拆:后端只拆**这一周清单上**的仓,而那一趟
										// 正在把清单整批换掉,此刻点下去可能撞上一个「不在候选清单上」的 400。
										// **已经有一趟在跑时不是把按钮撤掉,而是靠 pending 把它们全禁用**:
										// 撤掉的话,跑到一半切回这一屏会看到一整屏没有入口的候选行,而没有
										// 任何东西说得清为什么。
										onTeardown: scanBusy === null ? (name) => void teardown(name) : null,
										pending: run.kind === "running" ? run.fullName : null,
									}}
								/>
								{/* 重跑二次确认(上线前终审 A2)。在这之前那颗按钮点下去就走,而重跑会
								    把这一周的候选和排除整批删掉重灌 —— 用户自己申诉捞回来的那几行也在里面,
								    每一个都花掉过一次 ai 额度和一次 GitHub 调用。台账是重新算的,所以四个数
								    照样自洽,**没有一处会报错,页面看起来完全正常**。
								    按钮和闸门一起放在 RerunBar 里(不是留在这儿),这样渲染层测试才断言得了
								    「点那颗按钮只会打开确认框,不会真的重跑」。
								    N 从当前这一包里数(appealedFrom 非空的候选行),不需要新端点。 */}
								<RerunBar
									scan={scan.scan}
									appealCount={scan.candidates.filter((c) => c.appealedFrom).length}
									busy={scanBusy !== null}
									running={scanBusy === "run"}
									confirming={confirmRerun}
									onAsk={() => setConfirmRerun(true)}
									onConfirm={() => void runScan()}
									onCancel={() => setConfirmRerun(false)}
								/>
							</>
						) : (
							<section className="console">
								<p style={{ margin: 0, fontSize: 14 }}>还没有跑过周扫。</p>
								<p className="seed-hint">
									自动周扫是{WEEKLY_SCAN_SCHEDULE.human};不想等的话现在就能手动跑一次。
									一趟大概几十秒 —— 时间几乎全花在等 GitHub 上,不是在等模型。
								</p>
								<div className="console-row">
									<button type="button" className="btn-stamp" disabled={scanBusy !== null} onClick={() => void runScan()}>
										<span className="mark">▸</span>
										{scanBusy === "run" ? "扫描中…" : "现在跑一次"}
									</button>
									{scanBusy === "run" && (
										<span className="char-count">
											双路检索,每条检索词发两次 <span className="caret" />
										</span>
									)}
								</div>
							</section>
						)}
					</>
				)}

				{/* ———————————— 跨周变化(上线前终审的第四屏) ————————————
				    docs/01「为什么不做成 skill」:skill 给不了的只有跨周状态,而站长选的
				    四条差异化里有两条建在它上面。这一屏就是那个「唯一存在理由」的兑现,
				    也是风险 4 那条判据(「站长会不会去翻上一周」)唯一可执行的形式。 */}
				{phase === "editing" && view === "changes" && (
					<>
						{saved === null ? (
							<p className="seed-hint">
								这份档案还没保存,所以一周的记录都还没有。<strong>先回档案页保存</strong> ——
								跨周变化要有两周才比得出来。
							</p>
						) : weekList === null ? (
							<div className="skeleton" aria-hidden>
								<div className="skeleton-bar" style={{ width: "36%" }} />
								<div className="skeleton-bar" style={{ width: "72%" }} />
								<div className="skeleton-bar" style={{ width: "54%" }} />
							</div>
						) : (
							<ChangesView
								change={change}
								picked={pickedWeek}
								scans={weekList}
								onPick={pickWeek}
								weekScan={weekScan}
								busy={changesBusy !== null}
							/>
						)}
					</>
				)}

				{/* ———————————— 深度报告(阶段 7 的第三屏) ———————————— */}
				{phase === "editing" && view === "report" && (
					<>
						{reportReceipt && <div className="receipt">{reportReceipt}</div>}
						<ReportProgress run={run} />
						{run.kind === "failed" && (
							<div className="error-box" role="alert">
								{/* 后端的文案原样显示。**流内那两条里写着「已经计入今天的额度」**,
								    而被拦下的那些(429 / 502)写着「没有计入」—— 这个区别对用户很重要,
								    前端再包一层就把它抹平了。 */}
								<p style={{ margin: 0 }}>{run.error}</p>
								<div className="danger-row" style={{ marginTop: 10 }}>
									{run.refresh && (
										<button type="button" className="btn-line" onClick={() => window.location.reload()}>
											刷新页面
										</button>
									)}
									<button type="button" className="btn-line" onClick={() => goView("scan")}>
										回本周清单
									</button>
									{run.quota && <span className="char-count">额度是按天算的,UTC 零点自动恢复。</span>}
								</div>
							</div>
						)}
						{reportLoading && (
							<div className="skeleton" aria-hidden>
								<div className="skeleton-bar" style={{ width: "40%" }} />
								<div className="skeleton-bar" style={{ width: "85%" }} />
								<div className="skeleton-bar" style={{ width: "66%" }} />
							</div>
						)}
						{report ? (
							<ReportView report={report} />
						) : (
							run.kind !== "running" &&
							!reportLoading && (
								<section className="console">
									{/* **「还没拆过」是 200 + null,不是错误**(后端 GET /api/report 的注释)。
									    所以这一屏不是错误屏,是一个正常的空态,它得自己说清楚下一步在哪。 */}
									<p style={{ margin: 0, fontSize: 14 }}>
										{reportTarget?.repo
											? `${reportTarget.repo} 还没拆过。`
											: reportTarget?.id
												? "这份报告不在你名下,或者已经跟着档案一起被删掉了。"
												: "地址里没说要看哪一份报告。"}
									</p>
									<p className="seed-hint">
										深度报告只能从<strong>本周清单</strong>上点「拆开看看」开始 ——
										后端只拆你自己那一周清单上的仓(被排除的先点「这个该进来」捞回来)。一趟 1-2 分钟,按上限估 $
										{REPORT_EST_USD},每个账号每天 2 份。
									</p>
									<div className="console-row">
										<button type="button" className="btn-stamp" onClick={() => goView("scan")}>
											<span className="mark">▸</span>
											去本周清单
										</button>
									</div>
								</section>
							)
						)}
					</>
				)}

				{/* ———————————— 档案(草稿态与已保存态同一套界面) ———————————— */}
				{phase === "editing" && view === "dossier" && (
					<>
						{isNew && (
							<div className="banner">
								<strong>这份档案还没保存。</strong>
								四节都是我刚从那句话推出来的,先看一遍、改几处 —— 点最下面的「保存档案」才算数。
							</div>
						)}

						<DossierView
							sentence={sentence}
							fields={fields}
							// 一动手就把上一次的回执收起来:「已更新到 v2」和一堆未保存的改动
							// 同屏出现,会让人以为改动已经生效了
							onFields={(next) => {
								setFields(next);
								setReceipt(null);
							}}
							draft={isNew}
							verbatim={verbatim}
							rev={saved?.rev ?? null}
							onRestate={restate}
							onNotice={setNotice}
						/>

						{/* 门铃邮件的订阅开关(阶段 9)。**紧挨着删档**,因为这两个动作
						    最容易被搞混:一个是「别给我发信」,一个是「把这份档案连同
						    全部历史删掉」。而 email_optout 在删档时故意不删(store.ts
						    deleteDossierCascade),两者并排摆着,那条取舍才解释得清。
						    新用户(还没保存档案)也看得到:他保存完当天晚上就可能收到信,
						    「怎么关掉」不该等到收到第一封之后才找得着。 */}
						<EmailSwitch prefs={emailPrefs} busy={emailBusy} onChange={(next) => void setEmailOptOut(next)} />

						{/* 删档二次确认:必须说清会删掉什么,不能只是一个红按钮 */}
						{confirmDelete && (
							<section className="danger">
								<h3>删掉这份档案,从一句新的话重建?</h3>
								<p>这是为了换掉那句原话 —— 原话是你判断我理解得对不对的基准,改了基准这份档案就没法被质疑了,所以只能重建。</p>
								<p>会一起删掉:</p>
								<ul>
									<li>这份档案本身(现在是 v{saved?.rev ?? 1})</li>
									<li>
										它名下<strong>全部</strong>历史周扫快照 —— 删了之后就没有「上周」,跨周增量要从下下周才重新有得比
									</li>
									<li>
										基于它跑过的<strong>全部</strong>深度报告
									</li>
								</ul>
								<p>不能撤销。</p>
								<div className="danger-row">
									<button type="button" className="btn-danger" disabled={busy !== null} onClick={() => void remove()}>
										{busy === "delete" ? "删除中…" : "确认删除"}
									</button>
									<button type="button" className="btn-line" disabled={busy !== null} onClick={() => setConfirmDelete(false)}>
										再想想
									</button>
								</div>
							</section>
						)}

						<div className="savebar">
							<span className={`savebar-msg${stops.length > 0 || isNew ? " warn" : ""}`}>
								{stops.length > 0
									? stops[0]
									: isNew
										? "还没保存 —— 保存之后才会进入每周一的扫描。"
										: dirty
											? "有未保存的改动。"
											: `没有未保存的改动。下一次周扫(${WEEKLY_SCAN_SCHEDULE.human})会用 v${saved?.rev ?? 1}。`}
							</span>
							<div className="right">
								{!isNew && dirty && (
									<button
										type="button"
										className="btn-quiet"
										disabled={busy !== null}
										onClick={() => {
											if (saved) setFields(pick(saved));
											setNotice(null);
										}}
									>
										放弃改动
									</button>
								)}
								{!isNew && !confirmDelete && (
									<button type="button" className="btn-quiet" disabled={busy !== null} onClick={() => setConfirmDelete(true)}>
										删掉重建
									</button>
								)}
								<button
									type="button"
									className="btn-ink"
									disabled={busy !== null || stops.length > 0 || (!isNew && !dirty)}
									onClick={() => void save()}
								>
									{busy === "save" ? "保存中…" : isNew ? "保存档案" : "保存改动"}
								</button>
							</div>
						</div>
					</>
				)}

				<footer className="foot">
					An island of{" "}
					<a href="https://nanisle.com">nanisle.com</a> · open source ·{" "}
					<a href="https://github.com/AI-Nanisle/nanisle-product">fork me</a>
					{health && <span> · AI: {health.provider} · GitHub: {health.hasPat ? "PAT 5000/h" : "匿名 60/h"}</span>}
				</footer>
			</main>
		</>
	);
}
