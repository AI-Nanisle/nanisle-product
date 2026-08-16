import Anthropic from "@anthropic-ai/sdk";
import type { AppEnv } from "./env";

export type AiProvider = "mock" | "anthropic" | "gateway";

/** Error safe to surface to clients (message contains no upstream details). */
export class AiError extends Error {
	constructor(
		message: string,
		readonly status: number = 502,
	) {
		super(message);
	}
}

export function resolveProvider(env: AppEnv): AiProvider {
	const p = (env.AI_PROVIDER ?? "mock").toLowerCase();
	if (p === "mock" || p === "anthropic" || p === "gateway") return p;
	throw new AiError(`Unknown AI_PROVIDER "${p}" — use mock | anthropic | gateway`, 500);
}

function makeClient(env: AppEnv, provider: AiProvider): Anthropic {
	if (provider === "gateway") {
		if (!env.AI_GATEWAY_URL || !env.AI_GATEWAY_KEY) {
			throw new AiError("gateway mode needs AI_GATEWAY_URL and AI_GATEWAY_KEY", 500);
		}
		// Any Anthropic-compatible /v1/messages endpoint works (private gateway,
		// LiteLLM proxy, ...). The virtual key goes out as `Authorization: Bearer`,
		// so the real provider credential only ever lives inside the gateway.
		return new Anthropic({ baseURL: env.AI_GATEWAY_URL, authToken: env.AI_GATEWAY_KEY });
	}
	if (!env.ANTHROPIC_API_KEY) {
		throw new AiError("anthropic mode needs ANTHROPIC_API_KEY (or keep AI_PROVIDER=mock)", 500);
	}
	return new Anthropic({ apiKey: env.ANTHROPIC_API_KEY });
}

export interface CompleteInput {
	prompt: string;
	system?: string;
}

export interface CompleteResult {
	text: string;
	provider: AiProvider;
	model: string;
}

/**
 * The single seam every AI call in this product goes through.
 * Keep it when building on the template — it is what makes the product run
 * identically in mock / bring-your-own-key / gateway mode.
 */
export async function complete(env: AppEnv, input: CompleteInput): Promise<CompleteResult> {
	const provider = resolveProvider(env);
	const model = env.AI_MODEL ?? "claude-opus-5";

	if (provider === "mock") {
		return {
			provider,
			model: "mock",
			text:
				`[mock] Received: "${input.prompt.slice(0, 200)}". ` +
				"Set AI_PROVIDER=anthropic with your own ANTHROPIC_API_KEY (or =gateway) for real responses — see docs/ai-access.md.",
		};
	}

	const capRaw = Number.parseInt(env.AI_MAX_OUTPUT_TOKENS ?? "", 10);
	const maxTokens = Number.isFinite(capRaw) && capRaw > 0 ? capRaw : 1024;

	const client = makeClient(env, provider);
	const message = await client.messages.create({
		model,
		max_tokens: maxTokens,
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
