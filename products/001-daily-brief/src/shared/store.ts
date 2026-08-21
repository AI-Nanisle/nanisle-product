// B1 · 存储接缝(docs/02-技术方案.md §4.3)。全部访问模式收在一个窄接口里,
// 两个实现:DynamoDB(生产,store-dynamo.ts,Worker 与 Lambda 共用)和
// KV 替身(本地 dev / fork,src/worker/store-kv.ts)。接缝的存在就是公开仓的
// 硬规矩:fork 者零配置 `npm run dev` 必须能跑通全流程,AWS 凭证不是前置条件。

import type { SourceConfig, Tracker } from "./pipeline-core";
import type { Brief, FeedbackEvent, ItemNote, Thread } from "./types";
import type { Proposal } from "./weekly";

/** 未配置 SSO / AWS 时的固定本地用户(单用户模式)。 */
export const DEV_USER = "dev@local";

/**
 * 找源漏斗的累计计数(docs/02 §7.3 的仪表之一):候选源采纳率 = adopted/shown。
 * 只算 AI 提议且试抓通过、真实展示过的候选;手动添加、目录添加不计入。
 */
export interface SourceFunnelMetrics {
	/** 累计展示给用户的候选条数。 */
	shown: number;
	/** 其中被「加入」采纳的条数。 */
	adopted: number;
}

/** 读者偏好与产品自己维护的小状态。缺省 = 全部默认值(老配置无此字段)。 */
export interface UserPrefs {
	/** X2 · 轴外位开关,默认开;读者手动关、或连续没人点自动关。 */
	offAxis?: boolean;
	/** X2 · 连续多少期轴外位没被点开。到 OFF_AXIS_MISS_LIMIT 就自动关掉。 */
	offAxisMisses?: number;
	/** H5 · 读者说过「不用管这个站」的域名,别再反复提议(最多留 100 条)。 */
	dismissedHosts?: string[];
	/**
	 * E1 · 每日邮件提醒(docs/04),缺省 = 开(内测熟人默认要提醒,默认关等于
	 * 功能没做)。三个关闭入口:配置页开关、邮件页脚退订链、Gmail 原生退订按钮。
	 */
	emailPush?: boolean;
	/** S1 · 最近一次算过周指标的 ISO 周(YYYY-Www),防同周重复生成提案。 */
	lastWeeklyAt?: string;
}

/** H5 · 反向发现的窗口与门槛:30 天内点够 4 次,才值得开口问。 */
export const DISCOVERY_WINDOW_DAYS = 30;
export const DISCOVERY_MIN_CLICKS = 4;

/**
 * R9 · 口味画像:过往反馈的长期蒸馏(shared/taste.ts),每天进选材提示词。
 * 反馈事件 90 天就过期,不蒸馏,长期口味会跟着 TTL 一起蒸发。
 */
export interface TasteProfile {
	summary: string;
	/** 上次蒸馏(或读者手改)的时间;下次蒸馏只看这之后的新反馈。 */
	updatedAt: string;
	/** 上次蒸馏消化了多少条反馈,配置页展示用。 */
	distilledFrom: number;
	/** 读者亲手改过:重蒸馏时其中的明确偏好必须逐条保留(用户的原话是宪法)。 */
	edited?: boolean;
}

/** 一个用户的全部配置,整存整取(§4「追踪器仍整存整取」)。 */
export interface UserConfig {
	trackers: Tracker[];
	sources: SourceConfig[];
	/** 缺省 = 还没有任何候选展示过(老配置无此字段)。 */
	metrics?: SourceFunnelMetrics;
	prefs?: UserPrefs;
	/** R9 · 缺省 = 反馈还没攒够一次蒸馏(老配置无此字段)。 */
	taste?: TasteProfile;
	updatedAt: string;
}

/** 轴外位默认开:破茧要默认生效才有意义,但读者随时能关。 */
export function offAxisEnabled(config: Pick<UserConfig, "prefs">): boolean {
	return config.prefs?.offAxis !== false;
}

/** 存起来的一期简报。当日生成次数不记在这里,见下面的额度条目。 */
export interface StoredBrief {
	brief: Brief;
	generatedAt: string;
}

// ---------- 每日额度(docs/02 §8.3) ----------

/**
 * 两种花钱的动作,各记一个日计数器:
 *   gen  立即生成 —— 一次 = 一条完整管线(选材 + 成稿两次大输入调用),最贵
 *   ai   编辑侧的单次调用 —— 向导三步 + 「对编辑说一句」,按请求粗粒度计
 *
 * 粗到按请求而不是按 token,是因为这道闸防的是失控脚本,不是正常人的手速;
 * 真要按钱计量得先让 ai.ts 把 usage 带回来,那是开放注册那一档的事。
 */
export type QuotaKind = "gen" | "ai";

/** 当日已用次数。没有当天的条目 = 全 0。 */
export interface QuotaUsed {
	gen: number;
	ai: number;
}

/** 每人每日上限。两个实现都从这里读,别在调用点另写一份。 */
export const QUOTA_LIMITS: Record<QuotaKind, number> = { gen: 10, ai: 60 };

/** 额度条目留 7 天:够回看这一周,又不用另写清理任务(DynamoDB 原生 TTL)。 */
export const QUOTA_TTL_S = 7 * 24 * 3600;

/** /go 埋点的点击事件(和 FeedbackEvent 的区别:没有 kind)。 */
export interface ClickEvent {
	date: string;
	itemId: string;
	at: string;
	/**
	 * H4 · 被点开那条原文的域名。埋在事件上而不是事后回查简报:简报 90 天后
	 * 还在,但按 host 聚合是每天都要做的事,现算要拉一堆简报。老事件没有这个
	 * 字段,聚合时跳过即可。
	 */
	host?: string;
}

/** 读回来的事件流;判别方式和写入侧一致——有 kind 的是反馈。 */
export type StoredEvent = FeedbackEvent | ClickEvent;

export function isFeedbackEvent(ev: StoredEvent): ev is FeedbackEvent {
	return "kind" in ev;
}

/**
 * 一次 listEvents 最多读回多少条(R1)。重度用户 90 天能攒下几千条事件,
 * 生成路径上无上限的读会既慢又贵;选材只看近 7 天,500 条绰绰有余。
 */
export const MAX_EVENTS_READ = 500;

/**
 * 所有用户数据的读写都走这里 — Worker 的 API 层、Lambda 的生成编排都只认
 * 这个接口。方法全部是主键点查或前缀 Query,别往里加扫描类操作。
 */
export interface Store {
	isWhitelisted(email: string): Promise<boolean>;
	listWhitelist(): Promise<string[]>;
	getConfig(email: string): Promise<UserConfig | null>;
	putConfig(email: string, config: UserConfig): Promise<void>;
	/** 无 date = 最新一期(SK 前缀倒序取 1,日期字符串字典序即时间序)。 */
	getBrief(email: string, date?: string): Promise<StoredBrief | null>;
	/** 覆盖写当日简报。生成次数不在这里记(见 reserveQuota)。 */
	putBrief(email: string, brief: Brief): Promise<void>;
	/**
	 * 占一次额度:**先占位,后干活**(§8.3)。自增与判上限必须落在同一个原子
	 * 写里——旧版是「读计数 → 花 30–60 秒干活 → 结束时才自增」,并发请求会
	 * 全部通过前置检查,限额形同虚设。ok=false 时调用方必须直接拒绝请求。
	 */
	reserveQuota(email: string, date: string, kind: QuotaKind): Promise<{ ok: boolean; used: number }>;
	/**
	 * 退还一次额度。只用在**确定一个 token 都没花**的失败路径上(例如根本没
	 * 调通 Lambda)。模型报错不退:它跑过了,钱可能已经花掉,退还等于纵容
	 * 「失败就疯狂重试」这条真实的烧钱路径。
	 */
	refundQuota(email: string, date: string, kind: QuotaKind): Promise<void>;
	/** 当日两个计数器的已用量,给前端的额度读数(GET /api/usage)。 */
	getQuota(email: string, date: string): Promise<QuotaUsed>;
	/** 反馈/点击事件,一事件一条,TTL 90 天。有 kind 字段的是反馈。 */
	appendEvent(email: string, ev: FeedbackEvent | ClickEvent): Promise<void>;
	/**
	 * R1 · 读回 `sinceISO` 之后的事件,**新的在前**,最多 `limit` 条
	 * (默认且封顶 `MAX_EVENTS_READ`)。反馈与点击混在一个流里返回。
	 * 这是反馈回路的唯一读口:生成前的选材、feedbackEcho、S 线指标都走它。
	 */
	listEvents(email: string, sinceISO: string, limit?: number): Promise<StoredEvent[]>;
	/** T2 · 某人的线索台账;给 trackerKey 就只取那一个追踪器的。含已归档的。 */
	listThreads(email: string, trackerKey?: string): Promise<Thread[]>;
	/** T2 · 整条覆盖写。线索条数有限(每追踪器几十条),不做增量。 */
	putThread(email: string, thread: Thread): Promise<void>;
	/** S3 · 周自评提案(含已生效/已否决的近期记录)。 */
	listProposals(email: string): Promise<Proposal[]>;
	putProposal(email: string, proposal: Proposal): Promise<void>;
	/** S1 · 周指标快照,一周一条。 */
	putMetrics(email: string, week: string, metrics: unknown): Promise<void>;
	/** 阅读页日期下拉,倒序。 */
	listBriefDates(email: string): Promise<string[]>;
	/** N2 · 想法台账:追加前回读一条(读改写在 Worker 侧,写入频率是人手速)。 */
	getNote(email: string, date: string, itemId: string): Promise<ItemNote | null>;
	/** N2 · 整条覆盖写。**不设 TTL**——同线索台账,这是长期资产。 */
	putNote(email: string, note: ItemNote): Promise<void>;
	/** N2 · 想法页整页一次拉回,按简报日期倒序,最多 MAX_NOTES_READ 条。 */
	listNotes(email: string, limit?: number): Promise<ItemNote[]>;
}

/**
 * 一次 listNotes 最多读回多少条账。一天至多留几条想法,300 条 ≈ 大半年的量;
 * 真攒到上限时最老的想法仍在库里,只是这一页先不渲染——将来再谈分页。
 */
export const MAX_NOTES_READ = 300;

/** 事件条目的保存期:90 天后它已经完成使命(喂给编辑提示词的只看近 7 天)。 */
export const EVENT_TTL_S = 90 * 24 * 3600;
/** 提案 60 天后自然消失:那时它要么早生效了,要么早过时了。 */
export const PROPOSAL_TTL_S = 60 * 24 * 3600;
/** 周指标留一年多,够看同比。 */
export const METRICS_TTL_S = 400 * 24 * 3600;
