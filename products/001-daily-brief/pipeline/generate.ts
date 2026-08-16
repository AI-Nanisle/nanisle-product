/**
 * CLI wrapper around the shared generation core (src/shared/pipeline-core.ts).
 * The web UI's POST /api/generate is the primary path; this CLI exists for
 * local runs, cron on a VM, or CI:
 *
 *   npm run generate
 *
 * Config: sources.yaml / focus.yaml when present, otherwise the same
 * defaults the worker seeds from. Output: pipeline/out/brief-<date>.json,
 * plus POST /api/ingest when INGEST_URL + INGEST_TOKEN are set.
 */

import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { parse as parseYaml } from "yaml";
import Anthropic from "@anthropic-ai/sdk";
import type { Brief } from "../src/shared/types.ts";
import {
	USER_AGENT,
	assembleBrief,
	briefDate,
	buildEditorialPrompt,
	fetchAllSources,
	mockEditorial,
	parseEditorialJson,
} from "../src/shared/pipeline-core.ts";
import type { Filters, FocusEntry, SourceConfig } from "../src/shared/pipeline-core.ts";
import { DEFAULT_FILTERS, DEFAULT_FOCUS, DEFAULT_SOURCES } from "../src/shared/default-sources.ts";

const ROOT = join(dirname(fileURLToPath(import.meta.url)), "..");

function loadDevVars(): void {
	const path = join(ROOT, ".dev.vars");
	if (!existsSync(path)) return;
	for (const line of readFileSync(path, "utf8").split("\n")) {
		const m = line.match(/^\s*([A-Z0-9_]+)\s*=\s*(.*)\s*$/);
		if (m && process.env[m[1]] === undefined) process.env[m[1]] = m[2];
	}
}

function loadConfig(): { sources: SourceConfig[]; filters: Filters; focus: FocusEntry[] } {
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

	let focus = DEFAULT_FOCUS;
	const focusPath = process.env.FOCUS_FILE
		? join(ROOT, process.env.FOCUS_FILE)
		: existsSync(join(ROOT, "focus.yaml"))
			? join(ROOT, "focus.yaml")
			: existsSync(join(ROOT, "focus.example.yaml"))
				? join(ROOT, "focus.example.yaml")
				: null;
	if (focusPath) {
		focus = (parseYaml(readFileSync(focusPath, "utf8")) as { focus: FocusEntry[] }).focus ?? [];
		console.log(`[config] focus: ${focusPath}`);
	}
	return { sources, filters, focus };
}

async function llmEditorial(candidates: Parameters<typeof buildEditorialPrompt>[0], focus: FocusEntry[]) {
	const provider = (process.env.AI_PROVIDER ?? "mock").toLowerCase();
	const model = process.env.AI_MODEL ?? "claude-opus-5";
	let client: Anthropic;
	if (provider === "gateway") {
		if (!process.env.AI_GATEWAY_URL || !process.env.AI_GATEWAY_KEY) {
			throw new Error("gateway mode needs AI_GATEWAY_URL and AI_GATEWAY_KEY");
		}
		client = new Anthropic({ baseURL: process.env.AI_GATEWAY_URL, authToken: process.env.AI_GATEWAY_KEY });
	} else {
		if (!process.env.ANTHROPIC_API_KEY) {
			throw new Error("anthropic mode needs ANTHROPIC_API_KEY (or use AI_PROVIDER=mock)");
		}
		client = new Anthropic({ apiKey: process.env.ANTHROPIC_API_KEY });
	}

	const { system, user } = buildEditorialPrompt(candidates, focus);
	console.log(`[editorial] asking ${model} to pick from ${candidates.length} candidates…`);
	const message = await client.messages.create({
		model,
		max_tokens: 4096,
		system,
		messages: [{ role: "user", content: user }],
	});
	if (message.stop_reason === "refusal") throw new Error("model declined the editorial request");
	const raw = message.content
		.filter((b) => b.type === "text")
		.map((b) => b.text)
		.join("");
	return parseEditorialJson(raw);
}

async function pushToWorker(brief: Brief): Promise<void> {
	const url = process.env.INGEST_URL;
	const token = process.env.INGEST_TOKEN;
	if (!url || !token) {
		console.log("[push] INGEST_URL/INGEST_TOKEN not set — skipping push (file output only)");
		return;
	}
	const res = await fetch(`${url.replace(/\/$/, "")}/api/ingest`, {
		method: "POST",
		headers: { "content-type": "application/json", "x-ingest-token": token, "user-agent": USER_AGENT },
		body: JSON.stringify(brief),
		signal: AbortSignal.timeout(30_000),
	});
	if (!res.ok) throw new Error(`ingest failed: HTTP ${res.status} ${await res.text()}`);
	console.log(`[push] ingested to ${url} (${brief.date})`);
}

async function main(): Promise<void> {
	loadDevVars();
	const { sources, filters, focus } = loadConfig();
	const fetched = await fetchAllSources(sources, filters, (m) => console.log(m));
	console.log(
		`[filter] ${fetched.scanned} scanned → ${fetched.candidates.length} candidates (${fetched.ruleDropped.length} rule-dropped, ${fetched.sourcesOk} sources ok)`,
	);
	if (fetched.candidates.length === 0) {
		throw new Error("no candidates survived filtering — check feeds/network before shipping an empty brief");
	}

	const provider = (process.env.AI_PROVIDER ?? "mock").toLowerCase();
	const editorial =
		provider === "mock" ? mockEditorial(fetched.candidates) : await llmEditorial(fetched.candidates, focus);

	const brief = await assembleBrief(editorial, fetched, {
		date: process.env.BRIEF_DATE ?? briefDate(process.env.BRIEF_TZ ?? "America/New_York"),
		sourceCount: fetched.sourcesOk,
	});
	const picked = brief.sections.reduce((n, s) => n + s.items.length, 0);
	console.log(`[assemble] ${picked} items across ${brief.sections.length} sections for ${brief.date}`);

	const outDir = join(ROOT, "pipeline", "out");
	mkdirSync(outDir, { recursive: true });
	const outPath = join(outDir, `brief-${brief.date}.json`);
	writeFileSync(outPath, JSON.stringify(brief, null, "\t"), "utf8");
	console.log(`[write] ${outPath}`);

	await pushToWorker(brief);
}

main().catch((err) => {
	console.error("[fatal]", err);
	process.exit(1);
});
