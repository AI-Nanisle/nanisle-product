import { useState } from "react";
import type { SourceCategory, SourceConfig } from "../shared/pipeline-core";
import type { TestResult } from "./editor";

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

	const enabledCount = sources.filter((s) => s.enabled !== false).length;

	const manualAdd = async () => {
		if (!draft.name.trim() || !draft.url.trim() || busy) return;
		setBusy(true);
		setMsg("");
		try {
			const { addedUrls, failed } = await onAdd([draft]);
			if (addedUrls.length > 0) {
				setDraft({ name: "", url: "", category: draft.category });
				setAdding(false);
			} else {
				setMsg(failed[0]?.error ?? "添加失败");
			}
		} catch (err) {
			setMsg(err instanceof Error ? err.message : "添加失败");
		} finally {
			setBusy(false);
		}
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
								<button
									type="button"
									onClick={() => onSources(sources.filter((_, j) => j !== i))}
									className="font-mono-sc shrink-0 cursor-pointer text-[10px] text-[var(--ink-3)] hover:text-[var(--accent)]"
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

			{/* 手动添加:服务端自动做 feed 发现与试抓验证 */}
			<div className="mt-4 border-t border-[var(--line)] pt-4">
				{adding ? (
					<div className="space-y-2">
						<div className="flex flex-wrap gap-2">
							<input
								value={draft.name}
								onChange={(e) => setDraft({ ...draft, name: e.target.value })}
								placeholder="源名称"
								className={`${inputCls} w-36`}
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
								}}
								className="font-mono-sc cursor-pointer px-1 text-[11px] text-[var(--ink-3)] hover:text-[var(--ink)]"
							>
								取消
							</button>
						</div>
						{msg && <p className="font-mono-sc text-[11px] text-[var(--accent)]">✗ {msg}</p>}
					</div>
				) : (
					<button
						type="button"
						onClick={() => setAdding(true)}
						className="cursor-pointer rounded border border-dashed border-[var(--line-strong)] px-3 py-1.5 text-[12px] text-[var(--ink-2)] transition-colors hover:border-[var(--accent)] hover:text-[var(--accent)]"
					>
						+ 手动添加一个源
					</button>
				)}
			</div>
		</div>
	);
}
