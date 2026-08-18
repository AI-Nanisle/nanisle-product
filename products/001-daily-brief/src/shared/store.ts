// B1 · 存储接缝(docs/02-技术方案.md §4.3)。全部访问模式收在一个窄接口里,
// 两个实现:DynamoDB(生产,store-dynamo.ts,Worker 与 Lambda 共用)和
// KV 替身(本地 dev / fork,src/worker/store-kv.ts)。接缝的存在就是公开仓的
// 硬规矩:fork 者零配置 `npm run dev` 必须能跑通全流程,AWS 凭证不是前置条件。

import type { SourceConfig, Tracker } from "./pipeline-core";
import type { Brief, FeedbackEvent } from "./types";

/** 未配置 SSO / AWS 时的固定本地用户(单用户模式)。 */
export const DEV_USER = "dev@local";

/** 一个用户的全部配置,整存整取(§4「追踪器仍整存整取」)。 */
export interface UserConfig {
	trackers: Tracker[];
	sources: SourceConfig[];
	updatedAt: string;
}

/** 存起来的一期简报;genCount 承载立即生成限额(10 次/人/日)。 */
export interface StoredBrief {
	brief: Brief;
	generatedAt: string;
	genCount: number;
}

/** /go 埋点的点击事件(和 FeedbackEvent 的区别:没有 kind)。 */
export interface ClickEvent {
	date: string;
	itemId: string;
	at: string;
}

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
	/** 覆盖写当日简报;bumpGenCount 时原子自增,返回今日已生成次数。 */
	putBrief(email: string, brief: Brief, bumpGenCount: boolean): Promise<number>;
	/** 反馈/点击事件,一事件一条,TTL 90 天。有 kind 字段的是反馈。 */
	appendEvent(email: string, ev: FeedbackEvent | ClickEvent): Promise<void>;
	/** 阅读页日期下拉,倒序。 */
	listBriefDates(email: string): Promise<string[]>;
}

/** 事件条目的保存期:90 天后它已经完成使命(喂给编辑提示词的只看近 7 天)。 */
export const EVENT_TTL_S = 90 * 24 * 3600;
