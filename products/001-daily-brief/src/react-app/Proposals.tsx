// S4 · 提案卡片:每周自评越线之后,编辑提的改法就摆在这里。
//
// 三条规矩体现在界面上:
//   1. **每条都写依据**——「依据」那一行是指标算出来的真数字,不是「AI 觉得」。
//      说不出依据的建议,用户第二次就不看了。
//   2. **沉默即同意,但看得见倒计时**——不处理 7 天后自动生效,剩几天写在脸上,
//      不搞「你没反对就是同意了」的暗箱。
//   3. **否决永远一键可达**,而且立刻生效。沉默即同意的前提是开口一定管用。

import { useEffect, useState } from "react";
import { apiPath } from "./paths";

interface Proposal {
	id: string;
	createdAt: string;
	week: string;
	targetName: string;
	summary: string;
	evidence: string;
	status: string;
}

function daysLeft(createdAt: string, coolingDays: number): number {
	const elapsed = (Date.now() - Date.parse(createdAt)) / 86_400_000;
	return Math.max(0, Math.ceil(coolingDays - elapsed));
}

export default function Proposals({ onApplied }: { onApplied: () => void }) {
	const [list, setList] = useState<Proposal[]>([]);
	const [cooling, setCooling] = useState(7);
	const [busy, setBusy] = useState<string | null>(null);

	useEffect(() => {
		void (async () => {
			try {
				const res = await fetch(apiPath("proposals"));
				if (!res.ok) return;
				const data = (await res.json()) as { proposals?: Proposal[]; coolingDays?: number };
				setList(data.proposals ?? []);
				if (data.coolingDays) setCooling(data.coolingDays);
			} catch {
				// 提案读不到不挡配置操作
			}
		})();
	}, []);

	const decide = async (id: string, action: "apply" | "dismiss") => {
		setBusy(id);
		try {
			await fetch(apiPath(`proposals/${id}`), {
				method: "POST",
				headers: { "content-type": "application/json" },
				body: JSON.stringify({ action }),
			});
			setList((l) => l.filter((p) => p.id !== id));
			if (action === "apply") onApplied();
		} finally {
			setBusy(null);
		}
	};

	if (list.length === 0) return null;

	return (
		<section className="mb-5 rounded-[10px] border border-[var(--accent)] bg-[var(--accent-soft)] px-5 py-4">
			<p className="font-mono-sc m-0 text-[10px] uppercase tracking-[0.08em] text-[var(--ink-3)]">
				每周自评 · 编辑提了 {list.length} 条改法
			</p>
			<div className="mt-3 space-y-3">
				{list.map((p) => {
					const left = daysLeft(p.createdAt, cooling);
					return (
						<div key={p.id} className="rounded-md bg-[var(--card)] px-4 py-3">
							<p className="m-0 text-[14px] font-medium">{p.summary}</p>
							<p className="m-0 mt-1 text-[12px] leading-relaxed text-[var(--ink-2)]">
								<span className="font-mono-sc mr-1.5 text-[10px] text-[var(--ink-3)]">依据</span>
								{p.evidence}
							</p>
							<div className="mt-2 flex flex-wrap items-center gap-3">
								<button
									type="button"
									disabled={busy === p.id}
									onClick={() => void decide(p.id, "apply")}
									className="font-mono-sc cursor-pointer rounded border border-[var(--line-strong)] px-2.5 py-0.5 text-[11px] transition-colors hover:bg-[var(--ink)] hover:text-[var(--paper)] disabled:opacity-40"
								>
									就这么办
								</button>
								<button
									type="button"
									disabled={busy === p.id}
									onClick={() => void decide(p.id, "dismiss")}
									className="font-mono-sc cursor-pointer text-[11px] text-[var(--ink-3)] hover:text-[var(--ink)] disabled:opacity-40"
								>
									不用
								</button>
								<span className="font-mono-sc ml-auto text-[10px] text-[var(--ink-3)]">
									{left > 0 ? `${left} 天后自动生效` : "即将自动生效"}
								</span>
							</div>
						</div>
					);
				})}
			</div>
			<p className="font-mono-sc m-0 mt-2.5 text-[10px] leading-relaxed text-[var(--ink-3)]">
				这些改法都来自纯计算的周指标,不是模型的临场判断。不处理就在 {cooling} 天后自动生效,生效会记进定义的变更记录,随时能改回去。
			</p>
		</section>
	);
}
