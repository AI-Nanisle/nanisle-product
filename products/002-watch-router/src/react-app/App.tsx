import { useEffect, useState } from "react";
import type { WatchResult } from "../shared/schema";

// M1 收单壳(docs/03 F1 的雏形):URL / 粘贴正文 → /api/submit → 渲染结果。
// 当前后端返回 mock 示例;F2(流式)、F3(完整结果页)、F6(进度页)随
// W 线推进再替换这里。

interface Health {
	ok: boolean;
	provider: string;
	store: string;
	email: string | null;
	loginUrl: string;
	ssoConfigured: boolean;
}

interface SubmitResponse {
	cached?: boolean;
	lane?: string;
	result?: WatchResult;
	taskId?: string;
	error?: string;
	loginUrl?: string;
}

interface TaskResponse {
	status: "pending" | "running" | "done" | "failed";
	step?: string;
	path?: string;
	result?: WatchResult;
	error?: string;
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

export default function App() {
	const [health, setHealth] = useState<Health | null>(null);
	const [input, setInput] = useState("");
	const [result, setResult] = useState<WatchResult | null>(null);
	const [error, setError] = useState("");
	const [login, setLogin] = useState("");
	const [busy, setBusy] = useState(false);
	const [step, setStep] = useState<string | null>(null);

	useEffect(() => {
		// ?url= 预填:001 简报「深读 →」入口的承接端(docs/02 T7①)
		const preset = new URLSearchParams(window.location.search).get("url");
		if (preset) setInput(preset);
		fetch("api/health")
			.then((r) => r.json() as Promise<Health>)
			.then(setHealth)
			.catch(() => setHealth(null));
	}, []);

	/** 慢车道:轮询任务直到 done/failed(F6 的雏形;2.5s 一拍,超时由服务端判)。 */
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
				setResult(data.result);
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
		setResult(null);
		setStep(null);
		try {
			const trimmed = input.trim();
			const isUrl = /^https?:\/\//i.test(trimmed);
			const res = await fetch("api/submit", {
				method: "POST",
				headers: { "content-type": "application/json" },
				body: JSON.stringify(isUrl ? { url: trimmed } : { text: trimmed }),
			});
			const data = (await res.json()) as SubmitResponse;
			if (!res.ok) {
				setError(data.error ?? `请求失败(${res.status})`);
				if (res.status === 401 && data.loginUrl) setLogin(data.loginUrl);
			} else if (data.result) {
				setResult(data.result);
			} else if (data.taskId) {
				setStep("queued");
				await pollTask(data.taskId);
			}
		} catch {
			setError("网络错误,稍后再试。");
		} finally {
			setBusy(false);
			setStep(null);
		}
	}

	// 文章/粘贴的 start/end 是段号,视频/播客才是秒(shared/schema.ts)
	const isText = result?.meta.path === "article" || result?.meta.path === "paste";
	const fmtPos = (n: number) => (isText ? `§${n}` : fmtTime(n));
	const lowAmount = result
		? result.chapters.filter((ch) => ch.value === "low").reduce((s, ch) => s + (ch.end - ch.start), 0)
		: 0;
	const lowLabel = isText ? `低价值段共 ${lowAmount} 段` : `低价值段共 ${Math.round(lowAmount / 60)} 分钟`;

	return (
		<div className="min-h-screen bg-zinc-50 text-zinc-900">
			<main className="mx-auto max-w-2xl px-6 py-14">
				<h1 className="text-2xl font-semibold tracking-tight">观影路由</h1>
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
									<li key={i} className={"rounded-lg border bg-white p-3 text-sm " + (kp.anchored === false ? "border-zinc-200 opacity-60" : "border-zinc-200")}>
										{kp.point}
										<div className="mt-1 text-xs text-zinc-400">
											「{kp.quote}」{typeof kp.start === "number" && ` · ${fmtPos(kp.start)}`}
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
											{fmtPos(ch.start)}–{fmtPos(ch.end)}
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
							提取路径:{result.meta.path === "subtitle" ? "官方字幕" : result.meta.path === "whisper" ? "whisper 转写(时间戳与文字精度低一档)" : result.meta.path === "paste" ? "手动粘贴" : "文章抽取"}
							{result.meta.truncated && " · 内容过长已截断处理"}
						</p>
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
