// B6/B7 · AI 接缝(docs/02-技术方案.md §6)。原在 src/worker/ai.ts,挪进 shared
// 是因为 Lambda 的编辑调用也走这里——和 pipeline-core 一样保持运行时无关,
// 入参从 Worker 的 AppEnv 改成普通 config 对象(Worker 侧由 env.ts 适配)。
//
// 四个模式:deepseek(生产默认,OpenAI 兼容 API 直连,不引第二个 SDK)、
// mock(零配置演示/fork 首跑)、anthropic / gateway(换模对照的退路)。
// 换供应商是配置变更,不是代码变更——这是接缝存在的意义。

import Anthropic from "@anthropic-ai/sdk";

export type AiProvider = "mock" | "deepseek" | "anthropic" | "gateway";

/** Error safe to surface to clients (message contains no upstream details). */
export class AiError extends Error {
	readonly status: number;
	constructor(message: string, status = 502) {
		super(message);
		this.status = status;
	}
}

/** 运行时无关的 AI 配置。Worker 用 aiConfig(env) 适配,Lambda 直接从 process.env 拼。 */
export interface AiConfig {
	provider?: string;
	model?: string;
	maxOutputTokens?: string;
	deepseekApiKey?: string;
	anthropicApiKey?: string;
	gatewayUrl?: string;
	gatewayKey?: string;
}

export function resolveProvider(cfg: AiConfig): AiProvider {
	const p = (cfg.provider ?? "deepseek").toLowerCase();
	if (p === "deepseek") {
		// 默认档没配 key 时落回 mock 而不是报错:公开仓的零配置规矩(fork 首跑
		// 必须能走通全流程)优先。配错的托管实例会在产出里看到 [mock] 前缀、
		// /api/health 里看到 provider=mock——故障是响的,不是静默的。
		return cfg.deepseekApiKey ? "deepseek" : "mock";
	}
	if (p === "mock" || p === "anthropic" || p === "gateway") return p;
	throw new AiError(`Unknown AI_PROVIDER "${p}" — use deepseek | mock | anthropic | gateway`, 500);
}

export function makeClient(cfg: AiConfig, provider: AiProvider): Anthropic {
	if (provider === "gateway") {
		if (!cfg.gatewayUrl || !cfg.gatewayKey) {
			throw new AiError("gateway mode needs AI_GATEWAY_URL and AI_GATEWAY_KEY", 500);
		}
		// Any Anthropic-compatible /v1/messages endpoint works (private gateway,
		// LiteLLM proxy, ...). The virtual key goes out as `Authorization: Bearer`,
		// so the real provider credential only ever lives inside the gateway.
		return new Anthropic({ baseURL: cfg.gatewayUrl, authToken: cfg.gatewayKey });
	}
	if (!cfg.anthropicApiKey) {
		throw new AiError("anthropic mode needs ANTHROPIC_API_KEY (or use AI_PROVIDER=deepseek)", 500);
	}
	return new Anthropic({ apiKey: cfg.anthropicApiKey });
}

export interface CompleteInput {
	prompt: string;
	system?: string;
	/** 要求模型只输出 JSON(deepseek 映射为 response_format json_object)。 */
	json?: boolean;
}

export interface CompleteResult {
	text: string;
	provider: AiProvider;
	model: string;
}

function maxTokens(cfg: AiConfig): number {
	const cap = Number.parseInt(cfg.maxOutputTokens ?? "", 10);
	return Number.isFinite(cap) && cap > 0 ? cap : 1024;
}

interface DeepseekResponse {
	choices?: { message?: { content?: string }; finish_reason?: string }[];
}

async function completeDeepseek(cfg: AiConfig, input: CompleteInput): Promise<CompleteResult> {
	const model = cfg.model ?? "deepseek-chat";
	const res = await fetch("https://api.deepseek.com/chat/completions", {
		method: "POST",
		headers: {
			"content-type": "application/json",
			authorization: `Bearer ${cfg.deepseekApiKey}`,
		},
		body: JSON.stringify({
			model,
			max_tokens: maxTokens(cfg),
			...(input.json ? { response_format: { type: "json_object" } } : {}),
			messages: [
				...(input.system ? [{ role: "system", content: input.system }] : []),
				{ role: "user", content: input.prompt },
			],
		}),
	});
	if (!res.ok) {
		// 上游报文不透传给客户端(可能含 key 相关细节),进日志即可
		console.error("deepseek error", res.status, (await res.text()).slice(0, 500));
		if (res.status === 401) throw new AiError("DeepSeek API key 无效或已过期。", 502);
		if (res.status === 429) throw new AiError("DeepSeek 限流,请稍后重试。", 502);
		throw new AiError("上游 AI 错误,请稍后重试。", 502);
	}
	const data = (await res.json()) as DeepseekResponse;
	const text = data.choices?.[0]?.message?.content ?? "";
	if (!text) throw new AiError("模型返回了空结果,请重试。", 502);
	return { text, provider: "deepseek", model };
}

/**
 * The single seam every AI call in this product goes through — Worker 的向导
 * 与「对编辑说一句」、Lambda 的编辑调用都从这里出去。
 */
export async function complete(cfg: AiConfig, input: CompleteInput): Promise<CompleteResult> {
	const provider = resolveProvider(cfg);

	if (provider === "mock") {
		return {
			provider,
			model: "mock",
			text:
				`[mock] Received: "${input.prompt.slice(0, 200)}". ` +
				"Set AI_PROVIDER=deepseek with DEEPSEEK_API_KEY (or =anthropic / =gateway) for real responses.",
		};
	}

	if (provider === "deepseek") return completeDeepseek(cfg, input);

	const model = cfg.model ?? "claude-opus-5";
	const client = makeClient(cfg, provider);
	const message = await client.messages.create({
		model,
		max_tokens: maxTokens(cfg),
		...(input.system ? { system: input.system } : {}),
		messages: [{ role: "user", content: input.prompt }],
	});

	// Safety classifiers can decline with HTTP 200 + stop_reason "refusal";
	// content may be empty, so check before reading it.
	if (message.stop_reason === "refusal") {
		throw new AiError("The model declined this request.", 422);
	}

	const text = message.content
		.filter((block) => block.type === "text")
		.map((block) => block.text)
		.join("");
	return { text, provider, model: message.model };
}
