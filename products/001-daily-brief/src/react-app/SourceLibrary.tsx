import { useEffect, useState } from "react";
import type { SourceCategory, SourceConfig } from "../shared/pipeline-core";
import { isUnhealthy } from "../shared/pipeline-core";
import { TASTE_MAX_CHARS } from "../shared/taste";
import type { TasteProfile } from "../shared/store";
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
	/** H2 · 连续失败 ≥3 次的启用中源数。 */
	unhealthy?: number;
}

/** H3 · 自愈结果:recovered=原地址又通了,rediscovered/fallback=有替代,dead=三条路都断。 */
interface HealResult {
	ok: boolean;
	verdict: "recovered" | "rediscovered" | "fallback" | "dead";
	message: string;
	candidate?: { name: string; url: string; category: SourceCategory };
}

/** H5 · 从点击反向发现的候选站点。 */
interface DiscoveredHost {
	host: string;
	clicks: number;
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
	const [emailPush, setEmailPush] = useState<boolean | null>(null);
	// H3/H5 · 自愈结果(按源 key)与反向发现的候选站
	const [heal, setHeal] = useState<Record<string, HealResult | "healing">>({});
	const [discovered, setDiscovered] = useState<DiscoveredHost[]>([]);
	// R9 · 口味画像:null = 还没读到或没有;编辑态是一份本地草稿
	const [taste, setTaste] = useState<TasteProfile | null>(null);
	const [tasteLoaded, setTasteLoaded] = useState(false);
	const [tasteDraft, setTasteDraft] = useState<string | null>(null);
	const [tasteBusy, setTasteBusy] = useState(false);

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
					const data = (await res.json()) as { prefs?: { offAxis?: boolean; emailPush?: boolean } };
					setOffAxis(data.prefs?.offAxis !== false);
					setEmailPush(data.prefs?.emailPush !== false);
				}
			} catch {
				// 同上
			}
			try {
				const res = await fetch(apiPath("sources/discovered"));
				if (res.ok) {
					const data = (await res.json()) as { candidates?: DiscoveredHost[] };
					setDiscovered(data.candidates ?? []);
				}
			} catch {
				// 同上
			}
			try {
				const res = await fetch(apiPath("taste"));
				if (res.ok) {
					setTaste(((await res.json()) as { taste: TasteProfile | null }).taste);
					setTasteLoaded(true);
				}
			} catch {
				// 同上
			}
		})();
	}, []);

	const saveTaste = async (summary: string) => {
		setTasteBusy(true);
		try {
			const res = await fetch(apiPath("taste"), {
				method: "PUT",
				headers: { "content-type": "application/json" },
				body: JSON.stringify({ summary }),
			});
			if (res.ok) {
				setTaste(((await res.json()) as { taste: TasteProfile | null }).taste);
				setTasteDraft(null);
			}
		} finally {
			setTasteBusy(false);
		}
	};

	const toggleOffAxis = async () => {
		const next = !(offAxis ?? true);
		setOffAxis(next);
		await fetch(apiPath("prefs"), {
			method: "PUT",
			headers: { "content-type": "application/json" },
			body: JSON.stringify({ offAxis: next }),
		});
	};

	const toggleEmailPush = async () => {
		const next = !(emailPush ?? true);
		setEmailPush(next);
		await fetch(apiPath("prefs"), {
			method: "PUT",
			headers: { "content-type": "application/json" },
			body: JSON.stringify({ emailPush: next }),
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

	/** H3 · 让编辑修一个坏掉的源:先重试原地址,再站点重发现,最后退到检索源。 */
	const healSource = async (s: SourceConfig) => {
		setHeal((h) => ({ ...h, [s.key]: "healing" }));
		try {
			const res = await fetch(apiPath("sources/heal"), {
				method: "POST",
				headers: { "content-type": "application/json" },
				body: JSON.stringify({ key: s.key }),
			});
			const data = (await res.json()) as HealResult & { error?: string };
			if (!res.ok) throw new Error(data.error ?? "自愈失败");
			setHeal((h) => ({ ...h, [s.key]: data }));
		} catch (err) {
			setHeal((h) => ({
				...h,
				[s.key]: { ok: false, verdict: "dead", message: err instanceof Error ? err.message : "自愈失败" },
			}));
		}
	};

	/** 换成自愈找到的替代地址;URL 变了健康状态跟着清零,重新开始记。 */
	const applyHeal = (i: number, url: string) => {
		const s = sources[i];
		onSources(sources.map((x, j) => (j === i ? { ...x, url, health: undefined } : x)));
		setHeal((h) => {
			const next = { ...h };
			delete next[s.key];
			return next;
		});
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

			{/* H5 · 从点击反向发现:说的是「你真的点过这个站 N 次」,比模型凭空
			    推荐可信一个量级——而数据早在 v1 的 /go 埋点里就攒着了。 */}
			{discovered.length > 0 && (
				<div className="mt-4 rounded-lg border border-dashed border-[var(--accent)] bg-[var(--accent-soft)] px-4 py-3">
					<p className="font-mono-sc m-0 text-[10px] uppercase tracking-[0.08em] text-[var(--ink-3)]">
						你常点、但没订的站
					</p>
					<div className="mt-2 space-y-1.5">
						{discovered.map((d) => (
							<div key={d.host} className="flex flex-wrap items-center gap-2 text-[13px]">
								<span className="font-medium">{d.host}</span>
								<span className="font-mono-sc text-[11px] text-[var(--ink-3)]">近 30 天点了 {d.clicks} 次</span>
								<button
									type="button"
									onClick={() => {
										setDraft({ name: "", url: `https://${d.host}`, category: "blog" });
										setAdding(true);
										setDiscovered((list) => list.filter((x) => x.host !== d.host));
									}}
									className="font-mono-sc ml-auto cursor-pointer rounded border border-[var(--line-strong)] bg-[var(--card)] px-2 py-0.5 text-[10px] hover:bg-[var(--ink)] hover:text-[var(--paper)]"
								>
									加成信源
								</button>
								<button
									type="button"
									onClick={() => {
										setDiscovered((list) => list.filter((x) => x.host !== d.host));
										void fetch(apiPath("sources/dismiss-host"), {
											method: "POST",
											headers: { "content-type": "application/json" },
											body: JSON.stringify({ host: d.host }),
										});
									}}
									className="font-mono-sc cursor-pointer text-[10px] text-[var(--ink-3)] hover:text-[var(--ink)]"
								>
									不用管
								</button>
							</div>
						))}
					</div>
					<p className="font-mono-sc m-0 mt-2 text-[10px] text-[var(--ink-3)] opacity-80">
						「加成信源」会把地址填进下面的添加框并自动做 feed 发现,抓通了才真的加进来。
					</p>
				</div>
			)}

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
							{/* H2 · 坏掉的源必须自己喊出来——用户不会来报告 feed 挂了 */}
							{isUnhealthy(s) && (
								<div className="mt-1 pl-4">
									<span className="font-mono-sc text-[11px] text-[var(--accent)]">
										⚠ 连续抓取失败 {s.health?.consecutiveFailures} 次,已暂停每日抓取(每周自动复检一次)
										{s.health?.lastOkAt ? ` · 最近一次成功 ${s.health.lastOkAt.slice(5, 10)}` : " · 从未成功过"}
									</span>
									<button
										type="button"
										onClick={() => void healSource(s)}
										disabled={heal[s.key] === "healing"}
										className="font-mono-sc ml-3 cursor-pointer text-[11px] text-[var(--ink-3)] underline hover:text-[var(--ink)] disabled:cursor-default disabled:opacity-50"
									>
										{heal[s.key] === "healing" ? "找替代中…" : "让编辑修一下"}
									</button>
									{s.health?.lastError && (
										<p className="font-mono-sc m-0 mt-0.5 truncate text-[10px] text-[var(--ink-3)] opacity-70">
											{s.health.lastError}
										</p>
									)}
									{(() => {
										const h = heal[s.key];
										if (!h || h === "healing") return null;
										return (
											<div className="mt-1.5 border-l-2 border-[var(--line-strong)] pl-3 text-[12px]">
												<p className="m-0 text-[var(--ink-2)]">{h.message}</p>
												{h.candidate && (
													<div className="mt-1 flex flex-wrap items-center gap-2">
														<span className="font-mono-sc truncate text-[11px] text-[var(--ink-3)]">{h.candidate.url}</span>
														<button
															type="button"
															onClick={() => applyHeal(i, h.candidate!.url)}
															className="font-mono-sc cursor-pointer rounded border border-[var(--line-strong)] px-2 py-0.5 text-[10px] hover:bg-[var(--ink)] hover:text-[var(--paper)]"
														>
															换成这个
														</button>
													</div>
												)}
											</div>
										);
									})()}
								</div>
							)}
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

			{/* E1 · 邮件提醒开关(docs/04)。邮件只当门铃:三句话 + 回站按钮,
			    不放条目链接。邮件页脚的退订链和这里是同一个偏好。 */}
			{emailPush !== null && (
				<div className="mt-6 border-t border-[var(--line)] pt-4">
					<div className="flex items-baseline gap-3">
						<p className="font-mono-sc m-0 text-[10px] uppercase tracking-[0.08em] text-[var(--ink-3)]">
							每日邮件提醒
						</p>
						<button
							type="button"
							onClick={() => void toggleEmailPush()}
							className={`font-mono-sc ml-auto cursor-pointer text-[11px] transition-colors ${emailPush ? "text-[var(--accent)]" : "text-[var(--ink-3)] hover:text-[var(--ink)]"}`}
						>
							{emailPush ? "● 开着" : "○ 关着"}
						</button>
					</div>
					<p className="m-0 mt-1.5 text-[12px] leading-relaxed text-[var(--ink-3)]">
						每天早刊生成后发一封极简邮件:今日三句话 + 一个回到简报的按钮,没有任何条目链接——阅读和反馈都在网页上。
						邮件页脚也有一键退订,和这个开关是同一回事。
					</p>
				</div>
			)}

			{/* R9 · 口味画像:选材依据必须看得见、改得动(和追踪定义档案同一条
			    信任链)。反馈攒够 10 条,编辑会把它们蒸馏成这段备忘并注入每天的
			    选材;读者改过的字句在下次蒸馏时保留。 */}
			{tasteLoaded && (
				<div className="mt-6 border-t border-[var(--line)] pt-4">
					<div className="flex items-baseline gap-3">
						<p className="font-mono-sc m-0 text-[10px] uppercase tracking-[0.08em] text-[var(--ink-3)]">
							编辑记下的口味
							{taste && (
								<span className="ml-2 normal-case tracking-normal opacity-80">
									{taste.updatedAt.slice(0, 10)}
									{taste.edited ? " · 你改过" : ` · 蒸馏自 ${taste.distilledFrom} 条反馈`}
								</span>
							)}
						</p>
						{tasteDraft === null && (
							<button
								type="button"
								onClick={() => setTasteDraft(taste?.summary ?? "")}
								className="font-mono-sc ml-auto cursor-pointer text-[11px] text-[var(--ink-3)] transition-colors hover:text-[var(--ink)]"
							>
								{taste ? "改写" : "自己写一段"}
							</button>
						)}
					</div>
					{tasteDraft !== null ? (
						<div className="mt-2">
							<textarea
								value={tasteDraft}
								onChange={(e) => setTasteDraft(e.target.value.slice(0, TASTE_MAX_CHARS))}
								rows={5}
								placeholder="写给编辑:你要更多什么、不要什么、口味最近怎么变了"
								className="w-full rounded-md border border-[var(--line)] bg-[var(--card)] px-2.5 py-1.5 text-[13px] leading-relaxed outline-none focus:border-[var(--line-strong)]"
							/>
							<div className="mt-1.5 flex items-center gap-3">
								<button
									type="button"
									disabled={tasteBusy}
									onClick={() => void saveTaste(tasteDraft)}
									className="font-mono-sc cursor-pointer rounded border border-[var(--line-strong)] px-2.5 py-0.5 text-[11px] transition-colors hover:bg-[var(--ink)] hover:text-[var(--paper)] disabled:cursor-default disabled:opacity-50"
								>
									{tasteBusy ? "保存中…" : "保存"}
								</button>
								<button
									type="button"
									onClick={() => setTasteDraft(null)}
									className="font-mono-sc cursor-pointer text-[11px] text-[var(--ink-3)] hover:text-[var(--ink)]"
								>
									算了
								</button>
								<span className="font-mono-sc ml-auto text-[10px] text-[var(--ink-3)] opacity-70">
									{tasteDraft.length}/{TASTE_MAX_CHARS} · 清空保存 = 删掉画像
								</span>
							</div>
						</div>
					) : taste ? (
						<p className="m-0 mt-1.5 whitespace-pre-wrap text-[13px] leading-relaxed text-[var(--ink-2)]">{taste.summary}</p>
					) : (
						<p className="m-0 mt-1.5 text-[12px] leading-relaxed text-[var(--ink-3)]">
							还没有。你在简报里的反馈(有用/没用/已知道/多找这种)攒够 10 条后,编辑会把它们蒸馏成一段长期口味备忘,
							每天选材前重读——写在这里,你随时能看、能改。
						</p>
					)}
					{taste && tasteDraft === null && (
						<p className="font-mono-sc m-0 mt-1.5 text-[10px] text-[var(--ink-3)] opacity-80">
							每天选材前编辑都会重读这段话;和追踪定义或近几天的反馈冲突时,以后者为准。你改过的说法在下次蒸馏时保留。
						</p>
					)}
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
						{(metrics.unhealthy ?? 0) > 0 && (
							<span className="text-[var(--accent)]">坏掉的源 {metrics.unhealthy} 个</span>
						)}
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
