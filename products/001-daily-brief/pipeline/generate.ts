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

import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { parse as parseYaml } from "yaml";
import {
	assembleBrief,
	briefDate,
	buildEditorialPrompt,
	fetchAllSources,
	focusEntryToTracker,
	mockEditorial,
	parseEditorialJson,
} from "../src/shared/pipeline-core.ts";
import type { Filters, FocusEntry, SourceConfig, Tracker } from "../src/shared/pipeline-core.ts";
import { DEFAULT_FILTERS, DEFAULT_SOURCES, DEFAULT_TRACKERS, DEMO_TRACKERS } from "../src/shared/default-sources.ts";
import { complete, resolveProvider } from "../src/shared/ai.ts";
import type { AiConfig } from "../src/shared/ai.ts";

const ROOT = join(dirname(fileURLToPath(import.meta.url)), "..");

function loadDevVars(): void {
	const path = join(ROOT, ".dev.vars");
	if (!existsSync(path)) return;
	for (const line of readFileSync(path, "utf8").split("\n")) {
		const m = line.match(/^\s*([A-Z0-9_]+)\s*=\s*(.*)\s*$/);
		if (m && process.env[m[1]] === undefined) process.env[m[1]] = m[2];
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
		maxOutputTokens: process.env.AI_MAX_OUTPUT_TOKENS ?? "4096",
		deepseekApiKey: process.env.DEEPSEEK_API_KEY,
		anthropicApiKey: process.env.ANTHROPIC_API_KEY,
		gatewayUrl: process.env.AI_GATEWAY_URL,
		gatewayKey: process.env.AI_GATEWAY_KEY,
	};
}

async function main(): Promise<void> {
	loadDevVars();
	const { sources, filters, trackers } = loadConfig();
	const fetched = await fetchAllSources(sources, filters, (m) => console.log(m));
	console.log(
		`[filter] ${fetched.scanned} scanned → ${fetched.candidates.length} candidates (${fetched.ruleDropped.length} rule-dropped, ${fetched.sourcesOk} sources ok)`,
	);
	if (fetched.candidates.length === 0) {
		throw new Error("no candidates survived filtering — check feeds/network before shipping an empty brief");
	}

	// 编辑调用走 shared/ai.ts 的接缝——和 Lambda 生产路径同一段代码,本地拿
	// 真 key 验证的就是生产会用的那条链路(deepseek / anthropic / gateway)。
	const cfg = envAiConfig();
	const provider = resolveProvider(cfg);
	let editorial;
	if (provider === "mock") {
		editorial = mockEditorial(fetched.candidates, trackers);
	} else {
		const { system, user } = buildEditorialPrompt(fetched.candidates, trackers);
		console.log(`[editorial] asking ${provider}/${cfg.model ?? "(default model)"} to pick from ${fetched.candidates.length} candidates…`);
		const result = await complete(cfg, { prompt: user, system, json: true });
		editorial = parseEditorialJson(result.text, trackers);
	}

	const brief = await assembleBrief(editorial, fetched, {
		date: process.env.BRIEF_DATE ?? briefDate(process.env.BRIEF_TZ ?? "America/New_York"),
		sourceCount: fetched.sourcesOk,
		trackers,
	});
	const picked = brief.sections.reduce((n, s) => n + s.items.length, 0);
	console.log(`[assemble] ${picked} items across ${brief.sections.length} sections for ${brief.date}`);

	const outDir = join(ROOT, "pipeline", "out");
	mkdirSync(outDir, { recursive: true });
	const outPath = join(outDir, `brief-${brief.date}.json`);
	writeFileSync(outPath, JSON.stringify(brief, null, "\t"), "utf8");
	console.log(`[write] ${outPath}`);
}

main().catch((err) => {
	console.error("[fatal]", err);
	process.exit(1);
});
