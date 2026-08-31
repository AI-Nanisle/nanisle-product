import assert from "node:assert/strict";
import { createServer, type Server } from "node:http";
import { after, before, describe, it } from "node:test";
import { applyOwnerRoute, complete, extractJsonText, ownerRouteFromEnv, stripJsonFence } from "./ai.ts";
import type { AiConfig } from "./ai.ts";

describe("ownerRouteFromEnv", () => {
	it("is null without OWNER_AI_EMAILS (fork zero-config)", () => {
		assert.equal(ownerRouteFromEnv({}), null);
		assert.equal(ownerRouteFromEnv({ OWNER_AI_PROVIDER: "gateway" }), null);
	});
	it("parses emails case-insensitively and only the fields that are set", () => {
		const r = ownerRouteFromEnv({
			OWNER_AI_EMAILS: " Owner@Example.com , second@example.com ",
			OWNER_AI_PROVIDER: "gateway",
			OWNER_AI_MODEL: "opus",
			OWNER_FAST_AI_MODEL: "sonnet",
			OWNER_AI_GATEWAY_URL: "https://gw.example",
			OWNER_AI_GATEWAY_KEY: "k",
		});
		assert.deepEqual(r?.emails, ["owner@example.com", "second@example.com"]);
		assert.deepEqual(r?.cfg, { provider: "gateway", model: "opus", gatewayUrl: "https://gw.example", gatewayKey: "k" });
		assert.equal(r?.fastModel, "sonnet");
	});
});

describe("applyOwnerRoute", () => {
	const base: AiConfig = { provider: "deepseek", model: "deepseek-v4-pro", deepseekApiKey: "d", maxOutputTokens: "16384" };
	const route = ownerRouteFromEnv({
		OWNER_AI_EMAILS: "owner@example.com",
		OWNER_AI_PROVIDER: "gateway",
		OWNER_AI_MODEL: "opus",
		OWNER_FAST_AI_MODEL: "sonnet",
		OWNER_AI_GATEWAY_URL: "https://gw.example",
		OWNER_AI_GATEWAY_KEY: "k",
	});
	it("leaves other users untouched", () => {
		assert.equal(applyOwnerRoute("someone@example.com", base, route), base);
		assert.equal(applyOwnerRoute(undefined, base, route), base);
		assert.equal(applyOwnerRoute("owner@example.com", base, null), base);
	});
	it("routes the owner to the gateway and keeps the base as fallback", () => {
		const c = applyOwnerRoute("Owner@Example.com", base, route);
		assert.equal(c.provider, "gateway");
		assert.equal(c.model, "opus");
		assert.equal(c.gatewayUrl, "https://gw.example");
		assert.equal(c.maxOutputTokens, "16384"); // 没覆盖的字段跟 base
		assert.equal(c.fallback, base);
	});
	it("fast tier swaps in the fast model after fastVariant already ran", () => {
		const fastBase: AiConfig = { ...base, model: "deepseek-v4-flash" };
		const c = applyOwnerRoute("owner@example.com", fastBase, route, "fast");
		assert.equal(c.provider, "gateway");
		assert.equal(c.model, "sonnet");
		assert.equal(c.fallback?.model, "deepseek-v4-flash");
	});
});

describe("stripJsonFence", () => {
	it("strips ```json fences and leaves bare JSON alone", () => {
		assert.equal(stripJsonFence('```json\n{"a":1}\n```'), '{"a":1}');
		assert.equal(stripJsonFence('  ```\n{"a":1}\n```  '), '{"a":1}');
		assert.equal(stripJsonFence('{"a":1}'), '{"a":1}');
		assert.equal(stripJsonFence('text ```json\n{}\n``` more'), 'text ```json\n{}\n``` more');
	});
	it("keeps a fence that appears inside the JSON body", () => {
		assert.equal(stripJsonFence('```json\n{"a":"see ```x```"}\n```'), '{"a":"see ```x```"}');
	});
	it("recovers the body of a fence that was truncated before it closed", () => {
		// max_tokens 截断的典型形状:开了围栏没闭合
		assert.equal(stripJsonFence('```json\n{"a":1}'), '{"a":1}');
	});
	it("is linear on an unclosed fence with a long whitespace tail (ReDoS 回归)", () => {
		// 旧的正则版在这里会灾难性回溯:1KB 换行约 1.8 秒,8KB 超过 100 秒。
		const evil = "```json\n" + "\n".repeat(20_000);
		const t0 = performance.now();
		stripJsonFence(evil);
		const ms = performance.now() - t0;
		assert.ok(ms < 100, `stripJsonFence took ${ms.toFixed(0)}ms on 20k newlines — 回溯又回来了`);
	});
});

describe("extractJsonText", () => {
	it("takes bare JSON and fenced JSON as-is", () => {
		assert.equal(extractJsonText('{"a":1}'), '{"a":1}');
		assert.equal(extractJsonText('```json\n{"a":1}\n```'), '{"a":1}');
	});
	it("salvages JSON wrapped in prose — the 2026-08-30 失败形态", () => {
		// stripJsonFence 只认「整段以围栏开头」,前面多一句话它就原样放行
		assert.equal(extractJsonText('好的,我看完了:\n{"a":1}'), '{"a":1}');
		assert.equal(extractJsonText('{"a":1}\n\n以上就是全部内容。'), '{"a":1}');
		assert.equal(extractJsonText('前言\n```json\n{"a":1}\n```\n后记'), '{"a":1}');
	});
	it("returns null when there is no parsable object", () => {
		assert.equal(extractJsonText("完全不是 JSON"), null);
		assert.equal(extractJsonText('{"a":'), null); // 半截
		assert.equal(extractJsonText(""), null);
	});
});

// 假的 Anthropic 兼容网关:按 SDK 的 SSE 协议吐一段文本,或按 MODE 回错误。
// 验的是 complete() 的 SDK 路径——流式、onDelta、json 去围栏、专线失败回退。
describe("complete() via gateway", () => {
	let server: Server;
	let base = "";
	let lastBody: Record<string, unknown> | null = null;
	let calls = 0;
	before(async () => {
		server = createServer((req, res) => {
			let raw = "";
			req.on("data", (c) => (raw += c));
			req.on("end", () => {
				const body = JSON.parse(raw) as Record<string, any>;
				lastBody = body;
				const prompt = body.messages[0].content as string;
				if (prompt.includes("MODE:500")) {
					res.writeHead(500, { "content-type": "application/json" });
					res.end(JSON.stringify({ type: "error", error: { type: "api_error", message: "upstream error" } }));
					return;
				}
				if (prompt.includes("MODE:400") || prompt.includes("MODE:401")) {
					const code = prompt.includes("MODE:400") ? 400 : 401;
					res.writeHead(code, { "content-type": "application/json" });
					res.end(JSON.stringify({ type: "error", error: { type: "invalid_request_error", message: "nope" } }));
					return;
				}
				if (prompt.includes("MODE:429")) {
					res.writeHead(429, { "content-type": "application/json" });
					res.end(JSON.stringify({ type: "error", error: { type: "rate_limit_error", message: "limit" } }));
					return;
				}
				const text = prompt.includes("MODE:fenced")
					? '```json\n{"ok":true}\n```'
					: prompt.includes("MODE:preamble")
						? '好的,我看完了:\n{"ok":true}'
						: prompt.includes("MODE:garbage")
							? "这不是 JSON,一个花括号都没有。"
							: `echo:${prompt}`;
				const stopReason = prompt.includes("MODE:maxtokens") ? "max_tokens" : "end_turn";
				calls++;
				res.writeHead(200, { "content-type": "text/event-stream" });
				const ev = (type: string, data: Record<string, unknown>) => res.write(`event: ${type}\ndata: ${JSON.stringify({ type, ...data })}\n\n`);
				ev("message_start", { message: { id: "msg_1", type: "message", role: "assistant", model: "claude-test", content: [], stop_reason: null, stop_sequence: null, usage: { input_tokens: 1, output_tokens: 0 } } });
				ev("content_block_start", { index: 0, content_block: { type: "text", text: "" } });
				for (const piece of text.match(/[\s\S]{1,5}/g) ?? []) ev("content_block_delta", { index: 0, delta: { type: "text_delta", text: piece } });
				ev("content_block_stop", { index: 0 });
				ev("message_delta", { delta: { stop_reason: stopReason, stop_sequence: null }, usage: { output_tokens: 3 } });
				ev("message_stop", {});
				res.end();
			});
		});
		await new Promise<void>((r) => server.listen(0, "127.0.0.1", r));
		base = `http://127.0.0.1:${(server.address() as { port: number }).port}`;
	});
	after(() => {
		server.closeAllConnections();
		server.close();
	});

	const gw = (): AiConfig => ({ provider: "gateway", model: "opus", gatewayUrl: base, gatewayKey: "k", maxOutputTokens: "256" });

	it("streams and reports deltas, returns the assembled text", async () => {
		const deltas: string[] = [];
		const r = await complete(gw(), { prompt: "hello", system: "S", onDelta: (d) => deltas.push(d) });
		assert.equal(r.provider, "gateway");
		assert.equal(r.model, "claude-test");
		assert.equal(r.text, "echo:hello");
		assert.equal(deltas.join(""), "echo:hello");
		assert.equal(lastBody?.stream, true);
		assert.equal(lastBody?.system, "S");
	});
	it("json mode appends the JSON-only hint and strips fences", async () => {
		const r = await complete(gw(), { prompt: "MODE:fenced", system: "S", json: true });
		assert.equal(r.text, '{"ok":true}');
		assert.match(String(lastBody?.system), /^S\n\n.*JSON/);
	});
	it("falls back to the base config on upstream 5xx / 429 when a fallback is present", async () => {
		const mockBase: AiConfig = { provider: "mock" };
		const routed: AiConfig = { ...gw(), fallback: mockBase };
		const r1 = await complete(routed, { prompt: "MODE:500" });
		assert.equal(r1.provider, "mock");
		const r2 = await complete(routed, { prompt: "MODE:429" });
		assert.equal(r2.provider, "mock");
	});
	it("does not fall back without a fallback config", async () => {
		await assert.rejects(complete(gw(), { prompt: "MODE:500" }));
	});
	it("does NOT fall back on 4xx — a misconfigured lane must surface, not double-bill", async () => {
		// 模型别名网关不认(400)、虚拟 key 被吊销(401):换一家只会把同一个错再犯
		// 一遍,还双倍计费,而且故障被重试盖住没人发现。
		const routed: AiConfig = { ...gw(), fallback: { provider: "mock" } };
		await assert.rejects(complete(routed, { prompt: "MODE:400" }));
		await assert.rejects(complete(routed, { prompt: "MODE:401" }));
	});

	// ---- 2026-08-30 事故:网关 200 + end_turn,产出却不是裸 JSON ----

	it("salvages JSON that came wrapped in prose", async () => {
		const r = await complete(gw(), { prompt: "MODE:preamble", system: "S", json: true });
		assert.equal(r.text, '{"ok":true}');
	});
	it("retries once in place when the output is unparsable and there is no fallback", async () => {
		calls = 0;
		await assert.rejects(complete(gw(), { prompt: "MODE:garbage", system: "S", json: true }));
		assert.equal(calls, 2, "应当原地重来一次再放弃");
	});
	it("falls back on unparsable output — 专线吐坏一次不该让整单失败", async () => {
		const routed: AiConfig = { ...gw(), fallback: { provider: "mock" } };
		const r = await complete(routed, { prompt: "MODE:garbage", system: "S", json: true });
		assert.equal(r.provider, "mock");
	});
	it("treats stop_reason=max_tokens as a failure, not as a short answer", async () => {
		// 半截 JSON 以前会被当成功放行,到 parseResult 才炸,报错还甩锅给模型
		await assert.rejects(complete(gw(), { prompt: "MODE:maxtokens", system: "S" }), /max_tokens/);
	});
	it("does not police non-json calls", async () => {
		const r = await complete(gw(), { prompt: "MODE:garbage", system: "S" });
		assert.equal(r.text, "这不是 JSON,一个花括号都没有。");
	});
});
