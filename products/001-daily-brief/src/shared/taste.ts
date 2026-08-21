// R9 · 口味画像:反馈的长期蒸馏。近 7 天反馈段(feedback.ts)解决「这两天
// 说过的话」,这里解决「几个月来一直这样」——反馈事件 90 天就过期,不蒸馏,
// 长期口味会跟着 TTL 一起蒸发。做法照抄 newscope 的偏好摘要闭环:反馈攒到
// 阈值就让模型把它们重写成一段持久的备忘,存进配置、每天注入选材提示词。
//
// 三条纪律:
//   1. 画像只从反馈事实里来,模型不许臆测读者的职业、性格、动机——提示词里
//      写死,截断兜底。
//   2. 它是背景校准,不是硬规则:编辑提示词里排在追踪器定义与近期反馈之后,
//      冲突时让位(pipeline-core 第 15 条)。
//   3. 读者改过的画像(edited)是他的原话:重蒸馏必须逐条保留其中的明确偏好,
//      只许追加或按新反馈更新——用户的原话是宪法,和周自评同一条规矩。

// 值导入带 .ts:CLI/node --test 直跑不做无扩展名解析(同 default-sources.ts 注)。
import { isFeedbackEvent } from "./store.ts";
import type { Store, TasteProfile, UserConfig } from "./store";
import { loadFeedbackDigest } from "./feedback.ts";
import type { FeedbackNote } from "./feedback";
import { normalizeCnStyle } from "./style.ts";
import { ISSUE_ITEM_ID } from "./types.ts";

/** 攒多少条新反馈才值得重新蒸馏一次(newscope 的默认阈值也是 10)。 */
export const TASTE_MIN_FEEDBACK = 10;
/** 画像的目标长度:一段备忘,不是一篇小传。提示词管长度,截断只防失控。 */
export const TASTE_MAX_CHARS = 500;
/** 没有画像时最多回看多少天(= 事件 TTL,再往前也没有了)。 */
const TASTE_LOOKBACK_DAYS_MAX = 90;

const KIND_LABEL: Record<string, string> = {
	down: "没用",
	known: "已知道",
	up: "有用",
	more: "多找这种",
	want: "被筛掉但读者要",
	text: "看法",
};

function noteLine(n: FeedbackNote): string {
	const parts: string[] = [`[${KIND_LABEL[n.kind] ?? n.kind}]`];
	if (n.itemId === ISSUE_ITEM_ID) parts.push("(对整期的反馈)");
	else if (n.title) parts.push(`「${n.title}」`);
	if (n.source) parts.push(`来源 ${n.source}`);
	if (n.droppedReason) parts.push(`当初筛掉的理由:${n.droppedReason}`);
	if (n.text) parts.push(`读者原话:${n.text}`);
	return `- ${n.date} ${parts.join(" ")}`;
}

export function buildTastePrompt(
	prev: TasteProfile | undefined,
	notes: FeedbackNote[],
): { system: string; user: string } {
	const system = `你是一份个人每日简报的编辑,在为一位长期读者维护一段「口味画像」备忘——今后每天选材前你都会重读它。把下面的反馈记录蒸馏成一段中文备忘,直接写给未来选材的自己。

硬规则:
1. 只写反馈里有依据的偏好:哪类话题、角度、来源他要更多,哪类他明确不要,口味最近有什么变化。每一条都要能从反馈里指出出处。不许臆测他的职业、性格、动机——反馈里没有的事,一个字都不许写。
2. 和旧画像冲突时以新反馈为准,并把变化写出来(例如:过去常点开 X,最近连续说没用,少给)。旧画像里新反馈没有推翻的结论保留。
3. ≤${TASTE_MAX_CHARS} 字,连贯的一到三短段,不列编号清单。写具体,别写「他喜欢高质量内容」这种谁都适用的废话。
4. 只输出 JSON:{"summary": "..."},不要任何其他文字。`;

	const prevBlock = prev
		? `旧画像(${prev.updatedAt.slice(0, 10)} 写下${
				prev.edited ? ";**读者亲手改过**,其中的明确偏好必须逐条保留,只许追加或按新反馈更新" : ""
			}):
${prev.summary}

`
		: "";
	const user = `${prevBlock}自那以后的反馈(共 ${notes.length} 条,新的在前):
${notes.map(noteLine).join("\n")}

返回 JSON:{"summary": "..."}`;
	return { system, user };
}

export function parseTasteJson(raw: string): string {
	const cleaned = raw.replace(/^```(?:json)?\s*/i, "").replace(/\s*```\s*$/, "");
	const parsed = JSON.parse(cleaned) as { summary?: unknown };
	if (typeof parsed.summary !== "string" || !parsed.summary.trim()) return "";
	// 提示词管长度,这里只防失控;卡死在上限会把最后一句砍半,比长一点难看。
	return normalizeCnStyle(parsed.summary.trim()).slice(0, TASTE_MAX_CHARS + 200);
}

/** 进编辑提示词的画像段。没画像返回空串,调用方据此决定加不加这一段。 */
export function tastePromptBlock(taste: TasteProfile | undefined): string {
	if (!taste?.summary) return "";
	return `读者的长期口味画像(${taste.updatedAt.slice(0, 10)} 由过往反馈蒸馏${
		taste.edited ? ",读者亲手修订过" : ""
	};背景校准用,与追踪器定义或近期反馈冲突时以后者为准):
${taste.summary}`;
}

export interface TasteDistillDeps {
	call: (system: string, user: string) => Promise<string>;
	log?: (msg: string) => void;
	now?: Date;
}

/**
 * 攒够 TASTE_MIN_FEEDBACK 条新反馈才蒸馏(一次小调用),没攒够返回 null,
 * 调用方沿用存着的旧画像。整段自兜底:蒸馏失败只是画像旧一点,绝不挡当天
 * 的简报——和 enrichBrief 同一条纪律。
 */
export async function maybeDistillTaste(
	store: Store,
	email: string,
	config: UserConfig,
	deps: TasteDistillDeps,
): Promise<TasteProfile | null> {
	const log = deps.log ?? (() => {});
	const now = deps.now ?? new Date();
	try {
		const sinceISO =
			config.taste?.updatedAt ?? new Date(now.getTime() - TASTE_LOOKBACK_DAYS_MAX * 86_400_000).toISOString();
		const events = await store.listEvents(email, sinceISO);
		const freshCount = events.filter(isFeedbackEvent).length;
		if (freshCount < TASTE_MIN_FEEDBACK) return null;
		// join 回条目标题走近 7 天反馈段的同一条路;窗口按上次蒸馏时间放大
		const days = Math.min(
			TASTE_LOOKBACK_DAYS_MAX,
			Math.max(1, Math.ceil((now.getTime() - Date.parse(sinceISO)) / 86_400_000)),
		);
		const digest = await loadFeedbackDigest(store, email, { days, now, log });
		if (digest.notes.length === 0) return null;
		const { system, user } = buildTastePrompt(config.taste, digest.notes);
		const summary = parseTasteJson(await deps.call(system, user));
		if (!summary) return null;
		log(`[taste] 画像重蒸馏:消化 ${freshCount} 条新反馈`);
		return {
			summary,
			updatedAt: now.toISOString(),
			distilledFrom: freshCount,
			// edited 不带过来:这一版是模型写的;读者改过的字句已按纪律 3 进了新稿
		};
	} catch (err) {
		log(`[taste] FAILED, keeping the old profile: ${err}`);
		return null;
	}
}
