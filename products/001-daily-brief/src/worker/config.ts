// Config storage + validation, shared by the REST handlers (PUT /api/sources,
// PUT /api/focus) and the chat agent's tools — one set of rules, two entrances.

import { SOURCE_CATEGORIES, fnv1a } from "../shared/pipeline-core";
import type { FocusEntry, SourceConfig } from "../shared/pipeline-core";
import { DEFAULT_FOCUS, DEFAULT_SOURCES } from "../shared/default-sources";
import type { AppEnv } from "./env";

export const MAX_SOURCES = 50;
export const MAX_FOCUS = 20;

export async function getSources(env: AppEnv): Promise<SourceConfig[]> {
	const raw = await env.BRIEFS.get("config:sources");
	if (raw) return JSON.parse(raw) as SourceConfig[];
	return DEFAULT_SOURCES;
}

export async function getFocus(env: AppEnv): Promise<FocusEntry[]> {
	const raw = await env.BRIEFS.get("config:focus");
	if (raw) return JSON.parse(raw) as FocusEntry[];
	return DEFAULT_FOCUS;
}

export async function saveSources(env: AppEnv, sources: SourceConfig[]): Promise<void> {
	await env.BRIEFS.put("config:sources", JSON.stringify(sources));
}

export async function saveFocus(env: AppEnv, focus: FocusEntry[]): Promise<void> {
	await env.BRIEFS.put("config:focus", JSON.stringify(focus));
}

export function cleanSources(raw: unknown): { sources: SourceConfig[] } | { error: string } {
	if (!Array.isArray(raw) || raw.length > MAX_SOURCES) {
		return { error: `sources must be an array (max ${MAX_SOURCES})` };
	}
	const cleaned: SourceConfig[] = [];
	for (const [i, s] of (raw as Record<string, unknown>[]).entries()) {
		const name = typeof s.name === "string" ? s.name.trim() : "";
		const url = typeof s.url === "string" ? s.url.trim() : "";
		const category = s.category as SourceConfig["category"];
		if (!name || name.length > 100) return { error: `source #${i + 1}: name required (≤100 chars)` };
		if (!/^https?:\/\/\S+$/.test(url) || url.length > 500) return { error: `source #${i + 1}: url must be http(s)` };
		if (!SOURCE_CATEGORIES.includes(category)) return { error: `source #${i + 1}: bad category` };
		const maxItems =
			typeof s.max_items === "number" && s.max_items >= 1 && s.max_items <= 50 ? Math.floor(s.max_items) : undefined;
		cleaned.push({
			key: typeof s.key === "string" && s.key ? s.key.slice(0, 64) : fnv1a(url),
			name,
			url,
			category,
			enabled: s.enabled === false ? false : undefined,
			...(maxItems ? { max_items: maxItems } : {}),
		});
	}
	return { sources: cleaned };
}

export function cleanFocus(raw: unknown): { focus: FocusEntry[] } | { error: string } {
	if (!Array.isArray(raw) || raw.length > MAX_FOCUS) {
		return { error: `focus must be an array (max ${MAX_FOCUS})` };
	}
	const cleaned: FocusEntry[] = [];
	for (const f of raw as Record<string, unknown>[]) {
		const name = typeof f.name === "string" ? f.name.trim() : "";
		if (!name || name.length > 100) return { error: "every focus entry needs a name (≤100 chars)" };
		const detail = typeof f.detail === "string" ? f.detail.trim().slice(0, 500) : undefined;
		cleaned.push({ name, ...(detail ? { detail } : {}) });
	}
	return { focus: cleaned };
}
