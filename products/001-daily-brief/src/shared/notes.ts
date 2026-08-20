// N1 · 想法台账的落账逻辑(docs/03-实施清单.md §3.8)。R 线让反馈回到了明天的
// 选材,但对**读者自己**反馈仍是只写不读:事件 90 天过期、只存 itemId,写下的
// 想法既看不见也找不回。这个模块把每条反馈同时落进不过期的台账——快照在
// 写入时就抄好(标题/链接/分区),回溯不依赖简报还活着。
//
// 唯一的写入口是 applyEventToNote:纯函数,读改写由调用方(Worker)做。
// 快照只在**建账**时抄一次;追加永远不动已有快照——台账记的是「当时」。

// value import 带 .ts 扩展名:notes.test.ts 经 node --experimental-strip-types
// 直接加载本模块,node 不做扩展名搜索(type-only import 会被擦掉,不受此限)。
import type { Brief, FeedbackEvent, ItemNote, NoteEntry } from "./types";
import { ISSUE_ITEM_ID, MAX_NOTE_ENTRIES } from "./types.ts";

/**
 * 刊级反馈(期末一问)在想法页的固定标题。放这里而不是存进数据:台账存的是
 * 事实快照,界面文案改了不该要求回写历史数据。
 */
export const ISSUE_NOTE_TITLE = "期末一问:本该知道却没出现的";

type Snapshot = Pick<ItemNote, "title" | "url" | "source" | "sectionTitle">;

/**
 * 从当期简报里抄快照。比 feedback.ts 的 findInBrief 多找两处:轴外位(它有
 * 自己的反馈按钮,漏掉它的想法会变成无名账)和「已替你筛掉」区。
 */
function snapshotFromBrief(brief: Brief, itemId: string): Snapshot | null {
	for (const section of brief.sections) {
		const hit = section.items.find((i) => i.id === itemId);
		if (hit) return { title: hit.title, url: hit.url, source: hit.source, sectionTitle: section.title };
	}
	if (brief.offAxis?.id === itemId) {
		const { title, url, source } = brief.offAxis;
		return { title, url, source, sectionTitle: "不在你的追踪范围内" };
	}
	const dropped = brief.filteredOut.items.find((d) => d.id === itemId);
	if (dropped) {
		return { title: dropped.title, url: dropped.url, source: dropped.source, sectionTitle: "已替你筛掉" };
	}
	return null;
}

/**
 * 一条反馈事件落进台账:没有账就建账(顺手抄快照),有账就追加。
 * 简报已不在(被覆盖/过期后的补记)时建的是无快照账——想法本身仍然要留住,
 * 这正是台账和事件流的区别。
 */
export function applyEventToNote(
	existing: ItemNote | null,
	ev: FeedbackEvent,
	brief: Brief | null,
): ItemNote {
	const entry: NoteEntry = { at: ev.at, kind: ev.kind, ...(ev.text ? { text: ev.text } : {}) };
	if (existing) {
		return {
			...existing,
			entries: [...existing.entries, entry].slice(-MAX_NOTE_ENTRIES),
			updatedAt: ev.at,
		};
	}
	// 刊级反馈本来就不指向条目,不去简报里白找
	const snapshot = ev.itemId === ISSUE_ITEM_ID ? null : brief ? snapshotFromBrief(brief, ev.itemId) : null;
	return {
		date: ev.date,
		itemId: ev.itemId,
		...(snapshot ?? {}),
		entries: [entry],
		updatedAt: ev.at,
	};
}
