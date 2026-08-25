// 慢车道任务投递(docs/02 T1):aws4fetch 直签 SQS SendMessage。
// 消息体就是任务 id + 输入——消费者拿到后经 /api/queue/* 回程,状态
// 只有 Worker 能写,所以消息里不需要也不该带任何可信状态。

import { AwsClient } from "aws4fetch";
import type { AppEnv } from "./env";

export interface TaskMessage {
	taskId: string;
	url: string;
	contentKey: string;
	platform: string;
}

export async function sendTask(env: AppEnv, msg: TaskMessage): Promise<void> {
	if (!env.QUEUE_URL || !env.AWS_ACCESS_KEY_ID || !env.AWS_SECRET_ACCESS_KEY) {
		throw new Error("QUEUE_URL / AWS credentials not configured");
	}
	const aws = new AwsClient({
		accessKeyId: env.AWS_ACCESS_KEY_ID,
		secretAccessKey: env.AWS_SECRET_ACCESS_KEY,
		region: env.AWS_REGION ?? "us-east-1",
		service: "sqs",
	});
	const res = await aws.fetch(env.QUEUE_URL, {
		method: "POST",
		headers: { "content-type": "application/x-www-form-urlencoded" },
		// aws4fetch 的签名器只认 string/ArrayBuffer body——直接传 URLSearchParams
		// 对象会在签名阶段抛异常(线上 500 实测),必须先 toString
		body: new URLSearchParams({
			Action: "SendMessage",
			MessageBody: JSON.stringify(msg),
		}).toString(),
	});
	if (!res.ok) {
		const text = await res.text();
		throw new Error(`SQS SendMessage ${res.status}: ${text.slice(0, 300)}`);
	}
}
