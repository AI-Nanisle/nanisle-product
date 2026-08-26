import { useEffect, useState } from "react";
import type { ReactNode } from "react";
import type { WatchResult } from "../shared/schema";
import { SiteHeader } from "./SiteChrome";
import { apiPath } from "./paths";

// 收单 + 结果页(docs/03 F 线)。视觉与主站 Workspace v2 / 001 同一套语言
// (米白/黑墨/朱红,mono 做读数、serif 做内容),隐喻是「剪辑台」:
// 判决灯、左轨时间码、被灰掉的低价值胶段。逻辑说明见各 F 项注释。

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

interface SubmitResponse {
	cached?: boolean;
	lane?: string;
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
	result?: WatchResult;
	paragraphs?: string[];
	error?: string;
}

/** 快车道 SSE 事件(worker/index.ts 的 send 序列)。 */
interface FastEvent {
	type: "phase" | "delta" | "result" | "error" | "ping";
	phase?: string;
	chars?: number;
	result?: WatchResult;
	paragraphs?: string[];
	url?: string;
	error?: string;
	needPaste?: boolean;
}

/** 慢车道五步进度的展示文案(F6;顺序与 shared/store.ts 的 TaskStep 一致)。 */
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
					setLoaded({ result: ev.result, paragraphs: ev.paragraphs, url: ev.url });
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
				setLoaded({ result: data.result, paragraphs: data.paragraphs, url: data.url });
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
					setLoaded({ result: data.result, paragraphs: data.paragraphs, url: data.url });
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

	const result = loaded?.result ?? null;
	// 文章/粘贴的 start/end 是段号,视频/播客才是秒(shared/schema.ts)
	const isText = result?.meta.path === "article" || result?.meta.path === "paste";
	const fmtPos = (n: number) => (isText ? `§${n}` : fmtTime(n));
	const lowAmount = result
		? result.chapters.filter((ch) => ch.value === "low").reduce((s, ch) => s + (ch.end - ch.start), 0)
		: 0;
	const lowLabel = isText ? `低价值段共 ${lowAmount} 段` : `低价值段共 ${Math.round(lowAmount / 60)} 分钟`;
	const canJumpText = isText && (loaded?.paragraphs?.length ?? 0) > 0;
	const stepIdx = STEPS.findIndex(([k]) => k === step);

	/** 位置读数:能跳就是链接/按钮,不能跳只显示。 */
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
					{usage && (
						<span className="usage-chip">
							今日额度 {usage.used}/{usage.limit}
						</span>
					)}
				</header>
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
										{i > 0 && <span className="sep">→</span>} <span className={key === step || i < stepIdx ? "on" : ""}>{label}</span>
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

				<footer className="site-footer">
					An island of <a href="https://nanisle.com">nanisle.com</a> · open source ·{" "}
					<a href="https://github.com/AI-Nanisle/nanisle-product">fork me</a>
				</footer>
			</main>
		</div>
	);
}
