import { useCallback, useEffect, useMemo, useState } from "react";
import type { Brief, BriefItem, DroppedItem, FeedbackKind } from "../shared/types";
import Config from "./Config";
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

// 四个一键信号,对系统的意义各不相同:
// 有用/没用 = 口味;已知道 = 选题对但不新(别降这类选题的权);
// 多找这种 = 最高质量的正向定向信号(直接指向追踪器该收什么)。
const VOTE_KINDS: { kind: "up" | "down" | "known" | "more"; label: string; done: string }[] = [
	{ kind: "up", label: "有用", done: "✓ 有用" },
	{ kind: "down", label: "没用", done: "✓ 没用" },
	{ kind: "known", label: "已知道", done: "✓ 已知道" },
	{ kind: "more", label: "多找这种", done: "✓ 会多找" },
];

function ItemFeedback({ date, itemId }: { date: string; itemId: string }) {
	const voteKey = `daily-brief-vote:${date}:${itemId}`;
	const [vote, setVote] = useState<string>(() => localStorage.getItem(voteKey) ?? "");
	const [open, setOpen] = useState(false);
	const [text, setText] = useState("");
	const [sent, setSent] = useState(false);

	const cast = (kind: "up" | "down" | "known" | "more") => {
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
					写句反馈
				</button>
			</div>
			{open && (
				<div className="mt-2 flex gap-2">
					<input
						value={text}
						onChange={(e) => setText(e.target.value)}
						onKeyDown={(e) => e.key === "Enter" && send()}
						placeholder="例如:这条没什么细节 / 这类内容多来点"
						className="flex-1 rounded-md border border-[var(--line)] bg-[var(--card)] px-3 py-1.5 text-sm outline-none focus:border-[var(--line-strong)]"
					/>
					<button
						type="button"
						onClick={send}
						className="font-mono-sc text-[12px] px-3 rounded-md border border-[var(--line-strong)] hover:bg-[var(--ink)] hover:text-[var(--paper)] transition-colors cursor-pointer"
					>
						{sent ? "已收到" : "发送"}
					</button>
				</div>
			)}
		</div>
	);
}

// ---------- brief item ----------

function Item({ item, date, index }: { item: BriefItem; date: string; index: number }) {
	return (
		<article className="rise py-6 first:pt-4" style={{ animationDelay: `${index * 80}ms` }}>
			<div className="font-mono-sc text-[12px] text-[var(--ink-3)] mb-1.5">
				{item.source}
				{item.relatesTo && (
					<span className="ml-3 text-[var(--accent)]">◆ {item.relatesTo}</span>
				)}
			</div>
			<h3 className="font-bold text-xl leading-snug">
				<a href={productPath(`go/${date}/${item.id}`)} target="_blank" rel="noreferrer" className="headline-link">
					{item.title}
				</a>
			</h3>
			<p className="mt-2 text-[15px] leading-relaxed text-[var(--ink-2)]">{item.whyClick}</p>
			{item.caveat && (
				<p className="mt-2 border-l-2 border-[var(--line-strong)] pl-3 text-[13px] leading-relaxed text-[var(--ink-3)]">
					<span className="font-mono-sc text-[11px] mr-1.5 text-[var(--ink-3)]">原文存疑</span>
					{item.caveat}
				</p>
			)}
			<div className="mt-2.5 flex flex-wrap gap-x-5 gap-y-1 font-mono-sc text-[12px]">
				<a href={productPath(`go/${date}/${item.id}`)} target="_blank" rel="noreferrer" className="text-[var(--accent)] hover:underline">
					读原文 →
				</a>
				{item.discussionUrl && (
					<a href={item.discussionUrl} target="_blank" rel="noreferrer" className="text-[var(--ink-2)] hover:text-[var(--accent)]">
						讨论区
					</a>
				)}
				{item.extras?.map((x) => (
					<a key={x.url} href={x.url} target="_blank" rel="noreferrer" className="text-[var(--ink-2)] hover:text-[var(--accent)]">
						{x.label}
					</a>
				))}
			</div>
			{item.mergedFrom && item.mergedFrom.length > 0 && (
				<div className="mt-2 text-[12px] text-[var(--ink-3)]">
					同一事件:
					{item.mergedFrom.map((m) => (
						<a key={m.url} href={m.url} target="_blank" rel="noreferrer" className="ml-2 underline decoration-[var(--line-strong)] hover:text-[var(--accent)]">
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

// ---------- app ----------

// locked = 401 没登录(引导去南屿登录);denied = 403 登录有效但不在内测
// 名单(说明页)。两种态的文案不能串(F8)。
type LoadState = "loading" | "ready" | "locked" | "denied" | "error";
type View = ProductView;

export default function App() {
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
			<div className="min-h-screen flex items-center justify-center px-6">
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
			<div className="min-h-screen flex items-center justify-center px-6">
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
			<div className="min-h-screen flex items-center justify-center">
				<p className="font-mono-sc text-sm text-[var(--ink-3)]">加载失败,稍后再试。</p>
			</div>
		);
	}

	if (state === "loading") {
		return (
			<div className="min-h-screen flex items-center justify-center">
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
			{/* 报头。两个视图共用:切换是一枚分段开关,生成动作留在简报页的状态行,
			    不跟导航抢位置——配置页要的是安静。 */}
			<header className="pt-10 pb-4">
				<div className="flex flex-wrap items-center justify-between gap-x-4 gap-y-2">
					<span className="font-mono-sc inline-flex items-center gap-2 text-[11px] tracking-wider text-[var(--ink-3)]">
						<span className="dot dot-accent" />
						NANISLE · No.001
					</span>
					<div className="inline-flex items-center gap-0.5 rounded-lg border border-[var(--line)] bg-[var(--card)] p-[3px]">
						{(["brief", "config"] as const).map((v) => (
							<button
								key={v}
								type="button"
								onClick={() => setView(v)}
								className={`cursor-pointer rounded-md px-4 py-1 text-[13px] font-medium transition-colors ${
									view === v ? "bg-[var(--ink)] text-[var(--paper)]" : "text-[var(--ink-2)] hover:bg-[var(--paper-deep)] hover:text-[var(--ink)]"
								}`}
							>
								{v === "brief" ? "简报" : "配置"}
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
				{/* 生成状态行:平时是一句已完成的读数,跑起来就是进度 */}
				{view === "brief" && (
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
										(brief && genTime ? (
											<>
												<span className="text-[var(--ok)]">✓</span> {genTime.toLocaleTimeString("zh-CN", { hour12: false, hour: "2-digit", minute: "2-digit" })} 已生成 ·
												扫过 {brief.sourceCount} 源,入选 {totalItems} 条,筛掉 {brief.filteredOut.dropped} 条
											</>
										) : (
											<>先在配置页定义追踪器,或直接生成第一期</>
										))}
								</span>
								<span className="ml-auto flex shrink-0 items-center gap-3">
									{brief && dates.length > 0 && (
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
									<button
										type="button"
										onClick={() => void generate()}
										className="font-mono-sc cursor-pointer text-[11px] text-[var(--ink-3)] transition-colors hover:text-[var(--accent)]"
									>
										{brief ? "重新生成 ↻" : "生成第一期 ↻"}
									</button>
								</span>
							</>
						)}
					</div>
				)}
			</header>

			{view === "config" ? (
				<Config />
			) : !brief ? (
				/* 空态:还没生成过任何一期。引导两步——先改追踪器,再生成 */
				<div className="mx-auto max-w-[672px]">
					<div className="mt-8 rounded-[10px] border border-dashed border-[var(--line-strong)] bg-[var(--card)] px-6 py-12 text-center">
						<p className="text-sm text-[var(--ink-2)]">还没有第一期简报。</p>
						<p className="mt-2 text-[13px] text-[var(--ink-3)]">
							先到配置页把追踪器改成你自己的长期问题,再回来点「生成第一期」。
						</p>
						<button
							type="button"
							onClick={() => setView("config")}
							className="mt-5 cursor-pointer font-mono-sc text-[12px] text-[var(--accent)] hover:underline"
						>
							去配置追踪器 →
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
				<section key={section.key} className="mt-6 rounded-[10px] bg-[var(--card)] border border-[var(--line)] px-5">
					<div className={`flex items-baseline gap-3 pt-3 pb-2.5 ${section.items.length > 0 ? "border-b border-[var(--line)]" : ""}`}>
						<span className="font-mono-sc text-[11px] text-[var(--accent)]">
							{String(si + 1).padStart(2, "0")}
						</span>
						<h2 className="font-bold text-lg tracking-widest">{section.title}</h2>
						<span className="font-mono-sc ml-auto text-[11px] text-[var(--ink-3)]">
							{section.items.length > 0 ? `${section.items.length} 条` : "0 条"}
						</span>
					</div>
					{section.items.length > 0 ? (
						<div className="divide-y divide-[var(--line)]">
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
