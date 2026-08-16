import { useCallback, useEffect, useRef, useState } from "react";
import type { FocusEntry, SourceCategory, SourceConfig } from "../shared/pipeline-core";
import Chat from "./Chat";
import { apiPath } from "./paths";

// 配置工作台:左边和 AI 对话,右边是配置的实时状态。
// 对话产生的每次变更服务端已落库,这里只负责把面板即时刷新;
// 面板上的轻操作(开关/删除/改字段)则即改即存,不再有「保存全部」按钮。

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
	url?: string;
	total?: number;
	fresh?: number;
	latest?: { title: string; publishedAt: string | null }[];
	resolvedFrom?: string;
	error?: string;
}

type SyncState = "idle" | "saving" | "saved" | "error";

function headers(): Record<string, string> {
	const code = localStorage.getItem("daily-brief-access-code") ?? "";
	return { "content-type": "application/json", ...(code ? { "x-access-code": code } : {}) };
}

const inputCls =
	"rounded-md border border-[var(--line)] bg-[var(--card)] px-2.5 py-1.5 text-[13px] outline-none focus:border-[var(--line-strong)] min-w-0";

export default function Config() {
	const [sources, setSources] = useState<SourceConfig[] | null>(null);
	const [focus, setFocus] = useState<FocusEntry[]>([]);
	const [provider, setProvider] = useState<string | null>(null);
	const [sync, setSync] = useState<SyncState>("idle");
	const [syncMsg, setSyncMsg] = useState("");
	const [tests, setTests] = useState<Record<string, TestResult | "testing">>({});
	const [adding, setAdding] = useState(false);
	const [addDraft, setAddDraft] = useState({ name: "", url: "", category: "blog" as SourceCategory });
	const [addBusy, setAddBusy] = useState(false);
	const [addMsg, setAddMsg] = useState("");
	const savedTimer = useRef<ReturnType<typeof setTimeout> | null>(null);

	useEffect(() => {
		void (async () => {
			const [sres, fres, hres] = await Promise.all([
				fetch(apiPath("sources"), { headers: headers() }),
				fetch(apiPath("focus"), { headers: headers() }),
				fetch(apiPath("health")),
			]);
			if (sres.ok) setSources(((await sres.json()) as { sources: SourceConfig[] }).sources);
			if (fres.ok) setFocus(((await fres.json()) as { focus: FocusEntry[] }).focus);
			if (hres.ok) setProvider(((await hres.json()) as { provider: string }).provider);
		})();
	}, []);

	const markSynced = useCallback((ok: boolean, msg = "") => {
		setSync(ok ? "saved" : "error");
		setSyncMsg(msg);
		if (savedTimer.current) clearTimeout(savedTimer.current);
		if (ok) savedTimer.current = setTimeout(() => setSync("idle"), 2000);
	}, []);

	// 面板操作即改即存。失败时界面保留改动并明确报错,而不是悄悄回滚。
	const putSources = useCallback(
		async (next: SourceConfig[]) => {
			setSources(next);
			setSync("saving");
			try {
				const res = await fetch(apiPath("sources"), {
					method: "PUT",
					headers: headers(),
					body: JSON.stringify({ sources: next }),
				});
				markSynced(res.ok, res.ok ? "" : (((await res.json()) as { error?: string }).error ?? `HTTP ${res.status}`));
			} catch {
				markSynced(false, "网络错误");
			}
		},
		[markSynced],
	);

	const putFocus = useCallback(
		async (next: FocusEntry[]) => {
			setFocus(next);
			setSync("saving");
			try {
				const res = await fetch(apiPath("focus"), {
					method: "PUT",
					headers: headers(),
					body: JSON.stringify({ focus: next.filter((f) => f.name.trim()) }),
				});
				markSynced(res.ok, res.ok ? "" : (((await res.json()) as { error?: string }).error ?? `HTTP ${res.status}`));
			} catch {
				markSynced(false, "网络错误");
			}
		},
		[markSynced],
	);

	// 聊天卡片「添加」与面板手动添加共用:服务端会先试抓验证
	const addSources = useCallback(
		async (items: { name: string; url: string; category: string }[]) => {
			const res = await fetch(apiPath("sources/add"), {
				method: "POST",
				headers: headers(),
				body: JSON.stringify({ sources: items }),
			});
			if (!res.ok) {
				const data = (await res.json().catch(() => ({}))) as { error?: string };
				throw new Error(data.error ?? `HTTP ${res.status}`);
			}
			const data = (await res.json()) as {
				added: SourceConfig[];
				failed: { name: string; url: string; error: string }[];
				sources: SourceConfig[];
			};
			setSources(data.sources);
			return { addedUrls: data.added.map((a) => a.url), failed: data.failed };
		},
		[],
	);

	if (!sources) {
		return <p className="font-mono-sc animate-pulse py-12 text-center text-sm text-[var(--ink-3)]">读取配置…</p>;
	}

	const enabledCount = sources.filter((s) => s.enabled !== false).length;

	const testSource = async (url: string) => {
		setTests((t) => ({ ...t, [url]: "testing" }));
		try {
			const res = await fetch(apiPath("sources/test"), {
				method: "POST",
				headers: headers(),
				body: JSON.stringify({ url }),
			});
			setTests((t) => ({
				...t,
				[url]: res.ok ? "testing" : { ok: false, error: `HTTP ${res.status}` },
			}));
			if (res.ok) {
				const data = (await res.json()) as TestResult;
				setTests((t) => ({ ...t, [url]: data }));
			}
		} catch {
			setTests((t) => ({ ...t, [url]: { ok: false, error: "网络错误" } }));
		}
	};

	const manualAdd = async () => {
		if (!addDraft.name.trim() || !addDraft.url.trim() || addBusy) return;
		setAddBusy(true);
		setAddMsg("");
		try {
			const { addedUrls, failed } = await addSources([addDraft]);
			if (addedUrls.length > 0) {
				setAddDraft({ name: "", url: "", category: addDraft.category });
				setAdding(false);
			} else {
				setAddMsg(failed[0]?.error ?? "添加失败");
			}
		} catch (err) {
			setAddMsg(err instanceof Error ? err.message : "添加失败");
		} finally {
			setAddBusy(false);
		}
	};

	return (
		<div className="grid gap-5 pb-8 pt-2 lg:grid-cols-[minmax(0,1.1fr)_minmax(0,1fr)]">
			{/* 左:对话 */}
			<Chat headers={headers} provider={provider} onConfig={(s, f) => { setSources(s); setFocus(f); }} addSources={addSources} />

			{/* 右:配置实时面板 */}
			<div className="space-y-5">
				{/* 信息源 */}
				<section className="rounded-[10px] bg-[var(--card)] border border-[var(--line)]">
					<div className="flex items-center gap-2.5 border-b border-[var(--line)] px-4 py-2.5">
						<span className="text-[14px] font-bold tracking-wide">信息源</span>
						<span className="font-mono-sc text-[11px] uppercase tracking-wider text-[var(--ink-3)]">
							src {sources.length} · on {enabledCount}
						</span>
						<span className="font-mono-sc ml-auto text-[11px] text-[var(--ink-3)]">
							{sync === "saving" && "同步中…"}
							{sync === "saved" && <span className="text-[var(--ok)]">✓ 已同步</span>}
							{sync === "error" && <span className="text-[var(--accent)]">✗ {syncMsg || "同步失败"}</span>}
						</span>
					</div>
					<div className="px-4">
						{sources.map((s, i) => {
							const t = tests[s.url];
							return (
								<div key={s.key || i} className={`border-b border-[var(--line)] py-2 last:border-0 ${s.enabled === false ? "opacity-50" : ""}`}>
									<div className="flex items-center gap-2">
										<button
											type="button"
											onClick={() => void putSources(sources.map((x, j) => (j === i ? { ...x, enabled: x.enabled === false ? undefined : false } : x)))}
											title={s.enabled === false ? "已停用,点击启用" : "已启用,点击停用"}
											className="cursor-pointer p-0.5"
										>
											<span className={`dot ${s.enabled === false ? "dot-off" : "dot-on"}`} />
										</button>
										<input
											value={s.name}
											onChange={(e) => setSources(sources.map((x, j) => (j === i ? { ...x, name: e.target.value } : x)))}
											onBlur={() => void putSources(sources)}
											className="w-40 min-w-0 flex-1 bg-transparent text-[14px] font-medium outline-none"
										/>
										<select
											value={s.category}
											onChange={(e) => void putSources(sources.map((x, j) => (j === i ? { ...x, category: e.target.value as SourceCategory } : x)))}
											className="font-mono-sc cursor-pointer border-0 bg-transparent text-[11px] text-[var(--ink-3)] outline-none"
										>
											{CATEGORIES.map((cat) => (
												<option key={cat} value={cat}>
													{CATEGORY_LABELS[cat]}
												</option>
											))}
										</select>
										<button
											type="button"
											onClick={() => void testSource(s.url)}
											className="font-mono-sc shrink-0 cursor-pointer text-[11px] text-[var(--ink-3)] hover:text-[var(--ink)]"
										>
											{t === "testing" ? "抓取中…" : "试抓"}
										</button>
										<button
											type="button"
											onClick={() => void putSources(sources.filter((_, j) => j !== i))}
											className="font-mono-sc shrink-0 cursor-pointer text-[11px] text-[var(--ink-3)] hover:text-[var(--accent)]"
										>
											删除
										</button>
									</div>
									<p className="font-mono-sc mt-0.5 truncate pl-4 text-[11px] text-[var(--ink-3)] opacity-80">{s.url}</p>
									{t && t !== "testing" && (
										<div className="mt-1.5 border-l-2 border-[var(--line)] pl-3 text-[12px]">
											{t.ok ? (
												<>
													<span className="font-mono-sc text-[11px] text-[var(--ok)]">
														✓ {t.total} 条 · 30h 内 {t.fresh} 条
													</span>
													<ul className="mt-0.5 space-y-0.5 text-[var(--ink-2)]">
														{t.latest?.slice(0, 3).map((e, k) => (
															<li key={k} className="truncate">
																<span className="font-mono-sc mr-2 text-[10px] text-[var(--ink-3)]">
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
					{/* 手动添加:自动做 feed 发现与试抓验证 */}
					<div className="border-t border-[var(--line)] px-4 py-2.5">
						{adding ? (
							<div className="space-y-2">
								<div className="flex flex-wrap gap-2">
									<input
										value={addDraft.name}
										onChange={(e) => setAddDraft({ ...addDraft, name: e.target.value })}
										placeholder="源名称"
										className={`${inputCls} w-36`}
									/>
									<select
										value={addDraft.category}
										onChange={(e) => setAddDraft({ ...addDraft, category: e.target.value as SourceCategory })}
										className={`${inputCls} cursor-pointer`}
									>
										{CATEGORIES.map((cat) => (
											<option key={cat} value={cat}>
												{CATEGORY_LABELS[cat]}
											</option>
										))}
									</select>
									<input
										value={addDraft.url}
										onChange={(e) => setAddDraft({ ...addDraft, url: e.target.value })}
										onKeyDown={(e) => e.key === "Enter" && void manualAdd()}
										placeholder="feed 或网站地址(会自动发现 feed)"
										className={`${inputCls} font-mono-sc min-w-52 flex-1 text-[12px]`}
									/>
									<button
										type="button"
										onClick={() => void manualAdd()}
										disabled={addBusy}
										className="font-mono-sc cursor-pointer rounded-md border border-[var(--line-strong)] px-3 py-1.5 text-[12px] transition-colors hover:bg-[var(--ink)] hover:text-[var(--paper)] disabled:opacity-50"
									>
										{addBusy ? "验证中…" : "验证并添加"}
									</button>
									<button
										type="button"
										onClick={() => { setAdding(false); setAddMsg(""); }}
										className="font-mono-sc cursor-pointer px-1 text-[11px] text-[var(--ink-3)] hover:text-[var(--ink)]"
									>
										取消
									</button>
								</div>
								{addMsg && <p className="font-mono-sc text-[11px] text-[var(--accent)]">✗ {addMsg}</p>}
							</div>
						) : (
							<button
								type="button"
								onClick={() => setAdding(true)}
								className="font-mono-sc w-full cursor-pointer rounded-md border border-dashed border-[var(--line-strong)] px-3 py-2 text-[12px] text-[var(--ink-2)] transition-colors hover:border-[var(--accent)] hover:text-[var(--accent)]"
							>
								+ 手动添加(或直接在左边说一声)
							</button>
						)}
					</div>
				</section>

				{/* 当前关注 */}
				<section className="rounded-[10px] bg-[var(--card)] border border-[var(--line)]">
					<div className="flex items-center gap-2.5 border-b border-[var(--line)] px-4 py-2.5">
						<span className="text-[14px] font-bold tracking-wide">当前关注</span>
						<span className="font-mono-sc text-[11px] uppercase tracking-wider text-[var(--ink-3)]">
							focus {focus.filter((f) => f.name.trim()).length}
						</span>
					</div>
					<p className="px-4 pt-2 text-[13px] leading-relaxed text-[var(--ink-2)]">
						「项目弹药」分区只收和这里直接相关的内容。写具体点,或直接告诉左边的 AI 你最近在做什么。
					</p>
					<div className="space-y-2 px-4 py-3">
						{focus.map((f, i) => (
							<div key={i} className="flex flex-wrap gap-2">
								<input
									value={f.name}
									onChange={(e) => setFocus(focus.map((x, j) => (j === i ? { ...x, name: e.target.value } : x)))}
									onBlur={() => void putFocus(focus)}
									placeholder="关注点(如:本周产品)"
									className={`${inputCls} w-36 font-medium`}
								/>
								<input
									value={f.detail ?? ""}
									onChange={(e) => setFocus(focus.map((x, j) => (j === i ? { ...x, detail: e.target.value } : x)))}
									onBlur={() => void putFocus(focus)}
									placeholder="具体在做什么、关心什么(给编辑看的)"
									className={`${inputCls} min-w-48 flex-1`}
								/>
								<button
									type="button"
									onClick={() => void putFocus(focus.filter((_, j) => j !== i))}
									className="font-mono-sc cursor-pointer px-1 text-[11px] text-[var(--ink-3)] hover:text-[var(--accent)]"
								>
									删除
								</button>
							</div>
						))}
						<button
							type="button"
							onClick={() => setFocus([...focus, { name: "", detail: "" }])}
							className="font-mono-sc w-full cursor-pointer rounded-md border border-dashed border-[var(--line-strong)] px-3 py-2 text-[12px] text-[var(--ink-2)] transition-colors hover:border-[var(--accent)] hover:text-[var(--accent)]"
						>
							+ 添加关注点
						</button>
					</div>
				</section>
			</div>
		</div>
	);
}
