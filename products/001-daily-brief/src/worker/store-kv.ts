// B3 · Store 的 KV 替身实现(docs/02-技术方案.md §4.3)。本地 dev / fork 用:
// 未配 AWS 凭证时自动选它,配合固定用户 dev@local 跑单用户模式——公开仓的
// 零配置规矩靠它保住。键语义与 store-dynamo.ts 逐一对齐,只是换了介质;
// miniflare 本地有持久化,开发体验不降级。
//
// 键约定(全部带用户前缀,和旧版的全局键 config:*/brief:* 彻底分开):
//   user:<email>:config           配置整存整取
//   user:<email>:brief:<date>     每日简报 {brief, generatedAt, genCount}
//   user:<email>:fb:<ts>:<uuid>   反馈事件(expirationTtl 90 天)
//   user:<email>:click:<ts>:<uuid> 点击事件(同上)
//   user:<email>:thread:<trackerKey>:<threadKey>  线索台账(无 TTL)
//   user:<email>:note:<date>:<itemId>  想法台账(无 TTL)
//   user:<email>:proposal:<id>    周自评提案

import type { Brief, ItemNote, Thread } from "../shared/types";
import type { Store, StoredBrief, StoredEvent } from "../shared/store";
import { EVENT_TTL_S, MAX_EVENTS_READ, MAX_NOTES_READ, METRICS_TTL_S, PROPOSAL_TTL_S } from "../shared/store";
import type { Proposal } from "../shared/weekly";
import { dynamoStore } from "../shared/store-dynamo";
import type { AppEnv } from "./env";

export function kvStore(kv: KVNamespace): Store {
	const briefKey = (email: string, date: string) => `user:${email}:brief:${date}`;

	async function listDates(email: string): Promise<string[]> {
		const prefix = `user:${email}:brief:`;
		// KV list 按键名字典序升序;日期字符串字典序即时间序,反转即倒序。
		// 单用户本地库,一页 1000 个键绰绰有余。
		const list = await kv.list({ prefix, limit: 1000 });
		return list.keys.map((k) => k.name.slice(prefix.length)).reverse();
	}

	return {
		// KV 模式没有白名单:它只在本地 dev / fork 里出现,准入交给 userGuard
		// 的零配置回落(所有人都是 dev@local 或持有效会话的自己)。
		async isWhitelisted() {
			return true;
		},

		async listWhitelist() {
			// 定时全量只在 Lambda(必有 DynamoDB)里跑,这里只为接口完整
			return [];
		},

		async getConfig(email) {
			const raw = await kv.get(`user:${email}:config`);
			return raw ? JSON.parse(raw) : null;
		},

		async putConfig(email, config) {
			await kv.put(`user:${email}:config`, JSON.stringify(config));
		},

		async getBrief(email, date) {
			let key: string | null = null;
			if (date) {
				key = briefKey(email, date);
			} else {
				const dates = await listDates(email);
				if (dates.length > 0) key = briefKey(email, dates[0]);
			}
			if (!key) return null;
			const raw = await kv.get(key);
			return raw ? (JSON.parse(raw) as StoredBrief) : null;
		},

		async putBrief(email, brief: Brief, bumpGenCount) {
			// 单用户本地库,读改写没有并发问题;原子性只有 DynamoDB 实现需要保证
			const existing = await this.getBrief(email, brief.date);
			const genCount = (existing?.genCount ?? 0) + (bumpGenCount ? 1 : 0);
			const stored: StoredBrief = { brief, generatedAt: brief.generatedAt, genCount };
			await kv.put(briefKey(email, brief.date), JSON.stringify(stored));
			return genCount;
		},

		async appendEvent(email, ev) {
			const kind = "kind" in ev ? "fb" : "click";
			await kv.put(`user:${email}:${kind}:${ev.at}:${crypto.randomUUID()}`, JSON.stringify(ev), {
				expirationTtl: EVENT_TTL_S,
			});
		},

		async listEvents(email, sinceISO, limit = MAX_EVENTS_READ) {
			const cap = Math.min(Math.max(1, limit), MAX_EVENTS_READ);
			// 键形如 `user:<email>:fb:<ISO>:<uuid>`。ISO 里也有冒号,所以不去拆键,
			// 直接拿整串和 `<前缀><sinceISO>` 比字典序——前缀固定,比较即时间序。
			const pull = async (kind: "fb" | "click"): Promise<string[]> => {
				const prefix = `user:${email}:${kind}:`;
				const list = await kv.list({ prefix, limit: 1000 });
				return list.keys
					.map((k) => k.name)
					.filter((name) => name >= `${prefix}${sinceISO}`)
					.reverse()
					.slice(0, cap);
			};
			const keys = [...(await pull("fb")), ...(await pull("click"))];
			// 本地单用户库,逐个 get 可接受(生产走 DynamoDB 的两次 Query)
			const raws = await Promise.all(keys.map((k) => kv.get(k)));
			const events = raws
				.filter((raw): raw is string => Boolean(raw))
				.map((raw) => JSON.parse(raw) as StoredEvent);
			return events.sort((a, b) => b.at.localeCompare(a.at)).slice(0, cap);
		},

		async listThreads(email, trackerKey) {
			const prefix = `user:${email}:thread:${trackerKey ? `${trackerKey}:` : ""}`;
			const list = await kv.list({ prefix, limit: 300 });
			const raws = await Promise.all(list.keys.map((k) => kv.get(k.name)));
			return raws.filter((r): r is string => Boolean(r)).map((r) => JSON.parse(r) as Thread);
		},

		async putThread(email, thread) {
			// 线索台账不设 TTL:它是长期资产,和 90 天就该消失的事件流不是一回事
			await kv.put(`user:${email}:thread:${thread.trackerKey}:${thread.key}`, JSON.stringify(thread));
		},

		async listProposals(email) {
			const prefix = `user:${email}:proposal:`;
			const list = await kv.list({ prefix, limit: 100 });
			const raws = await Promise.all(list.keys.map((k) => kv.get(k.name)));
			return raws.filter((r): r is string => Boolean(r)).map((r) => JSON.parse(r) as Proposal);
		},

		async putProposal(email, proposal) {
			await kv.put(`user:${email}:proposal:${proposal.id}`, JSON.stringify(proposal), {
				expirationTtl: PROPOSAL_TTL_S,
			});
		},

		async putMetrics(email, week, metrics) {
			await kv.put(`user:${email}:metrics:${week}`, JSON.stringify(metrics), { expirationTtl: METRICS_TTL_S });
		},

		async listBriefDates(email) {
			return listDates(email);
		},

		async getNote(email, date, itemId) {
			const raw = await kv.get(`user:${email}:note:${date}:${itemId}`);
			return raw ? (JSON.parse(raw) as ItemNote) : null;
		},

		async putNote(email, note) {
			// 想法台账不设 TTL:同线索台账,读者自己的长期资产
			await kv.put(`user:${email}:note:${note.date}:${note.itemId}`, JSON.stringify(note));
		},

		async listNotes(email, limit = MAX_NOTES_READ) {
			const prefix = `user:${email}:note:`;
			// 键名以日期开头,升序 list 反转即「新账在前」(同 listDates 的道理)
			const list = await kv.list({ prefix, limit: 1000 });
			const keys = list.keys
				.map((k) => k.name)
				.reverse()
				.slice(0, Math.min(Math.max(1, limit), MAX_NOTES_READ));
			const raws = await Promise.all(keys.map((k) => kv.get(k)));
			return raws.filter((r): r is string => Boolean(r)).map((r) => JSON.parse(r) as ItemNote);
		},
	};
}

/** Worker 里有没有一套完整的 AWS 侧配置(store 与 Lambda 转调共用这组判断)。 */
export function awsConfigured(env: AppEnv): boolean {
	return Boolean(env.AWS_ACCESS_KEY_ID && env.AWS_SECRET_ACCESS_KEY && env.DDB_TABLE);
}

/**
 * 选择逻辑(§4.3):配了 AWS 凭证 → DynamoDB(生产),否则 KV 替身(dev/fork)。
 * 每请求现建一个,无状态、零网络开销。
 */
export function makeStore(env: AppEnv): { store: Store; mode: "dynamo" | "kv" } {
	if (awsConfigured(env)) {
		return {
			mode: "dynamo",
			store: dynamoStore({
				table: env.DDB_TABLE!,
				region: env.AWS_REGION ?? "us-east-1",
				accessKeyId: env.AWS_ACCESS_KEY_ID!,
				secretAccessKey: env.AWS_SECRET_ACCESS_KEY!,
			}),
		};
	}
	return { mode: "kv", store: kvStore(env.BRIEFS) };
}
