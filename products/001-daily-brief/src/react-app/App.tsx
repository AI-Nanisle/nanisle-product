import { useCallback, useEffect, useMemo, useState } from "react";
import type { Brief, BriefItem, DroppedItem, FeedbackKind } from "../shared/types";
import { ISSUE_ITEM_ID } from "../shared/types";
import Config from "./Config";
import Notes from "./Notes";
import { SiteHeader } from "./SiteChrome";
import { USAGE_CHANGED, apiPath, pathForView, productPath, type ProductView, viewFromPathname } from "./paths";

/**
 * 今日额度读数(GET /api/usage,docs/02 §8.3)。gen = 立即生成,ai = 编辑调用。
 * 上限由服务端下发而不是前端硬编码:改额度只该动一处(shared/store.ts)。
 */
interface Usage {
	date: string;
	gen: { used: number; limit: number };
	ai: { used: number; limit: number };
}

/**
 * GET /api/generate/status 的回包。生成是后台任务(POST 立即 202),这个端点
 * 是唯一的进度真相——浏览器内存里的转圈撑不过一次刷新,轮询它才撑得过。
 */
interface GenStatus {
	state: "idle" | "running" | "done" | "failed";
	startedAt?: string;
	error?: string;
	/** 走到第几步(服务端 GEN_STEPS 五段),生成方在每个分段点写回。 */
	progress?: { step: number; total: number; label: string };
	result?: {
		date: string;
		picked: number;
		scanned: number;
		sourceErrors?: { name: string; error: string }[];
	};
}

function fmtElapsed(s: number): string {
	if (s < 60) return `${s} 秒`;
	return `${Math.floor(s / 60)} 分 ${String(s % 60).padStart(2, "0")} 秒`;
}

/**
 * 额度在美东次日 0 点重置,换算成读者本地钟点(北京时间 12:00 或 13:00,随
 * 美东夏令时浮动)。夏令时切换当天可能差一小时——这只是一句提示,可以容忍。
 */
function quotaResetLocalTime(): string {
	const now = new Date();
	const gmt =
		new Intl.DateTimeFormat("en-US", { timeZone: "America/New_York", timeZoneName: "shortOffset" })
			.formatToParts(now)
			.find((p) => p.type === "timeZoneName")?.value ?? "GMT-5";
	const offH = Number(/GMT([+-]\d+)/.exec(gmt)?.[1] ?? "-5");
	const etDate = new Intl.DateTimeFormat("en-CA", { timeZone: "America/New_York" }).format(now);
	const resetMs = Date.parse(`${etDate}T00:00:00Z`) - offH * 3600_000 + 24 * 3600_000;
	return new Date(resetMs).toLocaleTimeString("zh-CN", { hour12: false, hour: "2-digit", minute: "2-digit" });
}

// 请求不带 x-access-code:userGuard 只认会话 cookie(F6)。访问码已降级为
// 站长凭证,不再是阅读凭证——前端没有它的位置。
async function postFeedback(date: string, itemId: string, kind: FeedbackKind, text?: string) {
	await fetch(apiPath("feedback"), {
		method: "POST",
		headers: { "content-type": "application/json" },
		body: JSON.stringify({ date, itemId, kind, ...(text ? { text } : {}) }),
	});
}

function weekdayOf(date: string): string {
	const d = new Date(`${date}T12:00:00`);
	return ["星期日", "星期一", "星期二", "星期三", "星期四", "星期五", "星期六"][d.getDay()] ?? "";
}

function isStale(brief: Brief): boolean {
	return Date.now() - new Date(brief.generatedAt).getTime() > 26 * 3600_000;
}

// ---------- per-item feedback ----------

// R4 · 从四个按钮收敛到两个 + 一个文本入口。四个并排时读者分不清该点哪个,
// 结果是一个都不点;两个廉价信号(口味)+ 一个能说人话的口子,总信号量更高。
// 代价要认:「已知道」承载的「话题对、我看过了」和「没用」是**相反**的调整
// 方向,收敛之后这个区分只能从自由文本里读——所以文本必须真被消费(R2)。
// known/more 的类型没删:老事件仍要被反馈摘要读回去。
const VOTE_KINDS: { kind: "up" | "down"; label: string; done: string }[] = [
	{ kind: "up", label: "👍 有用", done: "✓ 有用" },
	{ kind: "down", label: "没用", done: "✓ 没用" },
];

function ItemFeedback({ date, itemId }: { date: string; itemId: string }) {
	const voteKey = `daily-brief-vote:${date}:${itemId}`;
	const [vote, setVote] = useState<string>(() => localStorage.getItem(voteKey) ?? "");
	const [open, setOpen] = useState(false);
	const [text, setText] = useState("");
	const [sent, setSent] = useState(false);

	const cast = (kind: "up" | "down") => {
		if (vote) return;
		setVote(kind);
		localStorage.setItem(voteKey, kind);
		void postFeedback(date, itemId, kind);
	};
	const send = () => {
		if (!text.trim()) return;
		void postFeedback(date, itemId, "text", text.trim());
		setSent(true);
		setText("");
		setTimeout(() => {
			setSent(false);
			setOpen(false);
		}, 1500);
	};

	return (
		<div className="mt-3">
			<div className="flex flex-wrap items-center gap-x-4 gap-y-1 font-mono-sc text-[12px] text-[var(--ink-3)]">
				{VOTE_KINDS.map((v) => (
					<button
						key={v.kind}
						type="button"
						onClick={() => cast(v.kind)}
						disabled={Boolean(vote)}
						className={`transition-colors ${vote === v.kind ? "text-[var(--accent)]" : vote ? "opacity-40" : "hover:text-[var(--ink)] cursor-pointer"}`}
					>
						{vote === v.kind ? v.done : v.label}
					</button>
				))}
				<button
					type="button"
					onClick={() => setOpen((v) => !v)}
					className="hover:text-[var(--ink)] cursor-pointer"
				>
					留下我的看法
				</button>
			</div>
			{open && (
				<div className="mt-2 flex gap-2">
					{/* 引导语把收敛掉的三个按钮的语义捡回来:不同意 / 想更深 /
					    已经因为它做了事——这些是固定按钮永远表达不了的。 */}
					<input
						value={text}
						onChange={(e) => setText(e.target.value)}
						onKeyDown={(e) => e.key === "Enter" && send()}
						placeholder="这条你怎么看?(不同意、想更深、或者你已经因为它做了什么)"
						className="flex-1 rounded-md border border-[var(--line)] bg-[var(--card)] px-3 py-1.5 text-sm outline-none focus:border-[var(--line-strong)]"
					/>
					<button
						type="button"
						onClick={send}
						className="font-mono-sc text-[12px] px-3 rounded-md border border-[var(--line-strong)] hover:bg-[var(--ink)] hover:text-[var(--paper)] transition-colors cursor-pointer"
					>
						{sent ? "已记入想法页" : "发送"}
					</button>
				</div>
			)}
		</div>
	);
}

// ---------- brief item ----------

function Item({ item, date, index }: { item: BriefItem; date: string; index: number }) {
	return (
		<article className="brief-item rise" style={{ animationDelay: `${index * 70}ms` }}>
			{/* 抬头一行只放「这条从哪来、在哪条线索上」——都是读数,归等宽字体那一层。
			    relatesTo 原来是朱红的,和「读原文」「编辑判断」抢注意力:一条内容里
			    出现四处红,红就不再是强调了。这里降成灰,红只留给标题 hover 和读原文。 */}
			<div className="font-mono-sc mb-2 flex flex-wrap items-center gap-x-3 gap-y-1 text-[11px] text-[var(--ink-3)]">
				<span>{item.source}</span>
				{item.threadNote && <span className="thread-note">{item.threadNote}</span>}
				{item.relatesTo && <span className="min-w-0 truncate">◆ {item.relatesTo}</span>}
			</div>

			<h3 className="text-[21px] font-bold leading-[1.45] tracking-[0.01em]">
				<a href={productPath(`go/${date}/${item.id}`)} target="_blank" rel="noreferrer" className="headline-link">
					{item.title}
				</a>
			</h3>

			{/* 导语 → 实质 → 判断 → 存疑,四段各有各的角色,别再靠字号微调区分 */}
			<p className="brief-deck mt-2">{item.whyClick}</p>
			{item.substance && <p className="brief-body mt-3">{item.substance}</p>}
			{item.take && (
				<p className="brief-aside mt-3">
					<span className="label">编辑判断</span>
					{item.take}
				</p>
			)}
			{item.caveat && (
				<p className="brief-caveat mt-3">
					<span className="font-mono-sc mr-2 text-[10px] uppercase tracking-[0.08em]">原文存疑</span>
					{item.caveat}
				</p>
			)}

			<div className="font-mono-sc mt-3.5 flex flex-wrap items-center gap-x-5 gap-y-1 text-[12px]">
				<a
					href={productPath(`go/${date}/${item.id}`)}
					target="_blank"
					rel="noreferrer"
					className="text-[var(--accent)] hover:underline"
				>
					读原文 →
				</a>
				{item.discussionUrl && (
					<a href={item.discussionUrl} target="_blank" rel="noreferrer" className="text-[var(--ink-3)] hover:text-[var(--ink)]">
						讨论区
					</a>
				)}
				{item.extras?.map((x) => (
					<a key={x.url} href={x.url} target="_blank" rel="noreferrer" className="min-w-0 truncate text-[var(--ink-3)] hover:text-[var(--ink)]">
						{x.label}
					</a>
				))}
			</div>
			{item.mergedFrom && item.mergedFrom.length > 0 && (
				<div className="mt-2 text-[12px] text-[var(--ink-3)]">
					同一事件:
					{item.mergedFrom.map((m) => (
						<a key={m.url} href={m.url} target="_blank" rel="noreferrer" className="ml-2 underline decoration-[var(--line)] hover:text-[var(--accent)]">
							{m.label}
						</a>
					))}
				</div>
			)}
			<ItemFeedback date={date} itemId={item.id} />
		</article>
	);
}

// ---------- dropped item row ----------

function DroppedRow({ item, date }: { item: DroppedItem; date: string }) {
	const [wanted, setWanted] = useState(false);
	return (
		<li className="flex items-baseline gap-3 py-1.5 border-b border-[var(--line)] last:border-0">
			<a
				href={productPath(`go/${date}/${item.id}`)}
				target="_blank"
				rel="noreferrer"
				className="text-[13px] text-[var(--ink-2)] hover:text-[var(--accent)] truncate"
			>
				{item.title}
			</a>
			<span className="font-mono-sc text-[11px] text-[var(--ink-3)] shrink-0">{item.reason}</span>
			<button
				type="button"
				disabled={wanted}
				onClick={() => {
					setWanted(true);
					void postFeedback(date, item.id, "want");
				}}
				className={`ml-auto shrink-0 font-mono-sc text-[11px] cursor-pointer ${wanted ? "text-[var(--accent)]" : "text-[var(--ink-3)] hover:text-[var(--accent)]"}`}
			>
				{wanted ? "✓ 已记下" : "这条我要"}
			</button>
		</li>
	);
}

// ---------- X2 · 轴外位 ----------

/**
 * 不属于任何追踪器的一条。三条护栏里的第一条是**明确标注**:它必须一眼看出
 * 不是你定义的东西,绝不混进正常分区里假装是你要的。第二条是可关(下面那个
 * 按钮),第三条(连续 10 期没人点自动停)在生成侧。
 */
function OffAxis({ item, date }: { item: BriefItem; date: string }) {
	const [off, setOff] = useState(false);
	const close = () => {
		setOff(true);
		void fetch(apiPath("prefs"), {
			method: "PUT",
			headers: { "content-type": "application/json" },
			body: JSON.stringify({ offAxis: false }),
		});
	};
	if (off) return <p className="mt-6 text-[13px] text-[var(--ink-3)]">已关掉轴外推荐——配置页可以再打开。</p>;

	return (
		<section className="mt-6 rounded-[10px] border border-dashed border-[var(--line-strong)] px-5 py-4">
			<div className="flex items-baseline gap-3">
				<span className="font-mono-sc text-[11px] text-[var(--ink-3)]">✳</span>
				<h2 className="font-bold text-sm tracking-widest text-[var(--ink-2)]">不在你的追踪范围内</h2>
				<button
					type="button"
					onClick={close}
					className="font-mono-sc ml-auto cursor-pointer text-[11px] text-[var(--ink-3)] hover:text-[var(--accent)]"
				>
					不要这类
				</button>
			</div>
			<div className="mt-3 pl-7">
				<div className="font-mono-sc text-[11px] text-[var(--ink-3)]">{item.source}</div>
				<h3 className="mt-1.5 text-[19px] font-bold leading-[1.45]">
					<a href={productPath(`go/${date}/${item.id}`)} target="_blank" rel="noreferrer" className="headline-link">
						{item.title}
					</a>
				</h3>
				{/* 「为什么给你看」是轴外位存在的全部理由,它该是这一块里最先被读到的
				    一句,所以留着朱红——这是全页唯一一处用红讲理由的地方。 */}
				{item.relatesTo && (
					<p className="mt-2 text-[13.5px] leading-[1.85] text-[var(--accent)]">{item.relatesTo}</p>
				)}
				<p className="brief-deck mt-2">{item.whyClick}</p>
				{item.substance && <p className="brief-body mt-3">{item.substance}</p>}
				{item.take && (
					<p className="brief-aside mt-3">
						<span className="label">编辑判断</span>
						{item.take}
					</p>
				)}
				<ItemFeedback date={date} itemId={item.id} />
			</div>
		</section>
	);
}

// ---------- R5 · 期末一问 ----------

/**
 * 所有按钮都只能评价**已经给出的内容**;这一问问的是地图上的空洞——
 * 「本该知道却没出现」。它是唯一能暴露「还缺哪类信源」的入口,所以放在
 * 「已替你筛掉」下面、终点戳上面:读完了才知道少了什么。
 */
function IssueGap({ date }: { date: string }) {
	const doneKey = `daily-brief-gap:${date}`;
	const [text, setText] = useState("");
	const [sent, setSent] = useState(() => Boolean(localStorage.getItem(doneKey)));

	const send = () => {
		if (!text.trim()) return;
		void postFeedback(date, ISSUE_ITEM_ID, "text", text.trim());
		localStorage.setItem(doneKey, "1");
		setSent(true);
		setText("");
	};

	return (
		<section className="mt-4 rounded-[10px] border border-dashed border-[var(--line-strong)] px-4 py-3">
			<p className="font-mono-sc text-[12px] text-[var(--ink-3)]">今天有什么本该知道,但没出现在这里?</p>
			{sent ? (
				<p className="mt-2 text-[13px] text-[var(--accent)]">已记下——下一期的找源会先补这一块。</p>
			) : (
				<div className="mt-2 flex gap-2">
					<input
						value={text}
						onChange={(e) => setText(e.target.value)}
						onKeyDown={(e) => e.key === "Enter" && send()}
						placeholder="说个话题、一件事、或者某个你以为会看到的来源"
						className="flex-1 rounded-md border border-[var(--line)] bg-[var(--card)] px-3 py-1.5 text-sm outline-none focus:border-[var(--line-strong)]"
					/>
					<button
						type="button"
						onClick={send}
						className="font-mono-sc text-[12px] px-3 rounded-md border border-[var(--line-strong)] hover:bg-[var(--ink)] hover:text-[var(--paper)] transition-colors cursor-pointer"
					>
						发送
					</button>
				</div>
			)}
		</section>
	);
}

// ---------- app ----------

// locked = 401 没登录(引导去南屿登录)。旧的 denied(403 内测名单拦截)已随
// 白名单退役删除(docs/05):登录即可用。
type LoadState = "loading" | "ready" | "locked" | "error";
type View = ProductView;

/**
 * 产品页 = 主站页眉 + 产品自己的报纸。页眉是外壳,产品的每个状态
 * (读、配置、锁屏、报错)都在它下面——账号、导航、退出登录不会因为
 * 走进产品就消失。
 */
export default function App() {
	return (
		<>
			<SiteHeader />
			<ProductPage />
		</>
	);
}

function ProductPage() {
	const [brief, setBrief] = useState<Brief | null>(null);
	const [dates, setDates] = useState<string[]>([]);
	const [state, setState] = useState<LoadState>("loading");
	// 401 响应里带的主站登录地址,锁屏主按钮指向它
	const [lockLoginUrl, setLockLoginUrl] = useState("");
	const [view, setViewState] = useState<View>(() => viewFromPathname(window.location.pathname));
	const setView = (v: View) => {
		setViewState(v);
		window.history.pushState(null, "", pathForView(v));
	};
	const [generating, setGenerating] = useState(false);
	// 正在盯的那趟后台生成的起点。非 null 才开轮询:轮询必须等 POST 落地后再
	// 开,否则会把上一趟留下的旧收尾记录当成这一趟的结果。
	const [genStartedAt, setGenStartedAt] = useState<string | null>(null);
	const [genProgress, setGenProgress] = useState<GenStatus["progress"] | null>(null);
	const [genElapsedS, setGenElapsedS] = useState(0);
	const [genMsg, setGenMsg] = useState("");
	// 失败单独占一块横幅(yiren 反馈 #4),不跟状态行的常态读数挤一行小字;
	// 429 限额例外,仍走 genMsg——那是预期内的刹车,不该长着故障的脸。
	const [genError, setGenError] = useState<string | null>(null);
	const [usage, setUsage] = useState<Usage | null>(null);

	const load = useCallback(async (date?: string) => {
		setState("loading");
		try {
			const res = await fetch(`${apiPath("brief")}${date ? `?date=${date}` : ""}`);
			if (res.status === 401) {
				const body = (await res.json().catch(() => ({}))) as { loginUrl?: string };
				setLockLoginUrl(body.loginUrl ?? "");
				setState("locked");
				return;
			}
			if (res.status === 404 && !date) {
				// 还没有第一期——不是错误,渲染空态引导去生成
				setBrief(null);
				setState("ready");
				return;
			}
			if (!res.ok) throw new Error(String(res.status));
			setBrief((await res.json()) as Brief);
			setState("ready");
			const dres = await fetch(apiPath("dates"));
			if (dres.ok) setDates(((await dres.json()) as { dates: string[] }).dates);
		} catch {
			setState("error");
		}
	}, []);

	// 额度读数。取不到就让它保持 null——页眉少一行灰字,总好过为一个装饰性
	// 数字弹一个错误态出来。锁屏/未准入时这个请求本来就会 401/403。
	const loadUsage = useCallback(async () => {
		try {
			const res = await fetch(apiPath("usage"));
			if (res.ok) setUsage((await res.json()) as Usage);
		} catch {
			/* 读数不是关键路径,静默 */
		}
	}, []);

	useEffect(() => {
		void load();
	}, [load]);

	useEffect(() => {
		void loadUsage();
		// 配置页的编辑调用花的是同一份额度,它花完会广播(editor.ts)
		const onChanged = () => void loadUsage();
		window.addEventListener(USAGE_CHANGED, onChanged);
		return () => window.removeEventListener(USAGE_CHANGED, onChanged);
	}, [loadUsage]);

	useEffect(() => {
		const syncView = () => setViewState(viewFromPathname(window.location.pathname));
		window.addEventListener("popstate", syncView);
		return () => window.removeEventListener("popstate", syncView);
	}, []);

	// 点火。POST 立即返回 202(一趟要几分钟,活儿在 AWS 侧后台跑),这里只负责
	// 把 genStartedAt 立起来,下面的轮询 effect 接手盯到收尾。
	const generate = async () => {
		setGenerating(true);
		setGenMsg("");
		setGenError(null);
		setGenProgress(null);
		try {
			const res = await fetch(apiPath("generate"), { method: "POST" });
			const data = (await res.json().catch(() => ({}))) as {
				ok?: boolean;
				startedAt?: string;
				running?: boolean;
				error?: string;
			};
			if (res.status === 409 && data.running) {
				// 已有一趟在跑(另一个标签页点的,或刷新前点的):直接接上它的进度
				setGenStartedAt(data.startedAt ?? new Date().toISOString());
				return;
			}
			if (!res.ok || !data.ok) {
				// 429 = 今日限额打满:服务端文案已含「明早定时生成照常」,原样展示,
				// 不加「失败」前缀——这不是故障,是预期内的刹车(F7)
				if (res.status === 429 && data.error) {
					setGenMsg(data.error);
				} else {
					setGenError(data.error ?? `服务端返回 HTTP ${res.status},请稍后重试。`);
				}
				setGenerating(false);
				return;
			}
			setGenStartedAt(data.startedAt ?? new Date().toISOString());
		} catch {
			setGenError("网络错误,请求没有发出去——检查网络后再点一次。");
			setGenerating(false);
		} finally {
			// 点火即扣一次,429 也要刷(读数正好该跳到「已用完」)
			void loadUsage();
		}
	};

	// 盯进度:每 5 秒问一次 /api/generate/status,直到收尾。收尾读数由服务端
	// 落库的记录给出;waitUntil 被提前回收、记录没写上时,服务端会用简报落库
	// 时间兜底判成,这里拿不到读数就把话交给下面那行「✓ 已生成」的常态读数。
	useEffect(() => {
		if (!genStartedAt) return;
		let alive = true;
		const tick = async () => {
			let st: GenStatus;
			try {
				const res = await fetch(apiPath("generate/status"));
				if (!res.ok) return; // 瞬时故障:下个周期再问
				st = (await res.json()) as GenStatus;
			} catch {
				return; // 网络抖动:下个周期再问
			}
			if (!alive) return;
			if (st.state === "running") {
				setGenProgress(st.progress ?? null);
				return;
			}
			// 收尾了(idle = 记录过期,比如页面放了一夜,安静收场)
			setGenStartedAt(null);
			setGenProgress(null);
			setGenerating(false);
			if (st.state === "done") {
				const r = st.result;
				setGenMsg(
					r
						? `✓ ${r.date} 已生成:扫描 ${r.scanned} 条,入选 ${r.picked} 条 ${r.sourceErrors?.length ? `(${r.sourceErrors.length} 个源抓取失败)` : ""}`
						: "",
				);
				setView("brief");
				await load();
			} else if (st.state === "failed") {
				setGenError(st.error ?? "未知原因,请稍后重试。");
			}
			void loadUsage();
		};
		void tick();
		const timer = setInterval(() => void tick(), 5000);
		return () => {
			alive = false;
			clearInterval(timer);
		};
	}, [genStartedAt, load, loadUsage]);

	// 刷新不丢进度:挂载时问一次,有没跑完的就接着盯。锁屏/未准入时这个请求
	// 本来就 401/403,静默略过。
	useEffect(() => {
		void (async () => {
			try {
				const res = await fetch(apiPath("generate/status"));
				if (!res.ok) return;
				const st = (await res.json()) as GenStatus;
				if (st.state === "running") {
					setGenerating(true);
					setGenStartedAt(st.startedAt ?? new Date().toISOString());
					setGenProgress(st.progress ?? null);
				}
			} catch {
				/* 静默 */
			}
		})();
	}, []);

	// 进度行右侧的已跑时长,秒级走字——几分钟的等待,一个不动的转圈会被当成死机
	useEffect(() => {
		if (!genStartedAt) return;
		const started = new Date(genStartedAt).getTime();
		const update = () => setGenElapsedS(Math.max(0, Math.floor((Date.now() - started) / 1000)));
		update();
		const timer = setInterval(update, 1000);
		return () => clearInterval(timer);
	}, [genStartedAt]);

	// 额度用完就把按钮停掉:与其让人点下去再吃一个 429,不如按钮自己说清楚。
	const genLeft = usage ? Math.max(0, usage.gen.limit - usage.gen.used) : null;
	const genExhausted = genLeft === 0;
	const quotaReset = useMemo(quotaResetLocalTime, []);

	const totalItems = useMemo(
		() => brief?.sections.reduce((n, s) => n + s.items.length, 0) ?? 0,
		[brief],
	);

	if (state === "locked") {
		// F5:只留「用南屿账号登录」主按钮。访问码已降级为站长凭证,不再是阅读凭证。
		return (
			<div className="center-pane px-6">
				<div className="w-full max-w-sm">
					<h1 className="font-black text-3xl mb-1">每日简报</h1>
					<p className="text-sm text-[var(--ink-2)] mb-6">这份简报是私人的。登录南屿账号后阅读。</p>
					{lockLoginUrl ? (
						/* 去主站登录,登录后主站会带着手递 token 把人送回来 */
						<a
							href={lockLoginUrl}
							className="block w-full text-center rounded-md px-4 py-2.5 bg-[var(--ink)] text-[var(--paper)] text-sm hover:bg-[var(--accent)] transition-colors"
						>
							用南屿账号登录
						</a>
					) : (
						<p className="font-mono-sc text-[12px] text-[var(--ink-3)]">
							登录入口暂不可用——请从 nanisle.com 的产品页重新打开。
						</p>
					)}
				</div>
			</div>
		);
	}

	if (state === "error") {
		return (
			<div className="center-pane">
				<p className="font-mono-sc text-sm text-[var(--ink-3)]">加载失败,稍后再试。</p>
			</div>
		);
	}

	if (state === "loading") {
		return (
			<div className="center-pane">
				<p className="font-mono-sc text-sm text-[var(--ink-3)] animate-pulse">正在送报…</p>
			</div>
		);
	}

	// brief === null 且 ready = 还没生成过任何一期(空态)
	const genTime = brief ? new Date(brief.generatedAt) : null;

	// 一张报纸只有一个幅面:906 = 目录 210 + 间距 24 + 正文 672。
	// 两个视图共用它,切换 tab 时报头、双线、终点戳都不动。
	return (
		<div className="mx-auto max-w-[906px] px-5 pb-24">
			{/* 报头。两个视图共用:切换是一枚分段开关,生成动作压在双线下的状态行里,
			    不跟导航抢位置——两个视图都够得着,配置页也还是安静的。 */}
			<header className="pt-10 pb-4">
				<div className="flex flex-wrap items-center justify-between gap-x-4 gap-y-2">
					<span className="font-mono-sc inline-flex items-center gap-2 text-[11px] tracking-wider text-[var(--ink-3)]">
						<span className="dot dot-accent" />
						No.001 · 每周一个产品
					</span>
					<div className="inline-flex items-center gap-0.5 rounded-lg border border-[var(--line)] bg-[var(--card)] p-[3px]">
						{(["brief", "notes", "config"] as const).map((v) => (
							<button
								key={v}
								type="button"
								onClick={() => setView(v)}
								className={`cursor-pointer rounded-md px-4 py-1 text-[13px] font-medium transition-colors ${
									view === v ? "bg-[var(--ink)] text-[var(--paper)]" : "text-[var(--ink-2)] hover:bg-[var(--paper-deep)] hover:text-[var(--ink)]"
								}`}
							>
								{v === "brief" ? "简报" : v === "notes" ? "想法" : "配置"}
							</button>
						))}
					</div>
				</div>
				<h1 className="font-black text-[clamp(2.6rem,9vw,3.8rem)] leading-tight tracking-wide mt-3">
					每日简报
				</h1>
				<div className="mt-2 mb-3 flex flex-wrap items-baseline gap-x-4 gap-y-1 font-mono-sc text-[13px] text-[var(--ink-2)]">
					{view === "config" ? (
						<>
							<span className="text-[var(--accent)] font-medium">配置 · 追踪定义</span>
							<span>AI 起草,你圈改,虚线处都能直接编辑</span>
						</>
					) : view === "notes" ? (
						<>
							<span className="text-[var(--accent)] font-medium">想法 · 你留下的反馈与思考</span>
							<span>按日期记账,原文快照不过期,随时补记</span>
						</>
					) : brief ? (
						<>
							<span className="text-[var(--accent)] font-medium">{brief.date}</span>
							<span>{weekdayOf(brief.date)}</span>
							<span>
								{brief.sourceCount} 源 · {totalItems} 条 · 读完即止
							</span>
						</>
					) : (
						<span>还没有第一期</span>
					)}
				</div>
				<div className="rule-double" />
				{/* 生成状态行:平时是一句已完成的读数,跑起来就是进度。配置页同样留着——
				    改完追踪定义要能当场试生成一期看效果,否则风格无从调起(docs/02 §8.2 调参回路) */}
				<div className="flex flex-wrap items-center gap-x-4 gap-y-2 px-0.5 pt-2">
					{generating ? (
						<>
							<span className="font-mono-sc text-[12px] text-[var(--ink-2)]">
								<span className="text-[var(--accent)]">▸</span>{" "}
								{genProgress
									? `第 ${genProgress.step}/${genProgress.total} 步 · ${genProgress.label}…`
									: "抓取信息源,按追踪定义编选…"}
								<span className="caret ml-1" />
							</span>
							<span className="font-mono-sc ml-auto shrink-0 text-[11px] text-[var(--ink-3)]">
								{genStartedAt ? `已跑 ${fmtElapsed(genElapsedS)} · ` : ""}一趟约四五分钟,刷新或离开都不丢
							</span>
						</>
					) : (
						<>
							<span className="font-mono-sc text-[12px] text-[var(--ink-2)]">
								{genMsg ||
									(view === "config" ? (
										<>改完定义按右边试一期 · 一趟约四五分钟,跑完自动跳到简报页,中途刷新也不丢</>
									) : brief && genTime ? (
										<>
											<span className="text-[var(--ok)]">✓</span> {genTime.toLocaleTimeString("zh-CN", { hour12: false, hour: "2-digit", minute: "2-digit" })} 已生成 ·
											扫过 {brief.sourceCount} 源,入选 {totalItems} 条,筛掉 {brief.filteredOut.dropped} 条
										</>
									) : (
										<>先到配置页写下你想持续知道什么,再回来生成第一期</>
									))}
							</span>
							<span className="ml-auto flex shrink-0 items-center gap-3">
								{/* 今日额度读数(§8.3):额度是产品的一部分,不该等到点下去被拦住
								    才知道。写「还剩几次」不写「用了几比几」:读者关心的是前者。
								    平时是一枚安静的描边小签;剩 2 次以内转 accent 提醒省着用;
								    用完把重置钟点写在明面上——悬停提示手机上看不见,不能只靠它。
								    简报页只显示生成额度;配置页的编辑调用花另一份,所以那里
								    两个都摆出来。 */}
								{usage && genLeft !== null && (
									<span
										className={`font-mono-sc whitespace-nowrap rounded-full border px-2.5 py-[3px] text-[12px] ${
											genExhausted
												? "border-[var(--accent)] bg-[var(--accent-soft)] text-[var(--accent)]"
												: genLeft <= 2
													? "border-[var(--accent)] text-[var(--accent)]"
													: "border-[var(--line-strong)] text-[var(--ink-2)]"
										}`}
										title={`今日额度按美东日期计,每天美东 0 点(你的时间 ${quotaReset})重置。立即生成已用 ${usage.gen.used}/${usage.gen.limit} 次,编辑调用(向导与「对编辑说一句」)已用 ${usage.ai.used}/${usage.ai.limit} 次。`}
									>
										{genExhausted ? `生成已用完 · ${quotaReset} 重置` : `今日还可生成 ${genLeft} 次`}
										{view === "config" && ` · 编辑余 ${Math.max(0, usage.ai.limit - usage.ai.used)}`}
									</span>
								)}
								{view === "brief" && brief && dates.length > 0 && (
									<select
										value={brief.date}
										onChange={(e) => void load(e.target.value)}
										className="font-mono-sc cursor-pointer border-0 bg-transparent text-[11px] text-[var(--ink-3)] outline-none"
									>
										{!dates.includes(brief.date) && <option value={brief.date}>{brief.date}</option>}
										{dates.map((d) => (
											<option key={d} value={d}>
												{d}
											</option>
										))}
									</select>
								)}
								{/* 配置页上这是唯一的行动号召,用版记章(index.css .btn-stamp);
								    简报页的正文才是主角,「重新生成」退回一行灰字,不跟标题抢眼睛。 */}
								{view === "config" ? (
									<button
										type="button"
										onClick={() => void generate()}
										disabled={genExhausted}
										title={genExhausted ? "今日试生成次数已用完,明早定时生成照常" : undefined}
										className="btn-stamp disabled:cursor-not-allowed disabled:opacity-40"
									>
										<span className="mark" aria-hidden="true">
											▸
										</span>
										试生成一期
									</button>
								) : (
									<button
										type="button"
										onClick={() => void generate()}
										disabled={genExhausted}
										title={genExhausted ? "今日重新生成次数已用完,明早定时生成照常" : undefined}
										className="font-mono-sc cursor-pointer text-[11px] text-[var(--ink-3)] transition-colors hover:text-[var(--accent)] disabled:cursor-not-allowed disabled:text-[var(--ink-3)] disabled:opacity-40 disabled:hover:text-[var(--ink-3)]"
									>
										{genExhausted ? "今日已用完" : brief ? "重新生成 ↻" : "生成第一期 ↻"}
									</button>
								)}
							</span>
						</>
					)}
				</div>
				{/* 生成失败横幅(yiren 反馈 #4):进度行一收、界面弹回原样,只剩状态行
				    一行小字的话,人根本对不上「我刚点的那下怎么了」。失败要占一块
				    看得见的版面,说清原因和下一步,由用户自己关掉。429 不走这里——
				    限额是预期内的刹车,不是故障。 */}
				{genError && (
					<div className="mt-3 rounded-[10px] border border-[var(--accent)] bg-[var(--accent-soft)] px-5 py-3.5">
						<p className="m-0 text-[14px] font-bold text-[var(--accent)]">这次生成没有成功</p>
						<p className="m-0 mt-1 text-[13px] leading-relaxed text-[var(--ink-2)]">{genError}</p>
						<button
							type="button"
							onClick={() => setGenError(null)}
							className="font-mono-sc mt-2 cursor-pointer rounded border border-[var(--line-strong)] px-2.5 py-1 text-[11px] text-[var(--ink-2)] transition-colors hover:border-[var(--ink)] hover:text-[var(--ink)]"
						>
							知道了
						</button>
					</div>
				)}
			</header>

			{view === "config" ? (
				<Config
					// F9 · 一期都还没有(dates 空)且没在生成:档案页顶部给「生成第一期」引导
					firstIssuePending={dates.length === 0 && !brief && !generating}
					onGenerateFirst={() => void generate()}
					// 档案末尾的「试生成一期」(yiren 反馈 #3):同一个 generate
					onGenerate={() => void generate()}
					generating={generating}
				/>
			) : view === "notes" ? (
				<Notes />
			) : !brief ? (
				/* 空态:还没生成过任何一期。引导两步——先定义追踪器,再生成 */
				<div className="mx-auto max-w-[672px]">
					<div className="mt-8 rounded-[10px] border border-dashed border-[var(--line-strong)] bg-[var(--card)] px-6 py-12 text-center">
						<p className="text-sm text-[var(--ink-2)]">还没有第一期简报。</p>
						<p className="mt-2 text-[13px] text-[var(--ink-3)]">
							简报的分区就是你的追踪定义。先到配置页说清你想持续知道什么,再回来点「生成第一期」。
						</p>
						<button
							type="button"
							onClick={() => setView("config")}
							className="mt-5 cursor-pointer font-mono-sc text-[12px] text-[var(--accent)] hover:underline"
						>
							去写第一份追踪定义 →
						</button>
					</div>
				</div>
			) : (
				/* 简报是单栏读物:正文只占测量宽,在幅面里居中——
				   与配置页共用同一条中线,终点戳因此仍落在页面正中。 */
				<div className="mx-auto max-w-[672px]">
					{isStale(brief) && (
				<div className="mb-6 rounded-md border border-[var(--accent)] bg-[var(--accent-soft)] px-4 py-3 text-sm text-[var(--accent)]">
					今日未更新——最近一期生成于 {genTime?.toLocaleString("zh-CN")}。管线可能出问题了。
				</div>
			)}

			{brief.feedbackEcho && (
				<p className="mb-6 border-l-2 border-[var(--accent)] pl-3 text-[13px] text-[var(--ink-2)]">
					{brief.feedbackEcho}
				</p>
			)}

			{/* 追踪器分区:每个追踪器一个分区。空分区不藏——
			    「雷达照常扫过、今天没有新东西」本身就是要交付的信息 */}
			{brief.sections.map((section, si) => (
				<section key={section.key} className="mt-10 rounded-[10px] border border-[var(--line)] bg-[var(--card)] px-7">
					<div className={`flex items-baseline gap-3 pt-4 pb-3 ${section.items.length > 0 ? "border-b border-[var(--line)]" : ""}`}>
						<span className="font-mono-sc text-[11px] text-[var(--accent)]">
							{String(si + 1).padStart(2, "0")}
						</span>
						{/* 中文标题拉宽字距会散,收到 0.06em:够看出这是标题,又不散架 */}
						<h2 className="text-[17px] font-bold tracking-[0.06em]">{section.title}</h2>
						<span className="font-mono-sc ml-auto text-[11px] text-[var(--ink-3)]">
							{section.items.length > 0 ? `${section.items.length} 条` : "0 条"}
						</span>
					</div>
					{section.items.length > 0 ? (
						<div className="py-6">
							{section.items.map((item, i) => (
								<Item key={item.id} item={item} date={brief.date} index={si * 3 + i} />
							))}
						</div>
					) : (
						<p className="pb-4 pl-7 text-[13px] text-[var(--ink-3)]">
							今天没有新内容——雷达照常扫过,没有够格的。
						</p>
					)}
				</section>
			))}

			{brief.offAxis && <OffAxis item={brief.offAxis} date={brief.date} />}
			{brief.offAxisNote && (
				<p className="mt-6 border-l-2 border-[var(--line-strong)] pl-3 text-[13px] text-[var(--ink-3)]">
					{brief.offAxisNote}
				</p>
			)}

			{/* 已替你筛掉 */}
			<section className="mt-8">
				<details className="dropped rounded-[10px] border border-[var(--line)] bg-[var(--paper-deep)] px-4 py-3">
					<summary className="flex items-baseline gap-3">
						<span className="chevron font-mono-sc text-[11px] text-[var(--ink-3)]">▸</span>
						<span className="font-bold text-sm tracking-widest">已替你筛掉</span>
						<span className="font-mono-sc text-[11px] text-[var(--ink-3)]">
							扫描 {brief.filteredOut.scanned} · 筛掉 {brief.filteredOut.dropped}
						</span>
					</summary>
					<p className="mt-3 text-[13px] text-[var(--ink-2)]">{brief.filteredOut.summary}</p>
					{brief.filteredOut.items.length > 0 && (
						<ul className="mt-2">
							{brief.filteredOut.items.map((d) => (
								<DroppedRow key={d.id} item={d} date={brief.date} />
							))}
						</ul>
					)}
				</details>
			</section>

			<IssueGap date={brief.date} />

			{/* 终点戳:有限性的仪式感 */}
			<footer className="mt-16 flex flex-col items-center gap-8">
				<div className="end-stamp font-bold text-sm leading-relaxed">
					今日
					<br />
					到此为止
				</div>
				<p className="font-mono-sc text-[11px] text-[var(--ink-3)]">
					生成于 {genTime?.toLocaleString("zh-CN", { hour12: false })} · nanisle 每周一个产品 · 001
				</p>
			</footer>
				</div>
			)}
		</div>
	);
}
