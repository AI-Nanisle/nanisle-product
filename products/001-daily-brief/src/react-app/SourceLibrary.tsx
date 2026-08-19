import { useEffect, useState } from "react";
import type { SourceCategory, SourceConfig } from "../shared/pipeline-core";
import type { TestResult } from "./editor";
import CatalogPicker from "./CatalogPicker";
import { apiPath } from "./paths";

// 来源库:全局源池的高级管理区。追踪定义档案是主界面,这里是它的后台——
// 添加、停用、删除、试抓都在这一页,平时从左栏「来源库 N 个源 →」进来。
// 定义页里的「指定信源」只从这个池子里挑,不在这里重复源的增删。

export const CATEGORY_LABELS: Record<SourceCategory, string> = {
	news: "新闻",
	macro: "宏观",
	blog: "博客",
	podcast: "播客",
	paper: "论文",
};
export const CATEGORIES = Object.keys(CATEGORY_LABELS) as SourceCategory[];

const inputCls =
	"rounded-md border border-[var(--line)] bg-[var(--card)] px-2.5 py-1.5 text-[13px] outline-none focus:border-[var(--line-strong)] min-w-0";

/** 找源仪表(GET /api/metrics,docs/02 §7.3):判断找源机制够不够用的三个数。 */
interface MetricsReport {
	window: { briefs: number; from: string | null; to: string | null };
	candidates: { shown: number; adopted: number };
	selection: { total: number; query: number };
	trackers: { key: string; name: string; briefs: number; noHitStreak: number; lastHitDate: string | null }[];
}

function pct(part: number, whole: number): string {
	return whole > 0 ? `${Math.round((part / whole) * 100)}%` : "—";
}

/** 站点没有 feed 时的退路:把名字/域名翻译成 Google News 检索源(§7.3 第 1 层)。 */
function googleNewsQueryUrl(keyword: string): string {
	const zh = /[一-鿿]/.test(keyword);
	const locale = zh ? "hl=zh-CN&gl=CN&ceid=CN:zh-Hans" : "hl=en-US&gl=US&ceid=US:en";
	return `https://news.google.com/rss/search?q=${encodeURIComponent(keyword)}&${locale}`;
}

export default function SourceLibrary({
	sources,
	tests,
	onTest,
	onSources,
	onAdd,
}: {
	sources: SourceConfig[];
	tests: Record<string, TestResult | "testing">;
	onTest: (url: string) => void;
	/** save=false 只改本地(输入过程中),blur 时再带 save 落库。 */
	onSources: (next: SourceConfig[], save?: boolean) => void;
	onAdd: (items: { name: string; url: string; category: string }[]) => Promise<{
		addedUrls: string[];
		failed: { url: string; error: string }[];
	}>;
}) {
	const [adding, setAdding] = useState(false);
	const [draft, setDraft] = useState({ name: "", url: "", category: "blog" as SourceCategory });
	const [busy, setBusy] = useState(false);
	const [msg, setMsg] = useState("");
	const [suggestKw, setSuggestKw] = useState<string | null>(null);
	const [confirmDel, setConfirmDel] = useState<string | null>(null);
	const [catalogOpen, setCatalogOpen] = useState(false);
	const [metrics, setMetrics] = useState<MetricsReport | null>(null);
	// X2 · 轴外位开关(null = 还没读到)。默认开,所以缺字段按 true 算。
	const [offAxis, setOffAxis] = useState<boolean | null>(null);

	const enabledCount = sources.filter((s) => s.enabled !== false).length;

	useEffect(() => {
		void (async () => {
			try {
				const res = await fetch(apiPath("metrics"));
				if (res.ok) setMetrics((await res.json()) as MetricsReport);
			} catch {
				// 仪表读不到不挡管理操作,静默留空
			}
			try {
				const res = await fetch(apiPath("prefs"));
				if (res.ok) {
					const data = (await res.json()) as { prefs?: { offAxis?: boolean } };
					setOffAxis(data.prefs?.offAxis !== false);
				}
			} catch {
				// 同上
			}
		})();
	}, []);

	const toggleOffAxis = async () => {
		const next = !(offAxis ?? true);
		setOffAxis(next);
		await fetch(apiPath("prefs"), {
			method: "PUT",
			headers: { "content-type": "application/json" },
			body: JSON.stringify({ offAxis: next }),
		});
	};

	// 删除是二段确认;切到别的行或 4 秒无动作自动收回
	useEffect(() => {
		if (!confirmDel) return;
		const timer = setTimeout(() => setConfirmDel(null), 4000);
		return () => clearTimeout(timer);
	}, [confirmDel]);

	const manualAdd = async () => {
		if (!draft.url.trim() || busy) return;
		setBusy(true);
		setMsg("");
		setSuggestKw(null);
		try {
			const { addedUrls, failed } = await onAdd([draft]);
			if (addedUrls.length > 0) {
				setDraft({ name: "", url: "", category: draft.category });
				setAdding(false);
			} else {
				const err = failed[0]?.error ?? "添加失败";
				setMsg(err);
				// 抓取类失败才给「转查询源」的退路;重复/上限/字段问题给了也没意义
				if (!/已在配置里|上限|字段不完整/.test(err)) {
					let kw = draft.name.trim();
					if (!kw) {
						try {
							kw = new URL(/^https?:\/\//i.test(draft.url) ? draft.url : `https://${draft.url}`).hostname.replace(/^www\./, "");
						} catch {
							kw = draft.url.trim();
						}
					}
					if (kw) setSuggestKw(kw);
				}
			}
		} catch (err) {
			setMsg(err instanceof Error ? err.message : "添加失败");
		} finally {
			setBusy(false);
		}
	};

	const useQuerySource = () => {
		if (!suggestKw) return;
		setDraft({ name: `Google News:${suggestKw}`, url: googleNewsQueryUrl(suggestKw), category: "news" });
		setMsg("");
		setSuggestKw(null);
	};

	return (
		<div className="rounded-[10px] border border-[var(--line)] bg-[var(--card)] px-8 py-7">
			<div className="flex flex-wrap items-baseline gap-x-4 gap-y-1">
				<span className="font-mono-sc text-[10px] uppercase tracking-[0.08em] text-[var(--ink-3)]">
					高级管理 · 全局源池
				</span>
				<span className="font-mono-sc ml-auto text-[10px] text-[var(--ink-3)]">
					src {sources.length} · on {enabledCount}
				</span>
			</div>
			<h2 className="mt-2 text-[28px] font-black leading-tight tracking-wide">来源库</h2>
			<div className="rule-double mt-4 h-[5px]" />
			<p className="mt-4 text-[13px] text-[var(--ink-2)]">
				所有追踪定义共用这个源池。在某份定义里「指定信源」时,挑的就是这里的源;停用一个源,所有定义都不再从它取材。
			</p>

			<div className="mt-4">
				{sources.map((s, i) => {
					const t = tests[s.url];
					return (
						<div
							key={s.key || i}
							className={`border-b border-[var(--line)] py-2 last:border-0 ${s.enabled === false ? "opacity-50" : ""}`}
						>
							<div className="flex items-center gap-2">
								<button
									type="button"
									onClick={() =>
										onSources(
											sources.map((x, j) => (j === i ? { ...x, enabled: x.enabled === false ? undefined : false } : x)),
										)
									}
									title={s.enabled === false ? "已停用,点击启用" : "已启用,点击停用"}
									className="cursor-pointer p-0.5"
								>
									<span className={`dot ${s.enabled === false ? "dot-off" : "dot-on"}`} />
								</button>
								<input
									value={s.name}
									onChange={(e) => onSources(sources.map((x, j) => (j === i ? { ...x, name: e.target.value } : x)), false)}
									onBlur={() => onSources(sources)}
									className="w-40 min-w-0 flex-1 bg-transparent text-[14px] font-medium outline-none"
								/>
								<select
									value={s.category}
									onChange={(e) =>
										onSources(sources.map((x, j) => (j === i ? { ...x, category: e.target.value as SourceCategory } : x)))
									}
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
									onClick={() => onTest(s.url)}
									className="font-mono-sc shrink-0 cursor-pointer text-[10px] text-[var(--ink-3)] hover:text-[var(--ink)]"
								>
									{t === "testing" ? "抓取中…" : "试抓"}
								</button>
								{confirmDel === (s.key || s.url) ? (
									<button
										type="button"
										onClick={() => {
											setConfirmDel(null);
											onSources(sources.filter((_, j) => j !== i));
										}}
										className="font-mono-sc shrink-0 cursor-pointer text-[10px] font-bold text-[var(--accent)]"
									>
										确认删除?
									</button>
								) : (
									<button
										type="button"
										onClick={() => setConfirmDel(s.key || s.url)}
										title="删除后,所有引用它的追踪定义都不再从它取材"
										className="font-mono-sc shrink-0 cursor-pointer text-[10px] text-[var(--ink-3)] hover:text-[var(--accent)]"
									>
										删除
									</button>
								)}
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

			{/* 手动添加:服务端自动做 feed 发现与试抓验证;名称留空用 feed 自带标题 */}
			<div className="mt-4 border-t border-[var(--line)] pt-4">
				{adding ? (
					<div className="space-y-2">
						<div className="flex flex-wrap gap-2">
							<input
								value={draft.name}
								onChange={(e) => setDraft({ ...draft, name: e.target.value })}
								placeholder="源名称(留空用 feed 标题)"
								className={`${inputCls} w-44`}
							/>
							<select
								value={draft.category}
								onChange={(e) => setDraft({ ...draft, category: e.target.value as SourceCategory })}
								className={`${inputCls} cursor-pointer`}
							>
								{CATEGORIES.map((cat) => (
									<option key={cat} value={cat}>
										{CATEGORY_LABELS[cat]}
									</option>
								))}
							</select>
							<input
								value={draft.url}
								onChange={(e) => setDraft({ ...draft, url: e.target.value })}
								onKeyDown={(e) => e.key === "Enter" && void manualAdd()}
								placeholder="feed 或网站地址(会自动发现 feed)"
								className={`${inputCls} font-mono-sc min-w-52 flex-1 text-[12px]`}
							/>
							<button
								type="button"
								onClick={() => void manualAdd()}
								disabled={busy}
								className="font-mono-sc cursor-pointer rounded-md border border-[var(--line-strong)] px-3 py-1.5 text-[12px] transition-colors hover:bg-[var(--ink)] hover:text-[var(--paper)] disabled:opacity-50"
							>
								{busy ? "验证中…" : "验证并添加"}
							</button>
							<button
								type="button"
								onClick={() => {
									setAdding(false);
									setMsg("");
									setSuggestKw(null);
								}}
								className="font-mono-sc cursor-pointer px-1 text-[11px] text-[var(--ink-3)] hover:text-[var(--ink)]"
							>
								取消
							</button>
						</div>
						{msg && <p className="font-mono-sc text-[11px] text-[var(--accent)]">✗ {msg}</p>}
						{suggestKw && (
							<div className="flex flex-wrap items-center gap-2 rounded-md bg-[var(--paper-deep)] px-3 py-2">
								<span className="text-[12px] text-[var(--ink-2)]">
									这个站点可能没有 RSS——可以改用 Google News 检索它,照样每天出新条目:
								</span>
								<button
									type="button"
									onClick={useQuerySource}
									className="font-mono-sc cursor-pointer rounded border border-[var(--line-strong)] px-2 py-0.5 text-[11px] transition-colors hover:border-[var(--accent)] hover:text-[var(--accent)]"
								>
									改用检索「{suggestKw}」
								</button>
							</div>
						)}
					</div>
				) : (
					<div className="flex flex-wrap gap-2">
						<button
							type="button"
							onClick={() => setAdding(true)}
							className="cursor-pointer rounded border border-dashed border-[var(--line-strong)] px-3 py-1.5 text-[12px] text-[var(--ink-2)] transition-colors hover:border-[var(--accent)] hover:text-[var(--accent)]"
						>
							+ 手动添加一个源
						</button>
						<button
							type="button"
							onClick={() => setCatalogOpen((v) => !v)}
							className="cursor-pointer rounded border border-dashed border-[var(--line-strong)] px-3 py-1.5 text-[12px] text-[var(--ink-2)] transition-colors hover:border-[var(--accent)] hover:text-[var(--accent)]"
						>
							{catalogOpen ? "收起精选目录" : "浏览精选目录"}
						</button>
					</div>
				)}
				{catalogOpen && (
					<CatalogPicker
						existingUrls={sources.map((s) => s.url)}
						onPick={async (entry) => {
							const { failed } = await onAdd([{ name: entry.name, url: entry.url, category: entry.category }]);
							if (failed.length > 0) throw new Error(failed[0].error);
						}}
						note="目录里每条都经人工验证与定期巡检;加入前服务端仍会真实试抓一次。"
					/>
				)}
			</div>

			{/* X2 · 轴外位开关。你订的源决定你能看见什么,所以这个开关放在源库里:
			    它管的正是「订阅池之外的东西要不要进来」。 */}
			{offAxis !== null && (
				<div className="mt-6 border-t border-[var(--line)] pt-4">
					<div className="flex items-baseline gap-3">
						<p className="font-mono-sc m-0 text-[10px] uppercase tracking-[0.08em] text-[var(--ink-3)]">
							轴外推荐
						</p>
						<button
							type="button"
							onClick={() => void toggleOffAxis()}
							className={`font-mono-sc ml-auto cursor-pointer text-[11px] transition-colors ${offAxis ? "text-[var(--accent)]" : "text-[var(--ink-3)] hover:text-[var(--ink)]"}`}
						>
							{offAxis ? "● 开着" : "○ 关着"}
						</button>
					</div>
					<p className="m-0 mt-1.5 text-[12px] leading-relaxed text-[var(--ink-3)]">
						每期给一条不属于任何追踪定义的内容,并说明为什么你该看见。你只订这些源,就只看得见这些源——
						这一条是留给「你还不知道自己该知道」的东西的。连续 10 期一条没点开会自动停。
					</p>
				</div>
			)}

			{/* 运行仪表(docs/02 §7.3):找源机制够不够用,用这三个数说话 */}
			{metrics && (
				<div className="mt-6 border-t border-[var(--line)] pt-4">
					<p className="font-mono-sc m-0 text-[10px] uppercase tracking-[0.08em] text-[var(--ink-3)]">
						运行仪表 · 近 {metrics.window.briefs} 期
					</p>
					<div className="font-mono-sc mt-2 flex flex-wrap gap-x-6 gap-y-1 text-[11px] text-[var(--ink-2)]">
						<span>
							候选采纳率 {pct(metrics.candidates.adopted, metrics.candidates.shown)}
							({metrics.candidates.adopted}/{metrics.candidates.shown})
						</span>
						<span>
							入选内容查询源占比 {pct(metrics.selection.query, metrics.selection.total)}
							({metrics.selection.query}/{metrics.selection.total})
						</span>
					</div>
					{metrics.trackers.some((t) => t.briefs > 0) && (
						<div className="font-mono-sc mt-1.5 space-y-0.5 text-[11px] text-[var(--ink-3)]">
							{metrics.trackers
								.filter((t) => t.briefs > 0)
								.map((t) => (
									<p key={t.key} className="m-0">
										{t.name}:
										{t.noHitStreak > 0 ? (
											<span className={t.noHitStreak >= 3 ? "text-[var(--accent)]" : undefined}>
												{" "}
												连续 {t.noHitStreak} 期无命中
											</span>
										) : (
											" 最新一期有命中"
										)}
										{t.lastHitDate ? ` · 上次命中 ${t.lastHitDate}` : " · 窗口内从未命中"}
									</p>
								))}
						</div>
					)}
					<p className="font-mono-sc m-0 mt-1.5 text-[10px] text-[var(--ink-3)] opacity-80">
						采纳率持续低或无命中持续高,是该修目录/提前做观察式发现的信号(docs/02 §7.3)。
					</p>
				</div>
			)}
		</div>
	);
}
