import { useEffect, useState } from "react";
import type { ReactNode } from "react";
import type { WatchResult } from "../shared/schema";

// 收单 + 结果页(docs/03 F 线):
//   F1 收单(?url= 预填承接 001 深读入口) F2 快车道 SSE 边生成边给进度
//   F3 判决/要点/分段地图/灰段统计/路径徽章 F4 跳转(视频秒数 URL/文章段落锚点)
//   F5 低置信灰显 F6 慢车道五步进度轮询 F7 页眉额度读数

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
const STEP_LABELS: Record<string, string> = {
	queued: "排队中",
	downloading: "下载中",
	transcribing: "转写中",
	editing: "编辑中",
	done: "完成",
};

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
		fetch("api/usage")
			.then((r) => (r.ok ? (r.json() as Promise<Usage>) : null))
			.then((u) => u && setUsage(u))
			.catch(() => {});
	}

	useEffect(() => {
		// ?url= 预填:001 简报「深读 →」入口的承接端(docs/02 T7①)
		const preset = new URLSearchParams(window.location.search).get("url");
		if (preset) setInput(preset);
		fetch("api/health")
			.then((r) => r.json() as Promise<Health>)
			.then(setHealth)
			.catch(() => setHealth(null));
		refreshUsage();
	}, []);

	/** F4 · 文章段落锚点:展开原文区后滚动到对应段并短暂高亮。 */
	function jumpToPara(n: number) {
		setShowSource(true);
		setTimeout(() => {
			const el = document.getElementById(`para-${n}`);
			if (!el) return;
			el.scrollIntoView({ behavior: "smooth", block: "center" });
			el.classList.add("bg-amber-100");
			setTimeout(() => el.classList.remove("bg-amber-100"), 1600);
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
					setFastStatus(ev.phase === "extracting" ? "抽取正文中…" : "编辑中(整篇一次调用,长文要一两分钟)…");
				} else if (ev.type === "delta" && typeof ev.chars === "number") {
					setFastStatus(`编辑中…已生成 ${ev.chars} 字`);
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
			const res = await fetch(`api/task/${taskId}`);
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
			const res = await fetch("api/submit", {
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

	/** 位置标签:能跳就渲染成链接/按钮,不能跳只显示。 */
	function Pos({ start, children }: { start: number; children: ReactNode }) {
		if (canJumpText) {
			return (
				<button className="cursor-pointer underline decoration-dotted" onClick={() => jumpToPara(start)}>
					{children}
				</button>
			);
		}
		const href = jumpHref(loaded?.url, start);
		if (href && !isText) {
			return (
				<a className="underline decoration-dotted" href={href} target="_blank" rel="noreferrer">
					{children}
				</a>
			);
		}
		return <>{children}</>;
	}

	return (
		<div className="min-h-screen bg-zinc-50 text-zinc-900">
			<main className="mx-auto max-w-2xl px-6 py-14">
				<div className="flex items-baseline justify-between">
					<h1 className="text-2xl font-semibold tracking-tight">长视频总结</h1>
					{usage && (
						<span className="text-xs text-zinc-400">
							今日额度 {usage.used}/{usage.limit}
						</span>
					)}
				</div>
				<p className="mt-2 text-sm text-zinc-500">
					丢给我一条视频、播客或文章链接:值不值得看、讲了什么、每一段在哪——AI 先替你看完。
					{health && health.provider === "mock" && <span className="ml-1 font-mono text-amber-600">[mock 模式]</span>}
				</p>

				<div className="mt-8 space-y-3">
					<textarea
						className="h-28 w-full resize-y rounded-lg border border-zinc-300 bg-white p-3 text-sm outline-none focus:border-zinc-500"
						placeholder="粘贴链接(B站 / YouTube / 播客 / 文章),或直接把正文贴进来…"
						value={input}
						onChange={(e) => setInput(e.target.value)}
					/>
					<button
						className="rounded-lg bg-zinc-900 px-4 py-2 text-sm font-medium text-white disabled:opacity-40"
						disabled={busy || input.trim().length === 0}
						onClick={submit}
					>
						{busy ? "看着呢…" : "替我看"}
					</button>
					{fastStatus && <div className="text-sm text-zinc-500">{fastStatus}</div>}
					{step && (
						<div className="flex items-center gap-2 text-sm text-zinc-500">
							{["queued", "downloading", "transcribing", "editing", "done"].map((s, i) => (
								<span key={s} className={s === step ? "font-medium text-zinc-900" : "opacity-50"}>
									{i > 0 && <span className="mr-2 opacity-40">→</span>}
									{STEP_LABELS[s]}
								</span>
							))}
						</div>
					)}
				</div>

				{error && (
					<p className="mt-6 rounded-lg border border-red-200 bg-red-50 p-3 text-sm text-red-700">
						{error}
						{login && (
							<a className="ml-2 underline" href={login}>
								去登录 →
							</a>
						)}
					</p>
				)}

				{result && (
					<section className="mt-8 space-y-6">
						{result.meta.title && <h2 className="text-lg font-medium">{result.meta.title}</h2>}
						<div className="rounded-lg border border-zinc-200 bg-white p-4">
							<span
								className={
									"mr-2 rounded px-2 py-0.5 text-xs font-medium " +
									(result.verdict.worth === "yes"
										? "bg-green-100 text-green-800"
										: result.verdict.worth === "no"
											? "bg-red-100 text-red-700"
											: "bg-amber-100 text-amber-800")
								}
							>
								{result.verdict.worth === "yes" ? "值得看" : result.verdict.worth === "no" ? "可以跳过" : "部分值得"}
							</span>
							<span className="text-sm">{result.verdict.reason}</span>
						</div>

						<div>
							<h2 className="text-sm font-semibold text-zinc-700">总体要点</h2>
							<ul className="mt-2 space-y-2">
								{result.keyPoints.map((kp, i) => (
									<li
										key={i}
										className={
											"rounded-lg border bg-white p-3 text-sm " +
											(kp.anchored === false ? "border-zinc-200 opacity-60" : "border-zinc-200")
										}
									>
										{kp.point}
										<div className="mt-1 text-xs text-zinc-400">
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

						<div>
							<h2 className="text-sm font-semibold text-zinc-700">
								分段地图
								{lowAmount > 0 && <span className="ml-2 font-normal text-zinc-400">{lowLabel}</span>}
							</h2>
							<ol className="mt-2 space-y-1">
								{result.chapters.map((ch, i) => (
									<li
										key={i}
										className={
											"rounded-lg border p-3 text-sm " +
											(ch.value === "low" ? "border-zinc-100 bg-zinc-50 text-zinc-400" : "border-zinc-200 bg-white")
										}
									>
										<span className="mr-2 font-mono text-xs text-zinc-400">
											<Pos start={ch.start}>
												{fmtPos(ch.start)}–{fmtPos(ch.end)}
											</Pos>
										</span>
										{ch.gist}
										{ch.tracked && (
											<span className="ml-2 rounded bg-blue-100 px-1.5 py-0.5 text-xs text-blue-800">与你手头的事相关</span>
										)}
									</li>
								))}
							</ol>
						</div>

						<p className="text-xs text-zinc-400">
							提取路径:
							{result.meta.path === "subtitle"
								? "官方字幕"
								: result.meta.path === "whisper"
									? "whisper 转写(时间戳与文字精度低一档)"
									: result.meta.path === "paste"
										? "手动粘贴"
										: "文章抽取"}
							{result.meta.truncated && " · 内容过长已截断处理"}
							{loaded?.url && !isText && (
								<>
									{" · "}
									<a className="underline" href={loaded.url} target="_blank" rel="noreferrer">
										打开原片 →
									</a>
								</>
							)}
						</p>

						{canJumpText && (
							<div>
								<button
									className="text-sm text-zinc-500 underline decoration-dotted"
									onClick={() => setShowSource(!showSource)}
								>
									{showSource ? "收起原文" : "展开原文(点要点/分段可直接定位)"}
								</button>
								{showSource && (
									<div className="mt-3 max-h-96 space-y-3 overflow-y-auto rounded-lg border border-zinc-200 bg-white p-4 text-sm leading-relaxed">
										{loaded!.paragraphs!.map((p, i) => (
											<p key={i} id={`para-${i + 1}`} className="transition-colors duration-500">
												<span className="mr-2 font-mono text-xs text-zinc-300">§{i + 1}</span>
												{p}
											</p>
										))}
									</div>
								)}
							</div>
						)}
					</section>
				)}

				<footer className="mt-16 text-xs text-zinc-400">
					An island of{" "}
					<a className="underline" href="https://nanisle.com">
						nanisle.com
					</a>{" "}
					· open source ·{" "}
					<a className="underline" href="https://github.com/AI-Nanisle/nanisle-product">
						fork me
					</a>
				</footer>
			</main>
		</div>
	);
}
