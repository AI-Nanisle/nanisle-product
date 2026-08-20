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
//   USER#<email> / THREAD#<trackerKey>#<threadKey>  线索台账,**不设 ttl**
//   USER#<email> / NOTE#<date>#<itemId>          想法台账(N1),**不设 ttl**
//   USER#<email> / PROPOSAL#<id>                 周自评提案(S3),ttl 60 天
//   USER#<email> / METRICS#<YYYY-Www>            周指标快照(S1),ttl 400 天

import { AwsClient } from "aws4fetch";
import type { Brief, FeedbackEvent, FeedbackKind, ItemNote, Thread } from "./types";
import type { ClickEvent, Store, StoredBrief, StoredEvent } from "./store";
import { EVENT_TTL_S, MAX_EVENTS_READ, MAX_NOTES_READ, METRICS_TTL_S, PROPOSAL_TTL_S } from "./store";
import type { Proposal } from "./weekly";

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
export function clickEvent(date: string, itemId: string, url?: string): ClickEvent {
	let host: string | undefined;
	try {
		if (url) host = new URL(url).hostname.replace(/^www\./, "").toLowerCase();
	} catch {
		// URL 不合法就不记 host,点击本身照记
	}
	return { date, itemId, at: new Date().toISOString(), ...(host ? { host } : {}) };
}
