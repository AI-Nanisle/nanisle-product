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
	/**
	 * Claude Code 订阅的 setup token(`claude setup-token` 生成,sk-ant-oat 开头)。
	 * 它是 OAuth token,走 Authorization: Bearer 而不是 x-api-key;和 apiKey
	 * 二选一,两个都给时 apiKey 优先(按量付费的 key 语义更明确)。
	 */
	anthropicAuthToken?: string;
	gatewayUrl?: string;
	gatewayKey?: string;
}

/**
 * 轻任务档配置(docs/05 §D)。选材/成稿这类质量敏感的调用留在基础档
 * (deepseek-v4-pro,带 thinking);向导、改稿、口味蒸馏这类交互敏感或
 * 模板化的调用走这档——deepseek 模式下默认换 deepseek-v4-flash(快、省),
 * 其他 provider(anthropic/gateway/mock)不强塞 deepseek 型号,跟随基础档。
 * overrides 来自 FAST_AI_PROVIDER / FAST_AI_MODEL,显式配了就以配置为准。
 */
export function fastVariant(base: AiConfig, overrides?: { provider?: string; model?: string }): AiConfig {
	if (overrides?.provider || overrides?.model) {
		return {
			...base,
			...(overrides.provider ? { provider: overrides.provider } : {}),
			...(overrides.model ? { model: overrides.model } : {}),
		};
	}
	return resolveProvider(base) === "deepseek" ? { ...base, model: "deepseek-v4-flash" } : base;
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
	if (cfg.anthropicApiKey) return new Anthropic({ apiKey: cfg.anthropicApiKey });
	if (cfg.anthropicAuthToken) {
		// setup token 是 OAuth 凭证:Bearer 头 + oauth beta 标记
		return new Anthropic({
			authToken: cfg.anthropicAuthToken,
			defaultHeaders: { "anthropic-beta": "oauth-2025-04-20" },
		});
	}
	throw new AiError("anthropic mode needs ANTHROPIC_API_KEY or ANTHROPIC_AUTH_TOKEN (or use AI_PROVIDER=deepseek)", 500);
}

export interface CompleteInput {
	prompt: string;
	system?: string;
	/** 要求模型只输出 JSON(deepseek 映射为 response_format json_object)。 */
	json?: boolean;
	/**
	 * 整次调用(含流式读体)的总时限,超时抛 AiError 而不是吊死到边缘断连。
	 * 只给交互敏感的调用传(向导/refine 走 flash,60s 已是事故);选材/成稿
	 * 这类 thinking 长调用**不要传**——V4 Pro 正常就要跑好几分钟。
	 */
	timeoutMs?: number;
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

interface DeepseekStreamChunk {
	choices?: { delta?: { content?: string }; finish_reason?: string | null }[];
}

/**
 * 读 SSE 流,攒出最终 content 和 finish_reason。为什么必须流式:V4 Pro 默认开
 * thinking,选材这种大候选池调用整体要跑好几分钟;非流式时 5 分钟内一个字节
 * 都不来,Node(undici)默认的 body 空闲超时直接把连接掐断——本地和 Lambda
 * 都会踩。流式下 thinking 阶段就持续有增量字节,空闲超时永远不会触发。
 */
async function readSse(body: ReadableStream<Uint8Array>): Promise<{ text: string; finish: string }> {
	const reader = body.getReader();
	const decoder = new TextDecoder();
	let buffer = "";
	let text = "";
	let finish = "(无)";
	for (;;) {
		const { done, value } = await reader.read();
		if (done) break;
		buffer += decoder.decode(value, { stream: true });
		const events = buffer.split("\n\n");
		buffer = events.pop() ?? "";
		for (const event of events) {
			for (const line of event.split("\n")) {
				if (!line.startsWith("data:")) continue;
				const payload = line.slice(5).trim();
				if (!payload || payload === "[DONE]") continue;
				try {
					const chunk = JSON.parse(payload) as DeepseekStreamChunk;
					text += chunk.choices?.[0]?.delta?.content ?? "";
					const f = chunk.choices?.[0]?.finish_reason;
					if (f) finish = f;
				} catch {
					// 半截 JSON 或 keep-alive 注释,跳过
				}
			}
		}
	}
	return { text, finish };
}

/** 超时(TimeoutError/AbortError)换成能对用户明说的 AiError;其余原样上抛。 */
function rethrowTimeout(err: unknown, timeoutMs: number | undefined): never {
	if (timeoutMs && err instanceof Error && (err.name === "TimeoutError" || err.name === "AbortError")) {
		throw new AiError(`上游 AI 超过 ${Math.round(timeoutMs / 1000)} 秒没回完,请再试一次。`, 502);
	}
	throw err;
}

async function completeDeepseek(cfg: AiConfig, input: CompleteInput): Promise<CompleteResult> {
	// deepseek-chat 已于 2026-07-24 彻底退役(调用直接报错)。V4 Pro 默认开
	// thinking(effort=high),且 thinking 下不接受 temperature/top_p 等采样
	// 参数——这里本来就没传,别加。省钱档是 deepseek-v4-flash。
	const model = cfg.model ?? "deepseek-v4-pro";
	// V4 的思考也占输出预算,预算太小时 content 会被吃成空串(finish=length);
	// JSON 模式另有偶发空 content 的官方已知问题——所以空结果重试一次再报错。
	for (let attempt = 0; ; attempt++) {
		// 每轮各自起表:空结果重试的第二发不该继承第一发已耗掉的时限
		const signal = input.timeoutMs ? AbortSignal.timeout(input.timeoutMs) : undefined;
		let res: Response;
		try {
			res = await fetch("https://api.deepseek.com/chat/completions", {
				method: "POST",
				headers: {
					"content-type": "application/json",
					authorization: `Bearer ${cfg.deepseekApiKey}`,
				},
				body: JSON.stringify({
					model,
					max_tokens: maxTokens(cfg),
					stream: true,
					...(input.json ? { response_format: { type: "json_object" } } : {}),
					messages: [
						...(input.system ? [{ role: "system", content: input.system }] : []),
						{ role: "user", content: input.prompt },
					],
				}),
				...(signal ? { signal } : {}),
			});
		} catch (err) {
			rethrowTimeout(err, input.timeoutMs);
		}
		if (!res.ok) {
			// 上游报文不透传给客户端(可能含 key 相关细节),进日志即可
			console.error("deepseek error", res.status, (await res.text()).slice(0, 500));
			if (res.status === 401) throw new AiError("DeepSeek API key 无效或已过期。", 502);
			if (res.status === 429) throw new AiError("DeepSeek 限流,请稍后重试。", 502);
			throw new AiError("上游 AI 错误,请稍后重试。", 502);
		}
		if (!res.body) throw new AiError("上游 AI 错误,请稍后重试。", 502);
		let text: string;
		let finish: string;
		try {
			// signal 管的是整次调用:读流也在时限内(掐掉的是「连上了但吐字极慢」)
			({ text, finish } = await readSse(res.body));
		} catch (err) {
			rethrowTimeout(err, input.timeoutMs);
		}
		if (text) return { text, provider: "deepseek", model };
		console.error(`deepseek empty content, finish_reason=${finish}, max_tokens=${maxTokens(cfg)}, attempt=${attempt + 1}`);
		if (finish === "length") {
			throw new AiError("模型输出被 max_tokens 截断(思考也占预算),请调大 AI_MAX_OUTPUT_TOKENS。", 502);
		}
		if (attempt >= 1) throw new AiError("模型返回了空结果,请重试。", 502);
	}
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
	const message = await client.messages.create(
		{
			model,
			max_tokens: maxTokens(cfg),
			...(input.system ? { system: input.system } : {}),
			messages: [{ role: "user", content: input.prompt }],
		},
		// SDK 自带按次超时;超时抛 APIConnectionTimeoutError,调用方按普通失败重试
		input.timeoutMs ? { timeout: input.timeoutMs } : undefined,
	);

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
