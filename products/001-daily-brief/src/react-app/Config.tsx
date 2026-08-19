import { useCallback, useEffect, useRef, useState } from "react";
import { MAX_CHANGELOG } from "../shared/pipeline-core";
import type { SourceConfig, Tracker } from "../shared/pipeline-core";
import Dossier from "./Dossier";
import SourceLibrary from "./SourceLibrary";
import Wizard from "./Wizard";
import { refineTracker, wizardSources } from "./editor";
import type { ProposalItem, TestResult } from "./editor";
import { apiPath } from "./paths";

// 配置页 = 一叠追踪定义档案。左栏是目录,右边是当前那份定义的全文。
// 没有「保存全部」:每处改动即改即存,并在这份定义的变更记录里留一行。
// 「编辑」(AI)只在两处出面:新建定义时的三步向导(Wizard.tsx),
// 和档案页里被叫去找候选来源 / 落实「对编辑说一句」时——都是单次结构化调用。

type View = "doc" | "wizard" | "library";
type SyncState = "idle" | "saving" | "saved" | "error";

// 常规请求不再带 x-access-code:userGuard 认会话 cookie,访问码已降级为
// 站长凭证(只在 admin 端点用,前端没有对应界面)。
function headers(): Record<string, string> {
	return { "content-type": "application/json" };
}

/** /api/sources/add 单次最多 8 个源,「全部加入」按这个分批。 */
const ADOPT_BATCH = 8;

/** 展示编号:按定义在目录里的位置,和左栏序号一致。 */
function docId(index: number): string {
	return `TRK-${String(index + 1).padStart(3, "0")}`;
}

function withLog(t: Tracker, text?: string): Tracker {
	if (!text) return t;
	return { ...t, changelog: [{ at: new Date().toISOString(), text }, ...(t.changelog ?? [])].slice(0, MAX_CHANGELOG) };
}

export default function Config() {
	const [sources, setSources] = useState<SourceConfig[] | null>(null);
	const [trackers, setTrackers] = useState<Tracker[]>([]);
	const [selected, setSelected] = useState<string>("");
	const [view, setView] = useState<View>("doc");
	const [provider, setProvider] = useState<string | null>(null);
	const [sync, setSync] = useState<SyncState>("idle");
	const [syncMsg, setSyncMsg] = useState("");
	const [tests, setTests] = useState<Record<string, TestResult | "testing">>({});
	const [editorBusy, setEditorBusy] = useState(false);
	const [editorNote, setEditorNote] = useState("");
	const [candidates, setCandidates] = useState<Record<string, ProposalItem[]>>({});
	const savedTimer = useRef<ReturnType<typeof setTimeout> | null>(null);
	// 编辑调用是异步的,期间列表可能已被服务端改过。改动一律读这个镜像,
	// 免得某次调用之后的圈改把刚写回的定义又存没了。
	const trackersRef = useRef<Tracker[]>([]);

	const applyTrackers = useCallback((next: Tracker[]) => {
		trackersRef.current = next;
		setTrackers(next);
	}, []);

	useEffect(() => {
		void (async () => {
			const [sres, tres, hres] = await Promise.all([
				fetch(apiPath("sources"), { headers: headers() }),
				fetch(apiPath("trackers"), { headers: headers() }),
				fetch(apiPath("health")),
			]);
			if (sres.ok) setSources(((await sres.json()) as { sources: SourceConfig[] }).sources);
			if (tres.ok) {
				const list = ((await tres.json()) as { trackers: Tracker[] }).trackers;
				applyTrackers(list);
				// 有未完成的向导草稿就直接续上(刷新可续的入口),否则落在第一份档案
				const draft = list.find((t) => t.stage);
				if (draft) {
					setSelected(draft.key);
					setView("wizard");
				} else {
					setSelected(list[0]?.key ?? "");
					if (list.length === 0) setView("wizard");
				}
			}
			if (hres.ok) setProvider(((await hres.json()) as { provider: string }).provider);
		})();
	}, [applyTrackers]);

	const markSynced = useCallback((ok: boolean, msg = "") => {
		setSync(ok ? "saved" : "error");
		setSyncMsg(msg);
		if (savedTimer.current) clearTimeout(savedTimer.current);
		if (ok) savedTimer.current = setTimeout(() => setSync("idle"), 2000);
	}, []);

	// 即改即存。失败时界面保留改动并明确报错,而不是悄悄回滚。
	const put = useCallback(
		async (path: "sources" | "trackers", payload: Record<string, unknown>) => {
			setSync("saving");
			try {
				const res = await fetch(apiPath(path), { method: "PUT", headers: headers(), body: JSON.stringify(payload) });
				markSynced(res.ok, res.ok ? "" : (((await res.json()) as { error?: string }).error ?? `HTTP ${res.status}`));
			} catch {
				markSynced(false, "网络错误");
			}
		},
		[markSynced],
	);

	const putTrackers = useCallback(
		(next: Tracker[]) => {
			applyTrackers(next);
			void put("trackers", { trackers: next.filter((t) => t.name.trim()) });
		},
		[put, applyTrackers],
	);

	const putSources = useCallback(
		(next: SourceConfig[], save = true) => {
			setSources(next);
			if (save) void put("sources", { sources: next });
		},
		[put],
	);

	const patchTracker = useCallback(
		(key: string, patch: Partial<Tracker>, log?: string) => {
			putTrackers(trackersRef.current.map((t) => (t.key === key ? withLog({ ...t, ...patch }, log) : t)));
		},
		[putTrackers],
	);

	const addSources = useCallback(
		async (
			items: { name: string; url: string; category: string }[],
			trackerKey?: string,
			rules?: { url: string; include?: string[]; exclude?: string[] }[],
			/** "candidate" = 采纳 AI 候选卡,服务端据此记采纳率仪表。 */
			origin?: "candidate",
		) => {
			const res = await fetch(apiPath("sources/add"), {
				method: "POST",
				headers: headers(),
				body: JSON.stringify({
					sources: items,
					...(trackerKey ? { trackerKey } : {}),
					...(rules ? { rules } : {}),
					...(origin ? { origin } : {}),
				}),
			});
			if (!res.ok) {
				const data = (await res.json().catch(() => ({}))) as { error?: string };
				throw new Error(data.error ?? `HTTP ${res.status}`);
			}
			const data = (await res.json()) as {
				adopted: SourceConfig[];
				failed: { name: string; url: string; error: string }[];
				sources: SourceConfig[];
				trackers: Tracker[];
			};
			setSources(data.sources);
			applyTrackers(data.trackers);
			return data;
		},
		[applyTrackers],
	);

	const testSource = useCallback(async (url: string) => {
		setTests((t) => ({ ...t, [url]: "testing" }));
		try {
			const res = await fetch(apiPath("sources/test"), { method: "POST", headers: headers(), body: JSON.stringify({ url }) });
			const result: TestResult = res.ok ? ((await res.json()) as TestResult) : { ok: false, error: `HTTP ${res.status}` };
			setTests((t) => ({ ...t, [url]: result }));
		} catch {
			setTests((t) => ({ ...t, [url]: { ok: false, error: "网络错误" } }));
		}
	}, []);

	// ---------- 档案页的两个编辑动作(单次调用,F3/F4) ----------

	/** 「让编辑再找几个」:服务端自动排除已采纳/已拒绝,这里再排除已展示的。 */
	const findMore = (t: Tracker) => {
		if (editorBusy) return;
		setEditorBusy(true);
		setEditorNote("");
		void (async () => {
			try {
				const shown = (candidates[t.key] ?? []).map((c) => c.url);
				const res = await wizardSources(t.key, shown, headers());
				const fresh = (res.candidates ?? []).filter((c) => !shown.includes(c.url));
				setCandidates((c) => ({ ...c, [t.key]: [...(c[t.key] ?? []), ...fresh] }));
				if (res.note) setEditorNote(res.note);
			} catch (err) {
				setEditorNote(`出错了:${err instanceof Error ? err.message : "未知错误"}`);
			} finally {
				setEditorBusy(false);
			}
		})();
	};

	/** 「对编辑说一句」(真 AI 路径;mock 由 Dossier 就地起草提案)。 */
	const say = (t: Tracker, text: string) => {
		if (editorBusy) return;
		setEditorBusy(true);
		setEditorNote("");
		void (async () => {
			try {
				const { patch, note } = await refineTracker(t.key, text, headers());
				if (Object.keys(patch).length > 0) {
					// intent 被改写时旧的分句作废,档案会从新 intent 重新拆句
					patchTracker(
						t.key,
						{ ...patch, ...(patch.intent ? { intentSegments: undefined } : {}) },
						`你说「${text}」→ ${note ?? "编辑更新了定义"}`,
					);
				}
				if (note) setEditorNote(note);
			} catch (err) {
				setEditorNote(`出错了:${err instanceof Error ? err.message : "未知错误"}`);
			} finally {
				setEditorBusy(false);
			}
		})();
	};

	const adoptCandidate = async (t: Tracker, item: ProposalItem) => {
		setCandidates((c) => ({ ...c, [t.key]: (c[t.key] ?? []).filter((x) => x.url !== item.url) }));
		try {
			const data = await addSources([{ name: item.name, url: item.url, category: item.category }], t.key, undefined, "candidate");
			putTrackers(data.trackers.map((x) => (x.key === t.key ? withLog(x, `你采纳了候选来源「${item.name}」`) : x)));
		} catch (err) {
			setEditorNote(`加入失败:${err instanceof Error ? err.message : "未知错误"}`);
			setCandidates((c) => ({ ...c, [t.key]: [...(c[t.key] ?? []), item] }));
			throw err;
		}
	};

	/**
	 * 「全部加入」:一次采纳一整轮候选。服务端单次最多 8 个,所以按 8 分批;
	 * 每批各自成败,不因一个坏源连累整轮。返回没加成的候选和一句人话交代——
	 * 列表归谁管谁负责放回去(向导有自己的本地列表,档案页用 candidates 表)。
	 */
	const adoptCandidates = async (t: Tracker, items: ProposalItem[]) => {
		const failed: ProposalItem[] = [];
		const reasons: string[] = [];
		let adopted = 0;
		let latest: Tracker[] | null = null;
		for (let i = 0; i < items.length; i += ADOPT_BATCH) {
			const chunk = items.slice(i, i + ADOPT_BATCH);
			try {
				const data = await addSources(
					chunk.map((x) => ({ name: x.name, url: x.url, category: x.category })),
					t.key,
					undefined,
					"candidate",
				);
				adopted += data.adopted.length;
				latest = data.trackers;
				for (const f of data.failed) {
					// 服务端可能把 URL 规范化过(feed 发现),名字兜底匹配。
					const item = chunk.find((x) => x.url === f.url) ?? chunk.find((x) => x.name === f.name);
					if (item) failed.push(item);
					reasons.push(`${f.name}:${f.error}`);
				}
			} catch (err) {
				failed.push(...chunk);
				reasons.push(`${chunk.length} 个没加成(${err instanceof Error ? err.message : "未知错误"})`);
			}
		}
		if (latest && adopted > 0) {
			putTrackers(latest.map((x) => (x.key === t.key ? withLog(x, `你一键加入了 ${adopted} 个候选来源`) : x)));
		}
		return {
			failed,
			note: reasons.length > 0 ? `加入 ${adopted} 个 · ${reasons.join(" / ")}` : "",
		};
	};

	/** 从精选目录加源并绑定定义:失败往上抛,由目录组件就地显示错误。 */
	const addFromCatalog = async (t: Tracker, entry: { name: string; url: string; category: string }) => {
		const data = await addSources([{ name: entry.name, url: entry.url, category: entry.category }], t.key);
		if (data.adopted.length === 0) throw new Error(data.failed[0]?.error ?? "加入失败");
		putTrackers(data.trackers.map((x) => (x.key === t.key ? withLog(x, `你从精选目录加入了「${entry.name}」`) : x)));
	};

	const rejectCandidate = (t: Tracker, item: ProposalItem) => {
		setCandidates((c) => ({ ...c, [t.key]: (c[t.key] ?? []).filter((x) => x.url !== item.url) }));
		patchTracker(
			t.key,
			{ rejectedSourceUrls: [...new Set([...(t.rejectedSourceUrls ?? []), item.url])] },
			`你略过了候选「${item.name}」,以后不再推荐`,
		);
	};

	if (!sources) {
		return <p className="font-mono-sc animate-pulse py-12 text-center text-sm text-[var(--ink-3)]">读取配置…</p>;
	}

	const current = trackers.find((t) => t.key === selected) ?? trackers[0];
	const currentIndex = current ? trackers.findIndex((t) => t.key === current.key) : -1;
	// 向导视图的草稿:selected 指着的那份带 stage 的追踪器;没有 = 从提问开始
	const wizardDraft = view === "wizard" ? (trackers.find((t) => t.key === selected && t.stage) ?? null) : null;

	return (
		<div className="grid items-start gap-6 pt-2 pb-8 md:grid-cols-[210px_minmax(0,1fr)]">
			{/* 目录 */}
			<nav className="flex flex-col gap-0.5 md:sticky md:top-5">
				<p className="font-mono-sc m-0 mb-1.5 text-[10px] uppercase tracking-[0.05em] text-[var(--ink-3)]">
					追踪定义 · {trackers.length} 份
				</p>
				{trackers.map((t, i) => {
					const isDraft = Boolean(t.stage);
					const active = (view === "doc" || view === "wizard") && current?.key === t.key && selected === t.key;
					return (
						<button
							key={t.key}
							type="button"
							onClick={() => {
								setSelected(t.key);
								setView(isDraft ? "wizard" : "doc");
								setEditorNote("");
							}}
							className={`flex w-full cursor-pointer items-center gap-2 rounded-md px-2.5 py-1.5 text-left text-[13px] transition-colors ${
								active
									? "bg-[var(--ink)] font-medium text-[var(--paper)]"
									: `text-[var(--ink-2)] hover:bg-[var(--paper-deep)] ${t.enabled === false ? "opacity-50" : ""}`
							}`}
						>
							<span className="font-mono-sc text-[10px] text-[var(--ink-3)]">{String(i + 1).padStart(3, "0")}</span>
							<span className="min-w-0 flex-1 truncate">{t.name || "未命名定义"}</span>
							{isDraft && <span className="font-mono-sc text-[9px] text-[var(--accent)]">草稿</span>}
						</button>
					);
				})}
				<button
					type="button"
					onClick={() => {
						setSelected("");
						setView("wizard");
						setEditorNote("");
					}}
					className={`mt-2 cursor-pointer rounded-md border border-dashed px-2.5 py-1.5 text-left text-[12px] transition-colors ${
						view === "wizard" && !wizardDraft
							? "border-[var(--accent)] text-[var(--accent)]"
							: "border-[var(--line-strong)] text-[var(--ink-2)] hover:border-[var(--accent)] hover:text-[var(--accent)]"
					}`}
				>
					+ 新的长期问题
				</button>
				<button
					type="button"
					onClick={() => setView("library")}
					className={`font-mono-sc mt-4 cursor-pointer text-left text-[10px] leading-[1.8] transition-colors ${
						view === "library" ? "text-[var(--accent)]" : "text-[var(--ink-3)] hover:text-[var(--ink)]"
					}`}
				>
					来源库 {sources.length} 个源
					<br />
					高级管理,保持折叠 →
				</button>
				{sync !== "idle" && (
					<p className="font-mono-sc m-0 mt-3 text-[10px] text-[var(--ink-3)]">
						{sync === "saving" && "同步中…"}
						{sync === "saved" && <span className="text-[var(--ok)]">✓ 已同步</span>}
						{sync === "error" && <span className="text-[var(--accent)]">✗ {syncMsg || "同步失败"}</span>}
					</p>
				)}
			</nav>

			{/* 正文 */}
			{/* 正文列与简报正文同宽(672),两个视图的阅读测量宽保持一致 */}
			<div className="min-w-0 max-w-[672px]">
				{view === "library" && (
					<SourceLibrary sources={sources} tests={tests} onTest={(url) => void testSource(url)} onSources={putSources} onAdd={async (items) => {
						const data = await addSources(items);
						return { addedUrls: data.adopted.map((a) => a.url), failed: data.failed };
					}} />
				)}

				{view === "wizard" && (
					<Wizard
						key={wizardDraft?.key ?? "new"}
						draft={wizardDraft}
						sources={sources}
						headers={headers}
						onTrackers={(next, selectKey) => {
							applyTrackers(next);
							if (selectKey) setSelected(selectKey);
						}}
						onPatch={patchTracker}
						onAdopt={async (trackerKey, item) => {
							const t = trackersRef.current.find((x) => x.key === trackerKey);
							if (t) await adoptCandidate(t, item);
						}}
						onAdoptAll={async (trackerKey, items) => {
							const t = trackersRef.current.find((x) => x.key === trackerKey);
							if (!t) return { failed: items, note: "这份草稿不见了,刷新再试" };
							return adoptCandidates(t, items);
						}}
						onFinish={(key) => {
							patchTracker(key, { stage: undefined }, "向导完成,这份定义开始生效");
							setSelected(key);
							setView("doc");
						}}
						onDiscard={(key) => {
							if (key) {
								const next = trackersRef.current.filter((t) => t.key !== key);
								putTrackers(next);
								setSelected(next[0]?.key ?? "");
								setView(next.length === 0 ? "wizard" : "doc");
							} else {
								if (trackers.length > 0) {
									setSelected(trackers[0].key);
									setView("doc");
								}
							}
						}}
					/>
				)}

				{view === "doc" &&
					(current ? (
						<Dossier
							key={current.key}
							tracker={current}
							docId={docId(currentIndex)}
							sources={sources}
							provider={provider}
							tests={tests}
							candidates={candidates[current.key] ?? []}
							editorBusy={editorBusy}
							editorNote={editorNote}
							onPatch={(patch, log) => patchTracker(current.key, patch, log)}
							onDelete={() => {
								const next = trackers.filter((t) => t.key !== current.key);
								putTrackers(next);
								setSelected(next[0]?.key ?? "");
								if (next.length === 0) setView("wizard");
							}}
							onTest={(url) => void testSource(url)}
							onFindMore={() => findMore(current)}
							onAdoptCandidate={(item) => void adoptCandidate(current, item).catch(() => {})}
							onAdoptAllCandidates={() => {
								const usable = (candidates[current.key] ?? []).filter((x) => x.ok);
								if (usable.length === 0 || editorBusy) return;
								setEditorBusy(true);
								setEditorNote("");
								setCandidates((c) => ({ ...c, [current.key]: (c[current.key] ?? []).filter((x) => !x.ok) }));
								void adoptCandidates(current, usable)
									.then(({ failed, note }) => {
										if (failed.length > 0) {
											setCandidates((c) => ({ ...c, [current.key]: [...(c[current.key] ?? []), ...failed] }));
										}
										setEditorNote(note);
									})
									.finally(() => setEditorBusy(false));
							}}
							onRejectCandidate={(item) => rejectCandidate(current, item)}
							onAddCatalog={(entry) => addFromCatalog(current, entry)}
							onSay={(text) => say(current, text)}
						/>
					) : (
						<div className="rounded-[10px] border border-dashed border-[var(--line-strong)] px-8 py-10 text-center">
							<p className="m-0 text-[14px] text-[var(--ink-2)]">还没有任何追踪定义。</p>
							<button
								type="button"
								onClick={() => {
									setSelected("");
									setView("wizard");
								}}
								className="mt-3 cursor-pointer rounded-md bg-[var(--ink)] px-4 py-2 text-[13px] text-[var(--paper)] transition-colors hover:bg-[var(--accent)]"
							>
								写下第一个长期问题
							</button>
						</div>
					))}
			</div>
		</div>
	);
}
