// 阶段 7 · 深度报告的**跑动状态**:SSE 分帧 + 事件状态机 + 那几个文案键。
//
// 为什么单独一个文件而不是塞在 App.tsx 里(和 dossier-edit.ts 是同一条家法):
// 这一层是纯函数,所以 report-render.test.ts 能**直接喂一串事件进去**断言
// 「ping 不推进 phase、result 进终态、error 进错误态」。塞在组件里的话,这三条
// 只能靠人肉在浏览器里等 90 秒才验得到一次,而它们恰好是最容易写反的三条。
//
// 契约在 ../shared/types.ts(ReportEvent / ReportPhase),这里一个类型都不另写。

import type { ReportEvent, ReportPhase } from "../shared/types.ts";

// ---------------------------------------------------------------------------
// SSE 分帧
// ---------------------------------------------------------------------------

/**
 * 把收到的字节流切成一个个事件。**做成纯函数是为了能测**:输入是「上次剩下的
 * 半截 + 这次新收到的」,输出是「解析出来的事件 + 还没收全的那半截」。
 *
 * 边界条件全在这一个函数里,而它们是 SSE 消费最常出错的地方:
 *   - 一次 read 可能带回**半个**事件(必须留着,不能丢);
 *   - 一次 read 也可能带回**三个**事件(必须全解析,不能只取第一个);
 *   - `data:` 之外的行(注释、`event:`、`id:`)一律忽略;
 *   - JSON 解析不了的那一帧跳过,**不中断整条流** —— 一帧坏了不代表后面的
 *     result 也不该收到。
 */
export function splitSse(buffer: string): { events: ReportEvent[]; rest: string } {
	const frames = buffer.split("\n\n");
	// 最后一段永远是「还没收全的那半截」(收全了的话它是空串)
	const rest = frames.pop() ?? "";
	const events: ReportEvent[] = [];
	for (const frame of frames) {
		const line = frame.split("\n").find((l) => l.startsWith("data:"));
		if (!line) continue;
		try {
			events.push(JSON.parse(line.slice(5).trim()) as ReportEvent);
		} catch {
			continue;
		}
	}
	return { events, rest };
}

// ---------------------------------------------------------------------------
// 四个 phase 的文案
// ---------------------------------------------------------------------------

/** 服务端推 phase 的顺序(report.ts 的 onPhase 就是按它走的)。 */
export const PHASE_ORDER: readonly ReportPhase[] = ["fetching", "history", "source", "anchoring"];

/**
 * 每一步在页面上叫什么。**说清这一步在干什么**,不是四个进度条颜色——
 * 用户在这里要等 1-2 分钟,而这几十秒里唯一能让他判断「是不是卡住了」的东西
 * 就是这几句话和心跳点。
 */
export const PHASE_TEXT: Record<ReportPhase, { title: string; detail: string }> = {
	fetching: { title: "抓材料", detail: "GitHub 字段 / README / releases / 文件树 / HN 上的讨论 —— 全是原文,还没有模型参与" },
	history: { title: "节 1 · 发展史", detail: "模型在读当年 HN 上的一手反应和 changelog。它在思考的那几十秒里一个字都不会吐出来" },
	source: { title: "节 2 · 源码", detail: "模型在读挑出来的那几份源码正文" },
	anchoring: { title: "逐字锚定", detail: "把每一条引文拿回原文里比对,挂不上的判断当场丢弃 —— 这一步是纯代码,没有模型" },
};

/** 某个 phase 排第几(认不出来时返回 -1,页面据此不给任何一步打勾)。 */
export function phaseIndex(phase: string): number {
	return PHASE_ORDER.indexOf(phase as ReportPhase);
}

// ---------------------------------------------------------------------------
// 状态机
// ---------------------------------------------------------------------------

/**
 * 一趟报告跑到哪了。
 *
 * `beats` 是收到的 **ping 条数**,不是进度。types.ts 说得很清楚:ping 是
 * thinking 期间唯一的字节,它证明的是**连接还活着**,不是「又前进了一步」。
 * 把它渲染成进度就是在编——模型可能在 history 那一步待满 60 秒,期间来 6 个
 * ping,而进度条一格都不该动。页面上它只驱动一个跳动的点。
 *
 * `chars` 同理:delta 只报字符数不报内容(服务端就没发内容),所以页面只能说
 * 「已经吐了 N 字」,不能假装能预览。
 *
 * `resumed` = 这一趟不是这个页面开的,是刷新之后从 `/api/report/inflight`
 * 接回来的。接回来的是**进度不是流**(原来那条 SSE 已经断了,写端在服务端的
 * waitUntil 里拿不回来),所以页面上要说清楚这件事,否则读者会以为他看到的是
 * 实时的字节。
 */
export type RunState =
	| { kind: "idle" }
	| { kind: "running"; fullName: string; phase: ReportPhase | null; chars: number; beats: number; resumed: boolean }
	| { kind: "done"; fullName: string; cached: boolean }
	| { kind: "failed"; fullName: string; error: string; quota: boolean; refresh: boolean };

export const IDLE: RunState = { kind: "idle" };

/** 刚点下「拆开看看」。phase 先留空——第一条 phase 事件回来之前我们确实不知道。 */
export function startRun(fullName: string, resumed = false, phase: ReportPhase | null = null): RunState {
	return { kind: "running", fullName, phase, chars: 0, beats: 0, resumed };
}

/**
 * 喂一条事件进来,得到新状态。**终态吸收一切**:result / error 之后流就关了,
 * 再来的事件一律不改状态(真发生的话是服务端的 bug,而让页面从「完成」跳回
 * 「生成中」比什么都不做更糟)。
 */
export function reduceRun(state: RunState, ev: ReportEvent): RunState {
	if (state.kind !== "running") return state;
	switch (ev.type) {
		case "phase":
			// 只往前走。乱序或重复的 phase 不许把进度条拖回去。
			return phaseIndex(ev.phase) >= phaseIndex(state.phase ?? "") ? { ...state, phase: ev.phase } : state;
		case "delta":
			return { ...state, chars: ev.chars };
		case "ping":
			// **不动 phase**。它只证明连接活着。
			return { ...state, beats: state.beats + 1 };
		case "result":
			return { kind: "done", fullName: state.fullName, cached: ev.cached };
		case "error":
			return { kind: "failed", fullName: state.fullName, error: ev.error, quota: ev.quota === true, refresh: false };
		default:
			// 服务端将来加了新事件类型:忽略,别把页面搞死
			return state;
	}
}

/**
 * 流断了但没收到终态。**必须当失败处理,而且要说清那一单可能还在跑**——
 * 服务端那一趟在 `waitUntil` 里,页面断开它照样跑完照样扣钱(002 就是这么设计的,
 * 003 抄的同一段)。这时候让人「再试一次」等于叫他再花一次 $0.5。
 */
export function streamCutOff(state: RunState): RunState {
	if (state.kind !== "running") return state;
	return {
		kind: "failed",
		fullName: state.fullName,
		error: "连接断了,但服务端那一趟很可能还在跑(它跑在 waitUntil 里,页面关了也不停)。刷新页面能接回进度 —— 别急着重跑,那会再花一次额度。",
		quota: false,
		refresh: true,
	};
}

// ---------------------------------------------------------------------------
// 报告里的几个显示口径
// ---------------------------------------------------------------------------

/** 40 位 sha 太长,页面上显示前 7 位,但**链接里永远是全长的那一个**。 */
export function shortSha(sha: string): string {
	return /^[0-9a-f]{7,40}$/i.test(sha) ? sha.slice(0, 7) : sha;
}

/**
 * 证据的 `source` 是机器读的 id(types.ts ReportSourceId),给人看要翻一层。
 * **解析的是冒号前那一截,不解析中文** —— 同 ExclusionKind 的家法。
 */
export function sourceLabel(source: string): string {
	if (source === "repo") return "GitHub 仓库字段";
	if (source === "readme") return "README";
	if (source === "changelog") return "release / changelog";
	if (source.startsWith("raw:")) return `源码 ${source.slice(4)}`;
	if (source.startsWith("hn:")) return `HN #${source.slice(3)}`;
	return source;
}

/** `anchoredRatio` 是 0-1 的小数,**后端算的**,这里只负责变成一句人话。 */
export function pctText(ratio: number): string {
	if (!Number.isFinite(ratio)) return "—";
	return `${Math.round(ratio * 100)}%`;
}
