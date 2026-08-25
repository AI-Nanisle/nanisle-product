import { useEffect, useRef, useState } from "react";
import { MAX_INTENT_SEGMENTS, PURPOSE_QUESTION, joinSegments, purposeOptions, trackerSegments } from "../shared/pipeline-core";
import type { IntentSegment, SourceCategory, SourceConfig, Tracker } from "../shared/pipeline-core";
import { wizardSources, wizardSuggest, wizardTags, wizardUnderstand } from "./editor";
import type { ProposalItem } from "./editor";
import { ChipRow, InlineInput, IntentHistory } from "./Dossier";
import { CATEGORIES, CATEGORY_LABELS } from "./SourceLibrary";
import CandidateCard from "./CandidateCard";

// F1 · 三步向导(docs/02 §7):理解 → 标签 → 信源,每步一次结构化调用,
// 用户确认才前进。步骤状态就是草稿 tracker 的 stage 字段——草稿存在服务端
// 的用户配置里,刷新、关页、换设备都能从当前步续上(对话原文也在草稿上,
// 见 wizardMessages)。
// 步骤 1 的逐句圈改复用档案页同款交互(红标 = edited:true,服务端重生成时
// 按位置强制保留);步骤 2 复用 ChipRow;步骤 3 复用「编辑建议」候选卡。

const monoLabel = "font-mono-sc text-[10px] uppercase tracking-[0.08em]";
const primaryBtn =
	"cursor-pointer rounded-md bg-[var(--ink)] px-5 py-2.5 text-[14px] font-medium text-[var(--paper)] transition-colors hover:bg-[var(--accent)] disabled:cursor-default disabled:opacity-40";
const ghostBtn = "font-mono-sc cursor-pointer text-[11px] text-[var(--ink-3)] transition-colors hover:text-[var(--ink)]";

type Step = "ask" | "understanding" | "tags" | "sources";

function stepOf(draft: Tracker | null): Step {
	if (!draft?.stage) return "ask";
	return draft.stage;
}

export interface WizardProps {
	/** 当前草稿(带 stage);null = 还没起草,从提问开始。 */
	draft: Tracker | null;
	sources: SourceConfig[];
	headers: () => Record<string, string>;
	/** 服务端返回了新的全量追踪器列表(向导端点会写库)。 */
	onTrackers: (trackers: Tracker[], selectKey?: string) => void;
	/** 本地圈改即改即存(PUT /api/trackers 那条既有通道)。 */
	onPatch: (key: string, patch: Partial<Tracker>, log?: string) => void;
	/** 采纳候选:POST /api/sources/add(试抓过的 URL,服务端更新 tracker)。 */
	onAdopt: (trackerKey: string, item: ProposalItem) => Promise<void>;
	/** 一键采纳整轮候选;返回没加成的那几个(本页负责放回列表)和一句交代。 */
	onAdoptAll: (trackerKey: string, items: ProposalItem[]) => Promise<{ failed: ProposalItem[]; note: string }>;
	/**
	 * 手动输入一个源(siyang 反馈 #4):服务端做 feed 发现 + 真实试抓,失败时
	 * noted=true 表示这条需求已实时递给开发者。
	 */
	onManualAdd: (
		trackerKey: string,
		url: string,
		category: SourceCategory,
	) => Promise<{ ok: boolean; error?: string; noted?: boolean }>;
	/** 「完成」:调用方负责删 stage(草稿转生效)并切回档案页。 */
	/** 「完成」:调用方请求服务端把草稿转生效,**成功后**才切档案页;失败要抛出来,人留在向导里。 */
	onFinish: (key: string) => void | Promise<void>;
	/** 放弃:key 为 null 表示还没起草。 */
	onDiscard: (key: string | null) => void;
}

export default function Wizard({
	draft,
	sources,
	headers,
	onTrackers,
	onPatch,
	onAdopt,
	onAdoptAll,
	onManualAdd,
	onFinish,
	onDiscard,
}: WizardProps) {
	const step = stepOf(draft);
	const [busy, setBusy] = useState(false);
	const [note, setNote] = useState("");
	const [question, setQuestion] = useState("");
	// F8 · 帮我想(冷启动):一句处境 → 编辑出的候选题。处境在选题开始时还会
	// 作为 purpose 写进定义(是用户亲口说的,R8 的「不许猜」不拦它)。
	const [suggestContext, setSuggestContext] = useState("");
	const [suggestions, setSuggestions] = useState<string[]>([]);
	const [followUp, setFollowUp] = useState("");
	// R8 · 服务端出的追问。**显示与否只看草稿有没有 purpose**,不看这个状态——
	// 它只是本次响应带回来的问法。挂在瞬时状态上的话,刷新一次追问就永远消失了,
	// 而 purpose 还是空的(线上实测踩到过)。
	const [ask, setAsk] = useState<{ question: string; options: string[] } | null>(null);
	const [otherPurpose, setOtherPurpose] = useState("");
	const [candidates, setCandidates] = useState<ProposalItem[]>([]);
	const [editKey, setEditKey] = useState<string | null>(null);
	const [chipOpen, setChipOpen] = useState<string | null>(null);
	// 手动加源(第三步):URL + 类目,回车或按钮触发试抓
	const [manualUrl, setManualUrl] = useState("");
	const [manualCat, setManualCat] = useState<SourceCategory>("blog");
	// 第三步的候选只活在本页(反捏造:它们还没进任何配置);进入该步且没有
	// 候选时自动找一轮——刷新续跑也走这里,别让用户面对一个空屏。
	const autoFetched = useRef(false);

	// V2 · 向导对话的全文以草稿上的 wizardMessages 为准(服务端持久化)——
	// 刷新/换设备后继续对话,编辑仍看得到之前聊过的每一轮。挂本地状态的旧实现
	// 刷新即失忆,理解会按「只有第一句」重写(siyang 反馈 #2 的诱因之一)。
	const talkedSoFar = (): string[] =>
		draft?.wizardMessages?.length ? draft.wizardMessages : [draft?.question ?? draft?.name ?? ""];

	const segments = draft ? trackerSegments(draft) : [];
	/** 试抓通过的候选数——只有 2 个以上才值得给「全部加入」。 */
	const adoptableCount = candidates.filter((c) => c.ok).length;
	const adoptedSources = (draft?.sourceKeys ?? [])
		.map((k) => sources.find((s) => s.key === k))
		.filter((s): s is SourceConfig => Boolean(s));

	const run = async (fn: () => Promise<void>) => {
		if (busy) return;
		setBusy(true);
		setNote("");
		try {
			await fn();
		} catch (err) {
			setNote(`出错了:${err instanceof Error ? err.message : "未知错误"}`);
		} finally {
			setBusy(false);
		}
	};

	// ---------- 步骤动作 ----------

	/** F8 · 帮我想:一句处境换 4 个候选题。不建草稿,纯出题。 */
	const suggest = () =>
		run(async () => {
			const ctx = suggestContext.trim();
			if (!ctx) return;
			const res = await wizardSuggest(ctx, headers());
			setSuggestions(res.suggestions ?? []);
			if (res.note) setNote(res.note);
		});

	const start = () =>
		run(async () => {
			const q = question.trim();
			if (!q) return;
			// 选了编辑出的题(原样或没改)时,那句处境就是 purpose——用户亲口
			// 说的,直接写进定义,第 1 步的「你在忙什么」追问随之免掉。
			// 自己另写了题就不带:处境未必还贴着新题,宁可让追问去问。
			const ctx = suggestContext.trim();
			const purpose = ctx && suggestions.includes(q) ? ctx : undefined;
			const res = await wizardUnderstand([q], undefined, headers(), purpose);
			if (res.trackers && res.tracker) onTrackers(res.trackers, res.tracker.key);
			setAsk(res.ask ?? null);
			if (res.note) setNote(res.note);
		});

	const continueTalk = () =>
		run(async () => {
			if (!draft) return;
			const msg = followUp.trim();
			if (!msg) return;
			// 服务端上限 8 轮:超了保第一句(原话是理解的锚)+ 最近 7 句
			const all = [...talkedSoFar(), msg];
			const msgs = all.length > 8 ? [all[0], ...all.slice(-7)] : all;
			const res = await wizardUnderstand(msgs, draft.key, headers());
			if (res.trackers) onTrackers(res.trackers);
			setAsk(res.ask ?? null);
			setFollowUp("");
			if (res.note) setNote(res.note);
		});

	/** 回答追问:带着用途重跑一次理解,编辑按它重写。答完追问就消失。 */
	const answerPurpose = (purpose: string) =>
		run(async () => {
			if (!draft || !purpose.trim()) return;
			const res = await wizardUnderstand(talkedSoFar(), draft.key, headers(), purpose.trim());
			if (res.trackers) onTrackers(res.trackers);
			setAsk(res.ask ?? null);
			setOtherPurpose("");
			if (res.note) setNote(res.note);
		});

	const confirmUnderstanding = () =>
		run(async () => {
			if (!draft) return;
			const res = await wizardTags(draft.key, headers());
			if (res.trackers) onTrackers(res.trackers);
			if (res.note) setNote(res.note);
		});

	/** R10 · 「再给几个」:已有标签一个不动,让编辑换角度补(服务端合并)。 */
	const moreTags = () =>
		run(async () => {
			if (!draft) return;
			const res = await wizardTags(draft.key, headers(), true);
			if (res.trackers) onTrackers(res.trackers);
			if (res.note) setNote(res.note);
		});

	/** 手动加源:试抓通过即入定义;失败时如实交代,需求已递给开发者就说一声。 */
	const manualAdd = () =>
		run(async () => {
			if (!draft) return;
			const url = manualUrl.trim();
			if (!url) return;
			const res = await onManualAdd(draft.key, url, manualCat);
			if (res.ok) {
				setManualUrl("");
				return;
			}
			setNote(
				`这个源没加成:${res.error ?? "试抓失败"}${
					res.noted ? " · 已把这条需求记给开发者,评估支持后会进精选目录" : ""
				}`,
			);
		});

	const fetchCandidates = (exclude: string[]) =>
		run(async () => {
			if (!draft) return;
			autoFetched.current = true;
			const res = await wizardSources(draft.key, exclude, headers());
			if (res.trackers) onTrackers(res.trackers);
			setCandidates((c) => (exclude.length ? [...c, ...(res.candidates ?? [])] : (res.candidates ?? [])));
			if (res.note) setNote(res.note);
		});

	useEffect(() => {
		if (step === "sources" && !autoFetched.current && candidates.length === 0 && !busy) {
			void fetchCandidates([]);
		}
		// eslint-disable-next-line react-hooks/exhaustive-deps
	}, [step]);

	const adopt = (item: ProposalItem) => {
		if (!draft) return;
		setCandidates((c) => c.filter((x) => x.url !== item.url));
		void onAdopt(draft.key, item).catch((err: unknown) => {
			setNote(`加入失败:${err instanceof Error ? err.message : "未知错误"}`);
			setCandidates((c) => [...c, item]);
		});
	};

	/** 一键加入:先乐观清空试抓通过的候选,失败的由服务端交代后放回。 */
	const adoptAll = () =>
		run(async () => {
			if (!draft) return;
			const usable = candidates.filter((c) => c.ok);
			if (usable.length === 0) return;
			setCandidates((c) => c.filter((x) => !x.ok));
			const { failed, note: msg } = await onAdoptAll(draft.key, usable);
			if (failed.length > 0) setCandidates((c) => [...c, ...failed]);
			if (msg) setNote(msg);
		});

	const reject = (item: ProposalItem) => {
		if (!draft) return;
		setCandidates((c) => c.filter((x) => x.url !== item.url));
		onPatch(
			draft.key,
			{ rejectedSourceUrls: [...new Set([...(draft.rejectedSourceUrls ?? []), item.url])] },
			`你略过了候选「${item.name}」,以后不再推荐`,
		);
	};

	// ---------- 步骤 1 的逐句圈改(与档案页 02 节同款) ----------

	const putSegments = (next: IntentSegment[], log: string) => {
		if (!draft) return;
		onPatch(draft.key, { intentSegments: next, intent: joinSegments(next) }, log);
	};

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
			`你圈改了编辑的理解:「${before}」→「${v}」`,
		);
	};

	// ---------- 步骤 2 的标签换栏 ----------

	/** 拖到另一栏 = 改判收 / 不收:一次 patch 两个数组,别让中间态存进库。 */
	const moveTag = (to: "include" | "exclude", text: string) => {
		if (!draft) return;
		const from: "include" | "exclude" = to === "include" ? "exclude" : "include";
		const label = (kind: "include" | "exclude") => (kind === "include" ? "收什么" : "不收什么");
		const target = draft[to] ?? [];
		onPatch(
			draft.key,
			{
				[from]: (draft[from] ?? []).filter((x) => x !== text),
				[to]: target.includes(text) ? target : [...target, text],
			},
			`你把「${text}」从「${label(from)}」挪到了「${label(to)}」`,
		);
	};

	// ---------- 渲染 ----------

	const stepBar = (
		<div className={`${monoLabel} flex flex-wrap items-center gap-2 text-[var(--ink-3)]`}>
			<span className="text-[var(--accent)]">向导 · 新的追踪定义</span>
			<span className="mx-1 text-[var(--line-strong)]">|</span>
			{(
				[
					["understanding", "① 理解"],
					["tags", "② 标签"],
					["sources", "③ 信源"],
				] as const
			).map(([key, label]) => {
				const active = step === key || (step === "ask" && key === "understanding");
				return (
					<span key={key} className={active ? "font-medium text-[var(--ink)]" : ""}>
						{label}
					</span>
				);
			})}
		</div>
	);

	// 失败必须比一行灰字更响(yiren 反馈 #2「毫无反馈地停止了」):朱红面板 +
	// 明确的下一步。找信源步直接给重试按钮,别让人自己琢磨该点哪里。
	const isErrorNote = /^(出错了|加入失败)/.test(note);
	const noteLine =
		note &&
		(isErrorNote ? (
			<div className="mt-3 rounded-lg border border-[var(--accent)] bg-[var(--accent-soft)] px-3.5 py-2.5">
				<p className="m-0 text-[13px] font-medium text-[var(--accent)]">这一步没成功</p>
				<p className="m-0 mt-0.5 text-[12px] leading-relaxed text-[var(--ink-2)]">{note}</p>
				{step === "sources" && (
					<button
						type="button"
						onClick={() => fetchCandidates(candidates.map((c) => c.url))}
						disabled={busy}
						className="font-mono-sc mt-2 cursor-pointer rounded border border-[var(--accent)] px-2.5 py-1 text-[11px] text-[var(--accent)] transition-colors hover:bg-[var(--accent)] hover:text-[var(--paper)] disabled:opacity-40"
					>
						再试一次
					</button>
				)}
			</div>
		) : (
			<p className="mt-3 rounded-lg border border-[var(--line)] bg-[var(--paper-deep)] px-3.5 py-2 text-[12px] leading-relaxed text-[var(--ink-2)]">
				{note}
			</p>
		));

	const busyLine = busy && (
		<p className="font-mono-sc mt-3 text-[11px] text-[var(--ink-3)]">
			<span className="text-[var(--accent)]">▸</span> 编辑处理中… <span className="caret" />
		</p>
	);

	return (
		<div className="rounded-[10px] border border-[var(--line)] bg-[var(--card)] px-8 py-7">
			{stepBar}

			{step === "ask" && (
				<>
					<h2 className="mt-3 text-[22px] font-black tracking-wide">你想持续知道什么?</h2>
					<p className="mt-1.5 text-[13px] text-[var(--ink-2)]">
						用自己的话说。编辑会先给出它的理解,你逐句圈改、确认,再定标签和信源——全程不用填表单。
					</p>
					<textarea
						value={question}
						onChange={(e) => setQuestion(e.target.value)}
						rows={3}
						placeholder="比如:盯住 Agent 框架的重大版本与迁移成本"
						className="mt-4 w-full resize-y rounded-lg border border-[var(--line-strong)] bg-[var(--paper)] px-3.5 py-3 text-[15px] leading-relaxed outline-none focus:border-[var(--ink)]"
					/>
					{/* F8 · 帮我想(冷启动):想不出来问什么的人,让他先说处境——把处境
					    翻译成长期问题正是编辑的本行,凭空印几个例题帮不了任何具体的人。
					    出的题点一下填进输入框,改不改都行。 */}
					<div className="mt-3 rounded-lg border border-dashed border-[var(--line-strong)] px-3.5 py-2.5">
						<div className="flex flex-wrap items-center gap-2">
							<span className="font-mono-sc shrink-0 text-[10px] uppercase tracking-[0.08em] text-[var(--ink-3)]">
								一时想不出来?说说你在忙什么,编辑帮你出题
							</span>
							<input
								value={suggestContext}
								onChange={(e) => setSuggestContext(e.target.value)}
								onKeyDown={(e) => {
									if (e.key === "Enter" && !e.nativeEvent.isComposing) suggest();
								}}
								disabled={busy}
								placeholder="比如:在做跨境电商独立站 / 刚开始定投美股 / 在转行做 AI 产品"
								className="min-w-52 flex-1 rounded border border-[var(--line)] bg-[var(--paper)] px-2.5 py-1 text-[13px] outline-none focus:border-[var(--accent)] disabled:opacity-50"
							/>
							<button
								type="button"
								onClick={suggest}
								disabled={busy || !suggestContext.trim()}
								className="font-mono-sc cursor-pointer rounded border border-[var(--line-strong)] px-2.5 py-1 text-[11px] transition-colors hover:bg-[var(--ink)] hover:text-[var(--paper)] disabled:cursor-default disabled:opacity-40"
							>
								{busy ? "编辑在想…" : "帮我想几个"}
							</button>
						</div>
						{suggestions.length > 0 && (
							<div className="mt-2 flex flex-wrap gap-1.5">
								{suggestions.map((s) => (
									<button
										key={s}
										type="button"
										onClick={() => setQuestion(s)}
										className={`cursor-pointer rounded border border-dashed px-2.5 py-1 text-[12px] transition-colors ${
											question.trim() === s
												? "border-[var(--accent)] text-[var(--accent)]"
												: "border-[var(--line-strong)] text-[var(--ink-2)] hover:border-[var(--accent)] hover:text-[var(--accent)]"
										}`}
									>
										{s}
									</button>
								))}
							</div>
						)}
					</div>
					<div className="mt-4.5 flex items-center gap-3">
						<button type="button" onClick={start} disabled={busy || !question.trim()} className={primaryBtn}>
							{busy ? "编辑理解中…" : "开始 →"}
						</button>
						<button type="button" onClick={() => onDiscard(null)} className={ghostBtn}>
							取消
						</button>
					</div>
				</>
			)}

			{step === "understanding" && draft && (
				<>
					<section className="mt-5">
						<p className={`${monoLabel} mb-1.5 text-[var(--ink-3)]`}>你的原话(不会被 AI 改动)</p>
						<p className="m-0 border-l-2 border-[var(--line-strong)] pl-3 text-[15px] font-medium leading-relaxed">
							「{draft.question}」
						</p>
					</section>
					{/* R8 · 追问「你在忙什么」。只在编辑还不知道用途时出现一次:
					    答了就写进定义、再也不问。「就是想跟上」是合法答案——
					    不为难只想跟进展的人,选它就退回原来的行为。 */}
					{draft.purpose ? (
						<section className="mt-5">
							<p className={`${monoLabel} mb-1.5 text-[var(--ink-3)]`}>你在忙什么(选材按它取舍)</p>
							<p className="m-0 text-[14px] text-[var(--ink-2)]">{draft.purpose}</p>
						</section>
					) : (
						(() => {
							// 服务端给了问法就用它;没给(刷新、续跑、从第 2 步回来)就拿草稿上
							// 存的那份选项重建——只要 purpose 还空着,这一问就该一直在,
							// 而且看到的是**为这个话题生成的**那几个选项,不是通用词。
							const q = ask ?? { question: PURPOSE_QUESTION, options: purposeOptions(draft.purposeOptions) };
							return (
							<section className="mt-5 rounded-lg border border-dashed border-[var(--accent)] bg-[var(--accent-soft)] px-4 py-3">
								<p className="m-0 text-[14px] font-medium">{q.question}</p>
								<div className="mt-2.5 flex flex-wrap gap-2">
									{q.options.map((opt) => (
										<button
											key={opt}
											type="button"
											disabled={busy}
											onClick={() => answerPurpose(opt)}
											className="cursor-pointer rounded-full border border-[var(--line-strong)] bg-[var(--card)] px-3 py-1 text-[13px] transition-colors hover:border-[var(--accent)] hover:text-[var(--accent)] disabled:cursor-default disabled:opacity-40"
										>
											{opt}
										</button>
									))}
								</div>
								<div className="mt-2 flex items-center gap-2">
									<input
										value={otherPurpose}
										onChange={(e) => setOtherPurpose(e.target.value)}
										onKeyDown={(e) => {
											if (e.key === "Enter" && !e.nativeEvent.isComposing) answerPurpose(otherPurpose);
										}}
										disabled={busy}
										placeholder="其他:用你自己的话说一句"
										className="min-w-0 flex-1 rounded border border-[var(--line)] bg-[var(--card)] px-2.5 py-1 text-[13px] outline-none focus:border-[var(--accent)] disabled:opacity-50"
									/>
									<button
										type="button"
										onClick={() => answerPurpose(otherPurpose)}
										disabled={busy || !otherPurpose.trim()}
										className="font-mono-sc cursor-pointer rounded border border-[var(--line-strong)] px-2.5 py-1 text-[11px] transition-colors hover:bg-[var(--ink)] hover:text-[var(--paper)] disabled:cursor-default disabled:opacity-40"
									>
										就这样
									</button>
								</div>
							</section>
							);
						})()
					)}
					<section className="mt-5">
						<p className={`${monoLabel} mb-1.5 text-[var(--accent)]`}>编辑的理解 · 逐句圈改</p>
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
									onCommit={(v) => {
										setEditKey(null);
										const t = v.trim();
										if (t) putSegments([...segments, { text: t, edited: true }], `你给理解加了一句:「${t}」`);
									}}
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
							虚线处点击可改,回车保存 · 红色是你圈改过的,编辑重写理解时也会原样保留
						</p>
						{/* V1 · 编辑重写前的旧版理解都在这里,改坏了随时回去 */}
						<IntentHistory tracker={draft} onPatch={(patch, log) => onPatch(draft.key, patch, log)} />
					</section>
					{/* 继续对话:每轮基于全部原话重新产出完整理解(§7.2 防越聊越漂) */}
					<div className="mt-4 flex items-center gap-2 rounded-lg bg-[var(--paper-deep)] px-3.5 py-2">
						<span className="font-mono-sc text-[14px] text-[var(--accent)]">›</span>
						<input
							value={followUp}
							onChange={(e) => setFollowUp(e.target.value)}
							onKeyDown={(e) => {
								if (e.key === "Enter" && !e.nativeEvent.isComposing) continueTalk();
							}}
							disabled={busy}
							placeholder="理解不对?再说一句,编辑会整体重写(你圈改过的句子不动)"
							className="min-w-0 flex-1 bg-transparent text-[13px] outline-none disabled:opacity-50"
						/>
						<button
							type="button"
							onClick={continueTalk}
							disabled={busy || !followUp.trim()}
							className="font-mono-sc cursor-pointer rounded border border-[var(--line-strong)] px-2.5 py-1 text-[11px] transition-colors hover:bg-[var(--ink)] hover:text-[var(--paper)] disabled:cursor-default disabled:opacity-40"
						>
							发送
						</button>
					</div>
					{busyLine}
					{noteLine}
					<div className="mt-5 flex items-center gap-3">
						<button type="button" onClick={confirmUnderstanding} disabled={busy || segments.length === 0} className={primaryBtn}>
							理解没问题,定标签 →
						</button>
						<button type="button" onClick={() => onDiscard(draft.key)} className={`${ghostBtn} hover:text-[var(--accent)]`}>
							放弃这份草稿
						</button>
					</div>
				</>
			)}

			{step === "tags" && draft && (
				<>
					<section className="mt-5">
						<p className={`${monoLabel} mb-2 text-[var(--accent)]`}>收什么 / 不收什么 · 编辑的建议,直接增删改</p>
						<div className="grid gap-3 sm:grid-cols-2">
							<div>
								<p className="m-0 mb-1.5 text-[12px] text-[var(--ink-3)]">收</p>
								<ChipRow
									chips={(draft.include ?? []).map((text) => ({ text }))}
									open={chipOpen === "inc"}
									onOpen={() => setChipOpen("inc")}
									onClose={() => setChipOpen(null)}
									onAdd={(text) => {
										if ((draft.include ?? []).includes(text)) return;
										onPatch(draft.key, { include: [...(draft.include ?? []), text] }, `你在「收什么」加了「${text}」`);
									}}
									onRemove={(chip) =>
										onPatch(draft.key, { include: (draft.include ?? []).filter((x) => x !== chip.text) }, `你从「收什么」删掉了「${chip.text}」`)
									}
									bucket="include"
									onDropChip={(chip) => moveTag("include", chip.text)}
									onToggleChip={(chip) => moveTag("exclude", chip.text)}
								/>
							</div>
							<div>
								<p className="m-0 mb-1.5 text-[12px] text-[var(--ink-3)]">不收</p>
								<ChipRow
									chips={(draft.exclude ?? []).map((text) => ({ text }))}
									accent
									open={chipOpen === "exc"}
									onOpen={() => setChipOpen("exc")}
									onClose={() => setChipOpen(null)}
									onAdd={(text) => {
										if ((draft.exclude ?? []).includes(text)) return;
										onPatch(draft.key, { exclude: [...(draft.exclude ?? []), text] }, `你在「不收什么」加了「${text}」`);
									}}
									onRemove={(chip) =>
										onPatch(draft.key, { exclude: (draft.exclude ?? []).filter((x) => x !== chip.text) }, `你从「不收什么」删掉了「${chip.text}」`)
									}
									bucket="exclude"
									onDropChip={(chip) => moveTag("exclude", chip.text)}
									onToggleChip={(chip) => moveTag("include", chip.text)}
								/>
							</div>
						</div>
						{/* R10 · 不知道加什么标签时,让编辑换角度再想几个(已有的一个不动) */}
						<button
							type="button"
							onClick={moreTags}
							disabled={busy}
							className="mt-2.5 cursor-pointer rounded border border-dashed border-[var(--line-strong)] px-2.5 py-1 text-[12px] text-[var(--ink-2)] transition-colors hover:border-[var(--accent)] hover:text-[var(--accent)] disabled:opacity-40"
						>
							{busy ? "编辑在想…" : "+ 让编辑再给几个"}
						</button>
						<p className="font-mono-sc m-0 mt-2 text-[10px] text-[var(--ink-3)]">
							标签是选材的硬性信号,不是必填——留空也能进下一步 · 判错了点一下标签,它会挪到另一栏
						</p>
					</section>
					{busyLine}
					{noteLine}
					<div className="mt-5 flex items-center gap-3">
						<button type="button" onClick={() => fetchCandidates([])} disabled={busy} className={primaryBtn}>
							标签可以,去选信源 →
						</button>
						<button type="button" onClick={() => onPatch(draft.key, { stage: "understanding" })} className={ghostBtn}>
							← 回上一步
						</button>
						<button type="button" onClick={() => onDiscard(draft.key)} className={`${ghostBtn} hover:text-[var(--accent)]`}>
							放弃这份草稿
						</button>
					</div>
				</>
			)}

			{step === "sources" && draft && (
				<>
					<section className="mt-5">
						<p className={`${monoLabel} mb-2 text-[var(--accent)]`}>指定信源 · 候选都经真实试抓,逐条决定</p>
						{adoptedSources.length > 0 && (
							<div className="mb-2 flex flex-wrap items-center gap-1.5">
								<span className="font-mono-sc text-[10px] text-[var(--ink-3)]">已加入 {adoptedSources.length} 个:</span>
								{adoptedSources.map((s) => (
									<span key={s.key} className="inline-flex items-center gap-1 rounded bg-[var(--paper-deep)] px-2 py-0.5 text-[12px]">
										{s.name}
										<button
											type="button"
											onClick={() =>
												onPatch(
													draft.key,
													{
														sourceMode: "selected",
														sourceKeys: (draft.sourceKeys ?? []).filter((k) => k !== s.key),
													},
													`你把「${s.name}」移出了这份定义`,
												)
											}
											aria-label={`移除 ${s.name}`}
											className="cursor-pointer opacity-50 transition-opacity hover:opacity-100"
										>
											×
										</button>
									</span>
								))}
							</div>
						)}
						{candidates.map((cand) => (
							<CandidateCard key={cand.url} cand={cand} busy={busy} onAdopt={() => adopt(cand)} onReject={() => reject(cand)} />
						))}
						{candidates.length === 0 && !busy && (
							<p className="m-0 rounded-md border border-dashed border-[var(--line-strong)] px-3 py-3 text-[12px] text-[var(--ink-3)]">
								暂无候选。点「再找几个」让编辑换角度找,或先完成、回头从来源库补。
							</p>
						)}
						<div className="mt-2.5 flex flex-wrap items-center gap-2">
							{adoptableCount > 1 && (
								<button
									type="button"
									onClick={adoptAll}
									disabled={busy}
									className="font-mono-sc cursor-pointer rounded border border-[var(--ink)] bg-[var(--ink)] px-2.5 py-1 text-[11px] text-[var(--paper)] transition-colors hover:border-[var(--accent)] hover:bg-[var(--accent)] disabled:opacity-40"
								>
									全部加入 {adoptableCount} 个
								</button>
							)}
							<button
								type="button"
								onClick={() => fetchCandidates(candidates.map((c) => c.url))}
								disabled={busy}
								className="cursor-pointer rounded border border-dashed border-[var(--line-strong)] px-2.5 py-1 text-[12px] text-[var(--ink-2)] transition-colors hover:border-[var(--accent)] hover:text-[var(--accent)] disabled:opacity-40"
							>
								{busy ? "编辑在找…" : "+ 再找几个"}
							</button>
						</div>
						{/* 手动输入:你自己知道的源直接贴进来,服务端自动发现 feed 并真实试抓;
						    抓不通的会连同原因实时递给开发者(N1),不让需求消失在报错里 */}
						<div className="mt-2.5 flex flex-wrap items-center gap-2 rounded-md bg-[var(--paper-deep)] px-3 py-2">
							<span className="font-mono-sc shrink-0 text-[10px] text-[var(--ink-3)]">自己有想加的源?</span>
							<input
								value={manualUrl}
								onChange={(e) => setManualUrl(e.target.value)}
								onKeyDown={(e) => {
									if (e.key === "Enter" && !e.nativeEvent.isComposing) manualAdd();
								}}
								disabled={busy}
								placeholder="feed 或网站地址,会自动发现 feed"
								className="font-mono-sc min-w-44 flex-1 rounded border border-[var(--line)] bg-[var(--card)] px-2.5 py-1 text-[12px] outline-none focus:border-[var(--accent)] disabled:opacity-50"
							/>
							<select
								value={manualCat}
								onChange={(e) => setManualCat(e.target.value as SourceCategory)}
								disabled={busy}
								className="cursor-pointer rounded border border-[var(--line)] bg-[var(--card)] px-1.5 py-1 text-[12px] outline-none disabled:opacity-50"
							>
								{CATEGORIES.map((cat) => (
									<option key={cat} value={cat}>
										{CATEGORY_LABELS[cat]}
									</option>
								))}
							</select>
							<button
								type="button"
								onClick={manualAdd}
								disabled={busy || !manualUrl.trim()}
								className="font-mono-sc cursor-pointer rounded border border-[var(--line-strong)] px-2.5 py-1 text-[11px] transition-colors hover:bg-[var(--ink)] hover:text-[var(--paper)] disabled:cursor-default disabled:opacity-40"
							>
								{busy ? "验证中…" : "验证并加入"}
							</button>
						</div>
					</section>
					{busyLine}
					{noteLine}
					<div className="mt-5 flex items-center gap-3">
						<button
							type="button"
							onClick={() =>
								// run() 的 busy/报错兜住这次服务端确认:失败显示在错误面板里,
								// 视图不切换——绝不能出现「界面完成了、服务端没保存」的裂脑
								run(async () => {
									await onFinish(draft.key);
								})
							}
							disabled={busy || adoptedSources.length === 0}
							title={adoptedSources.length === 0 ? "至少加入一个信源,追踪器才不会空转" : undefined}
							className={primaryBtn}
						>
							完成,开始追踪 →
						</button>
						<button type="button" onClick={() => onPatch(draft.key, { stage: "tags" })} className={ghostBtn}>
							← 回上一步
						</button>
						<button type="button" onClick={() => onDiscard(draft.key)} className={`${ghostBtn} hover:text-[var(--accent)]`}>
							放弃这份草稿
						</button>
					</div>
				</>
			)}
		</div>
	);
}
