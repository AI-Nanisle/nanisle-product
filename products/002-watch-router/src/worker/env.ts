// Everything the worker reads from the environment, in one place.
// Non-secrets live in wrangler.jsonc `vars`; secrets come from
// `wrangler secret put` (deployed) or .dev.vars (local, gitignored).
// 密钥清单与轮换 runbook:主仓 infra/README.md。

import { fastVariant } from "../shared/ai";
import type { AiConfig } from "../shared/ai";

export interface AppEnv {
	/** Static client bundle, used when this Worker is called through a Service Binding. */
	ASSETS: Fetcher;
	/** KV namespace — 只放内容缓存(content:<platform>:<id>,docs/02 T6)。 */
	WATCH: KVNamespace;
	/** "deepseek" (production default) | "mock" | "anthropic" | "gateway" */
	AI_PROVIDER?: string;
	/** 编辑调用的模型(整篇转写进一次调用,docs/02 T3)。 */
	AI_MODEL?: string;
	/** 轻任务档(用户级高亮小调用,docs/02 T4)覆盖。 */
	FAST_AI_PROVIDER?: string;
	FAST_AI_MODEL?: string;
	/** Hard per-request output-token cap — cost guard for hosted instances. */
	AI_MAX_OUTPUT_TOKENS?: string;
	/** "1" turns all AI endpoints off (kill switch). */
	AI_DISABLED?: string;
	/** Secret. 站长凭证(x-access-code)。 */
	ACCESS_CODE?: string;
	/** Secret. Shared with the nanisle main site — verifies SSO handoff tokens and signs the session cookie. */
	NANISLE_SSO_SECRET?: string;
	/** Secret. 消费者回程鉴权(/api/queue/*,docs/02 T1)。与用户门禁分离、独立轮换。 */
	CONSUMER_TOKEN?: string;
	/** Secret. r.jina.ai 抽取兜底的免费 key(docs/02 T2)。不设 = 跳过兜底直接提示粘贴。 */
	JINA_KEY?: string;
	/** Secret. v1.5 交互包:读 001 追踪器定义的共享密钥(docs/02 T7②)。 */
	INTEROP_TOKEN?: string;
	/** 001 的 interop trackers 端点地址(不设 = 高亮整个关闭,地图照常)。 */
	INTEROP_TRACKERS_URL?: string;
	/** Main-site origin used in login redirects (default https://nanisle.com). */
	NANISLE_URL?: string;
	/** Canonical public mount for this product (no trailing slash). */
	APP_URL?: string;
	/**
	 * 本地 dev 专用:未配 NANISLE_SSO_SECRET 时(没有登录闸口)冒充哪个用户。
	 * 留空 = dev@local。生产实例永远别设:配了 SSO secret 时这个值不被读到。
	 */
	DEV_EMAIL?: string;

	// --- AWS 侧(主仓 infra/ 的 NanisleWatchRouter stack;配齐才走 DynamoDB/SQS,否则内存替身) ---
	/** Secret. 最小权限 IAM 用户 nanisle-watch-router-worker 的 access key。 */
	AWS_ACCESS_KEY_ID?: string;
	/** Secret. 同上。 */
	AWS_SECRET_ACCESS_KEY?: string;
	/** DynamoDB 表名(nanisle-watch-router)。 */
	DDB_TABLE?: string;
	/** us-east-1(表、队列、消费者 Lambda 所在 region)。 */
	AWS_REGION?: string;
	/** 慢车道任务队列 URL(cdk deploy 的 QueueUrl 输出)。 */
	QUEUE_URL?: string;

	// --- AI 凭证(按 AI_PROVIDER 二选一) ---
	/** Secret. AI_PROVIDER=deepseek(生产默认)。 */
	DEEPSEEK_API_KEY?: string;
	/** Secret. AI_PROVIDER=anthropic only. */
	ANTHROPIC_API_KEY?: string;
	/** Secret. AI_PROVIDER=anthropic 的另一种凭证(Claude Code 订阅 setup token)。 */
	ANTHROPIC_AUTH_TOKEN?: string;
	/** Base URL of an Anthropic-compatible endpoint — AI_PROVIDER=gateway only. */
	AI_GATEWAY_URL?: string;
	/** Secret. Virtual key issued by the gateway. */
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

/** 轻任务档的 AiConfig:用户级高亮小调用用(docs/02 T4 的第二次调用)。 */
export function fastAiConfig(env: AppEnv, overrides?: Partial<AiConfig>): AiConfig {
	return {
		...fastVariant(aiConfig(env), { provider: env.FAST_AI_PROVIDER, model: env.FAST_AI_MODEL }),
		...overrides,
	};
}

/** AWS 三件套配齐才走 DynamoDB;缺任何一个都用内存替身(fork 零配置)。 */
export function awsConfigured(env: AppEnv): boolean {
	return Boolean(env.AWS_ACCESS_KEY_ID && env.AWS_SECRET_ACCESS_KEY && env.DDB_TABLE);
}
