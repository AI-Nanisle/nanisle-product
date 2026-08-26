// Everything the worker reads from the environment, in one place.
// Non-secrets live in wrangler.jsonc `vars`; secrets come from
// `wrangler secret put` (deployed) or .dev.vars (local, gitignored).
// 密钥清单与轮换 runbook:主仓 infra/README.md。

import { fastVariant } from "../shared/ai";
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
	/** 轻任务档(向导/改稿/口味蒸馏)覆盖,见 shared/ai.ts fastVariant。 */
	FAST_AI_PROVIDER?: string;
	/** 同上;都没配时 deepseek 模式默认 deepseek-v4-flash。 */
	FAST_AI_MODEL?: string;
	/** Hard per-request output-token cap — cost guard for hosted instances. */
	AI_MAX_OUTPUT_TOKENS?: string;
	/** "1" turns all AI endpoints off (kill switch, docs/02 §8.3). */
	AI_DISABLED?: string;
	/** Secret. 站长凭证(x-access-code):手动触发全量生成等 admin 操作。 */
	ACCESS_CODE?: string;
	/** Secret. Shared with the nanisle main site — verifies SSO handoff tokens and signs the session cookie. */
	NANISLE_SSO_SECRET?: string;
	/**
	 * Secret. E1 · 退订 token 的 HMAC 密钥,与 generate Lambda 共享(cdk deploy
	 * 时注入 Lambda 环境)。专用密钥不复用 SSO secret:泄漏最坏后果只是被人退订。
	 * 未配置时退订端点返回 503(邮件本身也发不出去——Lambda 同样没配)。
	 */
	EMAIL_UNSUB_SECRET?: string;
	/**
	 * Secret. 跨产品只读端点(/api/interop/trackers)的共享密钥,与 002
	 * 长视频总结同值(002 docs/02 T7②)。未配置 = interop 端点关闭。
	 */
	INTEROP_TOKEN?: string;
	/** Main-site origin used in login redirects (default https://nanisle.com). */
	NANISLE_URL?: string;
	/** N1 · SES 发件地址(与 Lambda 的 EMAIL_FROM 同值,brief@nanisle.com)。 */
	EMAIL_FROM?: string;
	/**
	 * N1 · 开发者通知邮箱:用户手动加源试抓失败时实时发一封需求邮件到这里。
	 * 不设 = 不通知(fork 零配置照常跑)。发送走 Worker 自己的 AWS 凭证,
	 * IAM 用户需有 ses:SendEmail(主仓 infra 的 workerPolicy)。
	 */
	DEV_NOTIFY_EMAIL?: string;
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
	/** Secret. AI_PROVIDER=anthropic 的另一种凭证:Claude Code 订阅的 setup token(OAuth)。 */
	ANTHROPIC_AUTH_TOKEN?: string;
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
		anthropicAuthToken: env.ANTHROPIC_AUTH_TOKEN,
		gatewayUrl: env.AI_GATEWAY_URL,
		gatewayKey: env.AI_GATEWAY_KEY,
		...overrides,
	};
}

/** 轻任务档的 AiConfig(docs/05 §D):向导、对编辑说一句、口味蒸馏用。 */
export function fastAiConfig(env: AppEnv, overrides?: Partial<AiConfig>): AiConfig {
	return {
		...fastVariant(aiConfig(env), { provider: env.FAST_AI_PROVIDER, model: env.FAST_AI_MODEL }),
		...overrides,
	};
}
