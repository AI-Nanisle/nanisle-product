import { USAGE_CHANGED, apiPath } from "./paths";
import type { Tracker } from "../shared/pipeline-core";

// 「编辑」在配置侧的通道(F2):三步向导的三个端点 + 档案页的「对编辑说一句」。
// 每个都是一次普通 fetch——每步产出什么是确定的,服务端一次结构化调用就回来,
// 旧的 NDJSON 工具循环流(streamEditor)已随 chat.ts 退役。
//
// 这里不带对话历史:配置状态服务端自己有,草稿(stage)也存在服务端,
// 刷新、换设备都能续上。

/** 试抓结果(POST /api/sources/test,以及候选源卡里的预览)。 */
export interface TestResult {
	ok: boolean;
	url?: string;
	total?: number;
	fresh?: number;
	latest?: { title: string; publishedAt: string | null }[];
	resolvedFrom?: string;
	error?: string;
}

/** 编辑推荐、且已经试抓验证过的候选来源(服务端只回传抓通的)。 */
export interface ProposalItem {
	name: string;
	url: string;
	category: string;
	reason?: string;
	ok: boolean;
	total?: number;
	fresh?: number;
	latest?: { title: string; publishedAt: string | null }[];
	error?: string;
}

/** 向导端点的统一响应:改动过草稿时带回 tracker/trackers,选源步带 candidates。 */
export interface WizardResponse {
	tracker?: Tracker;
	trackers?: Tracker[];
	candidates?: ProposalItem[];
	/** R8 · 编辑还不知道用户拿它干什么时的追问(问法和选项都由服务端固定)。 */
	ask?: { question: string; options: string[] };
	note?: string;
}

async function post<T>(path: string, body: unknown, headers: Record<string, string>): Promise<T> {
	let res: Response;
	try {
		res = await fetch(apiPath(path), {
			method: "POST",
			headers: { "content-type": "application/json", ...headers },
			body: JSON.stringify(body),
		});
	} catch {
		throw new Error("网络错误,请重试");
	}
	// 这里的四个端点每次都动当日编辑额度,通知页眉重取读数。成功失败都要发:
	// 模型报错也计一笔(token 已经花了),读数照样得往前走。429 更要发——
	// 那正是读数该跳到「已用完」的时刻。
	window.dispatchEvent(new Event(USAGE_CHANGED));
	const data = (await res.json().catch(() => ({}))) as T & { error?: string };
	if (!res.ok) throw new Error(data.error ?? `HTTP ${res.status}`);
	return data;
}

/**
 * 步骤 1 · 理解:messages 是本次向导里用户说过的话(第一句 = 原话)。
 * purpose 是用户对 `ask` 追问的回答(选项文本或自填);带上它这一轮就不再追问。
 */
export function wizardUnderstand(
	messages: string[],
	trackerKey: string | undefined,
	headers: Record<string, string>,
	purpose?: string,
): Promise<WizardResponse> {
	return post(
		"wizard/understand",
		{ messages, ...(trackerKey ? { trackerKey } : {}), ...(purpose ? { purpose } : {}) },
		headers,
	);
}

/** 步骤 2 · 标签:基于已确认的理解起草收/不收建议。 */
export function wizardTags(trackerKey: string, headers: Record<string, string>): Promise<WizardResponse> {
	return post("wizard/tags", { trackerKey }, headers);
}

/**
 * 步骤 3 · 信源(档案页「让编辑再找几个」也走这里):服务端自动排除该追踪器
 * 已采纳/已拒绝的 URL;excludeUrls 用来排除本轮已展示、用户尚未表态的候选。
 */
export function wizardSources(
	trackerKey: string,
	excludeUrls: string[],
	headers: Record<string, string>,
): Promise<WizardResponse> {
	return post("wizard/sources", { trackerKey, ...(excludeUrls.length ? { excludeUrls } : {}) }, headers);
}

/**
 * 「对编辑说一句」(POST /api/refine):返回修改 patch(只含 intent/include/
 * exclude/sourceRules 中要改的字段)和一行说明,落库由调用方 onPatch 完成。
 */
export function refineTracker(
	trackerKey: string,
	text: string,
	headers: Record<string, string>,
): Promise<{ patch: Partial<Tracker>; note?: string }> {
	return post("refine", { trackerKey, text }, headers);
}
