import { useEffect, useRef, useState } from "react";
import type { FocusEntry, SourceConfig } from "../shared/pipeline-core";
import { apiPath } from "./paths";

// 与 worker 的 ChatEvent 对应(src/worker/chat.ts)。
export interface ProposalItem {
	name: string;
	url: string;
	category: string;
	reason?: string;
	ok: boolean;
	total?: number;
	fresh?: number;
	latest?: { title: string; publishedAt: string | null }[];
	error?: string;
}

type AdoptState = "idle" | "adding" | "added" | "failed";

type Entry =
	| { kind: "user"; text: string }
	| { kind: "ai"; text: string }
	| { kind: "tool"; label: string; summary?: string; name: string }
	| { kind: "proposal"; items: ProposalItem[]; adopt: Record<string, AdoptState> }
	| { kind: "notice"; text: string }
	| { kind: "error"; text: string };

const SUGGESTIONS = [
	"帮我加几个 AI 创业方向的信息源",
	"把最近一直没更新的源清理掉",
	"我最近在研究 Cloudflare Workers,调整下关注点",
];

const CATEGORY_LABELS: Record<string, string> = {
	news: "新闻",
	macro: "宏观",
	blog: "博客",
	podcast: "播客",
	paper: "论文",
};

interface ChatProps {
	headers: () => Record<string, string>;
	provider: string | null;
	onConfig: (sources: SourceConfig[], focus: FocusEntry[]) => void;
	/** 采纳推荐卡片里的源:走 /api/sources/add(带试抓验证),返回失败原因。 */
	addSources: (
		items: { name: string; url: string; category: string }[],
	) => Promise<{ addedUrls: string[]; failed: { url: string; error: string }[] }>;
}

export default function Chat({ headers, provider, onConfig, addSources }: ChatProps) {
	const [entries, setEntries] = useState<Entry[]>([]);
	const [input, setInput] = useState("");
	const [busy, setBusy] = useState(false);
	const scrollRef = useRef<HTMLDivElement>(null);

	useEffect(() => {
		const el = scrollRef.current;
		if (el) el.scrollTop = el.scrollHeight;
	}, [entries, busy]);

	const push = (e: Entry) => setEntries((prev) => [...prev, e]);

	const handleEvent = (ev: Record<string, unknown>) => {
		switch (ev.type) {
			case "text":
				push({ kind: "ai", text: String(ev.text ?? "") });
				break;
			case "tool":
				push({ kind: "tool", name: String(ev.name ?? ""), label: String(ev.label ?? "") });
				break;
			case "tool_result":
				// 给最近一条同名、还没有结果的工具行补上执行结果
				setEntries((prev) => {
					const next = [...prev];
					for (let i = next.length - 1; i >= 0; i--) {
						const e = next[i];
						if (e.kind === "tool" && e.name === ev.name && e.summary === undefined) {
							next[i] = { ...e, summary: String(ev.summary ?? "") };
							break;
						}
					}
					return next;
				});
				break;
			case "proposal":
				push({ kind: "proposal", items: (ev.items ?? []) as ProposalItem[], adopt: {} });
				break;
			case "config":
				onConfig(ev.sources as SourceConfig[], ev.focus as FocusEntry[]);
				break;
			case "notice":
				push({ kind: "notice", text: String(ev.text ?? "") });
				break;
			case "error":
				push({ kind: "error", text: String(ev.error ?? "出错了") });
				break;
		}
	};

	const send = async (text?: string) => {
		const content = (text ?? input).trim();
		if (!content || busy) return;
		setInput("");
		setBusy(true);
		// 历史只带用户和 AI 的文字轮次(工具行/卡片是展示层,配置状态服务端自己有)
		const history = [
			...entries
				.filter((e): e is Extract<Entry, { kind: "user" | "ai" }> => e.kind === "user" || e.kind === "ai")
				.map((e) => ({ role: e.kind === "user" ? "user" : "assistant", content: e.text })),
			{ role: "user", content },
		].slice(-30);
		push({ kind: "user", text: content });
		try {
			const res = await fetch(apiPath("chat"), {
				method: "POST",
				headers: { "content-type": "application/json", ...headers() },
				body: JSON.stringify({ messages: history }),
			});
			if (!res.ok || !res.body) {
				const data = (await res.json().catch(() => ({}))) as { error?: string };
				push({ kind: "error", text: data.error ?? `HTTP ${res.status}` });
				return;
			}
			const reader = res.body.getReader();
			const decoder = new TextDecoder();
			let buf = "";
			for (;;) {
				const { done, value } = await reader.read();
				if (done) break;
				buf += decoder.decode(value, { stream: true });
				let idx: number;
				while ((idx = buf.indexOf("\n")) >= 0) {
					const line = buf.slice(0, idx).trim();
					buf = buf.slice(idx + 1);
					if (!line) continue;
					try {
						handleEvent(JSON.parse(line) as Record<string, unknown>);
					} catch {
						// 半截行/非 JSON——忽略,不让一条坏行毁掉整个流
					}
				}
			}
		} catch {
			push({ kind: "error", text: "网络错误,请重试" });
		} finally {
			setBusy(false);
		}
	};

	const adopt = async (entryIdx: number, items: ProposalItem[]) => {
		const urls = items.map((i) => i.url);
		const mark = (state: AdoptState, only?: string[]) =>
			setEntries((prev) =>
				prev.map((e, i) => {
					if (i !== entryIdx || e.kind !== "proposal") return e;
					const adopt = { ...e.adopt };
					for (const u of only ?? urls) adopt[u] = state;
					return { ...e, adopt };
				}),
			);
		mark("adding");
		try {
			const { addedUrls, failed } = await addSources(
				items.map((i) => ({ name: i.name, url: i.url, category: i.category })),
			);
			mark("added", addedUrls);
			mark("failed", failed.map((f) => f.url));
			// 没回音的(理论上不会有)恢复可点
			mark(
				"idle",
				urls.filter((u) => !addedUrls.includes(u) && !failed.some((f) => f.url === u)),
			);
		} catch {
			mark("idle");
		}
	};

	const empty = entries.length === 0;

	return (
		<div className="flex flex-col rounded-[10px] bg-[var(--card)] border border-[var(--line)] h-[70vh] min-h-[480px] max-h-[780px]">
			{/* 标头:状态灯 + 仪表读数 */}
			<div className="flex items-center gap-2.5 border-b border-[var(--line)] px-4 py-2.5">
				<span className={`dot ${busy ? "dot-accent dot-busy" : "dot-on"}`} />
				<span className="text-[14px] font-bold tracking-wide">配置对话</span>
				<span className="ml-auto font-mono-sc text-[11px] uppercase tracking-wider text-[var(--ink-3)]">
					agent · {provider ?? "…"}
				</span>
			</div>

			{provider === "mock" && (
				<div className="border-b border-[var(--line)] bg-[var(--accent-soft)] px-4 py-2 text-[13px] text-[var(--accent)]">
					AI 尚未接入(mock 模式)。对话暂时不可用,右侧面板手动配置一切照常。
				</div>
			)}

			{/* 消息流 */}
			<div ref={scrollRef} className="chat-scroll flex-1 overflow-y-auto px-4 py-4">
				{empty && (
					<div className="flex h-full flex-col justify-end gap-4 pb-2">
						<p className="text-[14px] leading-relaxed text-[var(--ink-2)]">
							说出你想看什么,我来配置信息源:可以给具体网址(主页也行,我会自动找
							feed),也可以只说方向,我推荐、试抓、你确认。
						</p>
						<div className="flex flex-col items-start gap-2">
							{SUGGESTIONS.map((s) => (
								<button
									key={s}
									type="button"
									onClick={() => void send(s)}
									className="rounded-md border border-dashed border-[var(--line-strong)] px-3 py-1.5 text-[13px] text-[var(--ink-2)] transition-colors hover:border-[var(--accent)] hover:text-[var(--accent)] cursor-pointer"
								>
									{s}
								</button>
							))}
						</div>
					</div>
				)}

				<div className="space-y-3">
					{entries.map((e, idx) => {
						switch (e.kind) {
							case "user":
								return (
									<div key={idx} className="flex justify-end">
										<div className="max-w-[85%] rounded-lg bg-[var(--ink)] px-3.5 py-2 text-[14px] leading-relaxed text-[var(--paper)] whitespace-pre-wrap">
											{e.text}
										</div>
									</div>
								);
							case "ai":
								return (
									<div key={idx} className="max-w-[92%] text-[14px] leading-relaxed whitespace-pre-wrap">
										{e.text}
									</div>
								);
							case "tool":
								return (
									<div key={idx} className="font-mono-sc text-[12px] text-[var(--ink-3)]">
										<span className="text-[var(--accent)]">▸</span> {e.label}
										{e.summary !== undefined ? (
											<span className="text-[var(--ink-2)]"> — {e.summary}</span>
										) : (
											<span className="dot-busy inline-block"> …</span>
										)}
									</div>
								);
							case "proposal":
								return <ProposalCard key={idx} entryIdx={idx} items={e.items} adopt={e.adopt} onAdopt={adopt} />;
							case "notice":
								return (
									<div key={idx} className="rounded-md border border-[var(--line)] bg-[var(--paper-deep)] px-3 py-2 text-[13px] leading-relaxed text-[var(--ink-2)]">
										{e.text}
									</div>
								);
							case "error":
								return (
									<div key={idx} className="font-mono-sc text-[13px] text-[var(--accent)]">
										✗ {e.text}
									</div>
								);
						}
					})}
					{busy && (
						<div className="pt-1">
							<span className="caret" />
						</div>
					)}
				</div>
			</div>

			{/* 输入行 */}
			<div className="flex items-center gap-2 border-t border-[var(--line)] px-4 py-3">
				<span className="font-mono-sc text-[14px] text-[var(--accent)]">›</span>
				<input
					value={input}
					onChange={(e) => setInput(e.target.value)}
					onKeyDown={(e) => {
						if (e.key === "Enter" && !e.nativeEvent.isComposing) void send();
					}}
					placeholder={busy ? "执行中…" : "想看什么、不想看什么,直接说"}
					disabled={busy}
					className="min-w-0 flex-1 bg-transparent text-[14px] outline-none disabled:opacity-50"
				/>
				<button
					type="button"
					onClick={() => void send()}
					disabled={busy || !input.trim()}
					className="font-mono-sc cursor-pointer rounded-md border border-[var(--line-strong)] px-3 py-1.5 text-[12px] transition-colors hover:bg-[var(--ink)] hover:text-[var(--paper)] disabled:cursor-default disabled:opacity-40"
				>
					发送
				</button>
			</div>
		</div>
	);
}

function ProposalCard({
	entryIdx,
	items,
	adopt,
	onAdopt,
}: {
	entryIdx: number;
	items: ProposalItem[];
	adopt: Record<string, AdoptState>;
	onAdopt: (entryIdx: number, items: ProposalItem[]) => Promise<void>;
}) {
	const pending = items.filter((i) => i.ok && (adopt[i.url] ?? "idle") === "idle");
	return (
		<div className="rounded-lg border border-[var(--line)] bg-[var(--paper)]">
			<div className="flex items-center gap-2 border-b border-[var(--line)] px-3 py-1.5">
				<span className="font-mono-sc text-[11px] uppercase tracking-wider text-[var(--ink-3)]">
					推荐源 · 已试抓验证
				</span>
				{pending.length > 1 && (
					<button
						type="button"
						onClick={() => void onAdopt(entryIdx, pending)}
						className="font-mono-sc ml-auto cursor-pointer text-[12px] text-[var(--accent)] hover:underline"
					>
						全部添加({pending.length})
					</button>
				)}
			</div>
			<div className="divide-y divide-[var(--line)]">
				{items.map((item) => {
					const state = item.ok ? (adopt[item.url] ?? "idle") : "failed";
					return (
						<div key={item.url} className="px-3 py-2">
							<div className="flex items-center gap-2">
								<span className={`dot ${item.ok ? "dot-on" : "dot-off"}`} />
								<span className="text-[14px] font-medium">{item.name}</span>
								<span className="font-mono-sc text-[11px] text-[var(--ink-3)]">
									{CATEGORY_LABELS[item.category] ?? item.category}
								</span>
								{item.ok ? (
									<span className="font-mono-sc ml-auto shrink-0 text-[11px] text-[var(--ink-3)]">
										30h 内 {item.fresh} 条
									</span>
								) : (
									<span className="font-mono-sc ml-auto shrink-0 text-[11px] text-[var(--accent)]">
										✗ {item.error}
									</span>
								)}
								{item.ok && state === "idle" && (
									<button
										type="button"
										onClick={() => void onAdopt(entryIdx, [item])}
										className="font-mono-sc shrink-0 cursor-pointer rounded border border-[var(--line-strong)] px-2 py-0.5 text-[11px] transition-colors hover:bg-[var(--ink)] hover:text-[var(--paper)]"
									>
										添加
									</button>
								)}
								{state === "adding" && (
									<span className="font-mono-sc shrink-0 text-[11px] text-[var(--ink-3)]">…</span>
								)}
								{state === "added" && (
									<span className="font-mono-sc shrink-0 text-[11px] text-[var(--ok)]">✓ 已添加</span>
								)}
								{item.ok && state === "failed" && (
									<span className="font-mono-sc shrink-0 text-[11px] text-[var(--accent)]">添加失败</span>
								)}
							</div>
							{item.reason && <p className="mt-1 pl-4 text-[13px] text-[var(--ink-2)]">{item.reason}</p>}
							{item.ok && item.latest && item.latest.length > 0 && (
								<p className="font-mono-sc mt-0.5 truncate pl-4 text-[12px] text-[var(--ink-3)]">
									最新:{item.latest[0].title}
								</p>
							)}
							<p className="font-mono-sc mt-0.5 truncate pl-4 text-[11px] text-[var(--ink-3)] opacity-70">
								{item.url}
							</p>
						</div>
					);
				})}
			</div>
		</div>
	);
}
