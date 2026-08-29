// 本地/临时盒子消费者(docs/03 C7 与 02 讨论过的后备形态):直接长轮询
// SQS 跑同一条管线——Lambda 容器就绪前的联调工具,也是提额被拒/超长视频
// 顶穿 15 分钟时的既定退路。契约与 Lambda 完全一致,不改一行产品代码。
//
// 需要的环境变量:WORKER_BASE_URL、CONSUMER_TOKEN、DEEPSEEK_API_KEY、
// QUEUE_URL、AWS_ACCESS_KEY_ID/AWS_SECRET_ACCESS_KEY(可 AWS_SESSION_TOKEN),
// 可选 GROQ_API_KEY、PROXY_URL。用法见 ../README.md。

import { AwsClient } from "aws4fetch";
import { fastVariant, ownerRouteFromEnv } from "../../src/shared/ai";
import { processDiscover } from "./discover";
import type { DiscoverMessage } from "./discover";
import { processTask } from "./pipeline";
import type { PipelineConfig, TaskMessage } from "./pipeline";

const queueUrl = process.env.QUEUE_URL;
if (!queueUrl) throw new Error("QUEUE_URL not set");

const aws = new AwsClient({
	accessKeyId: process.env.AWS_ACCESS_KEY_ID!,
	secretAccessKey: process.env.AWS_SECRET_ACCESS_KEY!,
	sessionToken: process.env.AWS_SESSION_TOKEN,
	region: process.env.AWS_REGION ?? "us-east-1",
	service: "sqs",
});

async function sqs(params: Record<string, string>): Promise<string> {
	const res = await aws.fetch(queueUrl!, {
		method: "POST",
		headers: { "content-type": "application/x-www-form-urlencoded" },
		body: new URLSearchParams(params).toString(),
	});
	const text = await res.text();
	if (!res.ok) throw new Error(`SQS ${params.Action} ${res.status}: ${text.slice(0, 200)}`);
	return text;
}

const ai = {
	provider: process.env.AI_PROVIDER ?? "deepseek",
	model: process.env.AI_MODEL ?? "deepseek-v4-pro",
	// 16384 对齐 Worker 侧:V4 thinking 也占输出预算,编辑产出放开长度后 8192 会顶到
	maxOutputTokens: process.env.AI_MAX_OUTPUT_TOKENS ?? "16384",
	deepseekApiKey: process.env.DEEPSEEK_API_KEY,
};
const cfg: PipelineConfig = {
	workerBase: (process.env.WORKER_BASE_URL ?? "").replace(/\/+$/, ""),
	consumerToken: process.env.CONSUMER_TOKEN ?? "",
	ai,
	fastAi: fastVariant(ai, { provider: process.env.FAST_AI_PROVIDER, model: process.env.FAST_AI_MODEL }),
	groqApiKey: process.env.GROQ_API_KEY,
	proxyUrl: process.env.PROXY_URL,
	ownerRoute: ownerRouteFromEnv(process.env),
};
if (!cfg.workerBase || !cfg.consumerToken) throw new Error("WORKER_BASE_URL / CONSUMER_TOKEN not set");

console.log(`local consumer polling ${queueUrl}`);
for (;;) {
	let xml: string;
	try {
		xml = await sqs({ Action: "ReceiveMessage", MaxNumberOfMessages: "1", WaitTimeSeconds: "20" });
	} catch (err) {
		console.error("receive failed:", (err as Error).message);
		await new Promise((r) => setTimeout(r, 5000));
		continue;
	}
	const body = xml.match(/<Body>([\s\S]*?)<\/Body>/)?.[1];
	const receipt = xml.match(/<ReceiptHandle>([\s\S]*?)<\/ReceiptHandle>/)?.[1];
	if (!body || !receipt) continue; // 长轮询空转
	const decoded = body
		.replaceAll("&quot;", '"')
		.replaceAll("&#xA;", "\n")
		.replaceAll("&lt;", "<")
		.replaceAll("&gt;", ">")
		.replaceAll("&amp;", "&");
	try {
		const msg = JSON.parse(decoded) as TaskMessage | DiscoverMessage;
		if ((msg as DiscoverMessage).kind === "discover") {
			await processDiscover(msg as DiscoverMessage, cfg);
		} else if ((msg as TaskMessage).taskId && (msg as TaskMessage).url) {
			await processTask(msg as TaskMessage, cfg);
		} else {
			console.log("skip non-task message:", decoded.slice(0, 120));
		}
		// 与 Lambda 语义一致:管线级失败已 complete({error}),消息照删;
		// 只有回程失败会抛到这里 → 不删,visibility 过期后 SQS 重投
		await sqs({ Action: "DeleteMessage", ReceiptHandle: receipt });
	} catch (err) {
		console.error("task processing failed (will retry via SQS):", (err as Error).message);
	}
}
