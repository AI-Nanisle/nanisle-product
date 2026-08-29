import assert from "node:assert/strict";
import { createServer, type Server } from "node:http";
import { after, before, describe, it } from "node:test";
import { applyOwnerRoute, complete, ownerRouteFromEnv, stripJsonFence } from "./ai.ts";
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
});

// 假的 Anthropic 兼容网关:按 SDK 的 SSE 协议吐一段文本,或按 MODE 回错误。
// 验的是 complete() 的 SDK 路径——流式、onDelta、json 去围栏、专线失败回退。
describe("complete() via gateway", () => {
	let server: Server;
	let base = "";
	let lastBody: Record<string, unknown> | null = null;
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
				if (prompt.includes("MODE:429")) {
					res.writeHead(429, { "content-type": "application/json" });
					res.end(JSON.stringify({ type: "error", error: { type: "rate_limit_error", message: "limit" } }));
					return;
				}
				const text = prompt.includes("MODE:fenced") ? '```json\n{"ok":true}\n```' : `echo:${prompt}`;
				res.writeHead(200, { "content-type": "text/event-stream" });
				const ev = (type: string, data: Record<string, unknown>) => res.write(`event: ${type}\ndata: ${JSON.stringify({ type, ...data })}\n\n`);
				ev("message_start", { message: { id: "msg_1", type: "message", role: "assistant", model: "claude-test", content: [], stop_reason: null, stop_sequence: null, usage: { input_tokens: 1, output_tokens: 0 } } });
				ev("content_block_start", { index: 0, content_block: { type: "text", text: "" } });
				for (const piece of text.match(/[\s\S]{1,5}/g) ?? []) ev("content_block_delta", { index: 0, delta: { type: "text_delta", text: piece } });
				ev("content_block_stop", { index: 0 });
				ev("message_delta", { delta: { stop_reason: "end_turn", stop_sequence: null }, usage: { output_tokens: 3 } });
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
});
