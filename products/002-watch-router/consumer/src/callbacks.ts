// 消费者 → Worker 的回程(docs/02 T1):x-consumer-token 鉴权,
// 状态只有 Worker 能写,消费者只汇报。

import type { WatchResult } from "../../src/shared/schema";

export interface CallbackConfig {
	/** 002 Worker 的根地址(不带尾斜杠),如 https://nanisle-002-watch-router.….workers.dev */
	workerBase: string;
	consumerToken: string;
}

async function post(cfg: CallbackConfig, path: string, body: unknown): Promise<Record<string, unknown>> {
	const res = await fetch(`${cfg.workerBase}${path}`, {
		method: "POST",
		headers: {
			"content-type": "application/json",
			"x-consumer-token": cfg.consumerToken,
		},
		body: JSON.stringify(body),
	});
	const text = await res.text();
	if (!res.ok) throw new Error(`${path} ${res.status}: ${text.slice(0, 200)}`);
	try {
		return JSON.parse(text) as Record<string, unknown>;
	} catch {
		return {};
	}
}

/** 报进度。返回 alreadyDone=true 表示任务已完成(重投的旧消息),调用方应放弃。 */
export async function reportProgress(
	cfg: CallbackConfig,
	taskId: string,
	step: string,
	path?: string,
): Promise<{ alreadyDone: boolean }> {
	const out = await post(cfg, "/api/queue/progress", { taskId, step, ...(path ? { path } : {}) });
	return { alreadyDone: out.done === true };
}

export async function reportComplete(
	cfg: CallbackConfig,
	taskId: string,
	payload: { result?: WatchResult; error?: string; path?: string; paragraphs?: string[] },
): Promise<void> {
	await post(cfg, "/api/queue/complete", { taskId, ...payload });
}
