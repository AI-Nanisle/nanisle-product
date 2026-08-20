// N3 · 想法页(docs/03-实施清单.md §3.8):想法台账的回溯入口。你在简报里留过
// 的每一票、每一段话都按日期记在这里,标题/链接是落账当时的快照——简报本身
// 90 天会过期,这一页不会。补记走的还是 /api/feedback 那根管子:旧账上的新想法
// 既进台账,也进近 7 天的反馈窗口,顺带影响明天的选材。

import { useCallback, useEffect, useMemo, useState } from "react";
import type { FeedbackKind, ItemNote, NoteEntry } from "../shared/types";
import { ISSUE_ITEM_ID } from "../shared/types";
import { ISSUE_NOTE_TITLE } from "../shared/notes";
import { apiPath } from "./paths";

const KIND_LABEL: Record<FeedbackKind, string> = {
	up: "👍 有用",
	down: "没用",
	want: "这条我要",
	known: "已知道",
	more: "多找这种",
	text: "",
};

function weekdayOf(date: string): string {
	const d = new Date(`${date}T12:00:00`);
	return ["星期日", "星期一", "星期二", "星期三", "星期四", "星期五", "星期六"][d.getDay()] ?? "";
}

function entryTime(at: string): string {
	return new Date(at).toLocaleString("zh-CN", {
		hour12: false,
		month: "2-digit",
		day: "2-digit",
		hour: "2-digit",
		minute: "2-digit",
	});
}

function hasText(note: ItemNote): boolean {
	return note.entries.some((e) => e.text);
}

function NoteCard({ note, onAppend }: { note: ItemNote; onAppend: (note: ItemNote, text: string) => Promise<void> }) {
	const [open, setOpen] = useState(false);
	const [text, setText] = useState("");
	const [sending, setSending] = useState(false);

	// 纯投票收成一行徽章;带文字的表态各占一段——回溯要读的是话,不是按钮
	const votes = note.entries.filter((e) => !e.text && e.kind !== "text");
	const texts = note.entries.filter((e): e is NoteEntry & { text: string } => Boolean(e.text));
	const title = note.itemId === ISSUE_ITEM_ID ? ISSUE_NOTE_TITLE : note.title;

	const send = async () => {
		const t = text.trim();
		if (!t || sending) return;
		setSending(true);
		try {
			await onAppend(note, t);
			setText("");
			setOpen(false);
		} finally {
			setSending(false);
		}
	};

	return (
		<article className="border-b border-[var(--line)] py-5 last:border-0">
			<div className="font-mono-sc mb-1.5 flex flex-wrap items-center gap-x-3 gap-y-1 text-[11px] text-[var(--ink-3)]">
				{note.sectionTitle && <span>{note.sectionTitle}</span>}
				{note.source && <span>{note.source}</span>}
				{votes.map((v) => (
					<span key={v.at} className="text-[var(--accent)]">
						✓ {KIND_LABEL[v.kind]}
					</span>
				))}
			</div>
			<h3 className="text-[16px] font-bold leading-[1.5]">
				{note.url ? (
					<a href={note.url} target="_blank" rel="noreferrer" className="headline-link">
						{title}
					</a>
				) : (
					<span>{title ?? "(这条的原文快照没能留下)"}</span>
				)}
			</h3>
			{texts.length > 0 && (
				<div className="mt-2 space-y-2">
					{texts.map((e) => (
						<p key={e.at} className="border-l-2 border-[var(--line-strong)] pl-3 text-[13.5px] leading-[1.85] text-[var(--ink-2)]">
							{e.text}
							<span className="font-mono-sc ml-2 text-[11px] text-[var(--ink-3)]">
								{entryTime(e.at)}
								{e.kind !== "text" && ` · ${KIND_LABEL[e.kind]}`}
							</span>
						</p>
					))}
				</div>
			)}
			<div className="mt-2.5">
				{open ? (
					<div className="flex gap-2">
						<input
							value={text}
							onChange={(e) => setText(e.target.value)}
							onKeyDown={(e) => e.key === "Enter" && void send()}
							placeholder="现在回头看,你怎么想?"
							className="flex-1 rounded-md border border-[var(--line)] bg-[var(--card)] px-3 py-1.5 text-sm outline-none focus:border-[var(--line-strong)]"
						/>
						<button
							type="button"
							onClick={() => void send()}
							className="font-mono-sc cursor-pointer rounded-md border border-[var(--line-strong)] px-3 text-[12px] transition-colors hover:bg-[var(--ink)] hover:text-[var(--paper)]"
						>
							{sending ? "…" : "补记"}
						</button>
					</div>
				) : (
					<button
						type="button"
						onClick={() => setOpen(true)}
						className="font-mono-sc cursor-pointer text-[12px] text-[var(--ink-3)] hover:text-[var(--ink)]"
					>
						补一条想法
					</button>
				)}
			</div>
		</article>
	);
}

export default function Notes() {
	const [notes, setNotes] = useState<ItemNote[] | null>(null);
	const [failed, setFailed] = useState(false);
	const [query, setQuery] = useState("");
	const [onlyText, setOnlyText] = useState(false);

	const load = useCallback(async () => {
		try {
			const res = await fetch(apiPath("notes"));
			if (!res.ok) throw new Error(String(res.status));
			setNotes(((await res.json()) as { notes: ItemNote[] }).notes);
		} catch {
			setFailed(true);
		}
	}, []);

	useEffect(() => {
		void load();
	}, [load]);

	const append = useCallback(async (note: ItemNote, text: string) => {
		const res = await fetch(apiPath("feedback"), {
			method: "POST",
			headers: { "content-type": "application/json" },
			body: JSON.stringify({ date: note.date, itemId: note.itemId, kind: "text", text }),
		});
		if (!res.ok) return;
		// 服务端已落账,本地照样拼一条,免得为一次补记整页重拉
		const entry: NoteEntry = { at: new Date().toISOString(), kind: "text", text };
		setNotes((prev) =>
			prev?.map((n) =>
				n.date === note.date && n.itemId === note.itemId
					? { ...n, entries: [...n.entries, entry], updatedAt: entry.at }
					: n,
			) ?? prev,
		);
	}, []);

	const shown = useMemo(() => {
		if (!notes) return [];
		const q = query.trim().toLowerCase();
		return notes.filter((n) => {
			if (onlyText && !hasText(n)) return false;
			if (!q) return true;
			const hay = [n.title, n.source, n.sectionTitle, ...n.entries.map((e) => e.text)]
				.filter(Boolean)
				.join("\n")
				.toLowerCase();
			return hay.includes(q);
		});
	}, [notes, query, onlyText]);

	// 按简报日期分组(接口已按日期倒序给)
	const groups = useMemo(() => {
		const out: { date: string; notes: ItemNote[] }[] = [];
		for (const n of shown) {
			const last = out.at(-1);
			if (last && last.date === n.date) last.notes.push(n);
			else out.push({ date: n.date, notes: [n] });
		}
		return out;
	}, [shown]);

	if (failed) {
		return <p className="font-mono-sc mt-10 text-center text-sm text-[var(--ink-3)]">想法页加载失败,稍后再试。</p>;
	}
	if (notes === null) {
		return <p className="font-mono-sc mt-10 animate-pulse text-center text-sm text-[var(--ink-3)]">翻账本…</p>;
	}

	return (
		<div className="mx-auto max-w-[672px]">
			{notes.length === 0 ? (
				<div className="mt-8 rounded-[10px] border border-dashed border-[var(--line-strong)] bg-[var(--card)] px-6 py-12 text-center">
					<p className="text-sm text-[var(--ink-2)]">这里还是空的。</p>
					<p className="mt-2 text-[13px] text-[var(--ink-3)]">
						在简报里点「有用 / 没用」、写下看法、从「已替你筛掉」里捞一条——都会记到这一页,
						日后想回看当时的判断,随时来翻。
					</p>
				</div>
			) : (
				<>
					<div className="mt-6 flex flex-wrap items-center gap-x-4 gap-y-2">
						<input
							value={query}
							onChange={(e) => setQuery(e.target.value)}
							placeholder="搜标题、来源或你写过的话"
							className="min-w-0 flex-1 rounded-md border border-[var(--line)] bg-[var(--card)] px-3 py-1.5 text-sm outline-none focus:border-[var(--line-strong)]"
						/>
						<button
							type="button"
							onClick={() => setOnlyText((v) => !v)}
							className={`font-mono-sc cursor-pointer text-[12px] transition-colors ${onlyText ? "text-[var(--accent)]" : "text-[var(--ink-3)] hover:text-[var(--ink)]"}`}
						>
							{onlyText ? "✓ 只看写了想法的" : "只看写了想法的"}
						</button>
					</div>

					{groups.length === 0 ? (
						<p className="font-mono-sc mt-10 text-center text-sm text-[var(--ink-3)]">没有匹配的记录。</p>
					) : (
						groups.map((g) => (
							<section key={g.date} className="mt-8 rounded-[10px] border border-[var(--line)] bg-[var(--card)] px-7 pb-1">
								<div className="flex items-baseline gap-3 border-b border-[var(--line)] pt-4 pb-3">
									<span className="font-mono-sc text-[11px] text-[var(--accent)]">{g.date}</span>
									<h2 className="text-[15px] font-bold tracking-[0.06em]">{weekdayOf(g.date)}</h2>
									<span className="font-mono-sc ml-auto text-[11px] text-[var(--ink-3)]">{g.notes.length} 条</span>
								</div>
								{g.notes.map((n) => (
									<NoteCard key={`${n.date}:${n.itemId}`} note={n} onAppend={append} />
								))}
							</section>
						))
					)}
				</>
			)}
		</div>
	);
}
