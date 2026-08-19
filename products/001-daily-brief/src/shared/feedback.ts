// R2/R3 · 反馈回路(docs/03-实施清单.md §3.6)。在这之前反馈是**只写不读**的:
// 事件写进 FB#/CLICK#,没有任何代码读回来,`feedbackEcho` 字段声明了却永远是
// undefined。这个模块就是那条缺失的回路——读事件、拼进编辑提示词、算出回响。
//
// 两条硬规矩:
//   1. 事件只存 itemId,标题/来源必须回查当期简报才有。所以读完事件先按 date
//      批量 getBrief 做 join,再组提示词——直接把 itemId 丢给模型毫无意义。
//   2. 回响(feedbackEcho)里的**数字一律由代码算**,模型至多润色。自证性的
//      数字出自模型之口,就会变成一句永远正确的空话,比不做更伤信任(同 P0-1)。

// value import 一律带 .ts 扩展名:feedback.test.ts 经 node --experimental-strip-types
// 直接加载本模块,node 不做扩展名搜索(type-only import 会被擦掉,不受此限)。
import type { Brief, BriefItem, FeedbackEvent, FeedbackKind } from "./types";
import { ISSUE_ITEM_ID } from "./types.ts";
import type { ClickEvent, Store, StoredEvent } from "./store";
import { isFeedbackEvent } from "./store.ts";

/** 选材只看近 7 天:再往前的口味已经被后来的反馈覆盖掉了。 */
export const FEEDBACK_WINDOW_DAYS = 7;

/** join 时最多回查几期简报(窗口 7 天,给 8 是容错)。 */
const MAX_BRIEF_LOOKUPS = 8;
/** 每类反馈进提示词的条数上限——反馈是调子,不该淹没候选列表。 */
const MAX_NOTES_PER_KIND = 8;

/** 一条反馈事件 join 回它指向的条目之后的样子。 */
export interface FeedbackNote {
	kind: FeedbackKind;
	date: string;
	itemId: string;
	/** 刊级反馈(ISSUE_ITEM_ID)与已过期简报的条目没有标题。 */
	title?: string;
	source?: string;
	sourceKey?: string;
	/** 该条所在分区 = 追踪器 key(来自「已筛掉」区的条目没有)。 */
	trackerKey?: string;
	text?: string;
	/** 只有 want 才有:它来自「已筛掉」区,当初的过滤理由是最有用的信息。 */
	droppedReason?: string;
}

export interface FeedbackDigest {
	/** 窗口起点(ISO),写进日志方便对账。 */
	since: string;
	notes: FeedbackNote[];
	/** itemId → 窗口内点击次数。X2 的自动降频和 S 线指标都读它。 */
	clicks: Map<string, number>;
	clickCount: number;
	/** H5 · 原始点击事件(带 host)。按域名聚合的反向发现要用。 */
	clickEvents: ClickEvent[];
	/** join 时回查到的往期简报(date → brief),算回响时还要用,别重复读。 */
	briefs: Map<string, Brief>;
}

export const EMPTY_DIGEST: FeedbackDigest = {
	since: "",
	notes: [],
	clicks: new Map(),
	clickCount: 0,
	clickEvents: [],
	briefs: new Map(),
};

function findInBrief(brief: Brief, itemId: string): Partial<FeedbackNote> | null {
	for (const section of brief.sections) {
		const hit = section.items.find((i: BriefItem) => i.id === itemId);
		if (hit) {
			return {
				title: hit.title,
				source: hit.source,
				...(hit.sourceKey ? { sourceKey: hit.sourceKey } : {}),
				trackerKey: section.key,
			};
		}
	}
	const dropped = brief.filteredOut.items.find((d) => d.id === itemId);
	if (dropped) {
		return { title: dropped.title, source: dropped.source, droppedReason: dropped.reason };
	}
	return null;
}

function toNote(ev: FeedbackEvent, brief: Brief | undefined): FeedbackNote | null {
	const base: FeedbackNote = {
		kind: ev.kind,
		date: ev.date,
		itemId: ev.itemId,
		...(ev.text ? { text: ev.text } : {}),
	};
	if (ev.itemId === ISSUE_ITEM_ID) return base; // 刊级反馈本来就不指向条目
	const joined = brief ? findInBrief(brief, ev.itemId) : null;
	// 简报已过期(90 天事件 vs 更早的简报)又没有自由文本的裸投票,进提示词
	// 只是噪音:模型既不知道读者点的是什么,也无从调整。
	if (!joined) return ev.text ? base : null;
	return { ...base, ...joined };
}

/**
 * R1 的唯一消费者:读近 `days` 天事件,join 回条目,产出可直接进提示词的摘要。
 * 任何一步失败都降级成空摘要——反馈回路坏掉不该让当天的简报生不出来。
 */
export async function loadFeedbackDigest(
	store: Store,
	email: string,
	opts: { days?: number; now?: Date; log?: (msg: string) => void } = {},
): Promise<FeedbackDigest> {
	const days = opts.days ?? FEEDBACK_WINDOW_DAYS;
	const since = new Date((opts.now ?? new Date()).getTime() - days * 86_400_000).toISOString();
	try {
		const events: StoredEvent[] = await store.listEvents(email, since);
		const clicks = new Map<string, number>();
		const clickEvents: ClickEvent[] = [];
		const feedback: FeedbackEvent[] = [];
		for (const ev of events) {
			if (isFeedbackEvent(ev)) {
				feedback.push(ev);
			} else {
				clicks.set(ev.itemId, (clicks.get(ev.itemId) ?? 0) + 1);
				clickEvents.push(ev);
			}
		}
		const clickCount = [...clicks.values()].reduce((n, v) => n + v, 0);

		const dates = [...new Set(feedback.map((f) => f.date))].sort().reverse().slice(0, MAX_BRIEF_LOOKUPS);
		const briefs = new Map<string, Brief>();
		await Promise.all(
			dates.map(async (d) => {
				const stored = await store.getBrief(email, d);
				if (stored) briefs.set(d, stored.brief);
			}),
		);

		const notes = feedback
			.map((ev) => toNote(ev, briefs.get(ev.date)))
			.filter((n): n is FeedbackNote => n !== null);
		opts.log?.(`[feedback] ${notes.length} notes, ${clickCount} clicks since ${since.slice(0, 10)}`);
		return { since, notes, clicks, clickCount, clickEvents, briefs };
	} catch (err) {
		opts.log?.(`[feedback] FAILED, generating without it: ${err}`);
		return { ...EMPTY_DIGEST, since };
	}
}

function label(note: FeedbackNote): string {
	const parts = [note.title ? `「${note.title}」` : "(该条已不在留存的简报里)"];
	if (note.source) parts.push(`来源 ${note.source}`);
	if (note.text) parts.push(`读者原话:${note.text}`);
	return parts.join(" — ");
}

function group(notes: FeedbackNote[], kinds: FeedbackKind[]): FeedbackNote[] {
	return notes.filter((n) => kinds.includes(n.kind)).slice(0, MAX_NOTES_PER_KIND);
}

/**
 * 拼进编辑提示词的反馈段。空摘要返回空串,调用方据此决定加不加这一段。
 *
 * 四类信号的处理方向**互不相同**,提示词里必须说清,否则模型会一律当成
 * 「喜欢/不喜欢」:`known` 说的是「话题对、我看过了」,把它当 `down` 处理
 * 会把读者最关心的话题误杀掉。
 */
export function feedbackPromptBlock(digest: FeedbackDigest): string {
	if (digest.notes.length === 0) return "";
	const blocks: string[] = [];

	const down = group(digest.notes, ["down"]);
	if (down.length) {
		blocks.push(`【没用】读者明确否掉的,同类今天下调:\n${down.map((n) => `- ${label(n)}`).join("\n")}`);
	}
	const known = group(digest.notes, ["known"]);
	if (known.length) {
		blocks.push(
			"【已知道】话题是对的,只是读者已经看过了。**只提高新鲜度要求,绝不要下调这个话题**:\n" +
				known.map((n) => `- ${label(n)}`).join("\n"),
		);
	}
	const positive = group(digest.notes, ["up", "more"]);
	if (positive.length) {
		blocks.push(
			`【有用 / 多找这种】正信号,同源同话题优先:\n${positive.map((n) => `- ${label(n)}`).join("\n")}`,
		);
	}
	const want = group(digest.notes, ["want"]);
	if (want.length) {
		blocks.push(
			"【读者从「已筛掉」里捞回来的】当初的过滤理由是错的,别再用同样的理由滤掉:\n" +
				want
					.map((n) => `- ${label(n)}${n.droppedReason ? `(当初理由:${n.droppedReason})` : ""}`)
					.join("\n"),
		);
	}
	const issue = digest.notes.filter((n) => n.itemId === ISSUE_ITEM_ID && n.text).slice(0, MAX_NOTES_PER_KIND);
	if (issue.length) {
		blocks.push(
			"【读者说这几期缺了什么】——这是选材的空洞,今天优先补:\n" +
				issue.map((n) => `- ${n.date}:${n.text}`).join("\n"),
		);
	}
	const freeText = digest.notes
		.filter((n) => n.kind === "text" && n.text && n.itemId !== ISSUE_ITEM_ID)
		.slice(0, MAX_NOTES_PER_KIND);
	if (freeText.length) {
		blocks.push(`【读者对具体条目的看法】:\n${freeText.map((n) => `- ${label(n)}`).join("\n")}`);
	}

	if (blocks.length === 0) return "";
	return `读者近 ${FEEDBACK_WINDOW_DAYS} 天的反馈(读者亲口说的,权重高于你的猜测;但追踪器的「不收」列表仍是硬排除,反馈不能推翻定义):\n\n${blocks.join("\n\n")}`;
}

// ---------- R3 · 回响(数字全部由代码算) ----------

function countBySource(brief: Brief): Map<string, number> {
	const counts = new Map<string, number>();
	for (const section of brief.sections) {
		for (const item of section.items) {
			counts.set(item.source, (counts.get(item.source) ?? 0) + 1);
		}
	}
	return counts;
}

const KIND_LABEL: Partial<Record<FeedbackKind, string>> = {
	down: "「没用」",
	known: "「已知道」",
	more: "「多找这种」",
	up: "「有用」",
	want: "「我想要那条」",
};

/**
 * 首屏那句「基于你的反馈…」。只说两件能被验证的事:**收到了什么**(数事件),
 * 以及**哪个来源的条数真的降了**(比两期简报)。因果没验证出来就不写——
 * 宁可少一句,也不要一句永远正确的空话。
 */
export function buildFeedbackEcho(digest: FeedbackDigest, today: Brief): string | undefined {
	// 「上一次」= 窗口内最近一个有反馈、且不是今天这期的日期
	const dates = [...new Set(digest.notes.map((n) => n.date))].filter((d) => d !== today.date).sort();
	const last = dates.at(-1);
	if (!last) return undefined;
	const recent = digest.notes.filter((n) => n.date === last);
	if (recent.length === 0) return undefined;

	const counted = new Map<string, number>();
	for (const n of recent) {
		const key = KIND_LABEL[n.kind];
		if (key) counted.set(key, (counted.get(key) ?? 0) + 1);
	}
	const textCount = recent.filter((n) => n.text).length;
	const received = [
		...[...counted].map(([k, v]) => `${v} 条${k}`),
		...(textCount ? [`${textCount} 条看法`] : []),
	];
	if (received.length === 0) return undefined;

	// 效果:被否掉的那些来源,今天的条数是不是真的少了
	const effects: string[] = [];
	const prev = digest.briefs.get(last);
	if (prev) {
		const before = countBySource(prev);
		const after = countBySource(today);
		const negatives = new Set(
			recent.filter((n) => n.kind === "down" && n.source).map((n) => n.source as string),
		);
		for (const source of negatives) {
			const b = before.get(source) ?? 0;
			const a = after.get(source) ?? 0;
			if (a < b) effects.push(`${source} 从 ${b} 条降到 ${a} 条`);
		}
	}

	const head = `你在 ${last} 留下了 ${received.join("、")}`;
	// 没测出变化就只报「已计入」——这句是真的(反馈确实进了今天的选材提示词),
	// 而「所以今天少了 X」在没算出差值时并不是。
	return effects.length > 0 ? `${head};今天 ${effects.join(",")}。` : `${head},已计入今天的选材。`;
}
