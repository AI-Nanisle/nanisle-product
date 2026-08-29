// 订阅模式 · 发现新内容(docs/05 §3.1/§3.3;SQS {kind:"discover"} 消息的处理)。
//
// 为什么在 Lambda 而不是 Worker:B站只有 APP 端接口能稳定过,且从数据中心 IP
// 能否直连未验证;YouTube RSS 从 CF 出口有零散被拦案例;住宅代理只在这里。
// 三个平台一条路:YouTube UULF RSS / B站 archive/cursor + APP 签名 / 播客 RSS,
// 抓完把候选整包 POST 回 Worker 的 /api/queue/candidates,挑选在 Worker 做。
//
// 请求走 curl 而不是 fetch:Node 的 fetch 不认 PROXY_URL,而 curl 和 yt-dlp
// 一样是镜像里现成的;播客 RSS 直连省代理流量。

import { spawn } from "node:child_process";
import {
	BROWSER_UA,
	biliArchiveUrl,
	parseBiliArchive,
	parsePodcastFeed,
	parseYoutubeFeed,
	youtubeUploadsFeedUrl,
} from "../../src/shared/discover";
import type { Candidate, SubPlatform } from "../../src/shared/discover";
import type { CallbackConfig } from "./callbacks";

export interface DiscoverMessage {
	kind: "discover";
	email: string;
	date: string;
	subs: { platform: SubPlatform; id: string; title?: string }[];
}

export interface DiscoverConfig extends CallbackConfig {
	proxyUrl?: string;
}

function run(cmd: string, args: string[], timeoutMs: number): Promise<string> {
	return new Promise((resolve, reject) => {
		const child = spawn(cmd, args, { stdio: ["ignore", "pipe", "pipe"] });
		let out = "";
		let err = "";
		const timer = setTimeout(() => {
			child.kill();
			reject(new Error(`${cmd} 超时(${timeoutMs / 1000}s)`));
		}, timeoutMs);
		child.stdout.on("data", (d) => (out += d));
		child.stderr.on("data", (d) => (err += d));
		child.on("error", (e) => {
			clearTimeout(timer);
			reject(e);
		});
		child.on("close", (code) => {
			clearTimeout(timer);
			if (code === 0) resolve(out);
			else reject(new Error(`${cmd} exit ${code}: ${err.slice(-300)}`));
		});
	});
}

/** GET 文本;proxied=true 且配了代理就走代理。 */
async function get(cfg: DiscoverConfig, url: string, proxied: boolean): Promise<string> {
	const proxy = proxied && cfg.proxyUrl ? ["--proxy", cfg.proxyUrl] : [];
	return run("curl", ["-sS", "-L", "--max-time", "30", "-A", BROWSER_UA, ...proxy, url], 40_000);
}

/** YouTube RSS 没有时长:对最新的几条用 yt-dlp 补(经代理,约 2 秒一条)。 */
async function fillYoutubeDurations(cfg: DiscoverConfig, items: Candidate[], limit: number): Promise<void> {
	const fresh = items
		.filter((c) => !c.excluded && Date.now() - c.publishedAt < 48 * 3600 * 1000)
		.sort((a, b) => b.publishedAt - a.publishedAt)
		.slice(0, limit);
	for (const c of fresh) {
		try {
			const proxy = cfg.proxyUrl ? ["--proxy", cfg.proxyUrl] : [];
			const out = await run("yt-dlp", [...proxy, "--no-warnings", "--skip-download", "--print", "%(duration)s\t%(live_status)s", c.url], 60_000);
			const [d, live] = out.trim().split("\t");
			if (Number(d)) c.durationSec = Number(d);
			if (live && live !== "not_live" && live !== "NA" && live !== "was_live") c.excluded = `live:${live}`;
		} catch (err) {
			console.log(`duration probe failed ${c.id}: ${(err as Error).message.slice(-120)}`);
		}
	}
}

export async function processDiscover(msg: DiscoverMessage, cfg: DiscoverConfig): Promise<void> {
	const items: (Candidate & { subKey: string })[] = [];
	const sources: Record<string, string> = {};
	for (const [i, sub] of msg.subs.entries()) {
		const key = `${sub.platform}:${sub.id}`;
		// 礼貌间隔:B站每 UP ≥2 秒、不并发(docs/05 §3.4)
		if (i > 0) await new Promise((r) => setTimeout(r, 2000));
		try {
			let found: Candidate[] = [];
			if (sub.platform === "youtube") {
				found = parseYoutubeFeed(await get(cfg, youtubeUploadsFeedUrl(sub.id), true)).items;
				await fillYoutubeDurations(cfg, found, 3);
			} else if (sub.platform === "bilibili") {
				const parsed = parseBiliArchive(JSON.parse(await get(cfg, await biliArchiveUrl(sub.id), true)));
				if (parsed.error) throw new Error(parsed.error);
				found = parsed.items;
			} else {
				found = parsePodcastFeed(await get(cfg, sub.id, false)).items;
			}
			items.push(...found.map((c) => ({ ...c, subKey: key })));
			sources[key] = `ok:${found.length}`;
		} catch (err) {
			sources[key] = `error:${(err as Error).message.slice(0, 160)}`;
			console.error(`discover ${key} failed: ${(err as Error).message.slice(0, 200)}`);
		}
	}
	console.log(`discover ${msg.email} ${msg.date}: ${items.length} candidates from ${msg.subs.length} subs ${JSON.stringify(sources)}`);
	const res = await fetch(`${cfg.workerBase}/api/queue/candidates`, {
		method: "POST",
		headers: { "content-type": "application/json", "x-consumer-token": cfg.consumerToken },
		body: JSON.stringify({ email: msg.email, date: msg.date, items, sources }),
	});
	const text = await res.text();
	if (!res.ok) throw new Error(`candidates ${res.status}: ${text.slice(0, 200)}`);
	console.log(`candidates posted: ${text.slice(0, 120)}`);
}
