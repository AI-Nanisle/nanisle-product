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

/**
 * 每日额度(docs/02 T6:先占位后干活,占位失败 429,模型报错不退还)。
 * submit = 用户手动提交;sub = 订阅日报(docs/05「每人每天一条」)。分开计是因为
 * 订阅是产品答应「每天自动送一条」,不该去挤占用户自己想看点什么的那 10 次。
 */
export const QUOTA_LIMITS = { submit: 10, sub: 1 } as const;
export type QuotaKind = keyof typeof QUOTA_LIMITS;
/**
 * 拿当天运行权的结果。区分 fresh 与 takeover 是为了额度:takeover 说明这一天的
 * 额度已经被那个半路死掉的运行扣过了,兜底接手时不该再扣一次(否则 sub=1 会把
 * 恢复路径自己堵死)。
 */
export type ClaimResult = "fresh" | "takeover" | "taken";
/** 计数落在 USAGE#<date> 这一项的哪个属性上。 */
const QUOTA_ATTR: Record<QuotaKind, string> = { submit: "submits", sub: "subRuns" };

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
	/** 谁发起的:用户手动提交(缺省)/ 订阅每日挑选(完成时发邮件,docs/05 §3.5)。 */
	origin?: "user" | "subscription";
}

// ---------- 订阅模式(docs/05 §3.2;键约定见下) ----------
//   SUBSCRIBERS / <email>                  有订阅的用户索引(cron 枚举用;最后一个订阅删掉时一并删)
//   USER#<email> / SUB#<platform>:<id>     一条订阅
//   USER#<email> / CAND#<date>             当天候选(消费者回传,ttl 2 天)
//   USER#<email> / SUBRUN#<date>           当天挑选结果与理由(运营排查,ttl 30 天)
//   USER#<email> / PREFS                   邮件开关等偏好

export type SubPlatform = "youtube" | "bilibili" | "podcast";

export interface SubRecord {
	platform: SubPlatform;
	/** YouTube channelId / B站 mid / 播客 feed URL。 */
	id: string;
	title?: string;
	addedAt: number;
	/** 上次被挑中的时间(频道轮转用)。 */
	lastPickedAt?: number;
}

export const MAX_SUBSCRIPTIONS = 10;

export interface CandidateRecord {
	platform: SubPlatform;
	/** 订阅键 `${platform}:${subId}`,轮转按它归属。 */
	subKey: string;
	id: string;
	url: string;
	title: string;
	publishedAt: number;
	durationSec?: number;
	excluded?: string;
	channelTitle?: string;
}

export interface CandidatesRecord {
	date: string;
	items: CandidateRecord[];
	/** 消费者报告的每个订阅的抓取结果(成功条数或错误)。 */
	sources: Record<string, string>;
	at: number;
}

export interface SubRunRecord {
	date: string;
	/** 挑中的候选;null = 没挑(reason 说明)。 */
	picked: CandidateRecord | null;
	reason: string;
	taskId?: string;
	contentKey?: string;
	at: number;
}

export interface UserPrefs {
	emailPush?: boolean;
}

export const subKeyOf = (platform: string, id: string): string => `${platform}:${id}`;

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

/**
 * N 线 · 想法(2026-08-26 用户需求;设计哲学同 001 N1:结果是内容,想法是
 * 读者的长期资产)。target 锚点:overview | kp:<序号> | ch:<序号> | general。
 * 快照原则:title/url 建账时从处理记录抄一次,之后追加永不改——账记的是当时。
 */
export interface NoteEntry {
	/** 写下的时刻(ms),也当条目 id 用(同内容同毫秒双写的概率可忽略)。 */
	at: number;
	target: string;
	text: string;
	/**
	 * 写想法时所见结果的版本戳(= 内容缓存的 cachedAt)。重新生成后要点/分段
	 * 的序号会指向另一段内容,版本对不上的定点想法沉到「我的想法」兜底展示,
	 * 绝不挂错位。没有此字段的存量条目按「对不上」处理——保守但诚实。
	 */
	resultAt?: number;
}

export interface NoteRecord {
	contentKey: string;
	url?: string;
	title?: string;
	entries: NoteEntry[];
	updatedAt: number;
}

/** 单条内容的想法上限(有界状态,001 MAX_NOTE_ENTRIES 同款纪律)。 */
export const MAX_NOTE_ENTRIES = 50;

export class QuotaExceededError extends Error {
	constructor(kind: QuotaKind = "submit") {
		super(
			kind === "sub"
				? "今天的订阅日报已经跑过一次了(每人每天一条)。明天自动恢复。"
				: `今日提交次数已用完(${QUOTA_LIMITS.submit} 次/日)。明天自动恢复。`,
		);
	}
}

export interface Store {
	/** 内测白名单(docs/02 T7:门禁每请求复查)。 */
	isWhitelisted(email: string): Promise<boolean>;
	/** 原子占位(001 Q1 同款):自增与判上限压在同一个条件写里,超限抛 QuotaExceededError。 */
	reserveQuota(email: string, date: string, kind?: QuotaKind): Promise<void>;
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
	/** 历史列表(N 线):该用户全部处理记录,新的在前,封顶 200。 */
	listReadRecords(email: string): Promise<ReadRecord[]>;
	getNote(email: string, contentKey: string): Promise<NoteRecord | null>;
	putNote(email: string, note: NoteRecord): Promise<void>;

	// 订阅模式(docs/05 §3)
	listSubscriptions(email: string): Promise<SubRecord[]>;
	putSubscription(email: string, sub: SubRecord): Promise<void>;
	deleteSubscription(email: string, platform: SubPlatform, id: string): Promise<void>;
	/** 有订阅的用户(cron 枚举)。 */
	listSubscribers(): Promise<string[]>;
	putCandidates(email: string, rec: CandidatesRecord): Promise<void>;
	getCandidates(email: string, date: string): Promise<CandidatesRecord | null>;
	putSubRun(email: string, run: SubRunRecord): Promise<void>;
	getSubRun(email: string, date: string): Promise<SubRunRecord | null>;
	/**
	 * 当天的运行权占位。没有记录(或只有一条超过 staleMs 的「运行中」占位)时写一条
	 * 新占位并返回 true,否则 false。
	 * 为什么不是「先 getSubRun 看一眼再写」:读和写之间隔着抓 feed 的好几秒,并发
	 * 请求会全部穿过去,「每人每天一条」形同虚设。条件写把判断与占位压成一个原子操作。
	 * staleMs 是留给兜底 cron 的:00:00 那轮中途崩了会留下一条挂着的占位,01:30 的
	 * 兜底要能顶掉它接手,否则用户当天就彻底没有了。
	 */
	claimSubRun(email: string, date: string, staleMs?: number): Promise<ClaimResult>;
	getPrefs(email: string): Promise<UserPrefs>;
	putPrefs(email: string, prefs: UserPrefs): Promise<void>;
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

	async reserveQuota(email: string, date: string, kind: QuotaKind = "submit"): Promise<void> {
		try {
			await this.call("UpdateItem", {
				Key: { PK: { S: `USER#${email.toLowerCase()}` }, SK: { S: `USAGE#${date}` } },
				UpdateExpression: "ADD #n :one SET #ttl = if_not_exists(#ttl, :ttl)",
				ConditionExpression: "attribute_not_exists(#n) OR #n < :limit",
				ExpressionAttributeNames: { "#n": QUOTA_ATTR[kind], "#ttl": "ttl" },
				ExpressionAttributeValues: {
					":one": { N: "1" },
					":limit": { N: String(QUOTA_LIMITS[kind]) },
					":ttl": { N: String(Math.floor(Date.now() / 1000) + 7 * 24 * 3600) },
				},
			});
		} catch (err) {
			if (err instanceof ConditionalFailure) throw new QuotaExceededError(kind);
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
				...(t.origin ? { origin: { S: t.origin } } : {}),
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
			...(it.origin?.S === "subscription" ? { origin: "subscription" as const } : {}),
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
		return this.readRecordFromItem(contentKey, it);
	}

	private readRecordFromItem(contentKey: string, it: Record<string, { S?: string; N?: string }>): ReadRecord {
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

	async listReadRecords(email: string): Promise<ReadRecord[]> {
		// SK 是 READ#<contentKey>,不是时间序——全量拉(封顶 200)后按 at 排。
		// 内测规模一个用户几十条,一次 Query 足够;将来量大再加 at 的 GSI。
		const out = await this.call<{ Items?: Record<string, { S?: string; N?: string }>[] }>("Query", {
			KeyConditionExpression: "PK = :pk AND begins_with(SK, :pre)",
			ExpressionAttributeValues: {
				":pk": { S: `USER#${email.toLowerCase()}` },
				":pre": { S: "READ#" },
			},
			Limit: 200,
		});
		return (out.Items ?? [])
			.map((it) => this.readRecordFromItem((it.SK?.S ?? "").slice("READ#".length), it))
			.sort((a, b) => b.at - a.at);
	}

	async getNote(email: string, contentKey: string): Promise<NoteRecord | null> {
		const out = await this.call<{ Item?: Record<string, { S?: string; N?: string }> }>("GetItem", {
			Key: { PK: { S: `USER#${email.toLowerCase()}` }, SK: { S: `NOTE#${contentKey}` } },
		});
		const it = out.Item;
		if (!it) return null;
		let entries: NoteEntry[] = [];
		try {
			entries = it.entries?.S ? (JSON.parse(it.entries.S) as NoteEntry[]) : [];
		} catch {
			entries = [];
		}
		return {
			contentKey,
			url: it.url?.S,
			title: it.title?.S,
			entries,
			updatedAt: Number(it.updatedAt?.N ?? 0),
		};
	}

	async putNote(email: string, note: NoteRecord): Promise<void> {
		await this.call("PutItem", {
			Item: {
				PK: { S: `USER#${email.toLowerCase()}` },
				SK: { S: `NOTE#${note.contentKey}` },
				...(note.url ? { url: { S: note.url } } : {}),
				...(note.title ? { title: { S: note.title } } : {}),
				entries: { S: JSON.stringify(note.entries) },
				updatedAt: { N: String(note.updatedAt) },
			},
		});
	}

	// ---- 订阅模式 ----

	private userPk(email: string): { S: string } {
		return { S: `USER#${email.toLowerCase()}` };
	}

	async listSubscriptions(email: string): Promise<SubRecord[]> {
		const out = await this.call<{ Items?: Record<string, { S?: string; N?: string }>[] }>("Query", {
			KeyConditionExpression: "PK = :pk AND begins_with(SK, :pre)",
			ExpressionAttributeValues: { ":pk": this.userPk(email), ":pre": { S: "SUB#" } },
			Limit: MAX_SUBSCRIPTIONS * 2,
		});
		return (out.Items ?? [])
			.map((it) => ({
				platform: (it.platform?.S ?? "podcast") as SubPlatform,
				id: it.subId?.S ?? "",
				title: it.title?.S,
				addedAt: Number(it.addedAt?.N ?? 0),
				...(it.lastPickedAt?.N ? { lastPickedAt: Number(it.lastPickedAt.N) } : {}),
			}))
			.filter((s) => s.id)
			.sort((a, b) => a.addedAt - b.addedAt);
	}

	async putSubscription(email: string, sub: SubRecord): Promise<void> {
		await this.call("PutItem", {
			Item: {
				PK: this.userPk(email),
				SK: { S: `SUB#${subKeyOf(sub.platform, sub.id)}` },
				platform: { S: sub.platform },
				subId: { S: sub.id },
				...(sub.title ? { title: { S: sub.title } } : {}),
				addedAt: { N: String(sub.addedAt) },
				...(sub.lastPickedAt ? { lastPickedAt: { N: String(sub.lastPickedAt) } } : {}),
			},
		});
		// 订阅者索引:cron 靠它枚举;幂等 Put
		await this.call("PutItem", {
			Item: { PK: { S: "SUBSCRIBERS" }, SK: { S: email.toLowerCase() }, at: { N: String(Date.now()) } },
		});
	}

	async deleteSubscription(email: string, platform: SubPlatform, id: string): Promise<void> {
		await this.call("DeleteItem", {
			Key: { PK: this.userPk(email), SK: { S: `SUB#${subKeyOf(platform, id)}` } },
		});
		if ((await this.listSubscriptions(email)).length === 0) {
			await this.call("DeleteItem", { Key: { PK: { S: "SUBSCRIBERS" }, SK: { S: email.toLowerCase() } } });
		}
	}

	async listSubscribers(): Promise<string[]> {
		const out = await this.call<{ Items?: Record<string, { S?: string }>[] }>("Query", {
			KeyConditionExpression: "PK = :pk",
			ExpressionAttributeValues: { ":pk": { S: "SUBSCRIBERS" } },
			Limit: 500,
		});
		return (out.Items ?? []).map((it) => it.SK?.S ?? "").filter(Boolean);
	}

	async putCandidates(email: string, rec: CandidatesRecord): Promise<void> {
		await this.call("PutItem", {
			Item: {
				PK: this.userPk(email),
				SK: { S: `CAND#${rec.date}` },
				body: { S: JSON.stringify(rec) },
				ttl: { N: String(Math.floor(Date.now() / 1000) + 2 * 24 * 3600) },
			},
		});
	}

	async getCandidates(email: string, date: string): Promise<CandidatesRecord | null> {
		const out = await this.call<{ Item?: { body?: { S?: string } } }>("GetItem", {
			Key: { PK: this.userPk(email), SK: { S: `CAND#${date}` } },
		});
		try {
			return out.Item?.body?.S ? (JSON.parse(out.Item.body.S) as CandidatesRecord) : null;
		} catch {
			return null;
		}
	}

	async putSubRun(email: string, run: SubRunRecord): Promise<void> {
		await this.call("PutItem", {
			Item: {
				PK: this.userPk(email),
				SK: { S: `SUBRUN#${run.date}` },
				body: { S: JSON.stringify(run) },
				ttl: { N: String(Math.floor(Date.now() / 1000) + 30 * 24 * 3600) },
			},
		});
	}

	async claimSubRun(email: string, date: string, staleMs?: number): Promise<ClaimResult> {
		if (await this.tryClaim(email, date)) return "fresh";
		if (staleMs && (await this.tryClaim(email, date, staleMs))) return "takeover";
		return "taken";
	}

	private async tryClaim(email: string, date: string, staleMs?: number): Promise<boolean> {
		const now = Date.now();
		const run: SubRunRecord = { date, picked: null, reason: "运行中", at: now };
		// running/at 提到顶层是为了能写进条件表达式——body 是个 JSON 字符串,条件写读不进去
		try {
			await this.call("PutItem", {
				Item: {
					PK: this.userPk(email),
					SK: { S: `SUBRUN#${date}` },
					body: { S: JSON.stringify(run) },
					running: { BOOL: true },
					at: { N: String(now) },
					ttl: { N: String(Math.floor(now / 1000) + 30 * 24 * 3600) },
				},
				ConditionExpression: staleMs
					? "attribute_not_exists(SK) OR (running = :t AND #at < :cutoff)"
					: "attribute_not_exists(SK)",
				...(staleMs
					? {
							ExpressionAttributeNames: { "#at": "at" },
							ExpressionAttributeValues: { ":t": { BOOL: true }, ":cutoff": { N: String(now - staleMs) } },
						}
					: {}),
			});
			return true;
		} catch (err) {
			if (err instanceof ConditionalFailure) return false;
			throw err;
		}
	}

	async getSubRun(email: string, date: string): Promise<SubRunRecord | null> {
		const out = await this.call<{ Item?: { body?: { S?: string } } }>("GetItem", {
			Key: { PK: this.userPk(email), SK: { S: `SUBRUN#${date}` } },
		});
		try {
			return out.Item?.body?.S ? (JSON.parse(out.Item.body.S) as SubRunRecord) : null;
		} catch {
			return null;
		}
	}

	async getPrefs(email: string): Promise<UserPrefs> {
		const out = await this.call<{ Item?: { body?: { S?: string } } }>("GetItem", {
			Key: { PK: this.userPk(email), SK: { S: "PREFS" } },
		});
		try {
			return out.Item?.body?.S ? (JSON.parse(out.Item.body.S) as UserPrefs) : {};
		} catch {
			return {};
		}
	}

	async putPrefs(email: string, prefs: UserPrefs): Promise<void> {
		await this.call("PutItem", {
			Item: { PK: this.userPk(email), SK: { S: "PREFS" }, body: { S: JSON.stringify(prefs) } },
		});
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

	async reserveQuota(email: string, date: string, kind: QuotaKind = "submit"): Promise<void> {
		const key = `${email}:${date}:${kind}`;
		const n = this.quota.get(key) ?? 0;
		if (n >= QUOTA_LIMITS[kind]) throw new QuotaExceededError(kind);
		this.quota.set(key, n + 1);
	}

	async getQuota(email: string, date: string): Promise<number> {
		return this.quota.get(`${email}:${date}:submit`) ?? 0;
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

	async listReadRecords(email: string): Promise<ReadRecord[]> {
		return [...this.reads.entries()]
			.filter(([k]) => k.startsWith(`${email}:`))
			.map(([, v]) => ({ ...v }))
			.sort((a, b) => b.at - a.at)
			.slice(0, 200);
	}

	private notes = new Map<string, NoteRecord>();

	async getNote(email: string, contentKey: string): Promise<NoteRecord | null> {
		const n = this.notes.get(`${email}:${contentKey}`);
		return n ? { ...n, entries: [...n.entries] } : null;
	}

	async putNote(email: string, note: NoteRecord): Promise<void> {
		this.notes.set(`${email}:${note.contentKey}`, { ...note, entries: [...note.entries] });
	}

	// ---- 订阅模式 ----
	private subs = new Map<string, SubRecord>();
	private cands = new Map<string, CandidatesRecord>();
	private runs = new Map<string, SubRunRecord>();
	private prefs = new Map<string, UserPrefs>();

	async listSubscriptions(email: string): Promise<SubRecord[]> {
		return [...this.subs.entries()]
			.filter(([k]) => k.startsWith(`${email}:`))
			.map(([, v]) => ({ ...v }))
			.sort((a, b) => a.addedAt - b.addedAt);
	}

	async putSubscription(email: string, sub: SubRecord): Promise<void> {
		this.subs.set(`${email}:${subKeyOf(sub.platform, sub.id)}`, { ...sub });
	}

	async deleteSubscription(email: string, platform: SubPlatform, id: string): Promise<void> {
		this.subs.delete(`${email}:${subKeyOf(platform, id)}`);
	}

	async listSubscribers(): Promise<string[]> {
		return [...new Set([...this.subs.keys()].map((k) => k.slice(0, k.indexOf(":"))))];
	}

	async putCandidates(email: string, rec: CandidatesRecord): Promise<void> {
		this.cands.set(`${email}:${rec.date}`, rec);
	}

	async getCandidates(email: string, date: string): Promise<CandidatesRecord | null> {
		return this.cands.get(`${email}:${date}`) ?? null;
	}

	async putSubRun(email: string, run: SubRunRecord): Promise<void> {
		this.runs.set(`${email}:${run.date}`, run);
	}

	async getSubRun(email: string, date: string): Promise<SubRunRecord | null> {
		return this.runs.get(`${email}:${date}`) ?? null;
	}

	async claimSubRun(email: string, date: string, staleMs?: number): Promise<ClaimResult> {
		const key = `${email}:${date}`;
		const cur = this.runs.get(key);
		const stale = Boolean(staleMs && cur && cur.reason === "运行中" && Date.now() - cur.at > staleMs);
		if (cur && !stale) return "taken";
		this.runs.set(key, { date, picked: null, reason: "运行中", at: Date.now() });
		return cur ? "takeover" : "fresh";
	}

	async getPrefs(email: string): Promise<UserPrefs> {
		return { ...(this.prefs.get(email) ?? {}) };
	}

	async putPrefs(email: string, prefs: UserPrefs): Promise<void> {
		this.prefs.set(email, { ...prefs });
	}
}

/**
 * 结果缓存的 KV 键(docs/02 T6:content:<版本>:<platform>:<id>,60 天)。
 * 版本号进键:schema 有破坏性升级(如 2026-08-26 新增导读)时 bump 一位,
 * 老缓存自然被绕开并随 TTL 消亡——比迁移或运行时兼容分支都便宜。
 * v3(2026-08-28):详细笔记(docs/05)——老结果没有 notes,重开时提示重算。
 */
export function contentCacheKey(contentKey: string): string {
	return `content:v3:${contentKey}`;
}

export const CONTENT_CACHE_TTL_S = 60 * 24 * 3600;

/** KV 的最小结构约束——不引 KVNamespace 类型,这个文件消费者(Node)也要 import。 */
interface CacheKv {
	get<T>(key: string, type: "json"): Promise<T | null>;
}

/**
 * 读缓存:先看当前版本,没有再看上一版。
 * 版本号 bump 会把老记录整批绕开,但「我的记录」里那些条目并没有真的过期——不回落
 * 的话用户会看到一句假话(「缓存已过期(60 天)」),还要花一次额度才能重开。
 * 只有读回落;写永远只写当前版本,老键随自己的 TTL 消亡。
 */
export async function readCachedContent(kv: CacheKv, contentKey: string): Promise<CachedContent | null> {
	return (
		(await kv.get<CachedContent>(contentCacheKey(contentKey), "json")) ??
		(await kv.get<CachedContent>(`content:v2:${contentKey}`, "json"))
	);
}

export interface CachedContent {
	result: WatchResult;
	contentKey: string;
	cachedAt: number;
	/** 首次处理时的来源 URL(F4 跳转用;粘贴内容没有)。 */
	url?: string;
	/** 文章/粘贴的正文段落(F4 段落锚点跳转用;视频转写待 C 线)。 */
	paragraphs?: string[];
}
