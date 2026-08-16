import { useEffect, useState } from "react";
import type { FocusEntry, SourceCategory, SourceConfig } from "../shared/pipeline-core";

const CATEGORY_LABELS: Record<SourceCategory, string> = {
	news: "新闻",
	macro: "宏观",
	blog: "博客",
	podcast: "播客",
	paper: "论文",
};
const CATEGORIES = Object.keys(CATEGORY_LABELS) as SourceCategory[];

interface TestResult {
	ok: boolean;
	total?: number;
	fresh?: number;
	latest?: { title: string; publishedAt: string | null }[];
	error?: string;
}

function headers(): Record<string, string> {
	const code = localStorage.getItem("daily-brief-access-code") ?? "";
	return { "content-type": "application/json", ...(code ? { "x-access-code": code } : {}) };
}

const inputCls =
	"border border-[var(--line)] bg-[var(--card)] px-2 py-1.5 text-[13px] outline-none focus:border-[var(--line-strong)] min-w-0";

export default function Config() {
	const [sources, setSources] = useState<SourceConfig[] | null>(null);
	const [focus, setFocus] = useState<FocusEntry[]>([]);
	const [tests, setTests] = useState<Record<string, TestResult | "testing">>({});
	const [saveState, setSaveState] = useState<"idle" | "saving" | "saved" | "error">("idle");
	const [errorMsg, setErrorMsg] = useState("");

	useEffect(() => {
		void (async () => {
			const [sres, fres] = await Promise.all([
				fetch("/api/sources", { headers: headers() }),
				fetch("/api/focus", { headers: headers() }),
			]);
			if (sres.ok) setSources(((await sres.json()) as { sources: SourceConfig[] }).sources);
			if (fres.ok) setFocus(((await fres.json()) as { focus: FocusEntry[] }).focus);
		})();
	}, []);

	if (!sources) {
		return <p className="font-mono-sc text-sm text-[var(--ink-3)] py-12 text-center animate-pulse">读取配置…</p>;
	}

	const update = (i: number, patch: Partial<SourceConfig>) => {
		setSources(sources.map((s, j) => (j === i ? { ...s, ...patch } : s)));
		setSaveState("idle");
	};

	const testSource = async (i: number) => {
		const url = sources[i].url;
		setTests((t) => ({ ...t, [url]: "testing" }));
		try {
			const res = await fetch("/api/sources/test", {
				method: "POST",
				headers: headers(),
				body: JSON.stringify({ url }),
			});
			setTests((t) => ({ ...t, [url]: (res.ok ? res.json() : { ok: false, error: `HTTP ${res.status}` }) as never }));
			if (res.ok) {
				const data = (await res.json()) as TestResult;
				setTests((t) => ({ ...t, [url]: data }));
			}
		} catch {
			setTests((t) => ({ ...t, [url]: { ok: false, error: "网络错误" } }));
		}
	};

	const saveAll = async () => {
		setSaveState("saving");
		setErrorMsg("");
		try {
			const s1 = await fetch("/api/sources", {
				method: "PUT",
				headers: headers(),
				body: JSON.stringify({ sources }),
			});
			if (!s1.ok) {
				setErrorMsg(((await s1.json()) as { error?: string }).error ?? `HTTP ${s1.status}`);
				setSaveState("error");
				return;
			}
			const s2 = await fetch("/api/focus", {
				method: "PUT",
				headers: headers(),
				body: JSON.stringify({ focus: focus.filter((f) => f.name.trim()) }),
			});
			if (!s2.ok) {
				setErrorMsg(((await s2.json()) as { error?: string }).error ?? `HTTP ${s2.status}`);
				setSaveState("error");
				return;
			}
			setSaveState("saved");
			setTimeout(() => setSaveState("idle"), 2000);
		} catch {
			setErrorMsg("网络错误");
			setSaveState("error");
		}
	};

	return (
		<div className="pb-8">
			{/* 信息源 */}
			<div className="flex items-baseline gap-3 border-t border-[var(--line-strong)] pt-3 mt-2">
				<span className="font-mono-sc text-[11px] text-[var(--accent)]">A</span>
				<h2 className="font-serif-sc font-bold text-lg tracking-widest">信息源</h2>
				<span className="font-mono-sc text-[11px] text-[var(--ink-3)]">
					{sources.filter((s) => s.enabled !== false).length} 启用 / {sources.length} 总数
				</span>
			</div>
			<p className="mt-2 text-[13px] text-[var(--ink-2)]">
				任何 RSS / Atom 地址都能加。「试抓」会真的抓一次,预览这个源最近在发什么——先看再收,别囤源。
			</p>

			<div className="mt-4 space-y-3">
				{sources.map((s, i) => {
					const t = tests[s.url];
					return (
						<div key={i} className={`border border-[var(--line)] bg-[var(--card)] p-3 ${s.enabled === false ? "opacity-55" : ""}`}>
							<div className="flex flex-wrap items-center gap-2">
								<button
									type="button"
									onClick={() => update(i, { enabled: s.enabled === false ? undefined : false })}
									title={s.enabled === false ? "已停用,点击启用" : "已启用,点击停用"}
									className={`shrink-0 w-8 h-4.5 rounded-full relative transition-colors cursor-pointer ${s.enabled === false ? "bg-[var(--line)]" : "bg-[var(--accent)]"}`}
								>
									<span
										className={`absolute top-0.5 w-3.5 h-3.5 rounded-full bg-white transition-all ${s.enabled === false ? "left-0.5" : "left-4"}`}
									/>
								</button>
								<input
									value={s.name}
									onChange={(e) => update(i, { name: e.target.value })}
									placeholder="源名称"
									className={`${inputCls} w-52 font-medium`}
								/>
								<select
									value={s.category}
									onChange={(e) => update(i, { category: e.target.value as SourceCategory })}
									className={`${inputCls} cursor-pointer`}
								>
									{CATEGORIES.map((cat) => (
										<option key={cat} value={cat}>
											{CATEGORY_LABELS[cat]}
										</option>
									))}
								</select>
								<input
									value={s.url}
									onChange={(e) => update(i, { url: e.target.value })}
									placeholder="https://…/feed.xml"
									className={`${inputCls} flex-1 min-w-64 font-mono-sc text-[12px]`}
								/>
								<button
									type="button"
									onClick={() => void testSource(i)}
									className="font-mono-sc text-[11px] px-2.5 py-1.5 border border-[var(--line-strong)] hover:bg-[var(--ink)] hover:text-[var(--paper)] transition-colors cursor-pointer shrink-0"
								>
									{t === "testing" ? "抓取中…" : "试抓"}
								</button>
								<button
									type="button"
									onClick={() => {
										setSources(sources.filter((_, j) => j !== i));
										setSaveState("idle");
									}}
									className="font-mono-sc text-[11px] px-2 py-1.5 text-[var(--ink-3)] hover:text-[var(--accent)] cursor-pointer shrink-0"
								>
									删除
								</button>
							</div>
							{t && t !== "testing" && (
								<div className="mt-2 border-t border-dashed border-[var(--line)] pt-2 text-[12px]">
									{t.ok ? (
										<>
											<span className="font-mono-sc text-[11px] text-[var(--accent)]">
												✓ {t.total} 条 · 最近 30 小时 {t.fresh} 条
											</span>
											<ul className="mt-1 space-y-0.5 text-[var(--ink-2)]">
												{t.latest?.map((e, k) => (
													<li key={k} className="truncate">
														<span className="font-mono-sc text-[10px] text-[var(--ink-3)] mr-2">
															{e.publishedAt ? e.publishedAt.slice(0, 10) : "----"}
														</span>
														{e.title}
													</li>
												))}
											</ul>
										</>
									) : (
										<span className="font-mono-sc text-[11px] text-[var(--accent)]">✗ 抓取失败:{t.error}</span>
									)}
								</div>
							)}
						</div>
					);
				})}
			</div>
			<button
				type="button"
				onClick={() => {
					setSources([...sources, { key: "", name: "", url: "", category: "blog" }]);
					setSaveState("idle");
				}}
				className="mt-3 font-mono-sc text-[12px] px-3 py-2 border border-dashed border-[var(--line-strong)] text-[var(--ink-2)] hover:border-[var(--accent)] hover:text-[var(--accent)] transition-colors cursor-pointer w-full"
			>
				+ 添加信息源
			</button>

			{/* 关注点 */}
			<div className="flex items-baseline gap-3 border-t border-[var(--line-strong)] pt-3 mt-10">
				<span className="font-mono-sc text-[11px] text-[var(--accent)]">B</span>
				<h2 className="font-serif-sc font-bold text-lg tracking-widest">当前关注</h2>
			</div>
			<p className="mt-2 text-[13px] text-[var(--ink-2)]">
				「项目弹药」分区只收和这里直接相关的内容——写具体点:一个项目、一个待做的决定、一个持仓。改完下次生成立即生效。
			</p>
			<div className="mt-4 space-y-2">
				{focus.map((f, i) => (
					<div key={i} className="flex flex-wrap gap-2">
						<input
							value={f.name}
							onChange={(e) => {
								setFocus(focus.map((x, j) => (j === i ? { ...x, name: e.target.value } : x)));
								setSaveState("idle");
							}}
							placeholder="关注点(如:本周产品)"
							className={`${inputCls} w-52 font-medium`}
						/>
						<input
							value={f.detail ?? ""}
							onChange={(e) => {
								setFocus(focus.map((x, j) => (j === i ? { ...x, detail: e.target.value } : x)));
								setSaveState("idle");
							}}
							placeholder="具体在做什么、关心什么(给编辑看的)"
							className={`${inputCls} flex-1 min-w-64`}
						/>
						<button
							type="button"
							onClick={() => {
								setFocus(focus.filter((_, j) => j !== i));
								setSaveState("idle");
							}}
							className="font-mono-sc text-[11px] px-2 text-[var(--ink-3)] hover:text-[var(--accent)] cursor-pointer"
						>
							删除
						</button>
					</div>
				))}
			</div>
			<button
				type="button"
				onClick={() => {
					setFocus([...focus, { name: "", detail: "" }]);
					setSaveState("idle");
				}}
				className="mt-3 font-mono-sc text-[12px] px-3 py-2 border border-dashed border-[var(--line-strong)] text-[var(--ink-2)] hover:border-[var(--accent)] hover:text-[var(--accent)] transition-colors cursor-pointer w-full"
			>
				+ 添加关注点
			</button>

			{/* 保存 */}
			<div className="mt-8 flex items-center gap-4">
				<button
					type="button"
					onClick={() => void saveAll()}
					disabled={saveState === "saving"}
					className="px-6 py-2.5 bg-[var(--ink)] text-[var(--paper)] text-sm cursor-pointer hover:bg-[var(--accent)] transition-colors disabled:opacity-50"
				>
					{saveState === "saving" ? "保存中…" : saveState === "saved" ? "✓ 已保存" : "保存全部配置"}
				</button>
				{saveState === "error" && <span className="text-[13px] text-[var(--accent)]">{errorMsg}</span>}
			</div>
		</div>
	);
}
