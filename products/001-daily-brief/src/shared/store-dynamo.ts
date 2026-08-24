// B2 · Store 的 DynamoDB 实现(docs/02-技术方案.md §4)。用 aws4fetch 做
// SigV4 签名直调 DynamoDB HTTP API——Workers 运行时没有 AWS SDK 的原生环境,
// 而 fetch-based 的实现 Worker 和 Lambda 都能跑,所以两边共用这一份。
// Lambda 里的凭证来自执行角色(运行时自动注入 AWS_ACCESS_KEY_ID/SECRET/SESSION_TOKEN),
// Worker 里来自最小权限 IAM 用户 nanisle-daily-brief-worker 的 secret。
//
// 键约定(§4,和 infra/lib/daily-brief-stack.ts 的表声明一致):
//   WHITELIST / <email>                          白名单,一份数据两用(也是定时全量的用户清单)
//   USER#<email> / CONFIG                        配置整存整取
//   USER#<email> / BRIEF#<YYYY-MM-DD>            每日简报
//   USER#<email> / USAGE#<YYYY-MM-DD>            当日额度计数(gen / ai),ttl 7 天
//   USER#<email> / GENRUN                        立即生成的进度记录(B9),ttl 1 小时
//   USER#<email> / FB#<ISO>#<uuid>               反馈事件,ttl 90 天
//   USER#<email> / CLICK#<ISO>#<uuid>            点击事件,ttl 90 天
//   USER#<email> / THREAD#<trackerKey>#<threadKey>  线索台账,**不设 ttl**
//   USER#<email> / NOTE#<date>#<itemId>          想法台账(N1),**不设 ttl**
//   USER#<email> / PROPOSAL#<id>                 周自评提案(S3),ttl 60 天
//   USER#<email> / METRICS#<YYYY-Www>            周指标快照(S1),ttl 400 天

import { AwsClient } from "aws4fetch";
import type { Brief, FeedbackEvent, FeedbackKind, ItemNote, Thread } from "./types";
import type { ClickEvent, GenRun, Store, StoredBrief, StoredEvent } from "./store";
import {
	DEV_USER,
	EVENT_TTL_S,
	GEN_RUN_TTL_S,
	MAX_EVENTS_READ,
	MAX_NOTES_READ,
	METRICS_TTL_S,
	PROPOSAL_TTL_S,
	QUOTA_LIMITS,
	QUOTA_TTL_S,
} from "./store";
import type { Proposal } from "./weekly";

/**
 * DynamoDB 返回的错误,带上错误码(`__type` 的最后一段)。额度的条件写靠它
 * 分辨「上限到了」和「真的出故障了」——前者是预期内的刹车,后者才是事故。
 */
export class DynamoError extends Error {
	// 显式字段而不是构造器参数属性:tsconfig 开了 erasableSyntaxOnly
	// (`node --experimental-strip-types` 只擦类型,不做代码生成)。
	readonly kind: string;

	constructor(kind: string, message: string) {
		super(message);
		this.name = "DynamoError";
		this.kind = kind;
	}
}

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
			throw new DynamoError(
				kind,
				`DynamoDB ${action} failed: ${kind}${detail.message ? ` — ${detail.message}` : ""}`,
			);
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
		};
	}

	/** 额度条目的主键;gen 与 ai 两个计数器同住一条,一次点查就能出读数。 */
	function usageKey(email: string, date: string) {
		return { PK: { S: `USER#${email}` }, SK: { S: `USAGE#${date}` } };
	}

	return {
		// PK "WHITELIST" 的历史与现状(docs/05):这组条目原是站长手工维护的准入
		// 白名单;2026-08-24 准入退役后语义变成**定时刊的订阅名单**——putConfig
		// 自动把用户写进来,generateAll 遍历它扇出。键不改名:零迁移,存量成员
		// 天然还在名单里。
		async listWhitelist() {
			const emails: string[] = [];
			let startKey: unknown;
			// 订阅名单是几十人的量级,分页循环只是防御性的
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
			const metrics = s(out.Item?.metrics);
			const prefs = s(out.Item?.prefs);
			return {
				trackers: JSON.parse(trackers),
				sources: JSON.parse(sources),
				...(metrics ? { metrics: JSON.parse(metrics) } : {}),
				...(prefs ? { prefs: JSON.parse(prefs) } : {}),
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
					...(config.metrics ? { metrics: { S: JSON.stringify(config.metrics) } } : {}),
					...(config.prefs ? { prefs: { S: JSON.stringify(config.prefs) } } : {}),
					updatedAt: { S: config.updatedAt },
				},
			});
			// 订阅名单自动维护(docs/05 §A):有配置的人就该收定时刊。幂等覆盖写。
			// dev@local 除外:本地 dev 连线上库又没配 DEV_EMAIL 时会以它存配置,
			// 进了名单就等于每天白烧一份没人看的定时刊。
			if (email !== DEV_USER) {
				await call("PutItem", {
					Item: { PK: { S: "WHITELIST" }, SK: { S: email.trim().toLowerCase() } },
				});
			}
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

		async putBrief(email, brief) {
			// UpdateItem 而非 PutItem:重复生成覆盖简报内容,但不碰这条 SK 上可能
			// 存在的其他属性。限额的执行点已经搬去 USAGE#<date>(§8.3)。
			await call("UpdateItem", {
				Key: { PK: { S: `USER#${email}` }, SK: { S: `BRIEF#${brief.date}` } },
				UpdateExpression: "SET brief = :b, generatedAt = :g",
				ExpressionAttributeValues: {
					":b": { S: JSON.stringify(brief) },
					":g": { S: brief.generatedAt },
				},
			});
		},

		async getGenRun(email) {
			const out = await call<{ Item?: Item }>("GetItem", {
				Key: { PK: { S: `USER#${email}` }, SK: { S: "GENRUN" } },
			});
			const raw = s(out.Item?.run);
			return raw ? (JSON.parse(raw) as GenRun) : null;
		},

		async putGenRun(email, run) {
			await call("PutItem", {
				Item: {
					PK: { S: `USER#${email}` },
					SK: { S: "GENRUN" },
					run: { S: JSON.stringify(run) },
					ttl: { N: String(Math.floor(Date.now() / 1000) + GEN_RUN_TTL_S) },
				},
			});
		},

		async reserveQuota(email, date, kind, limit = QUOTA_LIMITS[kind]) {
			try {
				const out = await call<{ Attributes?: Item }>("UpdateItem", {
					Key: usageKey(email, date),
					// 自增与判上限在同一个原子写里:条件不成立时这次自增根本没发生,
					// 所以并发请求里恰好只有前 limit 个能通过。
					UpdateExpression: "SET #ttl = :ttl ADD #k :one",
					ConditionExpression: "attribute_not_exists(#k) OR #k < :limit",
					// 三个都用占位名:ttl 是 DynamoDB 保留字,#k 是运行时才定的属性名。
					ExpressionAttributeNames: { "#k": kind, "#ttl": "ttl" },
					ExpressionAttributeValues: {
						":one": { N: "1" },
						":limit": { N: String(limit) },
						":ttl": { N: String(Math.floor(Date.now() / 1000) + QUOTA_TTL_S) },
					},
					ReturnValues: "UPDATED_NEW",
				});
				return { ok: true, used: n(out.Attributes?.[kind]) ?? 0 };
			} catch (err) {
				// 条件写失败 = 已经到上限,不是故障。到了上限用量必然正好等于 limit。
				if (err instanceof DynamoError && err.kind === "ConditionalCheckFailedException") {
					return { ok: false, used: limit };
				}
				throw err;
			}
		},

		async refundQuota(email, date, kind) {
			try {
				await call("UpdateItem", {
					Key: usageKey(email, date),
					UpdateExpression: "ADD #k :minusOne",
					// 没有计数器就没有可退的:条件挡住,别把计数写成负数
					ConditionExpression: "#k > :zero",
					ExpressionAttributeNames: { "#k": kind },
					ExpressionAttributeValues: { ":minusOne": { N: "-1" }, ":zero": { N: "0" } },
				});
			} catch (err) {
				if (err instanceof DynamoError && err.kind === "ConditionalCheckFailedException") return;
				throw err;
			}
		},

		async getQuota(email, date) {
			const out = await call<{ Item?: Item }>("GetItem", { Key: usageKey(email, date) });
			return { gen: n(out.Item?.gen) ?? 0, ai: n(out.Item?.ai) ?? 0 };
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
			} else {
				const host = (ev as ClickEvent).host;
				if (host) item.host = { S: host };
			}
			await call("PutItem", { Item: item });
		},

		async listEvents(email, sinceISO, limit = MAX_EVENTS_READ) {
			const cap = Math.min(Math.max(1, limit), MAX_EVENTS_READ);
			// SK 是 `<前缀>#<ISO>#<uuid>`,ISO 字典序即时间序,所以时间窗能直接落在
			// 主键范围上,不用过滤扫描。上界取 `FB$` / `CLICK$`:'$'(0x24) 紧跟在
			// '#'(0x23) 之后,任何 `FB#…` 都小于 `FB$`——比 ￿ 之类的哨兵省心。
			const pull = (prefix: "FB" | "CLICK") =>
				call<{ Items?: Item[] }>("Query", {
					KeyConditionExpression: "PK = :pk AND SK BETWEEN :lo AND :hi",
					ExpressionAttributeValues: {
						":pk": { S: `USER#${email}` },
						":lo": { S: `${prefix}#${sinceISO}` },
						":hi": { S: `${prefix}$` },
					},
					ScanIndexForward: false,
					Limit: cap,
				});
			const [fb, click] = await Promise.all([pull("FB"), pull("CLICK")]);
			const events: StoredEvent[] = [];
			for (const item of fb.Items ?? []) {
				const kind = s(item.kind) as FeedbackKind | undefined;
				if (!kind) continue;
				const text = s(item.text);
				events.push({
					date: s(item.date) ?? "",
					itemId: s(item.itemId) ?? "",
					kind,
					...(text ? { text } : {}),
					at: s(item.at) ?? "",
				});
			}
			for (const item of click.Items ?? []) {
				const host = s(item.host);
				events.push({
					date: s(item.date) ?? "",
					itemId: s(item.itemId) ?? "",
					at: s(item.at) ?? "",
					...(host ? { host } : {}),
				});
			}
			// 两条流各自倒序回来,合并后按时间重排一次才是真的「新的在前」
			return events.sort((a, b) => b.at.localeCompare(a.at)).slice(0, cap);
		},

		async listThreads(email, trackerKey) {
			const prefix = trackerKey ? `THREAD#${trackerKey}#` : "THREAD#";
			const out = await call<{ Items?: Item[] }>("Query", {
				KeyConditionExpression: "PK = :pk AND begins_with(SK, :prefix)",
				ExpressionAttributeValues: { ":pk": { S: `USER#${email}` }, ":prefix": { S: prefix } },
				Limit: 300,
			});
			const threads: Thread[] = [];
			for (const item of out.Items ?? []) {
				const raw = s(item.thread);
				if (raw) threads.push(JSON.parse(raw) as Thread);
			}
			return threads;
		},

		async putThread(email, thread) {
			await call("PutItem", {
				Item: {
					PK: { S: `USER#${email}` },
					SK: { S: `THREAD#${thread.trackerKey}#${thread.key}` },
					thread: { S: JSON.stringify(thread) },
					updatedAt: { S: thread.updatedAt },
				},
			});
		},

		async listProposals(email) {
			const out = await call<{ Items?: Item[] }>("Query", {
				KeyConditionExpression: "PK = :pk AND begins_with(SK, :prefix)",
				ExpressionAttributeValues: { ":pk": { S: `USER#${email}` }, ":prefix": { S: "PROPOSAL#" } },
				Limit: 50,
			});
			const list: Proposal[] = [];
			for (const item of out.Items ?? []) {
				const raw = s(item.proposal);
				if (raw) list.push(JSON.parse(raw) as Proposal);
			}
			return list;
		},

		async putProposal(email, proposal) {
			await call("PutItem", {
				Item: {
					PK: { S: `USER#${email}` },
					SK: { S: `PROPOSAL#${proposal.id}` },
					proposal: { S: JSON.stringify(proposal) },
					ttl: { N: String(Math.floor(Date.now() / 1000) + PROPOSAL_TTL_S) },
				},
			});
		},

		async putMetrics(email, week, metrics) {
			await call("PutItem", {
				Item: {
					PK: { S: `USER#${email}` },
					SK: { S: `METRICS#${week}` },
					metrics: { S: JSON.stringify(metrics) },
					ttl: { N: String(Math.floor(Date.now() / 1000) + METRICS_TTL_S) },
				},
			});
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

		async getNote(email, date, itemId) {
			const out = await call<{ Item?: Item }>("GetItem", {
				Key: { PK: { S: `USER#${email}` }, SK: { S: `NOTE#${date}#${itemId}` } },
			});
			const raw = s(out.Item?.note);
			return raw ? (JSON.parse(raw) as ItemNote) : null;
		},

		async putNote(email, note) {
			// 想法台账不设 ttl:同 putThread,长期资产不跟事件流一起过期
			await call("PutItem", {
				Item: {
					PK: { S: `USER#${email}` },
					SK: { S: `NOTE#${note.date}#${note.itemId}` },
					note: { S: JSON.stringify(note) },
					updatedAt: { S: note.updatedAt },
				},
			});
		},

		async listNotes(email, limit = MAX_NOTES_READ) {
			// SK 是 NOTE#<date>#<itemId>,日期字典序即时间序,倒序 Query 就是新账在前
			const out = await call<{ Items?: Item[] }>("Query", {
				KeyConditionExpression: "PK = :pk AND begins_with(SK, :prefix)",
				ExpressionAttributeValues: { ":pk": { S: `USER#${email}` }, ":prefix": { S: "NOTE#" } },
				ScanIndexForward: false,
				Limit: Math.min(Math.max(1, limit), MAX_NOTES_READ),
			});
			const notes: ItemNote[] = [];
			for (const item of out.Items ?? []) {
				const raw = s(item.note);
				if (raw) notes.push(JSON.parse(raw) as ItemNote);
			}
			return notes;
		},
	};
}

/**
 * 供 Worker 转调 generate Lambda(Function URL,IAM 鉴权)用的签名客户端。
 * retries: 0 是成本闸,不是可调参数:aws4fetch 默认对任何 5xx 重试 **10 次**,
 * 而一趟生成要跑几分钟,边缘超时回 5xx 时 Lambda 其实还在跑——每次「重试」都是
 * 又一条完整管线、又一份模型账单(2026-08-21 实测 3 次点击被放大成 8 次调用)。
 */
export function lambdaClient(opts: Omit<DynamoOptions, "table">): AwsClient {
	return new AwsClient({
		accessKeyId: opts.accessKeyId,
		secretAccessKey: opts.secretAccessKey,
		...(opts.sessionToken ? { sessionToken: opts.sessionToken } : {}),
		region: opts.region,
		service: "lambda",
		retries: 0,
	});
}

/** 供 store 之外的裸 ClickEvent 构造用 —— 让 /go 端点不用自己拼字段名。 */
export function clickEvent(date: string, itemId: string, url?: string): ClickEvent {
	let host: string | undefined;
	try {
		if (url) host = new URL(url).hostname.replace(/^www\./, "").toLowerCase();
	} catch {
		// URL 不合法就不记 host,点击本身照记
	}
	return { date, itemId, at: new Date().toISOString(), ...(host ? { host } : {}) };
}
