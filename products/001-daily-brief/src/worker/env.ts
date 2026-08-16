// Everything the worker reads from the environment, in one place.
// Non-secrets live in wrangler.jsonc `vars`; secrets come from
// `wrangler secret put` (deployed) or .dev.vars (local, gitignored).
// See docs/ai-access.md for the full matrix.
export interface AppEnv {
	/** KV namespace holding briefs (`brief:*`), feedback (`fb:*`) and clicks (`click:*`). */
	BRIEFS: KVNamespace;
	/** "mock" (default) | "anthropic" (BYOK) | "gateway" (Anthropic-compatible proxy) */
	AI_PROVIDER?: string;
	/** Model ID sent on every request. */
	AI_MODEL?: string;
	/** Hard per-request output-token cap — cost guard for hosted instances. */
	AI_MAX_OUTPUT_TOKENS?: string;
	/** "1" turns all AI endpoints off (kill switch). */
	AI_DISABLED?: string;
	/** Secret. Comma-separated access codes; when set, brief/feedback/AI endpoints require `x-access-code`. */
	ACCESS_CODE?: string;
	/** Secret. Required by POST /api/ingest — the generation pipeline authenticates with it. */
	INGEST_TOKEN?: string;
	/** Timezone that defines "today" for /api/generate (default America/New_York). */
	BRIEF_TZ?: string;
	/** Secret. Your own key — AI_PROVIDER=anthropic only. */
	ANTHROPIC_API_KEY?: string;
	/** Base URL of an Anthropic-compatible endpoint — AI_PROVIDER=gateway only. */
	AI_GATEWAY_URL?: string;
	/** Secret. Virtual key issued by the gateway, sent as `Authorization: Bearer`. */
	AI_GATEWAY_KEY?: string;
}
