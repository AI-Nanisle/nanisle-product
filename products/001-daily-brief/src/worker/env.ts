// Everything the worker reads from the environment, in one place.
// Non-secrets live in wrangler.jsonc `vars`; secrets come from
// `wrangler secret put` (deployed) or .dev.vars (local, gitignored).
// 密钥清单与轮换 runbook:主仓 infra/README.md。

import type { AiConfig } from "../shared/ai";

export interface AppEnv {
	/** Static client bundle, used when this Worker is called through a Service Binding. */
	ASSETS: Fetcher;
	/** KV namespace — 本地 dev / fork 的替身存储(未配 AWS 凭证时启用,见 store-kv.ts)。 */
	BRIEFS: KVNamespace;
	/** "deepseek" (production default) | "mock" | "anthropic" | "gateway" */
	AI_PROVIDER?: string;
	/** Model ID sent on every request (deepseek-chat / claude-* …). */
	AI_MODEL?: string;
	/** Hard per-request output-token cap — cost guard for hosted instances. */
	AI_MAX_OUTPUT_TOKENS?: string;
	/** "1" turns all AI endpoints off (kill switch, docs/02 §8.3). */
	AI_DISABLED?: string;
	/** Secret. 站长凭证(x-access-code):手动触发全量生成等 admin 操作。 */
	ACCESS_CODE?: string;
	/** Secret. Shared with the nanisle main site — verifies SSO handoff tokens and signs the session cookie. */
	NANISLE_SSO_SECRET?: string;
	/** Main-site origin used in login redirects (default https://nanisle.com). */
	NANISLE_URL?: string;
	/** Canonical public mount for this product (no trailing slash). */
	APP_URL?: string;
	/** Timezone that defines "today" (default America/New_York). */
	BRIEF_TZ?: string;
	/**
	 * 本地 dev 专用:未配 NANISLE_SSO_SECRET 时(没有登录闸口)冒充哪个用户。
	 * 留空 = dev@local(零配置默认)。配上自己的邮箱,本地就直接读写线上那份
	 * 用户数据——前提是这个邮箱在白名单里,否则照样 403。生产实例永远别设:
	 * 配了 SSO secret 时这个值完全不被读到,身份只认会话 cookie。
	 */
	DEV_EMAIL?: string;

	// --- AWS 侧(主仓 infra/ 的 cdk stack;三个都配齐才走 DynamoDB,否则 KV 替身) ---
	/** Secret. 最小权限 IAM 用户 nanisle-daily-brief-worker 的 access key。 */
	AWS_ACCESS_KEY_ID?: string;
	/** Secret. 同上。 */
	AWS_SECRET_ACCESS_KEY?: string;
	/** DynamoDB 单表名(nanisle-daily-brief)。 */
	DDB_TABLE?: string;
	/** us-east-1(表和 Lambda 所在 region)。 */
	AWS_REGION?: string;
	/** generate Lambda 的 Function URL(cdk deploy 的 GenerateFunctionUrl 输出)。 */
	GENERATE_URL?: string;

	// --- AI 凭证(按 AI_PROVIDER 二选一) ---
	/** Secret. AI_PROVIDER=deepseek(生产默认)。 */
	DEEPSEEK_API_KEY?: string;
	/** Secret. AI_PROVIDER=anthropic only. */
	ANTHROPIC_API_KEY?: string;
	/** Base URL of an Anthropic-compatible endpoint — AI_PROVIDER=gateway only. */
	AI_GATEWAY_URL?: string;
	/** Secret. Virtual key issued by the gateway, sent as `Authorization: Bearer`. */
	AI_GATEWAY_KEY?: string;
}

/** AppEnv → 运行时无关的 AiConfig(shared/ai.ts 的入参)。 */
export function aiConfig(env: AppEnv, overrides?: Partial<AiConfig>): AiConfig {
	return {
		provider: env.AI_PROVIDER,
		model: env.AI_MODEL,
		maxOutputTokens: env.AI_MAX_OUTPUT_TOKENS,
		deepseekApiKey: env.DEEPSEEK_API_KEY,
		anthropicApiKey: env.ANTHROPIC_API_KEY,
		gatewayUrl: env.AI_GATEWAY_URL,
		gatewayKey: env.AI_GATEWAY_KEY,
		...overrides,
	};
}
