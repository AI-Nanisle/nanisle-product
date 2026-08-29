/**
 * 本地调试用的生成 CLI —— 生产入口是 lambda.ts(定时全量 + Worker 转调的
 * 立即生成),这里只为在本机快速验证抓取与编辑质量(尤其是换模对照):
 *
 *   npm run generate
 *
 * Config: sources.yaml / focus.yaml when present, otherwise the same
 * defaults the worker seeds from. Output: pipeline/out/brief-<date>.json —
 * 只写文件,不再推送任何远端(旧 /api/ingest 通道已随多用户版退役)。
 */

import { existsSync, mkdirSync, readFileSync, readdirSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { parse as parseYaml } from "yaml";
import {
	SEEN_WINDOW_DAYS,
	applySameStoryMerges,
	assembleBrief,
	briefDate,
	buildEditorialPrompt,
	clusterSameStory,
	dropSeenCandidates,
	enrichBrief,
	fetchAllSources,
	focusEntryToTracker,
	mockEditorial,
	parseEditorialJson,
	seenItemIds,
} from "../src/shared/pipeline-core.ts";
import type { Brief } from "../src/shared/types";
import { fetchArticleTextNode, resolvePickedGoogleUrls } from "./extract.ts";
import type { Filters, FocusEntry, SourceConfig, Tracker } from "../src/shared/pipeline-core.ts";
import { DEFAULT_FILTERS, DEFAULT_SOURCES, DEFAULT_TRACKERS, DEMO_TRACKERS } from "../src/shared/default-sources.ts";
import { complete, resolveProvider } from "../src/shared/ai.ts";
import type { AiConfig } from "../src/shared/ai.ts";

const ROOT = join(dirname(fileURLToPath(import.meta.url)), "..");

function loadDevVars(): void {
	const path = join(ROOT, ".dev.vars");
	if (!existsSync(path)) return;
	for (const line of readFileSync(path, "utf8").split("\n")) {
		const m = line.match(/^\s*([A-Z0-9_]+)\s*=\s*(.*)$/);
		if (!m || process.env[m[1]] !== undefined) continue;
		// 按 dotenv 惯例:去尾部空白;未加引号的值剥掉行内「 #注释」——否则注释
		// 会混进值里(比如进 Authorization 头,fetch 直接抛 ByteString 错)。
		let value = m[2].trim();
		if (!value.startsWith('"') && !value.startsWith("'")) {
			const hash = value.search(/\s#/);
			if (hash >= 0) value = value.slice(0, hash).trim();
		}
		process.env[m[1]] = value;
	}
}

function loadConfig(): { sources: SourceConfig[]; filters: Filters; trackers: Tracker[] } {
	let sources = DEFAULT_SOURCES;
	let filters = DEFAULT_FILTERS;
	const sourcesPath = join(ROOT, "sources.yaml");
	if (existsSync(sourcesPath)) {
		const raw = parseYaml(readFileSync(sourcesPath, "utf8")) as {
			sources: SourceConfig[];
			filters?: Partial<Filters>;
		};
		sources = raw.sources;
		filters = { ...DEFAULT_FILTERS, ...raw.filters };
		console.log(`[config] sources.yaml: ${sources.length} sources`);
	} else {
		console.log(`[config] built-in defaults: ${sources.length} sources`);
	}

	// A legacy focus.yaml still works: entries become plain trackers next to
	// the demo ones. Without one, the shared demo defaults apply. (CLI only —
	// the web app seeds no trackers at all.)
	let trackers = DEFAULT_TRACKERS;
	const focusPath = process.env.FOCUS_FILE
		? join(ROOT, process.env.FOCUS_FILE)
		: existsSync(join(ROOT, "focus.yaml"))
			? join(ROOT, "focus.yaml")
			: existsSync(join(ROOT, "focus.example.yaml"))
				? join(ROOT, "focus.example.yaml")
				: null;
	if (focusPath) {
		const focus = (parseYaml(readFileSync(focusPath, "utf8")) as { focus: FocusEntry[] }).focus ?? [];
		trackers = [...DEMO_TRACKERS, ...focus.map(focusEntryToTracker)];
		console.log(`[config] focus (legacy → trackers): ${focusPath}`);
	}
	return { sources, filters, trackers };
}

function envAiConfig(): AiConfig {
	return {
		provider: process.env.AI_PROVIDER,
		model: process.env.AI_MODEL,
		maxOutputTokens: process.env.AI_MAX_OUTPUT_TOKENS ?? "16384",
		deepseekApiKey: process.env.DEEPSEEK_API_KEY,
		anthropicApiKey: process.env.ANTHROPIC_API_KEY,
		gatewayUrl: process.env.AI_GATEWAY_URL,
		gatewayKey: process.env.AI_GATEWAY_KEY,
	};
}

/** 成稿段换模开关,和 lambda.ts 同一组变量——本地对照的就是生产会用的开关。 */
function envEnrichAiConfig(base: AiConfig): AiConfig {
	const provider = process.env.ENRICH_AI_PROVIDER;
	const model = process.env.ENRICH_AI_MODEL;
	if (!provider && !model) return base;
	return {
		...base,
		...(provider ? { provider } : {}),
		...(model ? { model } : {}),
		...(process.env.ENRICH_AI_MAX_OUTPUT_TOKENS ? { maxOutputTokens: process.env.ENRICH_AI_MAX_OUTPUT_TOKENS } : {}),
	};
}

/** 本地防重复:pipeline/out 里近几天的简报就是「已推荐过」的账本。 */
function localSeenBriefs(outDir: string, today: string): Brief[] {
	if (!existsSync(outDir)) return [];
	const cutoff = new Date(Date.now() - SEEN_WINDOW_DAYS * 86_400_000).toISOString().slice(0, 10);
	const briefs: Brief[] = [];
	for (const f of readdirSync(outDir)) {
		const m = /^brief-(\d{4}-\d{2}-\d{2})\.json$/.exec(f);
		if (!m || m[1] < cutoff || m[1] === today) continue;
		try {
			briefs.push(JSON.parse(readFileSync(join(outDir, f), "utf8")) as Brief);
		} catch {
			// 手改坏的旧文件不挡今天的生成
		}
	}
	return briefs;
}

async function main(): Promise<void> {
	loadDevVars();
	const date = process.env.BRIEF_DATE ?? briefDate(process.env.BRIEF_TZ ?? "America/New_York");
	const outDir = join(ROOT, "pipeline", "out");
	const { sources, filters, trackers } = loadConfig();
	const fetched = await fetchAllSources(sources, filters, (m) => console.log(m));
	console.log(
		`[filter] ${fetched.scanned} scanned → ${fetched.candidates.length} candidates (${fetched.ruleDropped.length} rule-dropped, ${fetched.sourcesOk} sources ok)`,
	);
	const seenDropped = dropSeenCandidates(fetched, seenItemIds(localSeenBriefs(outDir, date)));
	if (seenDropped > 0) console.log(`[seen] ${seenDropped} 条近期已入选,不重复推荐`);
	if (fetched.candidates.length === 0) {
		throw new Error("no candidates survived filtering — check feeds/network before shipping an empty brief");
	}

	// 编辑调用走 shared/ai.ts 的接缝——和 Lambda 生产路径同一段代码,本地拿
	// 真 key 验证的就是生产会用的那条链路(deepseek / anthropic / gateway)。
	// 同事件归簇(和 Lambda 同一套):主报道进提示词,其余选中后并回 merged
	const { primaries, mergedByPrimary } = clusterSameStory(fetched.candidates);
	if (primaries.length < fetched.candidates.length) {
		console.log(`[cluster] ${fetched.candidates.length} 条候选并成 ${primaries.length} 条`);
	}

	const cfg = envAiConfig();
	const provider = resolveProvider(cfg);
	let editorial;
	if (provider === "mock") {
		editorial = mockEditorial(primaries, trackers);
	} else {
		const { system, user } = buildEditorialPrompt(primaries, trackers);
		console.log(`[editorial] asking ${provider}/${cfg.model ?? "(default model)"} to pick from ${primaries.length} candidates…`);
		const result = await complete(cfg, { prompt: user, system, json: true });
		editorial = parseEditorialJson(result.text, trackers);
	}
	applySameStoryMerges(editorial, mergedByPrimary);

	// 入选条目的 Google News 跳转链换成原文 URL(和 Lambda 同一段逻辑)
	const pickedIds = new Set([
		...Object.values(editorial.sections).flat().flatMap((p) => [p.id, ...(p.merged ?? [])]),
		...(editorial.offAxis ? [editorial.offAxis.id] : []),
	]);
	await resolvePickedGoogleUrls(fetched.candidates, pickedIds, (m) => console.log(m));
	const brief = await assembleBrief(editorial, fetched, {
		date,
		sourceCount: fetched.sourcesOk,
		trackers,
	});
	const picked = brief.sections.reduce((n, s) => n + s.items.length, 0);
	console.log(`[assemble] ${picked} items across ${brief.sections.length} sections for ${brief.date}`);

	// 第二段 · 成稿:和 Lambda 同一段共享代码 + 同一组 ENRICH_* 开关,本地对照
	// deepseek 与 claude 在成稿上的差别,看的就是生产会跑的那条链路。
	const enrichCfg = envEnrichAiConfig(cfg);
	if (resolveProvider(enrichCfg) !== "mock") {
		await enrichBrief(
			brief,
			fetched,
			trackers,
			(system, user) =>
				complete(enrichCfg, { prompt: user, system, json: true }).then((r) => {
					console.log(`[enrich] via ${r.provider}/${r.model}`);
					return r.text;
				}),
			(m) => console.log(m),
			fetchArticleTextNode,
		);
	}

	mkdirSync(outDir, { recursive: true });
	const outPath = join(outDir, `brief-${brief.date}.json`);
	writeFileSync(outPath, JSON.stringify(brief, null, "\t"), "utf8");
	console.log(`[write] ${outPath}`);
}

main().catch((err) => {
	console.error("[fatal]", err);
	process.exit(1);
});
