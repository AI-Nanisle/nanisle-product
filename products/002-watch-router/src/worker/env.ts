// Everything the worker reads from the environment, in one place.
// Non-secrets live in wrangler.jsonc `vars`; secrets come from
// `wrangler secret put` (deployed) or .dev.vars (local, gitignored).
// 密钥清单与轮换 runbook:主仓 infra/README.md。

import { applyOwnerRoute, fastVariant, ownerRouteFromEnv } from "../shared/ai";
import type { AiConfig, OwnerRoute } from "../shared/ai";

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
	/** Secret. 订阅邮件退订 token 的 HMAC 密钥(docs/05 §3.5;001 同名不同值)。不设 = 不发邮件。 */
	EMAIL_UNSUB_SECRET?: string;
	/** 发件地址(裸地址;显示名在 email.ts 里统一加)。默认 watch@nanisle.com,域名身份在 001 的 stack 里已验证。 */
	EMAIL_FROM?: string;
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
	/** Base URL of an Anthropic-compatible endpoint — AI_PROVIDER=gateway only. */
	AI_GATEWAY_URL?: string;
	/** Secret. Virtual key issued by the gateway. */
	AI_GATEWAY_KEY?: string;
	// --- 站长专线(主仓 backend/docs/01):这些账号改走另一套 provider,其余用户不受影响 ---
	/** Secret. 逗号分隔的邮箱;不设 = 没有专线。 */
	OWNER_AI_EMAILS?: string;
	/** 专线的 provider(通常 gateway)。 */
	OWNER_AI_PROVIDER?: string;
	/** 专线基础档模型(如 opus)。 */
	OWNER_AI_MODEL?: string;
	/** 专线轻任务档模型(如 sonnet);不设跟 OWNER_AI_MODEL。 */
	OWNER_FAST_AI_MODEL?: string;
	/** 专线的输出上限;不设跟 AI_MAX_OUTPUT_TOKENS。 */
	OWNER_AI_MAX_OUTPUT_TOKENS?: string;
	/** Secret. 专线网关地址(不进仓,避免被定向扫描)。 */
	OWNER_AI_GATEWAY_URL?: string;
	/** Secret. 专线网关的 Bearer key。 */
	OWNER_AI_GATEWAY_KEY?: string;
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

/** 轻任务档的 AiConfig:用户级高亮小调用用(docs/02 T4 的第二次调用)。 */
export function fastAiConfig(env: AppEnv, overrides?: Partial<AiConfig>): AiConfig {
	return {
		...fastVariant(aiConfig(env), { provider: env.FAST_AI_PROVIDER, model: env.FAST_AI_MODEL }),
		...overrides,
	};
}


/** 站长专线路由表(env → OwnerRoute);没配 OWNER_AI_EMAILS 时为 null。 */
export function ownerRoute(env: AppEnv): OwnerRoute | null {
	return ownerRouteFromEnv(env as unknown as Record<string, string | undefined>);
}

/**
 * 按账号取基础档配置:命中专线名单走专线(带 fallback),否则就是 aiConfig(env)。
 * 调用点显式传的 overrides 最后再盖一次——否则 OWNER_AI_MAX_OUTPUT_TOKENS 这类
 * 专线字段会把调用点故意压低的上限顶掉(蒸馏那次的 2048 就是这么被吃掉的)。
 */
export function aiConfigFor(env: AppEnv, email: string | undefined, overrides?: Partial<AiConfig>): AiConfig {
	const routed = applyOwnerRoute(email, aiConfig(env, overrides), ownerRoute(env));
	return overrides ? { ...routed, ...overrides } : routed;
}

/** 按账号取轻任务档配置。先 fastVariant 再路由:FAST_AI_MODEL 的 deepseek 型号不能带进专线。 */
export function fastAiConfigFor(env: AppEnv, email: string | undefined, overrides?: Partial<AiConfig>): AiConfig {
	const routed = applyOwnerRoute(email, fastAiConfig(env, overrides), ownerRoute(env), "fast");
	return overrides ? { ...routed, ...overrides } : routed;
}

/** AWS 三件套配齐才走 DynamoDB;缺任何一个都用内存替身(fork 零配置)。 */
export function awsConfigured(env: AppEnv): boolean {
	return Boolean(env.AWS_ACCESS_KEY_ID && env.AWS_SECRET_ACCESS_KEY && env.DDB_TABLE);
}
