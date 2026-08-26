import { useEffect, useState } from "react";
import type { ReactNode } from "react";
import type { WatchResult } from "../shared/schema";
import { SiteHeader } from "./SiteChrome";
import { apiPath } from "./paths";

// 收单 + 结果页 + 记录/想法(docs/03 F 线 + N 线)。视觉与主站/001 同一套
// 语言,隐喻是「剪辑台」。N 线哲学同 001:结果是内容(60 天缓存,过期可
// 重算),想法是读者的长期资产(DynamoDB,永不过期)。

interface Health {
	ok: boolean;
	provider: string;
	store: string;
	email: string | null;
	loginUrl: string;
	ssoConfigured: boolean;
}

interface Usage {
	used: number;
	limit: number;
}

interface NoteEntry {
	at: number;
	target: string;
	text: string;
}

interface NoteRecord {
	contentKey: string;
	url?: string;
	title?: string;
	entries: NoteEntry[];
}

interface HistoryItem {
	contentKey: string;
	url?: string;
	title?: string;
	at: number;
}

interface SubmitResponse {
	cached?: boolean;
	lane?: string;
	contentKey?: string;
	result?: WatchResult;
	paragraphs?: string[];
	url?: string;
	taskId?: string;
	error?: string;
	needPaste?: boolean;
	loginUrl?: string;
}

interface TaskResponse {
	status: "pending" | "running" | "done" | "failed";
	step?: string;
	path?: string;
	url?: string;
	contentKey?: string;
	result?: WatchResult;
	paragraphs?: string[];
	error?: string;
}

/** 快车道 SSE 事件(worker/index.ts 的 send 序列)。 */
interface FastEvent {
	type: "phase" | "delta" | "result" | "error" | "ping";
	phase?: string;
	chars?: number;
	contentKey?: string;
	result?: WatchResult;
	paragraphs?: string[];
	url?: string;
	error?: string;
	needPaste?: boolean;
}

const STEPS = [
	["queued", "排队"],
	["downloading", "下载"],
	["transcribing", "转写"],
	["editing", "编辑"],
	["done", "完成"],
] as const;

function fmtTime(sec: number): string {
	const m = Math.floor(sec / 60);
	const s = Math.floor(sec % 60);
	return `${m}:${String(s).padStart(2, "0")}`;
}

function fmtDate(ms: number): string {
	return new Date(ms).toLocaleString("zh-CN", {
		month: "2-digit",
		day: "2-digit",
		hour: "2-digit",
		minute: "2-digit",
		hour12: false,
	});
}

/** F4 · 视频平台的带秒跳转链接;不认识的平台返回 null(只显示时间不跳)。 */
function jumpHref(url: string | undefined, startSec: number): string | null {
	if (!url) return null;
	try {
		const u = new URL(url);
		const host = u.hostname.replace(/^www\./, "");
		const t = Math.floor(startSec);
		if (host === "youtu.be" || host.endsWith("youtube.com")) {
			u.searchParams.set("t", `${t}s`);
			return u.toString();
		}
		if (host.endsWith("bilibili.com")) {
			u.searchParams.set("t", String(t));
			return u.toString();
		}
	} catch {
		// 非法 URL 就不给跳转
	}
	return null;
}

interface Loaded {
	contentKey?: string;
	result: WatchResult;
	paragraphs?: string[];
	url?: string;
}

const PATH_LABEL: Record<string, string> = {
	subtitle: "官方字幕",
	whisper: "whisper 转写(时间戳与文字精度低一档)",
	article: "文章抽取",
	paste: "手动粘贴",
};

export default function App() {
	const [health, setHealth] = useState<Health | null>(null);
	const [usage, setUsage] = useState<Usage | null>(null);
	const [input, setInput] = useState("");
	const [loaded, setLoaded] = useState<Loaded | null>(null);
	const [error, setError] = useState("");
	const [login, setLogin] = useState("");
	const [busy, setBusy] = useState(false);
	const [step, setStep] = useState<string | null>(null);
	const [fastStatus, setFastStatus] = useState<string | null>(null);
	const [showSource, setShowSource] = useState(false);
	// N 线状态
	const [view, setView] = useState<"main" | "history">("main");
	const [history, setHistory] = useState<HistoryItem[] | null>(null);
	const [note, setNote] = useState<NoteRecord | null>(null);
	/** 正在写想法的锚点(同一时刻只开一个输入框)。 */
	const [noteAt, setNoteAt] = useState<string | null>(null);
	const [noteText, setNoteText] = useState("");

	function refreshUsage() {
		fetch(apiPath("usage"))
			.then((r) => (r.ok ? (r.json() as Promise<Usage>) : null))
			.then((u) => u && setUsage(u))
			.catch(() => {});
	}

	useEffect(() => {
		// ?url= 预填:001 简报「深读 →」入口的承接端(docs/02 T7①)
		const preset = new URLSearchParams(window.location.search).get("url");
		if (preset) setInput(preset);
		fetch(apiPath("health"))
			.then((r) => r.json() as Promise<Health>)
			.then(setHealth)
			.catch(() => setHealth(null));
		refreshUsage();
	}, []);

	/** 结果就位后拉这条内容的想法账(独立请求,失败只是没想法,不碍读)。 */
	function loadNote(contentKey: string) {
		fetch(apiPath(`note/${contentKey}`))
			.then((r) => (r.ok ? (r.json() as Promise<{ note: NoteRecord | null }>) : null))
			.then((d) => setNote(d?.note ?? null))
			.catch(() => setNote(null));
	}

	function present(l: Loaded) {
		setLoaded(l);
		setNote(null);
		setNoteAt(null);
		if (l.contentKey) loadNote(l.contentKey);
	}

	async function loadHistory() {
		setView("history");
		try {
			const res = await fetch(apiPath("history"));
			if (res.status === 401) {
				const d = (await res.json()) as { loginUrl?: string };
				setError("请先登录南屿账号。");
				if (d.loginUrl) setLogin(d.loginUrl);
				setView("main");
				return;
			}
			const d = (await res.json()) as { items: HistoryItem[] };
			setHistory(d.items);
		} catch {
			setHistory([]);
		}
	}

	async function openRecord(item: HistoryItem) {
		setError("");
		try {
			const res = await fetch(apiPath(`result/${item.contentKey}`));
			const d = (await res.json()) as SubmitResponse & { expired?: boolean; note?: NoteRecord };
			if (d.expired) {
				// 结果缓存过期(60 天):预填原链接引导重算,想法账还在
				setView("main");
				setInput(item.url ?? "");
				setLoaded(null);
				setError("这份结果的缓存已过期(60 天)。原链接已填好,点「替我看」重新生成——你的想法一直都在,重新生成后照常显示。");
				return;
			}
			if (d.result) {
				setView("main");
				setShowSource(false);
				setLoaded({ contentKey: d.contentKey, result: d.result, paragraphs: d.paragraphs, url: d.url });
				setNote(d.note ?? null);
				setNoteAt(null);
				window.scrollTo({ top: 0 });
			}
		} catch {
			setError("打开记录失败,稍后再试。");
		}
	}

	async function addNote(target: string) {
		const key = loaded?.contentKey;
		const text = noteText.trim();
		if (!key || !text) return;
		try {
			const res = await fetch(apiPath("note"), {
				method: "POST",
				headers: { "content-type": "application/json" },
				body: JSON.stringify({ contentKey: key, target, text }),
			});
			const d = (await res.json()) as { ok?: boolean; entry?: NoteEntry; error?: string };
			if (d.ok && d.entry) {
				setNote((n) => ({
					contentKey: key,
					...(n ?? {}),
					entries: [...(n?.entries ?? []), d.entry!],
				}));
				setNoteText("");
				setNoteAt(null);
			} else if (d.error) {
				setError(d.error);
			}
		} catch {
			setError("想法没存上,稍后再试。");
		}
	}

	async function delNote(at: number) {
		const key = loaded?.contentKey;
		if (!key) return;
		setNote((n) => (n ? { ...n, entries: n.entries.filter((e) => e.at !== at) } : n));
		void fetch(apiPath("note/delete"), {
			method: "POST",
			headers: { "content-type": "application/json" },
			body: JSON.stringify({ contentKey: key, at }),
		}).catch(() => {});
	}

	/** F2 · 快车道 SSE:phase → delta(字符数)→ result/error。 */
	async function readFastStream(res: Response) {
		const reader = res.body!.getReader();
		const decoder = new TextDecoder();
		let buffer = "";
		for (;;) {
			const { done, value } = await reader.read();
			if (done) break;
			buffer += decoder.decode(value, { stream: true });
			const events = buffer.split("\n\n");
			buffer = events.pop() ?? "";
			for (const raw of events) {
				const line = raw.split("\n").find((l) => l.startsWith("data:"));
				if (!line) continue;
				let ev: FastEvent;
				try {
					ev = JSON.parse(line.slice(5).trim()) as FastEvent;
				} catch {
					continue;
				}
				if (ev.type === "phase") {
					setFastStatus(ev.phase === "extracting" ? "抽取正文中" : "编辑中(整篇一次调用,长文要一两分钟)");
				} else if (ev.type === "delta" && typeof ev.chars === "number") {
					setFastStatus(`编辑中 · 已生成 ${ev.chars} 字`);
				} else if (ev.type === "result" && ev.result) {
					present({ contentKey: ev.contentKey, result: ev.result, paragraphs: ev.paragraphs, url: ev.url });
				} else if (ev.type === "error" && ev.error) {
					setError(ev.error + (ev.needPaste ? "(把正文粘进输入框再试)" : ""));
				}
			}
		}
	}

	/** F6 · 慢车道:轮询任务直到 done/failed;超时由服务端判定。 */
	async function pollTask(taskId: string) {
		for (;;) {
			await new Promise((r) => setTimeout(r, 2500));
			const res = await fetch(apiPath(`task/${taskId}`));
			const data = (await res.json()) as TaskResponse;
			if (!res.ok) {
				setError((data as { error?: string }).error ?? `轮询失败(${res.status})`);
				return;
			}
			setStep(data.step ?? data.status);
			if (data.status === "done" && data.result) {
				present({ contentKey: data.contentKey, result: data.result, paragraphs: data.paragraphs, url: data.url });
				return;
			}
			if (data.status === "failed") {
				setError(data.error ?? "处理失败。");
				return;
			}
		}
	}

	async function submit() {
		setBusy(true);
		setError("");
		setLogin("");
		setLoaded(null);
		setNote(null);
		setStep(null);
		setFastStatus(null);
		setShowSource(false);
		try {
			const trimmed = input.trim();
			const isUrl = /^https?:\/\//i.test(trimmed);
			const res = await fetch(apiPath("submit"), {
				method: "POST",
				headers: { "content-type": "application/json" },
				body: JSON.stringify(isUrl ? { url: trimmed } : { text: trimmed }),
			});
			if (res.ok && res.headers.get("content-type")?.includes("text/event-stream")) {
				await readFastStream(res);
			} else {
				const data = (await res.json()) as SubmitResponse;
				if (!res.ok) {
					setError(data.error ?? `请求失败(${res.status})`);
					if (res.status === 401 && data.loginUrl) setLogin(data.loginUrl);
				} else if (data.result) {
					present({ contentKey: data.contentKey, result: data.result, paragraphs: data.paragraphs, url: data.url });
				} else if (data.taskId) {
					setStep("queued");
					await pollTask(data.taskId);
				}
			}
		} catch {
			setError("网络错误,稍后再试。");
		} finally {
			setBusy(false);
			setStep(null);
			setFastStatus(null);
			refreshUsage();
		}
	}

	/** F4 · 文章段落锚点:展开原文区后滚动到对应段并短暂点亮。 */
	function jumpToPara(n: number) {
		setShowSource(true);
		setTimeout(() => {
			const el = document.getElementById(`para-${n}`);
			if (!el) return;
			el.scrollIntoView({ behavior: "smooth", block: "center" });
			el.classList.add("para-hit");
			setTimeout(() => el.classList.remove("para-hit"), 1600);
		}, 60);
	}

	const result = loaded?.result ?? null;
	const isText = result?.meta.path === "article" || result?.meta.path === "paste";
	const fmtPos = (n: number) => (isText ? `§${n}` : fmtTime(n));
	const lowAmount = result
		? result.chapters.filter((ch) => ch.value === "low").reduce((s, ch) => s + (ch.end - ch.start), 0)
		: 0;
	const lowLabel = isText ? `低价值段共 ${lowAmount} 段` : `低价值段共 ${Math.round(lowAmount / 60)} 分钟`;
	const canJumpText = isText && (loaded?.paragraphs?.length ?? 0) > 0;
	const stepIdx = STEPS.findIndex(([k]) => k === step);
	const canNote = Boolean(loaded?.contentKey);

	function Pos({ start, children }: { start: number; children: ReactNode }) {
		if (canJumpText) {
			return (
				<button type="button" className="pos-link" onClick={() => jumpToPara(start)}>
					{children}
				</button>
			);
		}
		const href = jumpHref(loaded?.url, start);
		if (href && !isText) {
			return (
				<a className="pos-link" href={href} target="_blank" rel="noreferrer">
					{children}
				</a>
			);
		}
		return <>{children}</>;
	}

	/** N 线 · 一个锚点上的想法区:已有条目 + 「记一笔」入口。 */
	function NoteSpot({ target, always }: { target: string; always?: boolean }) {
		if (!canNote) return null;
		const entries = (note?.entries ?? []).filter((e) => e.target === target);
		const open = noteAt === target;
		if (!always && entries.length === 0 && !open) {
			return (
				<button type="button" className="note-add" onClick={() => { setNoteAt(target); setNoteText(""); }}>
					＋ 想法
				</button>
			);
		}
		return (
			<div className="note-spot">
				{entries.map((e) => (
					<div key={e.at} className="note-entry">
						<span className="note-meta">{fmtDate(e.at)}</span>
						{e.text}
						<button type="button" className="note-del" aria-label="删除这条想法" onClick={() => void delNote(e.at)}>
							×
						</button>
					</div>
				))}
				{open ? (
					<div className="note-form">
						<textarea
							autoFocus
							value={noteText}
							onChange={(e) => setNoteText(e.target.value)}
							placeholder="记下你此刻的想法…(只有你自己能看到)"
						/>
						<div className="note-form-row">
							<button type="button" className="btn-ink" disabled={!noteText.trim()} onClick={() => void addNote(target)}>
								存想法
							</button>
							<button type="button" className="note-cancel" onClick={() => setNoteAt(null)}>
								取消
							</button>
						</div>
					</div>
				) : (
					<button type="button" className="note-add" onClick={() => { setNoteAt(target); setNoteText(""); }}>
						＋ 想法
					</button>
				)}
			</div>
		);
	}

	return (
		<div>
			<SiteHeader />
			<main className="page">
				<header className="masthead rise">
					<h1>
						长视频总结
						<small>WATCH ROUTER · 002</small>
						{health?.provider === "mock" && <span className="mock-chip">MOCK</span>}
					</h1>
					<span className="masthead-side">
						{view === "history" ? (
							<button type="button" className="nav-mono" onClick={() => setView("main")}>
								← 返回
							</button>
						) : (
							<button type="button" className="nav-mono" onClick={() => void loadHistory()}>
								我的记录
							</button>
						)}
						{usage && (
							<span className="usage-chip">
								今日额度 {usage.used}/{usage.limit}
							</span>
						)}
					</span>
				</header>

				{view === "history" ? (
					<section className="rise">
						<p className="tagline">你处理过的每一条都在这里;想法永久保存,结果缓存 60 天(过期一键重算)。</p>
						{history === null ? (
							<p className="meta-line" style={{ marginTop: 24 }}>
								读取中…
							</p>
						) : history.length === 0 ? (
							<p className="meta-line" style={{ marginTop: 24 }}>
								还没有记录——回去丢一条链接试试。
							</p>
						) : (
							<ol className="history-list">
								{history.map((h) => (
									<li key={h.contentKey}>
										<button type="button" onClick={() => void openRecord(h)}>
											<span className="h-title">{h.title || h.url || h.contentKey}</span>
											<span className="h-date">{fmtDate(h.at)}</span>
										</button>
									</li>
								))}
							</ol>
						)}
						{error && (
							<div className="error-box rise" role="alert">
								{error}
							</div>
						)}
					</section>
				) : (
					<>
						<p className="tagline rise">
							丢给我一条视频、播客或文章链接:值不值得看、讲了什么、每一段在原片的哪几分钟——AI 先替你看完,你只看值得看的部分。
						</p>

						<section className="console rise" aria-label="收单">
							<textarea
								placeholder="粘贴链接(B站 / YouTube / 播客 / 文章),或直接把正文贴进来…"
								value={input}
								onChange={(e) => setInput(e.target.value)}
							/>
							<div className="console-row">
								<button type="button" className="btn-ink" disabled={busy || input.trim().length === 0} onClick={submit}>
									{busy ? "看着呢…" : "替我看"}
								</button>
								{fastStatus && <span className="statusline">{fastStatus}</span>}
								{step && (
									<span className="steps" aria-label="处理进度">
										{STEPS.map(([key, label], i) => (
											<span key={key}>
												{i > 0 && <span className="sep">→</span>}{" "}
												<span className={key === step || i < stepIdx ? "on" : ""}>{label}</span>
											</span>
										))}
									</span>
								)}
							</div>
						</section>

						{error && (
							<div className="error-box rise" role="alert">
								{error}
								{login && (
									<>
										{" "}
										<a href={login}>去登录 →</a>
									</>
								)}
							</div>
						)}

						{result && (
							<section className="result">
								{result.meta.title && <h2 className="content-title rise">{result.meta.title}</h2>}

								<div className={`verdict rise worth-${result.verdict.worth}`}>
									<span className="verdict-word">
										{result.verdict.worth === "yes" ? "值得看" : result.verdict.worth === "no" ? "可以跳过" : "部分值得"}
									</span>
									<p className="verdict-reason">{result.verdict.reason}</p>
								</div>

								{result.overview && (
									<div className="overview rise">
										<p className="ov-summary">{result.overview.summary}</p>
										<p className="ov-row">
											<span className="ov-label">有意思的是</span>
											{result.overview.interesting}
										</p>
										<p className="ov-row">
											<span className="ov-label ov-counter">反着想</span>
											{result.overview.counter}
										</p>
										<NoteSpot target="overview" />
									</div>
								)}

								<div className="rise">
									<h3 className="section-label">总体要点</h3>
									<ul className="kp-list">
										{result.keyPoints.map((kp, i) => (
											<li key={i} className={`kp${kp.anchored === false ? " unanchored" : ""}`}>
												<div className="kp-point">{kp.point}</div>
												<div className="kp-quote">
													「{kp.quote}」
													{typeof kp.start === "number" && (
														<>
															{" · "}
															<Pos start={kp.start}>{fmtPos(kp.start)}</Pos>
														</>
													)}
													{kp.anchored === false && " · 未能在原文中定位"}
												</div>
												<NoteSpot target={`kp:${i}`} />
											</li>
										))}
									</ul>
								</div>

								<div className="rise">
									<h3 className="section-label">
										分段地图
										{lowAmount > 0 && <span className="note">{lowLabel}</span>}
									</h3>
									<ol className="map">
										{result.chapters.map((ch, i) => (
											<li key={i} className={ch.value === "low" ? "low" : ""}>
												<span className="tc">
													<Pos start={ch.start}>
														{fmtPos(ch.start)}–{fmtPos(ch.end)}
													</Pos>
												</span>
												<span className="gist">
													{ch.gist}
													{ch.tracked && <span className="tracked-chip">与你的追踪相关 · {ch.tracked}</span>}
													<NoteSpot target={`ch:${i}`} />
												</span>
											</li>
										))}
									</ol>
								</div>

								<p className="meta-line rise">
									提取路径:{PATH_LABEL[result.meta.path] ?? result.meta.path}
									{result.meta.truncated && " · 内容过长已截断处理"}
									{loaded?.url && !isText && (
										<>
											{" · "}
											<a href={loaded.url} target="_blank" rel="noreferrer">
												打开原片 →
											</a>
										</>
									)}
								</p>

								{canNote && (
									<div className="rise">
										<h3 className="section-label">我的想法</h3>
										<NoteSpot target="general" always />
									</div>
								)}

								{canJumpText && (
									<div className="rise">
										<button type="button" className="source-toggle" onClick={() => setShowSource(!showSource)}>
											{showSource ? "收起原文" : "展开原文(点要点或分段的段号可直接定位)"}
										</button>
										{showSource && (
											<div className="source">
												{loaded!.paragraphs!.map((p, i) => (
													<p key={i} id={`para-${i + 1}`}>
														<span className="pn">§{i + 1}</span>
														{p}
													</p>
												))}
											</div>
										)}
									</div>
								)}
							</section>
						)}
					</>
				)}

				<footer className="site-footer">
					An island of <a href="https://nanisle.com">nanisle.com</a> · open source ·{" "}
					<a href="https://github.com/AI-Nanisle/nanisle-product">fork me</a>
				</footer>
			</main>
		</div>
	);
}
