import { useMemo, useState } from "react";
import { CATALOG } from "../shared/catalog";
import type { CatalogEntry } from "../shared/catalog";
import { CATEGORY_LABELS } from "./SourceLibrary";

// 精选目录浏览器:catalog.ts 那份人工验证过的 feed 目录,从「只进 AI 提示词」
// 开放成用户可以按主题自己挑的清单。来源库(全局添加)和档案页 04 节
// (添加并绑定当前定义)共用这一个组件,行为差异全在调用方的 onPick 里。

export default function CatalogPicker({
	existingUrls,
	onPick,
	note,
}: {
	/** 已经拥有的源 URL(来源库场景 = 全局池;档案页场景 = 该定义已选的源)。 */
	existingUrls: string[];
	onPick: (entry: CatalogEntry) => Promise<void>;
	/** 列表底部的一行说明,调用方解释「加入」在当前场景下的副作用。 */
	note?: string;
}) {
	const [topic, setTopic] = useState<string | null>(null);
	const [busyUrl, setBusyUrl] = useState<string | null>(null);
	const [doneUrls, setDoneUrls] = useState<string[]>([]);
	const [errs, setErrs] = useState<Record<string, string>>({});

	const topics = useMemo(() => {
		const counts = new Map<string, number>();
		for (const e of CATALOG) for (const t of e.topics) counts.set(t, (counts.get(t) ?? 0) + 1);
		return [...counts.entries()].sort((a, b) => b[1] - a[1]);
	}, []);

	const list = topic ? CATALOG.filter((e) => e.topics.includes(topic)) : CATALOG;
	const owned = new Set([...existingUrls, ...doneUrls]);

	const pick = async (entry: CatalogEntry) => {
		if (busyUrl) return;
		setBusyUrl(entry.url);
		setErrs((m) => ({ ...m, [entry.url]: "" }));
		try {
			await onPick(entry);
			setDoneUrls((u) => [...u, entry.url]);
		} catch (err) {
			setErrs((m) => ({ ...m, [entry.url]: err instanceof Error ? err.message : "加入失败" }));
		} finally {
			setBusyUrl(null);
		}
	};

	const chipCls = (active: boolean) =>
		`cursor-pointer rounded border px-2 py-0.5 text-[11px] transition-colors ${
			active
				? "border-[var(--ink)] bg-[var(--ink)] text-[var(--paper)]"
				: "border-[var(--line-strong)] text-[var(--ink-3)] hover:border-[var(--ink)] hover:text-[var(--ink)]"
		}`;

	return (
		<div className="mt-2 rounded-md border border-dashed border-[var(--line-strong)] bg-[var(--paper)] px-3 py-2.5">
			<div className="flex flex-wrap items-center gap-1.5">
				<button type="button" onClick={() => setTopic(null)} className={chipCls(topic === null)}>
					全部 {CATALOG.length}
				</button>
				{topics.map(([t, n]) => (
					<button key={t} type="button" onClick={() => setTopic(topic === t ? null : t)} className={chipCls(topic === t)}>
						{t} {n}
					</button>
				))}
			</div>
			<div className="mt-2 max-h-72 overflow-y-auto">
				{list.map((entry) => {
					const has = owned.has(entry.url);
					return (
						<div key={entry.url} className="border-b border-[var(--line)] py-1.5 last:border-0">
							<div className="flex flex-wrap items-center gap-2">
								<span className="min-w-30 text-[13px] font-medium">{entry.name}</span>
								<span className="font-mono-sc text-[10px] text-[var(--ink-3)]">
									{CATEGORY_LABELS[entry.category]} · {entry.lang === "zh" ? "中文" : "EN"} · {entry.topics.join(" ")}
								</span>
								{has ? (
									<span className="font-mono-sc ml-auto text-[10px] text-[var(--ok)]">✓ 已加入</span>
								) : (
									<button
										type="button"
										onClick={() => void pick(entry)}
										disabled={busyUrl !== null}
										className="font-mono-sc ml-auto cursor-pointer rounded border border-[var(--line-strong)] px-2 py-0.5 text-[10px] transition-colors hover:bg-[var(--ink)] hover:text-[var(--paper)] disabled:opacity-40"
									>
										{busyUrl === entry.url ? "验证中…" : "加入"}
									</button>
								)}
							</div>
							{errs[entry.url] && <p className="font-mono-sc m-0 mt-0.5 text-[10px] text-[var(--accent)]">✗ {errs[entry.url]}</p>}
						</div>
					);
				})}
				{list.length === 0 && <p className="font-mono-sc m-0 py-2 text-[11px] text-[var(--ink-3)]">这个主题下没有条目</p>}
			</div>
			{note && <p className="font-mono-sc m-0 mt-1.5 text-[10px] text-[var(--ink-3)]">{note}</p>}
		</div>
	);
}
