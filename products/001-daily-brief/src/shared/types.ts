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
 * Four one-click signals + free text + rescue-from-filtered:
 * up/down = taste; known = right topic but stale (novelty signal, don't
 * down-weight the topic); more = highest-quality positive signal, feeds the
 * tracker's include-list; want = appeal from the filtered-out section.
 */
export type FeedbackKind = "up" | "down" | "known" | "more" | "text" | "want";

export interface FeedbackEvent {
	date: string;
	itemId: string;
	kind: FeedbackKind;
	/** Free-form comment for kind "text" (may accompany a vote). */
	text?: string;
	at: string;
}
