// T3–T5 · 线索台账的读写逻辑(docs/03-实施清单.md §3.7)。
//
// 这是「追踪器」从**每日筛选条件**变成**真的在追踪**的地方:在这之前,每期
// 简报生成完即丢,读者看不到一个问题三个月来的进展。有了台账,一条内容不再
// 只是「今天的一条」,而是「某条线索的第 5 条证据,上次是 12 天前」。
//
// 两条规矩,和 R3 的回响同源:
//   1. 归并**不新增 LLM 调用**——线索清单塞进本来就要发的那一次编辑请求里。
//   2. 「第 5 条证据、上次 12 天前」这类数字**由代码算**,模型只负责归类。

import type { Brief, BriefItem, Thread, ThreadEvidence, ThreadStage } from "./types";
import { MAX_THREAD_EVIDENCE, THREAD_ARCHIVE_DAYS, THREAD_DORMANT_DAYS } from "./types.ts";

/** 进编辑提示词的活跃线索上限——提示词里线索清单不能喧宾夺主。 */
export const MAX_THREADS_IN_PROMPT = 20;

function daysBetween(from: string, to: string): number {
	const a = Date.parse(`${from}T00:00:00Z`);
	const b = Date.parse(`${to}T00:00:00Z`);
	if (Number.isNaN(a) || Number.isNaN(b)) return 0;
	return Math.round((b - a) / 86_400_000);
}

/**
 * 阶段只是 `lastEvidence` 距今多久的一个说法,不额外存状态机——状态机会和
 * 事实脱钩(某天没跑成生成,阶段就永远停在那儿),而日期不会。
 */
export function computeStage(thread: Pick<Thread, "lastEvidence" | "evidence">, today: string): ThreadStage {
	const idle = daysBetween(thread.lastEvidence, today);
	if (idle >= THREAD_DORMANT_DAYS) return "dormant";
	if (idle >= 8) return "quiet";
	return thread.evidence.length <= 1 ? "fresh" : "active";
}

export function shouldArchive(thread: Thread, today: string): boolean {
	return daysBetween(thread.lastEvidence, today) >= THREAD_ARCHIVE_DAYS;
}

/** 活跃 = 没归档、且不是 dormant 之外的什么都算(dormant 仍然展示,只是折叠)。 */
export function activeThreads(threads: Thread[]): Thread[] {
	return threads.filter((t) => !t.archived);
}

/** 拼进编辑提示词的线索清单。空数组返回空串,调用方据此决定加不加。 */
export function threadsPromptBlock(threads: Thread[], today: string): string {
	const live = activeThreads(threads)
		.filter((t) => computeStage(t, today) !== "dormant")
		.sort((a, b) => b.lastEvidence.localeCompare(a.lastEvidence))
		.slice(0, MAX_THREADS_IN_PROMPT);
	if (live.length === 0) return "";
	return live.map((t) => `    - ${t.key} 「${t.title}」(最近 ${t.lastEvidence},共 ${t.evidence.length} 条)`).join("\n");
}

/** 模型给的新线索 key 不可信:归一成安全字符,并保证非空。 */
export function normalizeThreadKey(raw: string, fallbackSeed: string): string {
	const cleaned = raw
		.trim()
		.toLowerCase()
		.replace(/[^a-z0-9-]+/g, "-")
		.replace(/^-+|-+$/g, "")
		.slice(0, 40);
	return cleaned || `th-${fallbackSeed.slice(0, 8)}`;
}

export interface ThreadUpdate {
	/** 需要落库的线索(新建或有变化的)。 */
	changed: Thread[];
}

/**
 * T4/T5 · 把今天这期的条目并进台账,并把「第几条证据、上次多久前」写回条目。
 *
 * 注意顺序:注记要用**并入之前**的线索状态算(「上次是 12 天前」说的是上一条
 * 证据,不是刚加的这条),所以先算注记再 push。
 */
export function applyThreads(brief: Brief, existing: Thread[], today: string, now = new Date().toISOString()): ThreadUpdate {
	const byKey = new Map(existing.map((t) => [t.key, t]));
	const changed = new Map<string, Thread>();
	// 一期之内同一条线索只收一条证据。模型倾向于把「都跟 agent 有关」的东西
	// 往同一条线索里塞(线上实测:临床试验 DAG、游戏生成、自我改进 agent 被归成
	// 一条),而同一天同一件事的多篇报道本来就该走 merged 合并,不是三条证据。
	const usedThisIssue = new Set<string>();

	for (const section of brief.sections) {
		for (const item of section.items) {
			if (!item.threadKey) continue;
			if (usedThisIssue.has(item.threadKey)) {
				// 同期重复归并 = 几乎必然是误归:让它独立成线索,别污染时间线
				item.threadKey = normalizeThreadKey(item.title.slice(0, 24), item.id);
				item.threadTitle = item.threadTitle ?? item.title;
			}
			usedThisIssue.add(item.threadKey);
			const prior = byKey.get(item.threadKey);
			const evidence: ThreadEvidence = {
				date: brief.date,
				itemId: item.id,
				title: item.title,
				url: item.url,
				source: item.source,
			};
			if (!prior) {
				const thread: Thread = {
					key: item.threadKey,
					trackerKey: section.key,
					// 线索标题优先用模型给的;没给就退回条目标题,总比没有强
					title: (item.threadTitle ?? item.title).slice(0, 80),
					firstSeen: brief.date,
					lastEvidence: brief.date,
					stage: "fresh",
					evidence: [evidence],
					updatedAt: now,
				};
				byKey.set(thread.key, thread);
				changed.set(thread.key, thread);
				item.threadNote = "新线索的第 1 条";
				continue;
			}
			// 注记用并入前的状态算
			const gap = daysBetween(prior.lastEvidence, brief.date);
			const nth = prior.evidence.length + 1;
			item.threadNote =
				gap > 0
					? `本线索第 ${nth} 条证据 · 上次 ${gap} 天前`
					: `本线索第 ${nth} 条证据 · 同日`;
			const merged: Thread = {
				...prior,
				trackerKey: section.key,
				lastEvidence: brief.date,
				evidence: [evidence, ...prior.evidence.filter((e) => e.itemId !== evidence.itemId)].slice(
					0,
					MAX_THREAD_EVIDENCE,
				),
				updatedAt: now,
			};
			merged.stage = computeStage(merged, today);
			byKey.set(merged.key, merged);
			changed.set(merged.key, merged);
		}
	}

	// 今天没被碰到的线索也要走一遍阶段机:沉寂是「时间到了」,不是「有人来更新」
	for (const thread of existing) {
		if (changed.has(thread.key) || thread.archived) continue;
		const stage = computeStage(thread, today);
		const archived = shouldArchive(thread, today) || undefined;
		if (stage !== thread.stage || archived !== thread.archived) {
			changed.set(thread.key, { ...thread, stage, ...(archived ? { archived } : {}), updatedAt: now });
		}
	}

	return { changed: [...changed.values()] };
}

/** 阅读页/档案页展示用的排序:活跃在前,同组按最近证据倒序。 */
export function sortThreadsForDisplay(threads: Thread[], today: string): Thread[] {
	const rank: Record<ThreadStage, number> = { active: 0, fresh: 1, quiet: 2, dormant: 3 };
	return [...threads].sort((a, b) => {
		const ra = rank[computeStage(a, today)] - rank[computeStage(b, today)];
		return ra !== 0 ? ra : b.lastEvidence.localeCompare(a.lastEvidence);
	});
}

/** 落库前把只在生成过程中有用的临时字段抹掉,别让它进简报。 */
export function stripTransient(brief: Brief): void {
	for (const section of brief.sections) {
		for (const item of section.items as (BriefItem & { threadTitle?: string })[]) {
			delete item.threadTitle;
		}
	}
}
