// I3 · 用户级高亮(docs/02 T4 的第二次调用 + T7② 的跨产品读取)。
// 分段地图对所有人长一个样,唯一的个性化是「与你手头的事直接相关」的段落
// 高亮,判断依据是 001 的追踪器定义——经 interop 端点只读拿定义文本,
// **降级是设计的一部分**:001 不可用/密钥没配/用户没有追踪器,一律安静地
// 返回 null,地图无高亮但完整可用,绝不阻塞主流程。

import { complete } from "../shared/ai";
import type { AiConfig } from "../shared/ai";
import type { WatchResult } from "../shared/schema";
import type { AppEnv } from "./env";

interface InteropTracker {
	key: string;
	name: string;
	question?: string;
	purpose?: string;
	intent?: string;
}

/** 追踪器定义的 10 分钟按用户缓存(T7②:避免每次提交都打 001)。isolate 本地,best-effort。 */
const trackerCache = new Map<string, { at: number; trackers: InteropTracker[] }>();
const TRACKER_CACHE_MS = 10 * 60 * 1000;

async function fetchTrackers(env: AppEnv, email: string): Promise<InteropTracker[] | null> {
	if (!env.INTEROP_TOKEN || !env.INTEROP_TRACKERS_URL) return null;
	const hit = trackerCache.get(email);
	if (hit && Date.now() - hit.at < TRACKER_CACHE_MS) return hit.trackers;
	try {
		const res = await fetch(`${env.INTEROP_TRACKERS_URL}?email=${encodeURIComponent(email)}`, {
			headers: { "x-interop-token": env.INTEROP_TOKEN },
			signal: AbortSignal.timeout(8000),
		});
		if (!res.ok) {
			console.log(`interop trackers ${res.status} for ${email}`);
			return null;
		}
		const data = (await res.json()) as { trackers?: InteropTracker[] };
		const trackers = (data.trackers ?? []).filter((t) => t.key && t.name);
		trackerCache.set(email, { at: Date.now(), trackers });
		return trackers;
	} catch (err) {
		console.log(`interop trackers fetch failed: ${(err as Error).message}`);
		return null; // 001 打不通 = 降级,不报错
	}
}

const HIGHLIGHT_SYSTEM = `你是「长视频总结」的编辑助手。给你一位读者的长期追踪定义,和一条内容的分段大意列表,判断哪些分段与读者的某个追踪**直接相关**——「直接相关」指读者看完这段就能对他追踪的问题多知道一点,擦边和泛泛提及不算。只输出一个 JSON 对象:
{ "hits": [ { "chapter": 段序号, "tracker": "追踪器key" } ] }
只报高置信的命中;没有命中就输出 { "hits": [] }。不要输出任何其他文字。`;

/**
 * 计算高亮(章节序号→追踪器名)。任何失败返回 null(降级);
 * 空对象 {} 表示「算过了,没有命中」——调用方也要缓存它,别每次重算。
 */
export async function computeTracked(
	env: AppEnv,
	fastCfg: AiConfig,
	email: string,
	result: WatchResult,
): Promise<Record<string, string> | null> {
	const trackers = await fetchTrackers(env, email);
	if (!trackers || trackers.length === 0) return null;

	const defs = trackers
		.map((t) => {
			const parts = [`key: ${t.key}`, `名称: ${t.name}`];
			if (t.question) parts.push(`长期问题: ${t.question}`);
			if (t.purpose) parts.push(`拿它做什么: ${t.purpose}`);
			if (t.intent) parts.push(`意图: ${t.intent}`);
			return `- ${parts.join(";")}`;
		})
		.join("\n");
	const gists = result.chapters.map((ch, i) => `[${i + 1}] ${ch.gist}`).join("\n");

	try {
		const res = await complete(fastCfg, {
			system: HIGHLIGHT_SYSTEM,
			prompt: `读者的追踪定义:\n${defs}\n\n内容分段(共 ${result.chapters.length} 段):\n${gists}`,
			json: true,
		});
		const parsed = JSON.parse(res.text) as { hits?: { chapter?: unknown; tracker?: unknown }[] };
		const byKey = new Map(trackers.map((t) => [t.key, t.name]));
		const tracked: Record<string, string> = {};
		for (const hit of parsed.hits ?? []) {
			const idx = Number(hit.chapter);
			const name = typeof hit.tracker === "string" ? byKey.get(hit.tracker) : undefined;
			// 序号越界或 key 不在定义集里的一律丢弃——模型编不出合法命中
			if (Number.isInteger(idx) && idx >= 1 && idx <= result.chapters.length && name) {
				tracked[String(idx - 1)] = name;
			}
		}
		return tracked;
	} catch (err) {
		console.log(`highlight call failed: ${(err as Error).message}`);
		return null; // 模型输出坏了也降级
	}
}

/** 把高亮合并进该用户的结果副本(共享缓存里的原件不动)。 */
export function mergeTracked(result: WatchResult, tracked: Record<string, string>): WatchResult {
	if (Object.keys(tracked).length === 0) return result;
	return {
		...result,
		chapters: result.chapters.map((ch, i) => (tracked[String(i)] ? { ...ch, tracked: tracked[String(i)] } : ch)),
	};
}
