import { useEffect, useState } from "react";
import {
	MAX_INTENT_SEGMENTS,
	QUOTA_OPTIONS,
	joinSegments,
	normalizeQuota,
	pushIntentVersion,
	trackerSegments,
} from "../shared/pipeline-core";
import type { IntentSegment, IntentVersion, SourceConfig, Tracker, TrackerSourceRule } from "../shared/pipeline-core";
import type { CatalogEntry } from "../shared/catalog";
import type { ProposalItem, TestResult } from "./editor";
import { CATEGORY_LABELS } from "./SourceLibrary";
import CandidateCard from "./CandidateCard";
import CatalogPicker from "./CatalogPicker";
import { apiPath } from "./paths";

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

/**
 * 跨栏拖拽的临时载荷。dragover 阶段浏览器不让读 dataTransfer(只有 drop 时才给),
 * 但「这枚标签能不能落这儿」必须在 dragover 就判断,所以payload 放模块变量;
 * dataTransfer 里仍写一份纯文本,拖到编辑器等外部目标时不至于是个空拖。
 */
let dragPayload: { bucket: string; chip: Chip } | null = null;

/** 标签行:回车添加,× 删除,给了 bucket 就能拖到另一行。收(墨)与不收(朱)只差配色。向导第二步也用它。 */
export function ChipRow({
	chips,
	accent,
	open,
	onOpen,
	onClose,
	onAdd,
	onRemove,
	bucket,
	onDropChip,
	onToggleChip,
}: {
	chips: Chip[];
	accent?: boolean;
	open: boolean;
	onOpen: () => void;
	onClose: () => void;
	onAdd: (text: string) => void;
	onRemove: (chip: Chip) => void;
	/** 本行的身份;与 onDropChip 一起给出才开启拖拽。 */
	bucket?: string;
	/** 另一行的标签被拖进来了(同一行内的拖拽会被忽略)。 */
	onDropChip?: (chip: Chip, fromBucket: string) => void;
	/**
	 * 点一下标签改判到另一栏(yiren 反馈 #1):拖拽没有任何可见的提示,
	 * 全靠悬停 title 自证,大多数人不会发现。点击是能被发现的那条路,
	 * 拖拽保留为顺手的快捷方式。
	 */
	onToggleChip?: (chip: Chip) => void;
}) {
	const [over, setOver] = useState(false);
	const draggable = Boolean(bucket && onDropChip);
	const accepts = () => draggable && dragPayload !== null && dragPayload.bucket !== bucket;
	return (
		<div
			onDragOver={(e) => {
				if (!accepts()) return;
				e.preventDefault();
				e.dataTransfer.dropEffect = "move";
				setOver(true);
			}}
			onDragLeave={(e) => {
				// 拖过内部子元素也会冒出 dragleave,只有真正离开整行才取消高亮。
				if (e.currentTarget.contains(e.relatedTarget as Node | null)) return;
				setOver(false);
			}}
			onDrop={(e) => {
				if (!accepts()) return;
				e.preventDefault();
				setOver(false);
				const payload = dragPayload;
				dragPayload = null;
				if (payload) onDropChip?.(payload.chip, payload.bucket);
			}}
			className={`flex flex-wrap items-center gap-1.5 ${
				draggable
					? `min-h-9 rounded-md border border-dashed p-1 transition-colors ${
							over ? "border-[var(--accent)] bg-[var(--accent-soft)]" : "border-transparent"
						}`
					: ""
			}`}
		>
			{chips.map((c) => (
				<span
					key={`${c.sourceKey ?? ""}:${c.text}`}
					draggable={draggable}
					onDragStart={(e) => {
						if (!bucket) return;
						dragPayload = { bucket, chip: c };
						e.dataTransfer.effectAllowed = "move";
						e.dataTransfer.setData("text/plain", c.text);
					}}
					onDragEnd={() => {
						dragPayload = null;
						setOver(false);
					}}
					onClick={onToggleChip ? () => onToggleChip(c) : undefined}
					title={
						onToggleChip
							? "点一下改判到另一栏(拖过去也行)"
							: draggable
								? "拖到另一栏可以改判收 / 不收"
								: undefined
					}
					className={`inline-flex items-center gap-1 rounded px-2 py-0.5 text-[12px] ${
						onToggleChip ? "cursor-pointer select-none" : draggable ? "cursor-grab select-none active:cursor-grabbing" : ""
					} ${accent ? "bg-[var(--accent-soft)] text-[var(--accent)]" : "bg-[var(--paper-deep)] text-[var(--ink)]"}`}
				>
					{c.text}
					{c.scope && <span className="font-mono-sc text-[10px] opacity-80">{c.scope}</span>}
					<button
						type="button"
						onClick={(e) => {
							// 别让删除冒泡成「点标签改判」:× 是删,标签本体才是挪
							e.stopPropagation();
							onRemove(c);
						}}
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

/**
 * V1 · 理解的历史版本:每次整体重写(向导继续对话、答用途、对编辑说一句、
 * 回滚本身)前自动存档的快照,可查看、可一键回到任意一版。回滚是「当前版
 * 先入历史,再整体换成那一版」——所以回滚永远可再回滚,不存在丢内容的路径。
 * 档案 02 节和向导第 1 步共用。
 */
export function IntentHistory({
	tracker,
	onPatch,
}: {
	tracker: Tracker;
	onPatch: (patch: Partial<Tracker>, log?: string) => void;
}) {
	const versions = tracker.intentVersions ?? [];
	if (versions.length === 0) return null;
	const rollback = (v: IntentVersion) => {
		onPatch(
			{
				intentSegments: v.segments,
				intent: joinSegments(v.segments),
				intentVersions: pushIntentVersion(tracker, "回滚前的版本"),
			},
			`你把编辑的理解回到了 ${mmdd(v.at)} 存档的版本`,
		);
	};
	return (
		<details className="mt-2">
			<summary className="font-mono-sc cursor-pointer text-[10px] text-[var(--ink-3)] transition-colors hover:text-[var(--ink)]">
				历史版本 {versions.length} 份 · 每次重写前自动存档,可回滚
			</summary>
			<div className="mt-1.5 space-y-2.5 border-l-2 border-[var(--line)] pl-3">
				{versions.map((v, i) => (
					<div key={`${v.at}:${i}`}>
						<p className="font-mono-sc m-0 text-[10px] text-[var(--ink-3)]">
							{mmdd(v.at)}
							{v.note ? ` · ${v.note}` : ""}
						</p>
						<p className="m-0 text-[12px] leading-relaxed text-[var(--ink-2)]">{joinSegments(v.segments)}</p>
						<button
							type="button"
							onClick={() => rollback(v)}
							className="font-mono-sc mt-0.5 cursor-pointer rounded border border-dashed border-[var(--line-strong)] px-2 py-0.5 text-[10px] text-[var(--ink-3)] transition-colors hover:border-[var(--accent)] hover:text-[var(--accent)]"
						>
							回到这版
						</button>
					</div>
				))}
			</div>
		</details>
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
	/** 「全部加入」:把这一轮试抓通过的候选一次采纳。 */
	onAdoptAllCandidates: () => void;
	onRejectCandidate: (item: ProposalItem) => void;
	/** 从精选目录加一个源:进全局源池并绑定这份定义(服务端仍会试抓)。 */
	onAddCatalog: (entry: CatalogEntry) => Promise<void>;
	/** 把一句话交给编辑(真 AI 时才走网络;mock 由本页就地起草提案)。 */
	onSay: (text: string) => void;
	/**
	 * 档案末尾的「试生成一期」(yiren 反馈 #3):配置页从上读到下,读完信源
	 * 顺理成章想看效果,而生成按钮却只在页首右上角——按阅读顺序在底部再给
	 * 一个,动作与页首那枚完全同源(App 的 generate,同一趟额度与进度)。
	 */
	onGenerate?: () => void;
	generating?: boolean;
}

/** T6 · 一条线索(GET /api/threads 的返回形状)。 */
interface ThreadView {
	key: string;
	trackerKey: string;
	title: string;
	firstSeen: string;
	lastEvidence: string;
	stage: "fresh" | "active" | "quiet" | "dormant";
	evidence: { date: string; itemId: string; title: string; url: string; source: string }[];
}

const STAGE_LABEL: Record<ThreadView["stage"], string> = {
	fresh: "新出现",
	active: "进行中",
	quiet: "转冷",
	dormant: "已沉寂",
};

/** 一条线索:一行摘要,点开是它的证据时间线。 */
function ThreadRow({ thread, open, onToggle }: { thread: ThreadView; open: boolean; onToggle: () => void }) {
	return (
		<div className="rounded-md border border-[var(--line)] px-3 py-1.5">
			<button type="button" onClick={onToggle} className="flex w-full cursor-pointer items-baseline gap-2 text-left">
				<span className="font-mono-sc text-[10px] text-[var(--ink-3)]">{open ? "▾" : "▸"}</span>
				<span className="min-w-0 flex-1 truncate text-[14px] font-medium">{thread.title}</span>
				<span
					className={`font-mono-sc shrink-0 text-[10px] ${thread.stage === "dormant" ? "text-[var(--ink-3)]" : "text-[var(--accent)]"}`}
				>
					{STAGE_LABEL[thread.stage]}
				</span>
				<span className="font-mono-sc shrink-0 text-[10px] text-[var(--ink-3)]">
					{thread.evidence.length} 条 · {thread.firstSeen.slice(5)}起
				</span>
			</button>
			{open && (
				<ul className="mt-1.5 space-y-1 border-l-2 border-[var(--line)] pl-3">
					{thread.evidence.map((e) => (
						<li key={e.itemId} className="text-[13px]">
							<span className="font-mono-sc mr-2 text-[10px] text-[var(--ink-3)]">{e.date.slice(5)}</span>
							<a href={e.url} target="_blank" rel="noreferrer" className="text-[var(--ink-2)] hover:text-[var(--accent)]">
								{e.title}
							</a>
							<span className="font-mono-sc ml-2 text-[10px] text-[var(--ink-3)]">{e.source}</span>
						</li>
					))}
				</ul>
			)}
		</div>
	);
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
	onAdoptAllCandidates,
	onRejectCandidate,
	onAddCatalog,
	onSay,
	onGenerate,
	generating,
}: DossierProps) {
	const [editKey, setEditKey] = useState<string | null>(null);
	// T6 · 这份定义底下的线索台账;哪条展开着
	const [threads, setThreads] = useState<ThreadView[]>([]);
	const [openThread, setOpenThread] = useState<string | null>(null);
	// T5 · 这份定义连续多少期没出过货(从 /api/metrics 现算的)
	const [noHitStreak, setNoHitStreak] = useState(0);
	useEffect(() => {
		let alive = true;
		void (async () => {
			try {
				const res = await fetch(apiPath(`threads?tracker=${encodeURIComponent(t.key)}`));
				if (!res.ok) return;
				const data = (await res.json()) as { threads?: ThreadView[] };
				if (alive) setThreads(data.threads ?? []);
			} catch {
				// 台账读不到不挡定义编辑,静默留空
			}
			try {
				const res = await fetch(apiPath("metrics"));
				if (!res.ok) return;
				const data = (await res.json()) as { trackers?: { key: string; noHitStreak: number }[] };
				const mine = data.trackers?.find((x) => x.key === t.key);
				if (alive && mine) setNoHitStreak(mine.noHitStreak);
			} catch {
				// 同上
			}
		})();
		return () => {
			alive = false;
		};
	}, [t.key]);

	// 哪一个标签输入框开着:"inc"/"exc" 是这份定义的全局标签,
	// "inc:<sourceKey>" 是某个来源的局部规则——同名会串,所以带上来源。
	const [chipOpen, setChipOpen] = useState<string | null>(null);
	const [sayText, setSayText] = useState("");
	const [proposal, setProposal] = useState<{ quote: string; kind: "inc" | "exc" } | null>(null);
	const [ruleOpen, setRuleOpen] = useState<string | null>(null);
	const [pickOpen, setPickOpen] = useState(false);
	const [catalogOpen, setCatalogOpen] = useState(false);

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

	/** 拖到另一栏 = 改判收 / 不收。局部规则的标签跟着它的来源一起换栏。 */
	const moveChip = (to: "include" | "exclude", chip: Chip) => {
		const from: "include" | "exclude" = to === "include" ? "exclude" : "include";
		const label = (kind: "include" | "exclude") => (kind === "include" ? "收什么" : "不收什么");
		if (!chip.sourceKey) {
			const target = t[to] ?? [];
			onPatch(
				{
					[from]: (t[from] ?? []).filter((x) => x !== chip.text),
					[to]: target.includes(chip.text) ? target : [...target, chip.text],
				},
				`你把「${chip.text}」从「${label(from)}」挪到了「${label(to)}」`,
			);
			return;
		}
		const rules = (t.sourceRules ?? []).map((rule): TrackerSourceRule =>
			rule.sourceKey === chip.sourceKey
				? {
						...rule,
						[from]: (rule[from] ?? []).filter((x) => x !== chip.text),
						[to]: [...new Set([...(rule[to] ?? []), chip.text])],
					}
				: rule,
		);
		onPatch(
			{ sourceRules: rules },
			`你把「${sourceName(chip.sourceKey)}」上的「${chip.text}」从${label(from)}挪到了${label(to)}`,
		);
	};

	/** 试抓通过的候选数——只有 2 个以上才值得给「全部加入」。 */
	const adoptableCount = candidates.filter((c) => c.ok).length;

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
				{paused && <span className="font-mono-sc text-[10px] text-[var(--accent)]">已停用</span>}
				<span className="ml-auto flex items-baseline gap-2">
					<select
						value={normalizeQuota(t.quota)}
						onChange={(e) => onPatch({ quota: Number(e.target.value) }, `你把每期上限改成 ${e.target.value} 条`)}
						title="这份定义每期最多几条"
						className="font-mono-sc cursor-pointer border-0 bg-transparent text-[10px] text-[var(--ink-3)] outline-none"
					>
						{QUOTA_OPTIONS.map((n) => (
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
				{/* R7 · 你在忙什么。它和原话一样是定义的一部分,而且是选材分岔口:
				    同一个话题,做产品的人和看投资的人该收到的是两批内容。 */}
				<div className="mt-2.5 pl-3.5">
					<span className="font-mono-sc mr-2 text-[10px] uppercase tracking-[0.08em] text-[var(--ink-3)]">
						你在忙什么
					</span>
					{editKey === "purpose" ? (
						<InlineInput
							value={t.purpose ?? ""}
							placeholder="例如:在做产品,怕平台改权限和定价"
							className="min-w-72 text-[13px]"
							onCommit={(v) => {
								setEditKey(null);
								const purpose = v.trim();
								if (purpose !== (t.purpose ?? "")) {
									onPatch({ purpose }, purpose ? `你改了在忙什么:「${purpose}」` : "你清空了「在忙什么」");
								}
							}}
							onCancel={() => setEditKey(null)}
						/>
					) : (
						<span
							onClick={() => setEditKey("purpose")}
							title="点击改写"
							className="cursor-text border-b border-dashed border-[var(--line-strong)] text-[13px] text-[var(--ink-2)] transition-colors hover:bg-[var(--accent-soft)]"
						>
							{t.purpose || <span className="text-[var(--ink-3)]">没说——选材只按话题走,点击补上</span>}
						</span>
					)}
				</div>
			</section>

			{/* T5 · 长期不出货就主动说。配了 5 个定义有 2 个永远是空的、却没人
			    解释,是最典型的留存杀手——静默比说实话贵得多。 */}
			{noHitStreak >= 7 && (
				<section className="mt-6 rounded-lg border border-[var(--accent)] bg-[var(--accent-soft)] px-4 py-3">
					<p className="m-0 text-[14px] font-medium text-[var(--accent)]">
						这份定义连续 {noHitStreak} 期没出过内容
					</p>
					<p className="m-0 mt-1.5 text-[13px] leading-relaxed text-[var(--ink-2)]">
						不是雷达没扫,是没有够格的。通常是两个原因,都能当场改:
					</p>
					<ul className="m-0 mt-1 list-none space-y-0.5 p-0 text-[13px] text-[var(--ink-2)]">
						<li>· 「收」的条件太窄 —— 去 03 节删掉一两个标签,或把它们挪进「不收」的反面</li>
						<li>· 指定的信源本来就不产这类内容 —— 去 04 节换成「全部来源」,或让编辑再找几个</li>
					</ul>
				</section>
			)}

			{/* T6 · 事态:这一节才让「追踪定义档案」名副其实——看得见一个问题
			    从第一次出现到今天是怎么走的,而不是每天一堆互不相干的条目。 */}
			{threads.length > 0 && (
				<section className="mt-6">
					<p className={`${sectionLabel} mb-1.5`}>事态 · 这个问题在怎么发展</p>
					<div className="space-y-1">
						{threads
							.filter((th) => th.stage !== "dormant")
							.map((th) => (
								<ThreadRow key={th.key} thread={th} open={openThread === th.key} onToggle={() => setOpenThread(openThread === th.key ? null : th.key)} />
							))}
					</div>
					{threads.some((th) => th.stage === "dormant") && (
						<details className="mt-2">
							<summary className="font-mono-sc cursor-pointer text-[11px] text-[var(--ink-3)]">
								已沉寂 {threads.filter((th) => th.stage === "dormant").length} 条(21 天以上没有新证据)
							</summary>
							<div className="mt-1 space-y-1">
								{threads
									.filter((th) => th.stage === "dormant")
									.map((th) => (
										<ThreadRow key={th.key} thread={th} open={openThread === th.key} onToggle={() => setOpenThread(openThread === th.key ? null : th.key)} />
									))}
							</div>
						</details>
					)}
				</section>
			)}

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
				<IntentHistory tracker={t} onPatch={onPatch} />
			</section>

			{/* 03 收什么 / 不收什么 */}
			<section className="mt-6">
				<p className={`${sectionLabel} mb-2`}>03 · 收什么 / 不收什么 · 判错了点一下标签换栏</p>
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
							bucket="include"
							onDropChip={(chip) => moveChip("include", chip)}
							onToggleChip={(chip) => moveChip("exclude", chip)}
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
							bucket="exclude"
							onDropChip={(chip) => moveChip("exclude", chip)}
							onToggleChip={(chip) => moveChip("include", chip)}
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
							{adoptableCount > 1 && (
								<button
									type="button"
									onClick={onAdoptAllCandidates}
									disabled={editorBusy}
									className="font-mono-sc cursor-pointer rounded border border-[var(--ink)] bg-[var(--ink)] px-2.5 py-1 text-[11px] text-[var(--paper)] transition-colors hover:bg-[var(--accent)] hover:border-[var(--accent)] disabled:opacity-40"
								>
									全部加入 {adoptableCount} 个
								</button>
							)}
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
							<button
								type="button"
								onClick={() => setCatalogOpen((v) => !v)}
								className={`${ghostBtn} hover:text-[var(--ink)]`}
							>
								{catalogOpen ? "收起精选目录" : "从精选目录添加"}
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
						{catalogOpen && (
							<CatalogPicker
								existingUrls={selectedSources.map((s) => s.url)}
								onPick={onAddCatalog}
								note="加入会同时进来源库并绑定这份定义;每条都经人工验证,服务端仍会真实试抓。"
							/>
						)}
					</div>
				)}
			</section>

			{/* 读完 01-04 的下一步(yiren 反馈 #3):改完定义当场试一期看效果 */}
			{onGenerate && (
				<div className="mt-6 flex flex-wrap items-center gap-3 border-t border-[var(--line)] pt-4">
					<button type="button" onClick={onGenerate} disabled={generating} className="btn-stamp">
						<span className="mark" aria-hidden="true">
							▸
						</span>
						试生成一期
					</button>
					<span className="font-mono-sc text-[11px] text-[var(--ink-3)]">
						{generating ? "已经在生成了,进度在页首状态行" : "按这份定义当场出一期看效果 · 约四五分钟,进度在页首状态行"}
					</span>
				</div>
			)}

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
