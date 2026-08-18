import { useState } from "react";
import { MAX_INTENT_SEGMENTS, MAX_TRACKER_QUOTA, joinSegments, trackerSegments } from "../shared/pipeline-core";
import type { IntentSegment, SourceConfig, Tracker, TrackerSourceRule } from "../shared/pipeline-core";
import type { ProposalItem, TestResult } from "./editor";
import { CATEGORY_LABELS } from "./SourceLibrary";
import CandidateCard from "./CandidateCard";

// 追踪定义档案:一份定义 = 一页文档,读起来像编辑写给你的稿子,
// 但每一处虚线都能当场圈改。四节的顺序就是信任链——
// 01 你的原话(AI 不动) → 02 编辑的理解 → 03 收/不收 → 04 具体到哪个源。
// 所有改动即改即存,并留一行变更记录:让人看得见系统按谁的话在跑。

/** 「收/不收」里的一枚标签。带 sourceKey 的是只作用于某个来源的局部规则。 */
export interface Chip {
	text: string;
	scope?: string;
	sourceKey?: string;
}

const monoLabel = "font-mono-sc text-[10px] uppercase tracking-[0.08em]";
const sectionLabel = `${monoLabel} text-[var(--accent)]`;
const ghostBtn = "font-mono-sc cursor-pointer text-[10px] text-[var(--ink-3)] transition-colors";

function mmdd(iso: string): string {
	const d = new Date(iso);
	if (Number.isNaN(d.getTime())) return iso.slice(0, 10);
	return `${String(d.getMonth() + 1).padStart(2, "0")}-${String(d.getDate()).padStart(2, "0")}`;
}

/** 回车提交、Esc 放弃的小输入框——档案和向导里所有就地编辑都走它。 */
export function InlineInput({
	value,
	accent,
	multiline,
	placeholder,
	className,
	onCommit,
	onCancel,
}: {
	value: string;
	accent?: boolean;
	multiline?: boolean;
	placeholder?: string;
	className?: string;
	onCommit: (next: string) => void;
	onCancel: () => void;
}) {
	const [draft, setDraft] = useState(value);
	const base = `rounded border bg-[var(--paper)] px-1.5 py-0.5 font-[inherit] outline-none ${
		accent ? "border-[var(--accent)]" : "border-[var(--line-strong)]"
	} ${className ?? ""}`;
	const keys = (e: { key: string; shiftKey: boolean; preventDefault: () => void }) => {
		if (e.key === "Escape") onCancel();
		else if (e.key === "Enter" && !(multiline && e.shiftKey)) {
			e.preventDefault();
			onCommit(draft);
		}
	};
	if (multiline) {
		return (
			<textarea
				autoFocus
				rows={3}
				value={draft}
				placeholder={placeholder}
				onChange={(e) => setDraft(e.target.value)}
				onKeyDown={keys}
				onBlur={() => onCommit(draft)}
				className={`${base} w-full resize-y leading-relaxed`}
			/>
		);
	}
	return (
		<input
			autoFocus
			value={draft}
			placeholder={placeholder}
			onChange={(e) => setDraft(e.target.value)}
			onKeyDown={keys}
			onBlur={() => onCommit(draft)}
			className={base}
		/>
	);
}

/** 标签行:回车添加,× 删除。收(墨)与不收(朱)只差配色。向导第二步也用它。 */
export function ChipRow({
	chips,
	accent,
	open,
	onOpen,
	onClose,
	onAdd,
	onRemove,
}: {
	chips: Chip[];
	accent?: boolean;
	open: boolean;
	onOpen: () => void;
	onClose: () => void;
	onAdd: (text: string) => void;
	onRemove: (chip: Chip) => void;
}) {
	return (
		<div className="flex flex-wrap items-center gap-1.5">
			{chips.map((c) => (
				<span
					key={`${c.sourceKey ?? ""}:${c.text}`}
					className={`inline-flex items-center gap-1 rounded px-2 py-0.5 text-[12px] ${
						accent ? "bg-[var(--accent-soft)] text-[var(--accent)]" : "bg-[var(--paper-deep)] text-[var(--ink)]"
					}`}
				>
					{c.text}
					{c.scope && <span className="font-mono-sc text-[10px] opacity-80">{c.scope}</span>}
					<button
						type="button"
						onClick={() => onRemove(c)}
						aria-label={`删除 ${c.text}`}
						className="cursor-pointer opacity-50 transition-opacity hover:opacity-100"
					>
						×
					</button>
				</span>
			))}
			{open ? (
				<InlineInput
					value=""
					accent={accent}
					placeholder="回车添加"
					className="w-28 text-[12px]"
					onCommit={(v) => {
						const t = v.trim();
						if (t) onAdd(t);
						onClose();
					}}
					onCancel={onClose}
				/>
			) : (
				<button
					type="button"
					onClick={onOpen}
					className={`cursor-pointer rounded border border-dashed border-[var(--line-strong)] px-2 py-0.5 text-[12px] text-[var(--ink-3)] transition-colors ${
						accent ? "hover:border-[var(--accent)] hover:text-[var(--accent)]" : "hover:border-[var(--ink)] hover:text-[var(--ink)]"
					}`}
				>
					+
				</button>
			)}
		</div>
	);
}

export interface DossierProps {
	tracker: Tracker;
	/** 展示用编号(按定义在列表里的位置),不是存储 key。 */
	docId: string;
	sources: SourceConfig[];
	provider: string | null;
	tests: Record<string, TestResult | "testing">;
	/** 编辑刚找到的候选来源(未落库,采纳后才写进定义)。 */
	candidates: ProposalItem[];
	editorBusy: boolean;
	editorNote: string;
	onPatch: (patch: Partial<Tracker>, log?: string) => void;
	onDelete: () => void;
	onTest: (url: string) => void;
	onFindMore: () => void;
	onAdoptCandidate: (item: ProposalItem) => void;
	onRejectCandidate: (item: ProposalItem) => void;
	/** 把一句话交给编辑(真 AI 时才走网络;mock 由本页就地起草提案)。 */
	onSay: (text: string) => void;
}

export default function Dossier({
	tracker: t,
	docId,
	sources,
	provider,
	tests,
	candidates,
	editorBusy,
	editorNote,
	onPatch,
	onDelete,
	onTest,
	onFindMore,
	onAdoptCandidate,
	onRejectCandidate,
	onSay,
}: DossierProps) {
	const [editKey, setEditKey] = useState<string | null>(null);
	// 哪一个标签输入框开着:"inc"/"exc" 是这份定义的全局标签,
	// "inc:<sourceKey>" 是某个来源的局部规则——同名会串,所以带上来源。
	const [chipOpen, setChipOpen] = useState<string | null>(null);
	const [sayText, setSayText] = useState("");
	const [proposal, setProposal] = useState<{ quote: string; kind: "inc" | "exc" } | null>(null);
	const [ruleOpen, setRuleOpen] = useState<string | null>(null);
	const [pickOpen, setPickOpen] = useState(false);

	const segments = trackerSegments(t);
	const paused = t.enabled === false;
	const selectedKeys =
		t.sourceMode === "selected" ? (t.sourceKeys ?? []) : sources.filter((s) => s.enabled !== false).map((s) => s.key);
	const selectedSources = selectedKeys
		.map((key) => sources.find((s) => s.key === key))
		.filter((s): s is SourceConfig => Boolean(s));
	const sourceName = (key: string) => sources.find((s) => s.key === key)?.name ?? key;

	// ---------- 02 编辑的理解 ----------

	const putSegments = (next: IntentSegment[], log: string) =>
		onPatch({ intentSegments: next, intent: joinSegments(next) }, log);

	const commitSegment = (idx: number, value: string) => {
		setEditKey(null);
		const v = value.trim();
		const before = segments[idx]?.text ?? "";
		if (v === before) return;
		if (!v) {
			putSegments(
				segments.filter((_, j) => j !== idx),
				`你删掉了理解里的「${before}」`,
			);
			return;
		}
		putSegments(
			segments.map((s, j) => (j === idx ? { text: v, edited: true } : s)),
			before ? `你圈改了编辑的理解:「${before}」→「${v}」` : `你写了一句理解:「${v}」`,
		);
	};

	const addSegment = (value: string) => {
		setEditKey(null);
		const v = value.trim();
		if (!v) return;
		putSegments([...segments, { text: v, edited: true }], `你给理解加了一句:「${v}」`);
	};

	// ---------- 03 收 / 不收 ----------

	const scopedChips = (kind: "include" | "exclude"): Chip[] =>
		(t.sourceRules ?? []).flatMap((rule) =>
			(rule[kind] ?? []).map((text) => ({ text, scope: `仅 ${sourceName(rule.sourceKey)}`, sourceKey: rule.sourceKey })),
		);
	const includeChips: Chip[] = [...(t.include ?? []).map((text) => ({ text })), ...scopedChips("include")];
	const excludeChips: Chip[] = [...(t.exclude ?? []).map((text) => ({ text })), ...scopedChips("exclude")];

	const addChip = (kind: "include" | "exclude", text: string) => {
		const current = t[kind] ?? [];
		if (current.includes(text)) return;
		onPatch(
			{ [kind]: [...current, text] },
			`你在「${kind === "include" ? "收什么" : "不收什么"}」加了「${text}」`,
		);
	};

	const removeChip = (kind: "include" | "exclude", chip: Chip) => {
		const label = kind === "include" ? "收什么" : "不收什么";
		if (!chip.sourceKey) {
			onPatch({ [kind]: (t[kind] ?? []).filter((x) => x !== chip.text) }, `你从「${label}」删掉了「${chip.text}」`);
			return;
		}
		const rules = (t.sourceRules ?? [])
			.map((rule): TrackerSourceRule =>
				rule.sourceKey === chip.sourceKey ? { ...rule, [kind]: (rule[kind] ?? []).filter((x) => x !== chip.text) } : rule,
			)
			.filter((rule) => (rule.include?.length ?? 0) + (rule.exclude?.length ?? 0) > 0);
		onPatch({ sourceRules: rules }, `你取消了「${sourceName(chip.sourceKey)}」上的${label}规则「${chip.text}」`);
	};

	// ---------- 04 指定信源 ----------

	const updateRule = (sourceKey: string, patch: Partial<TrackerSourceRule>, log: string) => {
		const current = t.sourceRules ?? [];
		const existing = current.find((rule) => rule.sourceKey === sourceKey);
		const next: TrackerSourceRule = { sourceKey, ...existing, ...patch };
		const kept = (next.include?.length ?? 0) + (next.exclude?.length ?? 0) > 0;
		onPatch(
			{
				sourceRules: kept
					? [...current.filter((rule) => rule.sourceKey !== sourceKey), next]
					: current.filter((rule) => rule.sourceKey !== sourceKey),
			},
			log,
		);
	};

	const ruleText = (source: SourceConfig): { text: string; accent: boolean } => {
		const rule = t.sourceRules?.find((r) => r.sourceKey === source.key);
		const parts: string[] = [];
		if (rule?.include?.length) parts.push(`只收:${rule.include.join("、")}`);
		if (rule?.exclude?.length) parts.push(`不收:${rule.exclude.join("、")}`);
		return { text: parts.join(" · ") || "无局部规则", accent: Boolean(rule?.exclude?.length) };
	};

	const statText = (source: SourceConfig): string => {
		const test = tests[source.url];
		if (test === "testing") return "抓取中…";
		if (!test) return CATEGORY_LABELS[source.category];
		return test.ok ? `30h 内 ${test.fresh} 条` : "抓取失败";
	};

	// ---------- 对编辑说一句 ----------

	const say = () => {
		const v = sayText.trim();
		if (!v) return;
		if (provider && provider !== "mock") {
			onSay(v);
			setSayText("");
			return;
		}
		// AI 未接入时不假装联网:按语气就地起草一条提案,用户点「应用」才真正落库。
		setProposal({ quote: v, kind: /不|别|排除|过滤|少/.test(v) ? "exc" : "inc" });
	};

	const applyProposal = () => {
		if (!proposal) return;
		const value = proposal.quote.replace(/^(不要|不看|别|排除|过滤)/, "").trim() || proposal.quote;
		const kind = proposal.kind === "exc" ? "exclude" : "include";
		onPatch(
			{ [kind]: [...(t[kind] ?? []), value] },
			`你说「${proposal.quote}」→ 已写进${proposal.kind === "exc" ? "不收什么" : "收什么"}`,
		);
		setProposal(null);
		setSayText("");
	};

	return (
		<div className={`rounded-[10px] border border-[var(--line)] bg-[var(--card)] px-8 py-7 ${paused ? "opacity-60" : ""}`}>
			{/* 报头行 */}
			<div className="flex flex-wrap items-baseline gap-x-3 gap-y-1">
				<span className={`${monoLabel} text-[var(--ink-3)]`}>追踪定义 · {docId}</span>
				{t.builtin && (
					<span className="font-mono-sc rounded border border-[var(--line)] px-1 text-[10px] text-[var(--ink-3)]">内置</span>
				)}
				{paused && <span className="font-mono-sc text-[10px] text-[var(--accent)]">已停用</span>}
				<span className="ml-auto flex items-baseline gap-2">
					<select
						value={Math.min(t.quota, MAX_TRACKER_QUOTA)}
						onChange={(e) => onPatch({ quota: Number(e.target.value) }, `你把每期上限改成 ${e.target.value} 条`)}
						title="这份定义每期最多几条"
						className="font-mono-sc cursor-pointer border-0 bg-transparent text-[10px] text-[var(--ink-3)] outline-none"
					>
						{Array.from({ length: MAX_TRACKER_QUOTA }, (_, n) => n + 1).map((n) => (
							<option key={n} value={n}>
								{n}条/期
							</option>
						))}
					</select>
					{t.changelog?.[0] && (
						<span className="font-mono-sc text-[10px] text-[var(--ink-3)]">· {mmdd(t.changelog[0].at)} 有更新</span>
					)}
					<button
						type="button"
						onClick={() => onPatch({ enabled: paused ? undefined : false }, paused ? "你重新启用了这份定义" : "你停用了这份定义")}
						className={`${ghostBtn} hover:text-[var(--ink)]`}
					>
						{paused ? "启用" : "停用"}
					</button>
					<button type="button" onClick={onDelete} className={`${ghostBtn} hover:text-[var(--accent)]`}>
						删除
					</button>
				</span>
			</div>

			{/* 定义名 = 简报里的分区标题,点一下就能改 */}
			{editKey === "name" ? (
				<InlineInput
					value={t.name}
					className="mt-2 w-full text-[26px] font-black tracking-wide"
					onCommit={(v) => {
						setEditKey(null);
						const name = v.trim();
						if (name && name !== t.name) onPatch({ name }, `你把定义改名为「${name}」`);
					}}
					onCancel={() => setEditKey(null)}
				/>
			) : (
				<h2
					onClick={() => setEditKey("name")}
					title="点击改名"
					className="mt-2 cursor-text text-[28px] font-black leading-tight tracking-wide"
				>
					{t.name || <span className="text-[var(--ink-3)]">未命名定义</span>}
				</h2>
			)}
			<div className="rule-double mt-4 h-[5px]" />

			{/* 对编辑说一句 */}
			<div className="mt-4 flex items-center gap-2 rounded-lg bg-[var(--paper-deep)] px-3.5 py-2">
				<span className="font-mono-sc text-[14px] text-[var(--accent)]">›</span>
				<input
					value={sayText}
					onChange={(e) => setSayText(e.target.value)}
					onKeyDown={(e) => {
						if (e.key === "Enter" && !e.nativeEvent.isComposing) say();
					}}
					disabled={editorBusy}
					placeholder="对编辑说一句,这份定义会当场更新:比如「别只盯工具类 SaaS」"
					className="min-w-0 flex-1 bg-transparent text-[13px] outline-none disabled:opacity-50"
				/>
				<button
					type="button"
					onClick={say}
					disabled={editorBusy || !sayText.trim()}
					className="font-mono-sc cursor-pointer rounded border border-[var(--line-strong)] px-2.5 py-1 text-[11px] transition-colors hover:bg-[var(--ink)] hover:text-[var(--paper)] disabled:cursor-default disabled:opacity-40"
				>
					发送
				</button>
			</div>

			{/* 编辑处理中(一次结构化调用,几秒即回,无需回放过程) */}
			{editorBusy && (
				<p className="font-mono-sc mt-2 px-1 text-[11px] leading-relaxed text-[var(--ink-3)]">
					<span className="text-[var(--accent)]">▸</span> 编辑处理中… <span className="caret" />
				</p>
			)}
			{editorNote && (
				<p className="mt-2 rounded-lg border border-[var(--line)] bg-[var(--paper-deep)] px-3.5 py-2 text-[12px] leading-relaxed text-[var(--ink-2)]">
					{editorNote}
				</p>
			)}
			{proposal && (
				<div className="mt-2 flex flex-wrap items-center gap-2.5 rounded-lg border border-dashed border-[var(--accent)] bg-[var(--accent-soft)] px-3.5 py-2.5">
					<span className="font-mono-sc shrink-0 text-[10px] text-[var(--accent)]">编辑的修改提案</span>
					<span className="min-w-50 flex-1 text-[13px]">
						把「{proposal.quote}」写进 <strong>{proposal.kind === "exc" ? "不收什么" : "收什么"}</strong>
					</span>
					<button
						type="button"
						onClick={applyProposal}
						className="font-mono-sc cursor-pointer rounded border border-[var(--ink)] bg-[var(--ink)] px-2.5 py-1 text-[10px] text-[var(--paper)]"
					>
						应用
					</button>
					<button type="button" onClick={() => setProposal(null)} className={`${ghostBtn} hover:text-[var(--accent)]`}>
						算了
					</button>
				</div>
			)}

			{/* 01 你的原话 */}
			<section className="mt-6">
				<p className={`${sectionLabel} mb-1.5`}>01 · 你的原话</p>
				{editKey === "question" ? (
					<InlineInput
						value={t.question ?? ""}
						multiline
						placeholder="用自己的话说清楚:你想持续知道什么"
						className="text-[15px]"
						onCommit={(v) => {
							setEditKey(null);
							const question = v.trim();
							if (question !== (t.question ?? "")) {
								onPatch({ question, askedAt: new Date().toISOString() }, "你重写了原话");
							}
						}}
						onCancel={() => setEditKey(null)}
					/>
				) : (
					<p
						onClick={() => setEditKey("question")}
						title="点击改写"
						className="m-0 cursor-text border-l-2 border-[var(--line-strong)] pl-3 text-[16px] font-medium leading-relaxed"
					>
						{t.question ? `「${t.question}」` : <span className="text-[var(--ink-3)]">还没写下这个长期问题——点击补上</span>}
					</p>
				)}
				<p className="font-mono-sc m-0 mt-1 pl-3.5 text-[10px] text-[var(--ink-3)]">
					{t.askedAt ? `${mmdd(t.askedAt)} · ` : ""}原话不会被 AI 改动
				</p>
			</section>

			{/* 02 编辑的理解 */}
			<section className="mt-6">
				<p className={`${sectionLabel} mb-1.5`}>02 · 编辑的理解</p>
				<div className="text-[15px] leading-[2]">
					{segments.map((seg, i) => (
						<span key={`${i}:${seg.text}`}>
							{editKey === `seg:${i}` ? (
								<InlineInput
									value={seg.text}
									accent
									className="min-w-64 text-[14px]"
									onCommit={(v) => commitSegment(i, v)}
									onCancel={() => setEditKey(null)}
								/>
							) : (
								<span
									onClick={() => setEditKey(`seg:${i}`)}
									title="点击圈改"
									className={`cursor-text border-b border-dashed transition-colors hover:bg-[var(--accent-soft)] ${
										seg.edited ? "border-[var(--accent)] text-[var(--accent)]" : "border-[var(--line-strong)]"
									}`}
								>
									{seg.text}
								</span>
							)}
							<span className="text-[var(--ink-3)]">;</span>{" "}
						</span>
					))}
					{editKey === "seg:new" ? (
						<InlineInput
							value=""
							accent
							placeholder="补一句编辑该怎么理解"
							className="min-w-64 text-[14px]"
							onCommit={addSegment}
							onCancel={() => setEditKey(null)}
						/>
					) : (
						segments.length < MAX_INTENT_SEGMENTS && (
							<button
								type="button"
								onClick={() => setEditKey("seg:new")}
								className="cursor-pointer rounded border border-dashed border-[var(--line-strong)] px-2 text-[12px] text-[var(--ink-3)] transition-colors hover:border-[var(--accent)] hover:text-[var(--accent)]"
							>
								+
							</button>
						)
					)}
				</div>
				<p className="font-mono-sc m-0 mt-1 text-[10px] text-[var(--ink-3)]">
					{segments.length === 0
						? "编辑还没写理解——你可以直接写,或让编辑起草"
						: "虚线处点击可改,回车保存 · 红色是你圈改过的"}
				</p>
			</section>

			{/* 03 收什么 / 不收什么 */}
			<section className="mt-6">
				<p className={`${sectionLabel} mb-2`}>03 · 收什么 / 不收什么</p>
				<div className="grid gap-3 sm:grid-cols-2">
					<div>
						<p className="m-0 mb-1.5 text-[12px] text-[var(--ink-3)]">收</p>
						<ChipRow
							chips={includeChips}
							open={chipOpen === "inc"}
							onOpen={() => setChipOpen("inc")}
							onClose={() => setChipOpen(null)}
							onAdd={(text) => addChip("include", text)}
							onRemove={(chip) => removeChip("include", chip)}
						/>
					</div>
					<div>
						<p className="m-0 mb-1.5 text-[12px] text-[var(--ink-3)]">不收</p>
						<ChipRow
							chips={excludeChips}
							accent
							open={chipOpen === "exc"}
							onOpen={() => setChipOpen("exc")}
							onClose={() => setChipOpen(null)}
							onAdd={(text) => addChip("exclude", text)}
							onRemove={(chip) => removeChip("exclude", chip)}
						/>
					</div>
				</div>
			</section>

			{/* 04 指定信源与局部规则 */}
			<section className="mt-6">
				<p className={`${sectionLabel} mb-2`}>04 · 指定信源与局部规则</p>
				{t.sourceMode !== "selected" ? (
					<div className="flex flex-wrap items-center gap-2.5 rounded-md bg-[var(--paper-deep)] px-3.5 py-2.5">
						<span className="min-w-55 flex-1 text-[12px] text-[var(--ink-2)]">
							当前沿用来源库全部 {selectedSources.length} 个源。逐条指定后,每次调整只作用于对应来源。
						</span>
						<button
							type="button"
							onClick={() =>
								onPatch(
									{ sourceMode: "selected", sourceKeys: selectedKeys },
									`你开始逐条指定来源(先展开当前 ${selectedKeys.length} 个)`,
								)
							}
							className="font-mono-sc cursor-pointer rounded border border-[var(--line-strong)] bg-[var(--card)] px-2.5 py-1 text-[11px] transition-colors hover:border-[var(--ink)]"
						>
							开始逐条指定
						</button>
					</div>
				) : (
					<div className="flex flex-col">
						{selectedSources.length === 0 && candidates.length === 0 && (
							<p className="m-0 rounded-md border border-dashed border-[var(--line-strong)] px-3 py-3 text-[12px] text-[var(--ink-3)]">
								还没有指定来源。让编辑找几个,或从来源库里挑。
							</p>
						)}
						{selectedSources.map((source) => {
							const rule = t.sourceRules?.find((r) => r.sourceKey === source.key);
							const { text, accent } = ruleText(source);
							const open = ruleOpen === source.key;
							const test = tests[source.url];
							return (
								<div key={source.key} className="border-b border-[var(--line)] py-2 last:border-0">
									<div className="flex flex-wrap items-center gap-2">
										<span className="dot dot-on" />
										<span className="min-w-30 text-[13px] font-medium">{source.name}</span>
										<span
											className={`min-w-0 flex-1 truncate text-[12px] ${accent ? "text-[var(--accent)]" : "text-[var(--ink-2)]"}`}
										>
											{text}
										</span>
										<span className="font-mono-sc text-[10px] text-[var(--ink-3)]">{statText(source)}</span>
										<button type="button" onClick={() => onTest(source.url)} className={`${ghostBtn} hover:text-[var(--ink)]`}>
											试抓
										</button>
										<button
											type="button"
											onClick={() => setRuleOpen(open ? null : source.key)}
											className={`${ghostBtn} hover:text-[var(--ink)]`}
										>
											{open ? "收起" : "改"}
										</button>
										<button
											type="button"
											onClick={() =>
												onPatch(
													{
														sourceMode: "selected",
														sourceKeys: selectedKeys.filter((k) => k !== source.key),
														sourceRules: (t.sourceRules ?? []).filter((r) => r.sourceKey !== source.key),
													},
													`你把「${source.name}」移出了这份定义`,
												)
											}
											className={`${ghostBtn} hover:text-[var(--accent)]`}
										>
											移除
										</button>
									</div>
									{test && test !== "testing" && (
										<div className="mt-1.5 border-l-2 border-[var(--line)] pl-3 text-[11px] text-[var(--ink-3)]">
											{test.ok ? (
												test.latest?.slice(0, 3).map((item) => (
													<p key={item.title} className="m-0 truncate">
														· {item.title}
													</p>
												))
											) : (
												<p className="m-0 text-[var(--accent)]">抓取失败:{test.error}</p>
											)}
										</div>
									)}
									{open && (
										<div className="mt-2 grid gap-3 border-t border-[var(--line)] pt-2 sm:grid-cols-2">
											<div>
												<p className="m-0 mb-1.5 text-[12px] text-[var(--ink-3)]">只从这个来源收</p>
												<ChipRow
													chips={(rule?.include ?? []).map((text) => ({ text }))}
													open={chipOpen === `inc:${source.key}`}
													onOpen={() => setChipOpen(`inc:${source.key}`)}
													onClose={() => setChipOpen(null)}
													onAdd={(text) =>
														updateRule(
															source.key,
															{ include: [...(rule?.include ?? []), text] },
															`你让「${source.name}」只收「${text}」`,
														)
													}
													onRemove={(chip) =>
														updateRule(
															source.key,
															{ include: (rule?.include ?? []).filter((x) => x !== chip.text) },
															`你取消了「${source.name}」的只收「${chip.text}」`,
														)
													}
												/>
											</div>
											<div>
												<p className="m-0 mb-1.5 text-[12px] text-[var(--ink-3)]">只在这个来源排除</p>
												<ChipRow
													chips={(rule?.exclude ?? []).map((text) => ({ text }))}
													accent
													open={chipOpen === `exc:${source.key}`}
													onOpen={() => setChipOpen(`exc:${source.key}`)}
													onClose={() => setChipOpen(null)}
													onAdd={(text) =>
														updateRule(
															source.key,
															{ exclude: [...(rule?.exclude ?? []), text] },
															`你让「${source.name}」不收「${text}」`,
														)
													}
													onRemove={(chip) =>
														updateRule(
															source.key,
															{ exclude: (rule?.exclude ?? []).filter((x) => x !== chip.text) },
															`你取消了「${source.name}」的不收「${chip.text}」`,
														)
													}
												/>
											</div>
											<p className="m-0 text-[11px] text-[var(--ink-3)] sm:col-span-2">
												这里的调整只影响 {source.name},不会改动其他来源。
											</p>
										</div>
									)}
								</div>
							);
						})}

						{/* 编辑建议的候选来源:先看理由和最近三条,再决定 */}
						{candidates.map((cand) => (
							<CandidateCard
								key={cand.url}
								cand={cand}
								onAdopt={() => onAdoptCandidate(cand)}
								onReject={() => onRejectCandidate(cand)}
							/>
						))}

						<div className="mt-2.5 flex flex-wrap items-center gap-2">
							<button
								type="button"
								onClick={onFindMore}
								disabled={editorBusy}
								className="cursor-pointer rounded border border-dashed border-[var(--line-strong)] px-2.5 py-1 text-[12px] text-[var(--ink-2)] transition-colors hover:border-[var(--accent)] hover:text-[var(--accent)] disabled:opacity-40"
							>
								{editorBusy ? "编辑在找…" : "+ 让编辑再找几个"}
							</button>
							<button
								type="button"
								onClick={() => setPickOpen((v) => !v)}
								className={`${ghostBtn} hover:text-[var(--ink)]`}
							>
								{pickOpen ? "收起来源库" : "从来源库添加"}
							</button>
						</div>
						{pickOpen && (
							<div className="mt-2 flex flex-wrap gap-1.5">
								{sources
									.filter((s) => !selectedKeys.includes(s.key))
									.map((s) => (
										<button
											key={s.key}
											type="button"
											onClick={() =>
												onPatch({ sourceMode: "selected", sourceKeys: [...selectedKeys, s.key] }, `你从来源库加入了「${s.name}」`)
											}
											className="cursor-pointer rounded border border-dashed border-[var(--line-strong)] px-2 py-0.5 text-[11px] text-[var(--ink-3)] transition-colors hover:border-[var(--ink)] hover:text-[var(--ink)]"
										>
											+ {s.name}
										</button>
									))}
								{sources.filter((s) => !selectedKeys.includes(s.key)).length === 0 && (
									<span className="font-mono-sc text-[11px] text-[var(--ink-3)]">来源库里的源都在这份定义里了</span>
								)}
							</div>
						)}
					</div>
				)}
			</section>

			{/* 变更记录 */}
			<section className="mt-6 border-t border-[var(--line)] pt-3.5">
				<p className={`${monoLabel} mb-1.5 text-[var(--ink-3)]`}>变更记录</p>
				<div className="font-mono-sc text-[11px] leading-[2] text-[var(--ink-3)]">
					{(t.changelog ?? []).length === 0 ? (
						<p className="m-0">还没有改动记录。这里会逐条记下谁在什么时候改了什么。</p>
					) : (
						(t.changelog ?? []).map((entry, i) => (
							<p key={`${entry.at}:${i}`} className="m-0">
								{mmdd(entry.at)} {entry.text}
							</p>
						))
					)}
				</div>
			</section>
		</div>
	);
}
