import type { ProposalItem } from "./editor";
import { CATEGORY_LABELS } from "./SourceLibrary";

// 编辑建议的候选来源卡:先看推荐理由和最近三条真实标题,再决定加入/不要。
// 档案页(Dossier 04 节)和向导第三步共用同一张卡——同一个决策,同一个样子。

export default function CandidateCard({
	cand,
	busy,
	onAdopt,
	onReject,
}: {
	cand: ProposalItem;
	busy?: boolean;
	onAdopt: () => void;
	onReject: () => void;
}) {
	return (
		<div className="mt-2 flex flex-col gap-1.5 rounded-md border border-dashed border-[var(--line-strong)] bg-[var(--paper)] px-3 py-2">
			<div className="flex flex-wrap items-center gap-2">
				<span className="font-mono-sc shrink-0 text-[10px] text-[var(--accent)]">编辑建议</span>
				<span className="min-w-30 text-[13px] font-medium">{cand.name}</span>
				<span className="font-mono-sc text-[10px] text-[var(--ink-3)]">
					{CATEGORY_LABELS[cand.category as keyof typeof CATEGORY_LABELS] ?? cand.category}
					{cand.ok ? ` · 30h 内 ${cand.fresh} 条` : " · 抓取失败"}
				</span>
				{cand.ok ? (
					<button
						type="button"
						onClick={onAdopt}
						disabled={busy}
						className="font-mono-sc ml-auto cursor-pointer rounded border border-[var(--ink)] bg-[var(--ink)] px-2 py-0.5 text-[10px] text-[var(--paper)] disabled:opacity-40"
					>
						加入
					</button>
				) : (
					<span className="font-mono-sc ml-auto text-[10px] text-[var(--accent)]">✗ {cand.error}</span>
				)}
				<button
					type="button"
					onClick={onReject}
					disabled={busy}
					className="font-mono-sc cursor-pointer text-[10px] text-[var(--ink-3)] transition-colors hover:text-[var(--accent)] disabled:opacity-40"
				>
					不要
				</button>
			</div>
			{cand.reason && <p className="m-0 text-[12px] text-[var(--ink-2)]">{cand.reason}</p>}
			{cand.latest && cand.latest.length > 0 && (
				<div className="border-l-2 border-[var(--line)] pl-2 text-[11px] text-[var(--ink-3)]">
					{cand.latest.slice(0, 3).map((item) => (
						<p key={item.title} className="m-0 truncate">
							· {item.title}
						</p>
					))}
				</div>
			)}
		</div>
	);
}
