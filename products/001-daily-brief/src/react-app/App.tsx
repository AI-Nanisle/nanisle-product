import { useCallback, useEffect, useMemo, useState } from "react";
import type { Brief, BriefItem, DroppedItem, FeedbackKind } from "../shared/types";
import { ISSUE_ITEM_ID } from "../shared/types";
import Config from "./Config";
import Notes from "./Notes";
import { SiteHeader } from "./SiteChrome";
import { apiPath, pathForView, productPath, type ProductView, viewFromPathname } from "./paths";

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

// locked = 401 没登录(引导去南屿登录);denied = 403 登录有效但不在内测
// 名单(说明页)。两种态的文案不能串(F8)。
type LoadState = "loading" | "ready" | "locked" | "denied" | "error";
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
	// 403 响应里的准入说明(服务端文案为准)
	const [denyMsg, setDenyMsg] = useState("");
	const [view, setViewState] = useState<View>(() => viewFromPathname(window.location.pathname));
	const setView = (v: View) => {
		setViewState(v);
		window.history.pushState(null, "", pathForView(v));
	};
	const [generating, setGenerating] = useState(false);
	const [genMsg, setGenMsg] = useState("");

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
			if (res.status === 403) {
				const body = (await res.json().catch(() => ({}))) as { error?: string };
				setDenyMsg(body.error ?? "产品内测中,你的账号还不在名单里。");
				setState("denied");
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

	useEffect(() => {
		void load();
	}, [load]);

	useEffect(() => {
		const syncView = () => setViewState(viewFromPathname(window.location.pathname));
		window.addEventListener("popstate", syncView);
		return () => window.removeEventListener("popstate", syncView);
	}, []);

	const generate = async () => {
		setGenerating(true);
		setGenMsg("");
		try {
			const res = await fetch(apiPath("generate"), { method: "POST" });
			const data = (await res.json()) as {
				ok?: boolean;
				date?: string;
				picked?: number;
				scanned?: number;
				error?: string;
				sourceErrors?: { name: string; error: string }[];
			};
			if (!res.ok || !data.ok) {
				// 429 = 今日限额打满:服务端文案已含「明早定时生成照常」,原样展示,
				// 不加「失败」前缀——这不是故障,是预期内的刹车(F7)
				setGenMsg(res.status === 429 && data.error ? data.error : `生成失败:${data.error ?? `HTTP ${res.status}`}`);
			} else {
				const failed = data.sourceErrors?.length
					? `(${data.sourceErrors.length} 个源抓取失败)`
					: "";
				setGenMsg(`✓ ${data.date} 已生成:扫描 ${data.scanned} 条,入选 ${data.picked} 条 ${failed}`);
				setView("brief");
				await load();
			}
		} catch {
			setGenMsg("生成失败:网络错误");
		} finally {
			setGenerating(false);
		}
	};

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

	if (state === "denied") {
		// F8:登录有效但不在内测名单(403)。文案与 401 的「去登录」严格分开。
		return (
			<div className="center-pane px-6">
				<div className="w-full max-w-sm">
					<h1 className="font-black text-3xl mb-1">产品内测中</h1>
					<p className="text-sm text-[var(--ink-2)] mb-6">{denyMsg}</p>
					<a
						href="https://nanisle.com"
						className="font-mono-sc text-[12px] text-[var(--ink-3)] hover:text-[var(--ink)]"
					>
						← 回南屿
					</a>
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
								<span className="text-[var(--accent)]">▸</span> 抓取信息源,按追踪定义编选…
								<span className="caret ml-1" />
							</span>
							<span className="font-mono-sc ml-auto shrink-0 text-[11px] text-[var(--ink-3)]">约半分钟</span>
						</>
					) : (
						<>
							<span className="font-mono-sc text-[12px] text-[var(--ink-2)]">
								{genMsg ||
									(view === "config" ? (
										<>改完定义按右边试一期 · 抓取加编选约半分钟,跑完自动跳到简报页</>
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
									<button type="button" onClick={() => void generate()} className="btn-stamp">
										<span className="mark" aria-hidden="true">
											▸
										</span>
										试生成一期
									</button>
								) : (
									<button
										type="button"
										onClick={() => void generate()}
										className="font-mono-sc cursor-pointer text-[11px] text-[var(--ink-3)] transition-colors hover:text-[var(--accent)]"
									>
										{brief ? "重新生成 ↻" : "生成第一期 ↻"}
									</button>
								)}
							</span>
						</>
					)}
				</div>
			</header>

			{view === "config" ? (
				<Config />
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
