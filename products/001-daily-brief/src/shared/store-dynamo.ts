// B2 · Store 的 DynamoDB 实现(docs/02-技术方案.md §4)。用 aws4fetch 做
// SigV4 签名直调 DynamoDB HTTP API——Workers 运行时没有 AWS SDK 的原生环境,
// 而 fetch-based 的实现 Worker 和 Lambda 都能跑,所以两边共用这一份。
// Lambda 里的凭证来自执行角色(运行时自动注入 AWS_ACCESS_KEY_ID/SECRET/SESSION_TOKEN),
// Worker 里来自最小权限 IAM 用户 nanisle-daily-brief-worker 的 secret。
//
// 键约定(§4,和 infra/lib/daily-brief-stack.ts 的表声明一致):
//   WHITELIST / <email>                          白名单,一份数据两用(也是定时全量的用户清单)
//   USER#<email> / CONFIG                        配置整存整取
//   USER#<email> / BRIEF#<YYYY-MM-DD>            每日简报,genCount 承载立即生成限额
//   USER#<email> / FB#<ISO>#<uuid>               反馈事件,ttl 90 天
//   USER#<email> / CLICK#<ISO>#<uuid>            点击事件,ttl 90 天

import { AwsClient } from "aws4fetch";
import type { Brief, FeedbackEvent } from "./types";
import type { ClickEvent, Store, StoredBrief } from "./store";
import { EVENT_TTL_S } from "./store";

export interface DynamoOptions {
	table: string;
	region: string;
	accessKeyId: string;
	secretAccessKey: string;
	/** Lambda 执行角色的临时凭证带 session token;IAM 用户的长期凭证没有。 */
	sessionToken?: string;
}

/** 本实现只用得到两种属性类型:字符串(JSON 也序列化成字符串存)和数字。 */
type Attr = { S: string } | { N: string };
type Item = Record<string, Attr>;

function s(v: Item[string] | undefined): string | undefined {
	return v && "S" in v ? v.S : undefined;
}

function n(v: Item[string] | undefined): number | undefined {
	return v && "N" in v ? Number(v.N) : undefined;
}

export function dynamoStore(opts: DynamoOptions): Store {
	const endpoint = `https://dynamodb.${opts.region}.amazonaws.com/`;
	const aws = new AwsClient({
		accessKeyId: opts.accessKeyId,
		secretAccessKey: opts.secretAccessKey,
		...(opts.sessionToken ? { sessionToken: opts.sessionToken } : {}),
		region: opts.region,
		service: "dynamodb",
	});

	async function call<T>(action: string, body: Record<string, unknown>): Promise<T> {
		const res = await aws.fetch(endpoint, {
			method: "POST",
			headers: {
				"content-type": "application/x-amz-json-1.0",
				"x-amz-target": `DynamoDB_20120810.${action}`,
			},
			body: JSON.stringify({ TableName: opts.table, ...body }),
		});
		if (!res.ok) {
			// __type 形如 com.amazonaws.dynamodb.v20120810#ResourceNotFoundException
			const detail = (await res.json().catch(() => ({}))) as { __type?: string; message?: string };
			const kind = detail.__type?.split("#").pop() ?? `HTTP ${res.status}`;
			throw new Error(`DynamoDB ${action} failed: ${kind}${detail.message ? ` — ${detail.message}` : ""}`);
		}
		return (await res.json()) as T;
	}

	/** 前缀 Query 的共用形状;倒序 + Limit 由调用点定。 */
	function briefQuery(email: string, extra: Record<string, unknown>) {
		return call<{ Items?: Item[] }>("Query", {
			KeyConditionExpression: "PK = :pk AND begins_with(SK, :prefix)",
			ExpressionAttributeValues: { ":pk": { S: `USER#${email}` }, ":prefix": { S: "BRIEF#" } },
			ScanIndexForward: false,
			...extra,
		});
	}

	function toStoredBrief(item: Item | undefined): StoredBrief | null {
		const raw = s(item?.brief);
		if (!raw) return null;
		return {
			brief: JSON.parse(raw) as Brief,
			generatedAt: s(item?.generatedAt) ?? "",
			genCount: n(item?.genCount) ?? 0,
		};
	}

	return {
		async isWhitelisted(email) {
			// 白名单键按小写存储(主仓 infra/scripts/whitelist-add.ps1 写入时归一)。
			// 读侧同样归一:上游(better-auth)目前恰好会小写化邮箱,但不依赖它。
			const out = await call<{ Item?: Item }>("GetItem", {
				Key: { PK: { S: "WHITELIST" }, SK: { S: email.trim().toLowerCase() } },
			});
			return Boolean(out.Item);
		},

		async listWhitelist() {
			const emails: string[] = [];
			let startKey: unknown;
			// 白名单是几十人的量级,分页循环只是防御性的
			do {
				const out = await call<{ Items?: Item[]; LastEvaluatedKey?: unknown }>("Query", {
					KeyConditionExpression: "PK = :pk",
					ExpressionAttributeValues: { ":pk": { S: "WHITELIST" } },
					...(startKey ? { ExclusiveStartKey: startKey } : {}),
				});
				for (const item of out.Items ?? []) {
					const email = s(item.SK);
					if (email) emails.push(email);
				}
				startKey = out.LastEvaluatedKey;
			} while (startKey);
			return emails;
		},

		async getConfig(email) {
			const out = await call<{ Item?: Item }>("GetItem", {
				Key: { PK: { S: `USER#${email}` }, SK: { S: "CONFIG" } },
			});
			const trackers = s(out.Item?.trackers);
			const sources = s(out.Item?.sources);
			if (!trackers || !sources) return null;
			return {
				trackers: JSON.parse(trackers),
				sources: JSON.parse(sources),
				updatedAt: s(out.Item?.updatedAt) ?? "",
			};
		},

		async putConfig(email, config) {
			await call("PutItem", {
				Item: {
					PK: { S: `USER#${email}` },
					SK: { S: "CONFIG" },
					trackers: { S: JSON.stringify(config.trackers) },
					sources: { S: JSON.stringify(config.sources) },
					updatedAt: { S: config.updatedAt },
				},
			});
		},

		async getBrief(email, date) {
			if (date) {
				const out = await call<{ Item?: Item }>("GetItem", {
					Key: { PK: { S: `USER#${email}` }, SK: { S: `BRIEF#${date}` } },
				});
				return toStoredBrief(out.Item);
			}
			const out = await briefQuery(email, { Limit: 1 });
			return toStoredBrief(out.Items?.[0]);
		},

		async putBrief(email, brief, bumpGenCount) {
			// UpdateItem 而非 PutItem:genCount 要原子自增(§8.3 的限额执行点),
			// 且重复生成覆盖简报内容但不清零当日计数。
			const out = await call<{ Attributes?: Item }>("UpdateItem", {
				Key: { PK: { S: `USER#${email}` }, SK: { S: `BRIEF#${brief.date}` } },
				UpdateExpression: "SET brief = :b, generatedAt = :g ADD genCount :inc",
				ExpressionAttributeValues: {
					":b": { S: JSON.stringify(brief) },
					":g": { S: brief.generatedAt },
					":inc": { N: bumpGenCount ? "1" : "0" },
				},
				ReturnValues: "UPDATED_NEW",
			});
			return n(out.Attributes?.genCount) ?? 0;
		},

		async appendEvent(email, ev) {
			const isFeedback = "kind" in ev;
			const item: Item = {
				PK: { S: `USER#${email}` },
				SK: { S: `${isFeedback ? "FB" : "CLICK"}#${ev.at}#${crypto.randomUUID()}` },
				itemId: { S: ev.itemId },
				date: { S: ev.date },
				at: { S: ev.at },
				ttl: { N: String(Math.floor(Date.now() / 1000) + EVENT_TTL_S) },
			};
			if (isFeedback) {
				item.kind = { S: (ev as FeedbackEvent).kind };
				const text = (ev as FeedbackEvent).text;
				if (text) item.text = { S: text };
			}
			await call("PutItem", { Item: item });
		},

		async listBriefDates(email) {
			const out = await briefQuery(email, {
				Limit: 100,
				ProjectionExpression: "SK",
			});
			return (out.Items ?? [])
				.map((item) => s(item.SK)?.slice("BRIEF#".length) ?? "")
				.filter(Boolean);
		},
	};
}

/** 供 Worker 转调 generate Lambda(Function URL,IAM 鉴权)用的签名客户端。 */
export function lambdaClient(opts: Omit<DynamoOptions, "table">): AwsClient {
	return new AwsClient({
		accessKeyId: opts.accessKeyId,
		secretAccessKey: opts.secretAccessKey,
		...(opts.sessionToken ? { sessionToken: opts.sessionToken } : {}),
		region: opts.region,
		service: "lambda",
	});
}

/** 供 store 之外的裸 ClickEvent 构造用 —— 让 /go 端点不用自己拼字段名。 */
export function clickEvent(date: string, itemId: string): ClickEvent {
	return { date, itemId, at: new Date().toISOString() };
}
