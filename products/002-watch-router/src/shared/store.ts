// 存储接缝(docs/02 T6):丢了能重算的进 KV(内容缓存,不经此文件),
// 丢了要负责的进 DynamoDB——配额、任务状态机、用户处理记录、白名单。
// 本文件是接口 + DynamoDB 实现 + 内存替身;选择逻辑在 worker/store.ts:
// AWS 凭证配齐 → dynamo,否则内存(fork / 本地 dev 零配置跑通)。
//
// 键约定(docs/03 D2,已随 infra 部署定死):
//   WHITELIST / <email>            内测白名单,一人一条
//   USER#<email> / USAGE#<date>    配额(原子占位,ttl 7d)
//   USER#<email> / READ#<key>      处理记录(不设 ttl,个人长期资产)
//   TASK#<id> / META               任务状态机(ttl 1d;任务在途载体是 SQS)

import { AwsClient } from "aws4fetch";
import type { ExtractPath, WatchResult } from "./schema";

/** 本地 dev / fork(没有登录闸口)的固定用户。 */
export const DEV_USER = "dev@local";

/** 每日额度(docs/02 T6:先占位后干活,占位失败 429,模型报错不退还)。 */
export const QUOTA_LIMITS = { submit: 10 } as const;

/** 慢车道五步进度(F6 进度页按这个顺序渲染)。 */
export type TaskStep = "queued" | "downloading" | "transcribing" | "editing" | "done";
export type TaskStatus = "pending" | "running" | "done" | "failed";

/** 任务超时:超过这个时长没有 complete,轮询侧显式判失败(docs/02 T1)。 */
export const TASK_TIMEOUT_MS = 10 * 60 * 1000;

export interface TaskRecord {
	id: string;
	email: string;
	url: string;
	/** 内容缓存键(content-id.ts 归一出来的 <platform>:<id>)。 */
	contentKey: string;
	platform: string;
	status: TaskStatus;
	step: TaskStep;
	/** 提取路径徽章,消费者报进度时带上(subtitle/whisper)。 */
	path?: ExtractPath;
	error?: string;
	createdAt: number;
	updatedAt: number;
}

export interface ReadRecord {
	contentKey: string;
	url: string;
	title?: string;
	at: number;
	/**
	 * I3 · 用户级高亮(章节序号 → 追踪器名)。存进处理记录做用户级缓存:
	 * 同一用户重复打开同一内容不重复花高亮小调用的钱;内容级共享缓存里
	 * 永远没有这个字段(它是用户属性,docs/02 T4 的两次调用拆分)。
	 */
	tracked?: Record<string, string>;
}

export class QuotaExceededError extends Error {
	constructor() {
		super(`今日提交次数已用完(${QUOTA_LIMITS.submit} 次/日)。明天自动恢复。`);
	}
}

export interface Store {
	/** 内测白名单(docs/02 T7:门禁每请求复查)。 */
	isWhitelisted(email: string): Promise<boolean>;
	/** 原子占位(001 Q1 同款):自增与判上限压在同一个条件写里,超限抛 QuotaExceededError。 */
	reserveQuota(email: string, date: string): Promise<void>;
	/** 当日已用额度(F7 页眉读数;只读不占位)。 */
	getQuota(email: string, date: string): Promise<number>;
	createTask(task: TaskRecord): Promise<void>;
	getTask(id: string): Promise<TaskRecord | null>;
	/** 进度/状态更新。只更新给到的字段,updatedAt 总是刷新。 */
	updateTask(
		id: string,
		patch: Partial<Pick<TaskRecord, "status" | "step" | "path" | "error">>,
	): Promise<void>;
	/** 处理记录(结果页「我处理过的」将来消费;complete/缓存命中时落一条)。 */
	putReadRecord(email: string, rec: ReadRecord): Promise<void>;
	/** 读处理记录(I3 高亮的用户级缓存靠它)。 */
	getReadRecord(email: string, contentKey: string): Promise<ReadRecord | null>;
}

export interface DdbConfig {
	accessKeyId: string;
	secretAccessKey: string;
	table: string;
	region: string;
}

type Attr = Record<string, unknown>;

/** DynamoDB HTTP API 直调(aws4fetch SigV4 签名,001 store-dynamo 同款姿势)。 */
export class DdbStore implements Store {
	private aws: AwsClient;
	private endpoint: string;
	private table: string;

	constructor(cfg: DdbConfig) {
		this.aws = new AwsClient({
			accessKeyId: cfg.accessKeyId,
			secretAccessKey: cfg.secretAccessKey,
			region: cfg.region,
			service: "dynamodb",
		});
		this.endpoint = `https://dynamodb.${cfg.region}.amazonaws.com/`;
		this.table = cfg.table;
	}

	private async call<T>(target: string, body: Record<string, unknown>): Promise<T> {
		const res = await this.aws.fetch(this.endpoint, {
			method: "POST",
			headers: {
				"content-type": "application/x-amz-json-1.0",
				"x-amz-target": `DynamoDB_20120810.${target}`,
			},
			body: JSON.stringify({ TableName: this.table, ...body }),
		});
		if (!res.ok) {
			const text = await res.text();
			// 条件写失败要能和真故障分开(配额到上限就是这条路)
			if (text.includes("ConditionalCheckFailedException")) {
				throw new ConditionalFailure();
			}
			throw new Error(`DynamoDB ${target} ${res.status}: ${text.slice(0, 300)}`);
		}
		return (await res.json()) as T;
	}

	async isWhitelisted(email: string): Promise<boolean> {
		const out = await this.call<{ Item?: Attr }>("GetItem", {
			Key: { PK: { S: "WHITELIST" }, SK: { S: email.toLowerCase() } },
			ProjectionExpression: "PK",
		});
		return Boolean(out.Item);
	}

	async reserveQuota(email: string, date: string): Promise<void> {
		try {
			await this.call("UpdateItem", {
				Key: { PK: { S: `USER#${email.toLowerCase()}` }, SK: { S: `USAGE#${date}` } },
				UpdateExpression: "ADD #n :one SET #ttl = if_not_exists(#ttl, :ttl)",
				ConditionExpression: "attribute_not_exists(#n) OR #n < :limit",
				ExpressionAttributeNames: { "#n": "submits", "#ttl": "ttl" },
				ExpressionAttributeValues: {
					":one": { N: "1" },
					":limit": { N: String(QUOTA_LIMITS.submit) },
					":ttl": { N: String(Math.floor(Date.now() / 1000) + 7 * 24 * 3600) },
				},
			});
		} catch (err) {
			if (err instanceof ConditionalFailure) throw new QuotaExceededError();
			throw err;
		}
	}

	async getQuota(email: string, date: string): Promise<number> {
		const out = await this.call<{ Item?: { submits?: { N?: string } } }>("GetItem", {
			Key: { PK: { S: `USER#${email.toLowerCase()}` }, SK: { S: `USAGE#${date}` } },
			ProjectionExpression: "submits",
		});
		return Number(out.Item?.submits?.N ?? 0);
	}

	async createTask(t: TaskRecord): Promise<void> {
		await this.call("PutItem", {
			Item: {
				PK: { S: `TASK#${t.id}` },
				SK: { S: "META" },
				email: { S: t.email },
				url: { S: t.url },
				contentKey: { S: t.contentKey },
				platform: { S: t.platform },
				status: { S: t.status },
				step: { S: t.step },
				...(t.path ? { path: { S: t.path } } : {}),
				createdAt: { N: String(t.createdAt) },
				updatedAt: { N: String(t.updatedAt) },
				ttl: { N: String(Math.floor(t.createdAt / 1000) + 24 * 3600) },
			},
		});
	}

	async getTask(id: string): Promise<TaskRecord | null> {
		const out = await this.call<{ Item?: Record<string, { S?: string; N?: string }> }>("GetItem", {
			Key: { PK: { S: `TASK#${id}` }, SK: { S: "META" } },
		});
		const it = out.Item;
		if (!it) return null;
		return {
			id,
			email: it.email?.S ?? "",
			url: it.url?.S ?? "",
			contentKey: it.contentKey?.S ?? "",
			platform: it.platform?.S ?? "",
			status: (it.status?.S ?? "pending") as TaskStatus,
			step: (it.step?.S ?? "queued") as TaskStep,
			path: it.path?.S as TaskRecord["path"],
			error: it.error?.S,
			createdAt: Number(it.createdAt?.N ?? 0),
			updatedAt: Number(it.updatedAt?.N ?? 0),
		};
	}

	async updateTask(
		id: string,
		patch: Partial<Pick<TaskRecord, "status" | "step" | "path" | "error">>,
	): Promise<void> {
		const sets: string[] = ["#u = :u"];
		const names: Record<string, string> = { "#u": "updatedAt" };
		const values: Attr = { ":u": { N: String(Date.now()) } };
		for (const [k, v] of Object.entries(patch)) {
			if (v === undefined) continue;
			names[`#${k}`] = k;
			values[`:${k}`] = { S: String(v) };
			sets.push(`#${k} = :${k}`);
		}
		await this.call("UpdateItem", {
			Key: { PK: { S: `TASK#${id}` }, SK: { S: "META" } },
			UpdateExpression: `SET ${sets.join(", ")}`,
			// 只允许更新还存在的任务(ttl 过期/伪造 id 都会撞条件),不静默 upsert
			ConditionExpression: "attribute_exists(PK)",
			ExpressionAttributeNames: names,
			ExpressionAttributeValues: values,
		});
	}

	async putReadRecord(email: string, rec: ReadRecord): Promise<void> {
		await this.call("PutItem", {
			Item: {
				PK: { S: `USER#${email.toLowerCase()}` },
				SK: { S: `READ#${rec.contentKey}` },
				url: { S: rec.url },
				...(rec.title ? { title: { S: rec.title } } : {}),
				...(rec.tracked ? { tracked: { S: JSON.stringify(rec.tracked) } } : {}),
				at: { N: String(rec.at) },
			},
		});
	}

	async getReadRecord(email: string, contentKey: string): Promise<ReadRecord | null> {
		const out = await this.call<{ Item?: Record<string, { S?: string; N?: string }> }>("GetItem", {
			Key: { PK: { S: `USER#${email.toLowerCase()}` }, SK: { S: `READ#${contentKey}` } },
		});
		const it = out.Item;
		if (!it) return null;
		let tracked: Record<string, string> | undefined;
		try {
			tracked = it.tracked?.S ? (JSON.parse(it.tracked.S) as Record<string, string>) : undefined;
		} catch {
			tracked = undefined;
		}
		return {
			contentKey,
			url: it.url?.S ?? "",
			title: it.title?.S,
			at: Number(it.at?.N ?? 0),
			...(tracked ? { tracked } : {}),
		};
	}
}

/** call() 内部用:条件写失败(到上限 / 任务不存在)与真故障分流的标记。 */
class ConditionalFailure extends Error {}

/**
 * 内存替身:本地 dev / fork 用。白名单放行所有人(身份本来就是 dev@local);
 * 配额读改写(本地无并发对手);任务放 Map——wrangler dev 单 isolate,够用。
 */
export class MemoryStore implements Store {
	private quota = new Map<string, number>();
	private tasks = new Map<string, TaskRecord>();
	private reads = new Map<string, ReadRecord>();

	async isWhitelisted(_email: string): Promise<boolean> {
		return true;
	}

	async reserveQuota(email: string, date: string): Promise<void> {
		const key = `${email}:${date}`;
		const n = this.quota.get(key) ?? 0;
		if (n >= QUOTA_LIMITS.submit) throw new QuotaExceededError();
		this.quota.set(key, n + 1);
	}

	async getQuota(email: string, date: string): Promise<number> {
		return this.quota.get(`${email}:${date}`) ?? 0;
	}

	async createTask(t: TaskRecord): Promise<void> {
		this.tasks.set(t.id, { ...t });
	}

	async getTask(id: string): Promise<TaskRecord | null> {
		const t = this.tasks.get(id);
		return t ? { ...t } : null;
	}

	async updateTask(
		id: string,
		patch: Partial<Pick<TaskRecord, "status" | "step" | "path" | "error">>,
	): Promise<void> {
		const t = this.tasks.get(id);
		if (!t) throw new Error(`task ${id} not found`);
		Object.assign(t, patch, { updatedAt: Date.now() });
	}

	async putReadRecord(email: string, rec: ReadRecord): Promise<void> {
		this.reads.set(`${email}:${rec.contentKey}`, { ...rec });
	}

	async getReadRecord(email: string, contentKey: string): Promise<ReadRecord | null> {
		const rec = this.reads.get(`${email}:${contentKey}`);
		return rec ? { ...rec } : null;
	}
}

/**
 * 结果缓存的 KV 键(docs/02 T6:content:<版本>:<platform>:<id>,60 天)。
 * 版本号进键:schema 有破坏性升级(如 2026-08-26 新增导读)时 bump 一位,
 * 老缓存自然被绕开并随 TTL 消亡——比迁移或运行时兼容分支都便宜。
 */
export function contentCacheKey(contentKey: string): string {
	return `content:v2:${contentKey}`;
}

export const CONTENT_CACHE_TTL_S = 60 * 24 * 3600;

export interface CachedContent {
	result: WatchResult;
	contentKey: string;
	cachedAt: number;
	/** 首次处理时的来源 URL(F4 跳转用;粘贴内容没有)。 */
	url?: string;
	/** 文章/粘贴的正文段落(F4 段落锚点跳转用;视频转写待 C 线)。 */
	paragraphs?: string[];
}
