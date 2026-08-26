// The daily brief data model. Produced by pipeline/generate.ts, stored in KV
// (`brief:<date>`), served by GET /api/brief, rendered by the React app.
// Shared between worker, pipeline and UI — keep it dependency-free.

export interface BriefLink {
	label: string;
	url: string;
}

export interface BriefItem {
	/** Stable per-item id (hash of the canonical URL). Feedback and clicks key on it. */
	id: string;
	title: string;
	/**
	 * 1–2 sentences answering "why is this worth 10 minutes of your time" —
	 * a routing hint, never a summary that replaces the original.
	 */
	whyClick: string;
	/** Original article/episode URL. Always present — the brief is a router. */
	url: string;
	/** Human-readable source name (e.g. "Simon Willison"). */
	source: string;
	/**
	 * S2 · When the original was published (ISO). Absent in briefs written
	 * before the weekly metrics existed — the 时效滞后 metric skips those.
	 */
	publishedAt?: string;
	/** Stable key of the source config this item came from (absent in old briefs). */
	sourceKey?: string;
	/** Comment-thread URL (HN etc.) when one exists. */
	discussionUrl?: string;
	/** 1–2 related links for going deeper (same-day related coverage, data source, opposing view). */
	extras?: BriefLink[];
	/**
	 * 第二段「成稿」的产物:这篇**究竟给出了什么**——具体的数字、机制、结论。
	 * 不是全文摘要,是最硬的那一两点;读完仍然需要原文的论证过程。
	 */
	substance?: string;
	/**
	 * 编辑的**独立判断**:适用边界、方法弱点、与读者追踪问题的冲突、什么条件下
	 * 结论会反转。硬边界是「只许基于正文里出现过的事实做推论」——放开它去引入
	 * 外部事实,就是拿反捏造原则换深度,那笔买卖不划算。界面上与事实分开渲染。
	 */
	take?: string;
	/** Doubts, caveats or disagreement present in the original — preserved, never flattened. */
	caveat?: string;
	/** How this item relates to its tracker's question (one clause). */
	relatesTo?: string;
	/** When several sources covered the same event, the other reports merged into this item. */
	mergedFrom?: BriefLink[];
	/** T4 · Which thread this item belongs to (absent in briefs written before T1). */
	threadKey?: string;
	/**
	 * T3 · Title the model proposed for a *new* thread. Transient: it exists
	 * between the editorial call and the ledger merge, and `stripTransient`
	 * removes it before the issue is stored.
	 */
	threadTitle?: string;
	/**
	 * T4 · "本线索第 5 条证据,上次是 12 天前" —— **computed in code**, never
	 * written by the model, and frozen into the issue at generation time: a
	 * brief is a snapshot, so recomputing it later would rewrite history.
	 */
	threadNote?: string;
}

export interface DroppedItem {
	id: string;
	title: string;
	url: string;
	source: string;
	/** Why it was filtered out (rule name or model's reason). */
	reason: string;
}

/**
 * 「今日速览」的一句:该追踪范围内今天动了什么的一条快讯合成。refs 是句子的
 * 事实来源(锚回原文,可以一句挂多条同事件报道)——原文锚定哲学不因合成而破。
 */
export interface RecapSentence {
	text: string;
	refs: BriefLink[];
}

export interface BriefSection {
	/** Tracker key this section belongs to (built-ins use "headlines"/"learn"). */
	key: string;
	title: string;
	/**
	 * 今日速览:不值得占条目位、但扫一眼有用的快讯,合成 0-4 句放在条目之前。
	 * 不占追踪器配额;没有够格的快讯时缺省,UI 整块不渲染。
	 */
	recap?: RecapSentence[];
	/** Empty items[] means the tracker ran but found nothing today — the UI
	 * still renders the section with a "no news" line, never hides it. */
	items: BriefItem[];
}

export interface Brief {
	/** YYYY-MM-DD in the brief's home timezone. */
	date: string;
	/** ISO timestamp of generation — the UI shows a "stale" banner past 26h. */
	generatedAt: string;
	/** v2: "based on yesterday's feedback, this issue has less X" — feedback must be felt. */
	feedbackEcho?: string;
	/**
	 * E1 · 今日三句话(docs/04):邮件推送的正文,编辑调用顺带产出。写的是
	 * 「今天为什么值得点开」,不是条目摘要。模型漏给时由代码从各版块首条机械
	 * 拼出兜底(见 assembleBrief)。老简报没有这个字段。
	 */
	tldr?: string[];
	sections: BriefSection[];
	/**
	 * X2 · 轴外位:一条**不属于任何追踪器**的内容。一个「读者自己定义追踪范围」
	 * 的产品,茧房是结构性副作用——这一条是主动对冲。它单独放,绝不混进正常
	 * 分区里假装是读者要的;`relatesTo` 写的是「为什么我觉得你该看见」。
	 */
	offAxis?: BriefItem;
	/** 轴外位被自动停掉时的交代(连续 10 期没被点开)。由代码写,不由模型写。 */
	offAxisNote?: string;
	/** The accountability section: what was scanned and what was filtered out. */
	filteredOut: {
		scanned: number;
		dropped: number;
		/** One human sentence: "mostly release-notes noise and duplicate coverage of X". */
		summary: string;
		items: DroppedItem[];
	};
	/** Number of sources fetched (for the header line). */
	sourceCount: number;
}

/**
 * up/down = taste; text = the reader's own words (R4 made it a first-class
 * button — it carries everything a fixed button can't); want = appeal from the
 * filtered-out section; text with itemId `__issue__` = the end-of-issue "what
 * should have been here?" answer.
 *
 * known/more are retired from the UI (R4 收敛到三个按钮) but stay in the type:
 * events written before that are still read back by the feedback digest, and
 * they mean different things — known = right topic, already seen (raise the
 * novelty bar, never down-weight the topic); more = strongest positive signal.
 */
export type FeedbackKind = "up" | "down" | "known" | "more" | "text" | "want";

/**
 * T1 · 一条线索的一条证据。字段是冗余快照(标题/链接都存下来),不指回简报:
 * 简报 90 天后可能已经不在了,而台账是长期资产,不该跟着一起失忆。
 */
export interface ThreadEvidence {
	date: string;
	itemId: string;
	title: string;
	url: string;
	source: string;
}

/**
 * fresh  = 刚出现,只有一条证据
 * active = 还在持续出料
 * quiet  = 8–20 天没有新证据
 * dormant= 21 天以上没动静(45 天后移出活跃列表)
 */
export type ThreadStage = "fresh" | "active" | "quiet" | "dormant";

/**
 * T1 · 线索:一个追踪器底下正在发展的一件事。
 *
 * 这是「追踪器」从**每日筛选条件**变成**真的在追踪**的那个东西:没有它,
 * 每期简报生成完即丢,读者永远看不到一个问题三个月来的进展。
 */
export interface Thread {
	key: string;
	trackerKey: string;
	title: string;
	/** 第一次出现的日期(YYYY-MM-DD)。 */
	firstSeen: string;
	/** 最近一条证据的日期。阶段机全看它。 */
	lastEvidence: string;
	stage: ThreadStage;
	/** 最新在前,硬上限 MAX_THREAD_EVIDENCE 条,超出挤掉最旧。 */
	evidence: ThreadEvidence[];
	/** 沉寂 45 天后置位:移出活跃列表,但**不删**——台账不销毁历史。 */
	archived?: boolean;
	updatedAt: string;
}

/** 一条线索最多留几条证据。有界状态:台账不能无限长。 */
export const MAX_THREAD_EVIDENCE = 10;
/** 多少天没新证据算沉寂 / 该归档。 */
export const THREAD_DORMANT_DAYS = 21;
export const THREAD_ARCHIVE_DAYS = 45;

/**
 * R5 · 期末一问「今天有什么本该知道却没出现」的 itemId 哨兵。它是刊级反馈,
 * 不指向任何条目,但 itemId 是必填——用哨兵值,不为它改数据结构。
 * 放在 types.ts(零依赖)而不是 feedback.ts:阅读页也要用它,不该为一个常量
 * 把 Store 那一摊拖进前端包。
 */
export const ISSUE_ITEM_ID = "__issue__";

export interface FeedbackEvent {
	date: string;
	itemId: string;
	kind: FeedbackKind;
	/** Free-form comment for kind "text" (may accompany a vote). */
	text?: string;
	at: string;
}

/** N1 · 想法台账里的一次表态:一票或一段话,带时间。 */
export interface NoteEntry {
	at: string;
	kind: FeedbackKind;
	text?: string;
}

/**
 * N1 · 想法台账:一条简报内容名下,读者留过的全部反馈与想法。
 *
 * 事件流(FeedbackEvent)是写给选材模型的——只存 itemId、90 天过期;想法是
 * 读者自己的资产,道理同 T1 的线索台账:字段是冗余快照(标题/链接/分区都
 * 存下来,不指回简报),**不设 TTL**。简报会过期,「我当时是怎么想的」不该
 * 跟着一起失忆。刊级反馈(期末一问)没有条目可指,快照字段全缺省,靠
 * itemId === ISSUE_ITEM_ID 识别。
 */
export interface ItemNote {
	/** 所属简报的日期(YYYY-MM-DD)。 */
	date: string;
	itemId: string;
	/** 落台账当时从简报里抄下的快照;简报已被覆盖/过期时缺省。 */
	title?: string;
	url?: string;
	source?: string;
	sectionTitle?: string;
	/** 时间正序,追加写;满了挤掉最旧(有界状态,同 MAX_THREAD_EVIDENCE)。 */
	entries: NoteEntry[];
	updatedAt: string;
}

/** 一条内容名下最多留几次表态。50 = 对同一条写 50 段想法,现实里到不了。 */
export const MAX_NOTE_ENTRIES = 50;
