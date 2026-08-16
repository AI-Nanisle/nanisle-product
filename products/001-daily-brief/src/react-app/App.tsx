import { useCallback, useEffect, useMemo, useState } from "react";
import type { Brief, BriefItem, DroppedItem, FeedbackKind } from "../shared/types";
import Config from "./Config";

const CODE_KEY = "daily-brief-access-code";

function getCode(): string {
	return localStorage.getItem(CODE_KEY) ?? "";
}

function apiHeaders(): Record<string, string> {
	const code = getCode();
	return code ? { "x-access-code": code } : {};
}

async function postFeedback(date: string, itemId: string, kind: FeedbackKind, text?: string) {
	await fetch("/api/feedback", {
		method: "POST",
		headers: { "content-type": "application/json", ...apiHeaders() },
		body: JSON.stringify({ date, itemId, kind, ...(text ? { text } : {}) }),
	});
}

function weekdayOf(date: string): string {
	const d = new Date(`${date}T12:00:00`);
	return ["星期日", "星期一", "星期二", "星期三", "星期四", "星期五", "星期六"][d.getDay()] ?? "";
}

function isStale(brief: Brief): boolean {
	if (brief.sample) return false;
	return Date.now() - new Date(brief.generatedAt).getTime() > 26 * 3600_000;
}

// ---------- per-item feedback ----------

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
			<div className="flex items-center gap-4 font-mono-sc text-[11px] text-[var(--ink-3)]">
				<button
					type="button"
					onClick={() => cast("up")}
					disabled={Boolean(vote)}
					className={`transition-colors ${vote === "up" ? "text-[var(--accent)]" : vote ? "opacity-40" : "hover:text-[var(--ink)] cursor-pointer"}`}
				>
					{vote === "up" ? "✓ 有用" : "有用"}
				</button>
				<button
					type="button"
					onClick={() => cast("down")}
					disabled={Boolean(vote)}
					className={`transition-colors ${vote === "down" ? "text-[var(--accent)]" : vote ? "opacity-40" : "hover:text-[var(--ink)] cursor-pointer"}`}
				>
					{vote === "down" ? "✓ 没用" : "没用"}
				</button>
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
						className="flex-1 border border-[var(--line)] bg-[var(--card)] px-3 py-1.5 text-sm outline-none focus:border-[var(--line-strong)]"
					/>
					<button
						type="button"
						onClick={send}
						className="font-mono-sc text-[11px] px-3 border border-[var(--line-strong)] hover:bg-[var(--ink)] hover:text-[var(--paper)] transition-colors cursor-pointer"
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
			<div className="font-mono-sc text-[11px] text-[var(--ink-3)] mb-1.5">
				{item.source}
				{item.relatesTo && (
					<span className="ml-3 text-[var(--accent)]">◆ {item.relatesTo}</span>
				)}
			</div>
			<h3 className="font-serif-sc font-bold text-xl leading-snug">
				<a href={`/go/${date}/${item.id}`} target="_blank" rel="noreferrer" className="headline-link">
					{item.title}
				</a>
			</h3>
			<p className="mt-2 text-[15px] leading-relaxed text-[var(--ink-2)]">{item.whyClick}</p>
			{item.caveat && (
				<p className="mt-2 border-l-2 border-[var(--line-strong)] pl-3 text-[13px] leading-relaxed text-[var(--ink-3)]">
					<span className="font-mono-sc text-[10px] mr-1.5 text-[var(--ink-3)]">原文存疑</span>
					{item.caveat}
				</p>
			)}
			<div className="mt-2.5 flex flex-wrap gap-x-5 gap-y-1 font-mono-sc text-[11px]">
				<a href={`/go/${date}/${item.id}`} target="_blank" rel="noreferrer" className="text-[var(--accent)] hover:underline">
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
				href={`/go/${date}/${item.id}`}
				target="_blank"
				rel="noreferrer"
				className="text-[13px] text-[var(--ink-2)] hover:text-[var(--accent)] truncate"
			>
				{item.title}
			</a>
			<span className="font-mono-sc text-[10px] text-[var(--ink-3)] shrink-0">{item.reason}</span>
			<button
				type="button"
				disabled={wanted}
				onClick={() => {
					setWanted(true);
					void postFeedback(date, item.id, "want");
				}}
				className={`ml-auto shrink-0 font-mono-sc text-[10px] cursor-pointer ${wanted ? "text-[var(--accent)]" : "text-[var(--ink-3)] hover:text-[var(--accent)]"}`}
			>
				{wanted ? "✓ 已记下" : "这条我要"}
			</button>
		</li>
	);
}

// ---------- app ----------

type LoadState = "loading" | "ready" | "locked" | "error";
type View = "brief" | "config";

export default function App() {
	const [brief, setBrief] = useState<Brief | null>(null);
	const [dates, setDates] = useState<string[]>([]);
	const [state, setState] = useState<LoadState>("loading");
	const [codeInput, setCodeInput] = useState("");
	const [view, setViewState] = useState<View>(() =>
		window.location.hash === "#config" ? "config" : "brief",
	);
	const setView = (v: View) => {
		setViewState(v);
		window.history.replaceState(null, "", v === "config" ? "#config" : "#");
	};
	const [generating, setGenerating] = useState(false);
	const [genMsg, setGenMsg] = useState("");

	const load = useCallback(async (date?: string) => {
		setState("loading");
		try {
			const res = await fetch(`/api/brief${date ? `?date=${date}` : ""}`, { headers: apiHeaders() });
			if (res.status === 401) {
				setState("locked");
				return;
			}
			if (!res.ok) throw new Error(String(res.status));
			setBrief((await res.json()) as Brief);
			setState("ready");
			const dres = await fetch("/api/dates", { headers: apiHeaders() });
			if (dres.ok) setDates(((await dres.json()) as { dates: string[] }).dates);
		} catch {
			setState("error");
		}
	}, []);

	useEffect(() => {
		void load();
	}, [load]);

	const generate = async () => {
		setGenerating(true);
		setGenMsg("");
		try {
			const res = await fetch("/api/generate", { method: "POST", headers: apiHeaders() });
			const data = (await res.json()) as {
				ok?: boolean;
				date?: string;
				picked?: number;
				scanned?: number;
				error?: string;
				sourceErrors?: { name: string; error: string }[];
			};
			if (!res.ok || !data.ok) {
				setGenMsg(`生成失败:${data.error ?? `HTTP ${res.status}`}`);
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
		return (
			<div className="min-h-screen flex items-center justify-center px-6">
				<div className="w-full max-w-sm">
					<h1 className="font-serif-sc font-black text-3xl mb-1">每日简报</h1>
					<p className="text-sm text-[var(--ink-2)] mb-6">这份简报是私人的。输入访问码继续。</p>
					<div className="flex gap-2">
						<input
							type="password"
							value={codeInput}
							onChange={(e) => setCodeInput(e.target.value)}
							onKeyDown={(e) => {
								if (e.key === "Enter") {
									localStorage.setItem(CODE_KEY, codeInput.trim());
									void load();
								}
							}}
							placeholder="访问码"
							className="flex-1 border border-[var(--line-strong)] bg-[var(--card)] px-3 py-2 text-sm outline-none focus:border-[var(--ink)]"
						/>
						<button
							type="button"
							onClick={() => {
								localStorage.setItem(CODE_KEY, codeInput.trim());
								void load();
							}}
							className="px-4 py-2 bg-[var(--ink)] text-[var(--paper)] text-sm cursor-pointer hover:bg-[var(--accent)] transition-colors"
						>
							进入
						</button>
					</div>
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

	if (state === "loading" || !brief) {
		return (
			<div className="min-h-screen flex items-center justify-center">
				<p className="font-mono-sc text-sm text-[var(--ink-3)] animate-pulse">正在送报…</p>
			</div>
		);
	}

	const genTime = new Date(brief.generatedAt);

	return (
		<div className="mx-auto max-w-2xl px-5 pb-24">
			{/* 报头 */}
			<header className="pt-10 pb-4">
				<div className="flex flex-wrap items-baseline justify-between gap-y-2 font-mono-sc text-[11px] text-[var(--ink-3)]">
					<span>NANISLE · No.001</span>
					<div className="flex items-baseline gap-3">
						<button
							type="button"
							onClick={() => setView("brief")}
							className={`cursor-pointer ${view === "brief" ? "text-[var(--accent)] border-b border-[var(--accent)]" : "hover:text-[var(--ink)]"}`}
						>
							简报
						</button>
						<button
							type="button"
							onClick={() => setView("config")}
							className={`cursor-pointer ${view === "config" ? "text-[var(--accent)] border-b border-[var(--accent)]" : "hover:text-[var(--ink)]"}`}
						>
							配置
						</button>
						<button
							type="button"
							onClick={() => void generate()}
							disabled={generating}
							className="px-2.5 py-1 border border-[var(--line-strong)] hover:bg-[var(--ink)] hover:text-[var(--paper)] transition-colors cursor-pointer disabled:opacity-50"
						>
							{generating ? "生成中…约半分钟" : "立即生成"}
						</button>
						{view === "brief" && dates.length > 0 && (
							<select
								value={brief.date}
								onChange={(e) => void load(e.target.value)}
								className="bg-transparent border border-[var(--line)] px-2 py-0.5 cursor-pointer outline-none"
							>
								{!dates.includes(brief.date) && <option value={brief.date}>{brief.date}</option>}
								{dates.map((d) => (
									<option key={d} value={d}>
										{d}
									</option>
								))}
							</select>
						)}
					</div>
				</div>
				<h1 className="font-serif-sc font-black text-[clamp(2.6rem,9vw,3.8rem)] leading-tight tracking-wide mt-3">
					每日简报
				</h1>
				<div className="mt-2 mb-3 flex flex-wrap items-baseline gap-x-4 gap-y-1 font-mono-sc text-[12px] text-[var(--ink-2)]">
					<span className="text-[var(--accent)] font-medium">{brief.date}</span>
					<span>{weekdayOf(brief.date)}</span>
					<span>
						{brief.sourceCount} 源 · {totalItems} 条 · 读完即止
					</span>
					{brief.sample && <span className="px-1.5 border border-[var(--accent)] text-[var(--accent)]">示例数据</span>}
				</div>
				<div className="rule-double" />
			</header>

			{genMsg && (
				<p className="mb-4 font-mono-sc text-[12px] text-[var(--ink-2)] border border-[var(--line)] bg-[var(--card)] px-3 py-2">
					{genMsg}
				</p>
			)}

			{view === "config" ? (
				<Config />
			) : (
				<>
					{isStale(brief) && (
				<div className="mb-6 border border-[var(--accent)] bg-[var(--accent-soft)] px-4 py-3 text-sm text-[var(--accent)]">
					今日未更新——最近一期生成于 {genTime.toLocaleString("zh-CN")}。管线可能出问题了。
				</div>
			)}

			{brief.feedbackEcho && (
				<p className="mb-6 border-l-2 border-[var(--accent)] pl-3 text-[13px] text-[var(--ink-2)]">
					{brief.feedbackEcho}
				</p>
			)}

			{/* 三个价值分区 */}
			{brief.sections.map(
				(section, si) =>
					section.items.length > 0 && (
						<section key={section.key} className="mb-2">
							<div className="flex items-baseline gap-3 border-t border-[var(--line-strong)] pt-3 mt-6">
								<span className="font-mono-sc text-[11px] text-[var(--accent)]">
									{String(si + 1).padStart(2, "0")}
								</span>
								<h2 className="font-serif-sc font-bold text-lg tracking-widest">{section.title}</h2>
							</div>
							<div className="divide-y divide-[var(--line)]">
								{section.items.map((item, i) => (
									<Item key={item.id} item={item} date={brief.date} index={si * 3 + i} />
								))}
							</div>
						</section>
					),
			)}

			{/* 已替你筛掉 */}
			<section className="mt-8">
				<details className="dropped border border-[var(--line)] bg-[var(--paper-deep)] px-4 py-3">
					<summary className="flex items-baseline gap-3">
						<span className="chevron font-mono-sc text-[11px] text-[var(--ink-3)]">▸</span>
						<span className="font-serif-sc font-bold text-sm tracking-widest">已替你筛掉</span>
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
				<div className="end-stamp font-serif-sc font-bold text-sm leading-relaxed">
					今日
					<br />
					到此为止
				</div>
				<p className="font-mono-sc text-[10px] text-[var(--ink-3)]">
					生成于 {genTime.toLocaleString("zh-CN", { hour12: false })} · nanisle 每周一个产品 · 001
				</p>
			</footer>
				</>
			)}
		</div>
	);
}
