// The config chat agent: POST /api/chat streams NDJSON events while an LLM
// tool-loop edits sources/focus in KV. Design notes:
// - Stateless: the client sends the visible transcript (plain text turns);
//   the current config is injected fresh into the system prompt each request,
//   so a lost transcript never desyncs anything — KV is the source of truth.
// - Nothing enters the config unverified: add/preview both go through
//   probeFeed (fetch + parse + autodiscovery). The model can only *propose*
//   URLs; only URLs that actually served a feed are persisted or shown.
// - Two write paths on purpose: add_sources for explicit user instructions,
//   preview_sources for the model's own recommendations (rendered as cards,
//   the user clicks 添加 — the confirmation step lives in the UI).

import type Anthropic from "@anthropic-ai/sdk";
import { AiError, makeClient, resolveProvider } from "./ai";
import type { AppEnv } from "./env";
import { SOURCE_CATEGORIES, fnv1a } from "../shared/pipeline-core";
import type { FocusEntry, SourceConfig } from "../shared/pipeline-core";
import {
	MAX_FOCUS,
	MAX_SOURCES,
	cleanFocus,
	getFocus,
	getSources,
	saveFocus,
	saveSources,
} from "./config";
import { probeFeed } from "./feeds";

// ---------- request parsing ----------

export interface ChatTurn {
	role: "user" | "assistant";
	content: string;
}

const MAX_TURNS = 30;
const MAX_TURN_CHARS = 4000;
const MAX_TOOL_ROUNDS = 6;

export function parseChatBody(body: unknown): { messages: ChatTurn[] } | { error: string } {
	const messages = (body as { messages?: unknown })?.messages;
	if (!Array.isArray(messages) || messages.length === 0 || messages.length > MAX_TURNS) {
		return { error: `messages must be a non-empty array (max ${MAX_TURNS})` };
	}
	const cleaned: ChatTurn[] = [];
	for (const m of messages as Record<string, unknown>[]) {
		if (m.role !== "user" && m.role !== "assistant") return { error: "role must be user | assistant" };
		if (typeof m.content !== "string" || !m.content.trim() || m.content.length > MAX_TURN_CHARS) {
			return { error: `every message needs string content (≤${MAX_TURN_CHARS} chars)` };
		}
		cleaned.push({ role: m.role, content: m.content });
	}
	if (cleaned[cleaned.length - 1].role !== "user") return { error: "last message must be from user" };
	return { messages: cleaned };
}

// ---------- tools ----------

const CANDIDATE_SCHEMA = {
	type: "object" as const,
	properties: {
		name: { type: "string", description: "简洁的源名称,用户可读" },
		url: { type: "string", description: "feed URL 或站点主页(会自动做 feed 发现)" },
		category: { type: "string", enum: SOURCE_CATEGORIES },
		reason: { type: "string", description: "一句话:为什么推荐它" },
	},
	required: ["name", "url", "category"],
};

const TOOLS: Anthropic.Tool[] = [
	{
		name: "preview_sources",
		description:
			"试抓验证一批候选源但不写入配置。结果会以卡片呈现给用户,由用户逐个点「添加」或回复确认。凡是你主动推荐(而非用户明确点名)的源都必须先走这里。",
		input_schema: {
			type: "object",
			properties: { candidates: { type: "array", items: CANDIDATE_SCHEMA, maxItems: 6 } },
			required: ["candidates"],
		},
	},
	{
		name: "add_sources",
		description:
			"试抓验证并把通过的源立即写入配置。只用于用户明确要求添加的源(给了具体 URL,或对你的推荐说了「加上/都要」)。返回每个源的验证结果和最新条目标题。",
		input_schema: {
			type: "object",
			properties: {
				sources: {
					type: "array",
					items: {
						type: "object",
						properties: {
							name: { type: "string" },
							url: { type: "string" },
							category: { type: "string", enum: SOURCE_CATEGORIES },
						},
						required: ["name", "url", "category"],
					},
					maxItems: 8,
				},
			},
			required: ["sources"],
		},
	},
	{
		name: "update_sources",
		description: "按 key 修改已有源:启用/停用、改名、改分类、单源条数上限。",
		input_schema: {
			type: "object",
			properties: {
				updates: {
					type: "array",
					items: {
						type: "object",
						properties: {
							key: { type: "string" },
							enabled: { type: "boolean" },
							name: { type: "string" },
							category: { type: "string", enum: SOURCE_CATEGORIES },
							max_items: { type: "number" },
						},
						required: ["key"],
					},
					maxItems: 20,
				},
			},
			required: ["updates"],
		},
	},
	{
		name: "remove_sources",
		description: "按 key 删除源。批量删除且用户指令没有明确点名时,先向用户复述确认再调用。",
		input_schema: {
			type: "object",
			properties: { keys: { type: "array", items: { type: "string" }, maxItems: 50 } },
			required: ["keys"],
		},
	},
	{
		name: "set_focus",
		description:
			"整体替换「当前关注」列表(项目弹药分区靠它选材)。先把当前列表和用户意图合并成完整新列表再调用——这是全量替换,不是追加。",
		input_schema: {
			type: "object",
			properties: {
				focus: {
					type: "array",
					items: {
						type: "object",
						properties: {
							name: { type: "string", description: "关注点名称,≤100 字" },
							detail: { type: "string", description: "具体在做什么、关心什么(给编辑看)" },
						},
						required: ["name"],
					},
					maxItems: MAX_FOCUS,
				},
			},
			required: ["focus"],
		},
	},
];

function buildSystem(sources: SourceConfig[], focus: FocusEntry[]): string {
	const sourceLines = sources
		.map(
			(s) =>
				`- key=${s.key} [${s.category}]${s.enabled === false ? " [已停用]" : ""} ${s.name} — ${s.url}`,
		)
		.join("\n");
	const focusLines = focus.map((f) => `- ${f.name}${f.detail ? `:${f.detail}` : ""}`).join("\n");
	return `你是「每日简报」的配置助理。这份简报每天从用户配置的 RSS/Atom 源抓取内容,由编辑模型选出最多 8 条。你负责通过对话帮用户管理两样东西:信息源列表和「当前关注」列表。

今天是 ${new Date().toISOString().slice(0, 10)}。

# 当前信息源(共 ${sources.length},上限 ${MAX_SOURCES})
${sourceLines || "(空)"}

# 当前关注(共 ${focus.length},上限 ${MAX_FOCUS})
${focusLines || "(空)"}

# 分类
news=新闻 macro=宏观/经济 blog=博客/分析 podcast=播客 paper=论文。headlines 分区主要取 news/macro,ammo 取 blog,learn 取 podcast/paper——给源选分类时想着它的内容最终去哪个分区。

# 常用平台的 RSS 形态(把用户的意图翻译成这些,一切源最终都是一个 feed URL)
- 模糊主题/关键词 → Google News 搜索源(首选,一定抓得通):https://news.google.com/rss/search?q=<关键词>&hl=en-US&gl=US&ceid=US:en (中文内容用 hl=zh-CN&gl=CN&ceid=CN:zh-Hans)
- Hacker News:https://hnrss.org/frontpage?points=100;按关键词 https://hnrss.org/newest?q=<词>&points=50
- Reddit:https://www.reddit.com/r/<sub>/.rss;每周精华 https://www.reddit.com/r/<sub>/top/.rss?t=week
- GitHub 发布:https://github.com/<owner>/<repo>/releases.atom
- YouTube 频道:https://www.youtube.com/feeds/videos.xml?channel_id=<UC…>
- Substack:https://<name>.substack.com/feed;arXiv:https://rss.arxiv.org/rss/<分类>

# 规则
1. 用户明确点名的操作(给了 URL、说了删哪个/停哪个/关注点怎么改)→ 直接调对应工具执行,别啰嗦。
2. 你主动推荐的源 → 必须先 preview_sources 试抓;卡片会呈现给用户,由用户点「添加」或回复确认后你再 add_sources。没验证过的 URL 一个都不许说给用户。
3. 模糊兴趣(如「我想关注 AI 创业」)→ 先给一个 Google News 搜索源,再配 2-3 个你确信存在的具体源,一起 preview。
4. 用户只给了网站主页也没关系,工具会自动做 feed 发现。
5. 批量删除/清空而用户没有明确点名时,先复述你理解的范围让用户确认。
6. 回复短、简体中文、纯文本(不用 markdown 标题和列表符号也能说清)。配置面板就在旁边,别复读完整列表。加完源用最新条目标题一句话说明这个源现在在发什么。
7. 与配置无关的请求,一句话说明你只管配置,拉回正题。`;
}

// ---------- events ----------

export type ChatEvent =
	| { type: "text"; text: string }
	| { type: "tool"; name: string; label: string }
	| { type: "tool_result"; name: string; summary: string }
	| {
			type: "proposal";
			items: {
				name: string;
				url: string;
				category: string;
				reason?: string;
				ok: boolean;
				total?: number;
				fresh?: number;
				latest?: { title: string; publishedAt: string | null }[];
				error?: string;
			}[];
	  }
	| { type: "config"; sources: SourceConfig[]; focus: FocusEntry[] }
	| { type: "notice"; text: string }
	| { type: "error"; error: string }
	| { type: "done" };

type Emit = (ev: ChatEvent) => void;

// ---------- tool execution ----------

interface ChatState {
	sources: SourceConfig[];
	focus: FocusEntry[];
}

function toolLabel(name: string, input: unknown): string {
	const n = (k: string) => (Array.isArray((input as Record<string, unknown[]>)?.[k]) ? (input as Record<string, unknown[]>)[k].length : 0);
	switch (name) {
		case "preview_sources":
			return `试抓验证 ${n("candidates")} 个候选源`;
		case "add_sources":
			return `验证并添加 ${n("sources")} 个源`;
		case "update_sources":
			return `更新 ${n("updates")} 个源`;
		case "remove_sources":
			return `移除 ${n("keys")} 个源`;
		case "set_focus":
			return "更新关注点";
		default:
			return name;
	}
}

interface CandidateInput {
	name?: unknown;
	url?: unknown;
	category?: unknown;
	reason?: unknown;
}

function validCandidate(c: CandidateInput): { name: string; url: string; category: SourceConfig["category"]; reason?: string } | null {
	const name = typeof c.name === "string" ? c.name.trim().slice(0, 100) : "";
	const url = typeof c.url === "string" ? c.url.trim() : "";
	const category = c.category as SourceConfig["category"];
	if (!name || !url || url.length > 500 || !SOURCE_CATEGORIES.includes(category)) return null;
	return { name, url, category, ...(typeof c.reason === "string" ? { reason: c.reason.slice(0, 200) } : {}) };
}

async function execPreview(input: Record<string, unknown>, emit: Emit): Promise<string> {
	const rawCands = Array.isArray(input.candidates) ? (input.candidates as CandidateInput[]).slice(0, 6) : [];
	const cands = rawCands.map(validCandidate).filter((c): c is NonNullable<ReturnType<typeof validCandidate>> => c !== null);
	if (cands.length === 0) return JSON.stringify({ error: "no valid candidates" });
	const probes = await Promise.all(cands.map((c) => probeFeed(c.url)));
	const items: Extract<ChatEvent, { type: "proposal" }>["items"] = cands.map((c, i) => {
		const p = probes[i];
		return {
			name: c.name,
			url: p.ok ? p.url : c.url,
			category: c.category,
			...(c.reason ? { reason: c.reason } : {}),
			ok: p.ok,
			...(p.ok ? { total: p.total, fresh: p.fresh, latest: p.latest?.slice(0, 3) } : { error: p.error }),
		};
	});
	emit({ type: "proposal", items });
	emit({
		type: "tool_result",
		name: "preview_sources",
		summary: `${items.filter((i) => i.ok).length} 通过 / ${items.filter((i) => !i.ok).length} 失败`,
	});
	return JSON.stringify({
		note: "结果已用卡片呈现给用户(含最新条目),等用户点「添加」或回复。不要复述每条内容,一两句话点评即可。",
		results: items.map((i) => ({
			name: i.name,
			url: i.url,
			ok: i.ok,
			...(i.ok ? { fresh: i.fresh, total: i.total } : { error: i.error }),
		})),
	});
}

async function execAdd(env: AppEnv, input: Record<string, unknown>, state: ChatState, emit: Emit): Promise<string> {
	const rawList = Array.isArray(input.sources) ? (input.sources as CandidateInput[]).slice(0, 8) : [];
	const list = rawList.map(validCandidate).filter((c): c is NonNullable<ReturnType<typeof validCandidate>> => c !== null);
	if (list.length === 0) return JSON.stringify({ error: "no valid sources" });
	const probes = await Promise.all(list.map((c) => probeFeed(c.url)));
	const results: Record<string, unknown>[] = [];
	let added = 0;
	for (const [i, c] of list.entries()) {
		const p = probes[i];
		if (!p.ok) {
			results.push({ name: c.name, url: c.url, ok: false, error: `试抓失败:${p.error}` });
			continue;
		}
		const key = fnv1a(p.url);
		if (state.sources.some((s) => s.key === key || s.url === p.url)) {
			results.push({ name: c.name, url: p.url, ok: false, error: "已在配置里" });
			continue;
		}
		if (state.sources.length >= MAX_SOURCES) {
			results.push({ name: c.name, url: p.url, ok: false, error: `源数量已达上限 ${MAX_SOURCES}` });
			continue;
		}
		state.sources.push({ key, name: c.name, url: p.url, category: c.category });
		added++;
		results.push({
			name: c.name,
			url: p.url,
			key,
			ok: true,
			fresh: p.fresh,
			total: p.total,
			latest: p.latest?.slice(0, 3).map((l) => l.title),
			...(p.resolvedFrom ? { note: `从 ${p.resolvedFrom} 自动发现了 feed 地址` } : {}),
		});
	}
	if (added > 0) {
		await saveSources(env, state.sources);
		emit({ type: "config", sources: state.sources, focus: state.focus });
	}
	emit({ type: "tool_result", name: "add_sources", summary: `已添加 ${added} 个,失败 ${results.length - added} 个` });
	return JSON.stringify({ results });
}

async function execUpdate(env: AppEnv, input: Record<string, unknown>, state: ChatState, emit: Emit): Promise<string> {
	const updates = Array.isArray(input.updates) ? (input.updates as Record<string, unknown>[]).slice(0, 20) : [];
	const results: Record<string, unknown>[] = [];
	let touched = 0;
	for (const u of updates) {
		const key = typeof u.key === "string" ? u.key : "";
		const s = state.sources.find((x) => x.key === key);
		if (!s) {
			results.push({ key, ok: false, error: "key 不存在" });
			continue;
		}
		if (typeof u.enabled === "boolean") s.enabled = u.enabled ? undefined : false;
		if (typeof u.name === "string" && u.name.trim()) s.name = u.name.trim().slice(0, 100);
		if (typeof u.category === "string" && SOURCE_CATEGORIES.includes(u.category as SourceConfig["category"])) {
			s.category = u.category as SourceConfig["category"];
		}
		if (typeof u.max_items === "number" && u.max_items >= 1 && u.max_items <= 50) s.max_items = Math.floor(u.max_items);
		touched++;
		results.push({ key, ok: true, now: { name: s.name, category: s.category, enabled: s.enabled !== false } });
	}
	if (touched > 0) {
		await saveSources(env, state.sources);
		emit({ type: "config", sources: state.sources, focus: state.focus });
	}
	emit({ type: "tool_result", name: "update_sources", summary: `更新了 ${touched} 个源` });
	return JSON.stringify({ results });
}

async function execRemove(env: AppEnv, input: Record<string, unknown>, state: ChatState, emit: Emit): Promise<string> {
	const keys = Array.isArray(input.keys) ? (input.keys as unknown[]).filter((k): k is string => typeof k === "string") : [];
	const before = state.sources.length;
	const missing = keys.filter((k) => !state.sources.some((s) => s.key === k));
	state.sources = state.sources.filter((s) => !keys.includes(s.key));
	const removed = before - state.sources.length;
	if (removed > 0) {
		await saveSources(env, state.sources);
		emit({ type: "config", sources: state.sources, focus: state.focus });
	}
	emit({ type: "tool_result", name: "remove_sources", summary: `移除了 ${removed} 个源` });
	return JSON.stringify({ removed, ...(missing.length ? { missingKeys: missing } : {}) });
}

async function execFocus(env: AppEnv, input: Record<string, unknown>, state: ChatState, emit: Emit): Promise<string> {
	const cleaned = cleanFocus(input.focus);
	if ("error" in cleaned) return JSON.stringify({ error: cleaned.error });
	state.focus = cleaned.focus;
	await saveFocus(env, state.focus);
	emit({ type: "config", sources: state.sources, focus: state.focus });
	emit({ type: "tool_result", name: "set_focus", summary: `关注点现有 ${state.focus.length} 条` });
	return JSON.stringify({ ok: true, count: state.focus.length });
}

async function execTool(env: AppEnv, name: string, input: Record<string, unknown>, state: ChatState, emit: Emit): Promise<string> {
	switch (name) {
		case "preview_sources":
			return execPreview(input, emit);
		case "add_sources":
			return execAdd(env, input, state, emit);
		case "update_sources":
			return execUpdate(env, input, state, emit);
		case "remove_sources":
			return execRemove(env, input, state, emit);
		case "set_focus":
			return execFocus(env, input, state, emit);
		default:
			return JSON.stringify({ error: `unknown tool ${name}` });
	}
}

// ---------- the loop ----------

export function chatStream(env: AppEnv, turns: ChatTurn[]): ReadableStream<Uint8Array> {
	const encoder = new TextEncoder();
	return new ReadableStream<Uint8Array>({
		async start(controller) {
			const emit: Emit = (ev) => {
				try {
					controller.enqueue(encoder.encode(`${JSON.stringify(ev)}\n`));
				} catch {
					// client went away mid-stream — keep executing, KV writes must finish
				}
			};
			try {
				await runChat(env, turns, emit);
			} catch (err) {
				if (err instanceof AiError) {
					emit({ type: "error", error: err.message });
				} else {
					console.error("chat: upstream error", err);
					emit({ type: "error", error: "上游 AI 错误,请稍后重试。" });
				}
			} finally {
				emit({ type: "done" });
				try {
					controller.close();
				} catch {
					// already closed
				}
			}
		},
	});
}

async function runChat(env: AppEnv, turns: ChatTurn[], emit: Emit): Promise<void> {
	const provider = resolveProvider(env);
	const state: ChatState = { sources: await getSources(env), focus: await getFocus(env) };

	if (provider === "mock") {
		emit({
			type: "notice",
			text:
				"AI 尚未接入(当前 mock 模式),对话配置暂不可用。旁边的配置面板一切功能照常。接入方法:本地在 .dev.vars 设 AI_PROVIDER=anthropic + ANTHROPIC_API_KEY;线上 wrangler secret put ANTHROPIC_API_KEY 并把 AI_PROVIDER 改为 anthropic 后重新部署。",
		});
		return;
	}

	const client = makeClient(env, provider);
	const model = env.AI_MODEL ?? "claude-opus-5";
	// Tool JSON + replies need room; never let the 1024 default truncate a turn.
	const capRaw = Number.parseInt(env.AI_MAX_OUTPUT_TOKENS ?? "", 10);
	const maxTokens = Number.isFinite(capRaw) && capRaw >= 2048 ? capRaw : 2048;

	const system = buildSystem(state.sources, state.focus);
	const messages: Anthropic.MessageParam[] = turns.map((t) => ({ role: t.role, content: t.content }));

	for (let round = 0; round <= MAX_TOOL_ROUNDS; round++) {
		const message = await client.messages.create({
			model,
			max_tokens: maxTokens,
			system,
			tools: TOOLS,
			messages,
		});
		if (message.stop_reason === "refusal") {
			emit({ type: "error", error: "模型拒绝了这次请求。" });
			return;
		}

		for (const block of message.content) {
			if (block.type === "text" && block.text.trim()) emit({ type: "text", text: block.text });
		}

		const toolUses = message.content.filter((b): b is Anthropic.ToolUseBlock => b.type === "tool_use");
		if (toolUses.length === 0 || message.stop_reason !== "tool_use") return;

		if (round === MAX_TOOL_ROUNDS) {
			emit({ type: "notice", text: "这轮操作步骤太多,已在安全上限处停下。继续对话即可接着做。" });
			return;
		}

		messages.push({ role: "assistant", content: message.content });
		const results: Anthropic.ToolResultBlockParam[] = [];
		for (const tu of toolUses) {
			emit({ type: "tool", name: tu.name, label: toolLabel(tu.name, tu.input) });
			const result = await execTool(env, tu.name, (tu.input ?? {}) as Record<string, unknown>, state, emit);
			results.push({ type: "tool_result", tool_use_id: tu.id, content: result });
		}
		messages.push({ role: "user", content: results });
	}
}
