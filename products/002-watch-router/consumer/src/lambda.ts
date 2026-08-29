// Lambda 入口(SQS 触发,batchSize=1)。管线失败已在 processTask 内部
// complete({error}) 显式上报,这里正常返回让 SQS 删消息——重试只留给
// 「回程本身失败」这种基础设施级错误(向上抛 → SQS 重投 → 两次后 DLQ)。

import { fastVariant, ownerRouteFromEnv } from "../../src/shared/ai";
import { processDiscover } from "./discover";
import type { DiscoverMessage } from "./discover";
import { processTask } from "./pipeline";
import type { PipelineConfig, TaskMessage } from "./pipeline";

interface SqsEvent {
	Records?: { body: string }[];
}

function configFromEnv(): PipelineConfig {
	const workerBase = process.env.WORKER_BASE_URL;
	const consumerToken = process.env.CONSUMER_TOKEN;
	if (!workerBase || !consumerToken) throw new Error("WORKER_BASE_URL / CONSUMER_TOKEN not set");
	const ai = {
		provider: process.env.AI_PROVIDER ?? "deepseek",
		model: process.env.AI_MODEL ?? "deepseek-v4-pro",
		// 16384 对齐 Worker 侧:V4 thinking 也占输出预算,编辑产出放开长度后 8192 会顶到
		maxOutputTokens: process.env.AI_MAX_OUTPUT_TOKENS ?? "16384",
		deepseekApiKey: process.env.DEEPSEEK_API_KEY,
	};
	return {
		workerBase: workerBase.replace(/\/+$/, ""),
		consumerToken,
		ai,
		fastAi: fastVariant(ai, { provider: process.env.FAST_AI_PROVIDER, model: process.env.FAST_AI_MODEL }),
		groqApiKey: process.env.GROQ_API_KEY,
		proxyUrl: process.env.PROXY_URL,
		ownerRoute: ownerRouteFromEnv(process.env),
	};
}

export async function handler(event: SqsEvent): Promise<{ ok: true }> {
	const cfg = configFromEnv();
	for (const record of event.Records ?? []) {
		const msg = JSON.parse(record.body) as TaskMessage | DiscoverMessage;
		// 订阅模式的发现消息(docs/05 §3.1)与总结任务共用一条队列,按 kind 分流
		if ((msg as DiscoverMessage).kind === "discover") {
			// 形状先验一遍再进:少个 subs 字段就会在 for…of 里抛,消息重投两次进 DLQ
			const d = msg as DiscoverMessage;
			if (typeof d.email !== "string" || typeof d.date !== "string" || !Array.isArray(d.subs)) {
				console.error("malformed discover message, skip:", record.body.slice(0, 200));
				continue;
			}
			await processDiscover(d, cfg);
			continue;
		}
		if (!(msg as TaskMessage).taskId || !(msg as TaskMessage).url) {
			console.error("malformed task message, skip:", record.body.slice(0, 200));
			continue;
		}
		await processTask(msg as TaskMessage, cfg);
	}
	return { ok: true };
}
