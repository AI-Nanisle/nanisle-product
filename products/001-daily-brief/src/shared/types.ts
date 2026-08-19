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
	/** Stable key of the source config this item came from (absent in old briefs). */
	sourceKey?: string;
	/** Comment-thread URL (HN etc.) when one exists. */
	discussionUrl?: string;
	/** 1–2 related links for going deeper (same-day related coverage, data source, opposing view). */
	extras?: BriefLink[];
	/** Doubts, caveats or disagreement present in the original — preserved, never flattened. */
	caveat?: string;
	/** How this item relates to its tracker's question (one clause). */
	relatesTo?: string;
	/** When several sources covered the same event, the other reports merged into this item. */
	mergedFrom?: BriefLink[];
}

export interface DroppedItem {
	id: string;
	title: string;
	url: string;
	source: string;
	/** Why it was filtered out (rule name or model's reason). */
	reason: string;
}

export interface BriefSection {
	/** Tracker key this section belongs to (built-ins use "headlines"/"learn"). */
	key: string;
	title: string;
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
