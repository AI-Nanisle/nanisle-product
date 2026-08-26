// Lambda 入口(SQS 触发,batchSize=1)。管线失败已在 processTask 内部
// complete({error}) 显式上报,这里正常返回让 SQS 删消息——重试只留给
// 「回程本身失败」这种基础设施级错误(向上抛 → SQS 重投 → 两次后 DLQ)。

import { processTask } from "./pipeline";
import type { PipelineConfig, TaskMessage } from "./pipeline";

interface SqsEvent {
	Records?: { body: string }[];
}

function configFromEnv(): PipelineConfig {
	const workerBase = process.env.WORKER_BASE_URL;
	const consumerToken = process.env.CONSUMER_TOKEN;
	if (!workerBase || !consumerToken) throw new Error("WORKER_BASE_URL / CONSUMER_TOKEN not set");
	return {
		workerBase: workerBase.replace(/\/+$/, ""),
		consumerToken,
		ai: {
			provider: process.env.AI_PROVIDER ?? "deepseek",
			model: process.env.AI_MODEL ?? "deepseek-v4-pro",
			maxOutputTokens: process.env.AI_MAX_OUTPUT_TOKENS ?? "8192",
			deepseekApiKey: process.env.DEEPSEEK_API_KEY,
		},
		groqApiKey: process.env.GROQ_API_KEY,
		proxyUrl: process.env.PROXY_URL,
	};
}

export async function handler(event: SqsEvent): Promise<{ ok: true }> {
	const cfg = configFromEnv();
	for (const record of event.Records ?? []) {
		const msg = JSON.parse(record.body) as TaskMessage;
		if (!msg.taskId || !msg.url) {
			console.error("malformed task message, skip:", record.body.slice(0, 200));
			continue;
		}
		await processTask(msg, cfg);
	}
	return { ok: true };
}
