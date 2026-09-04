// AI 接缝。整份物理复制自 002 的 src/shared/ai.ts,接口一个字没改
// (docs/02 决策 T7)——模板自带的 src/worker/ai.ts 只有 mock/anthropic/gateway
// 三档、没有 deepseek,也没有 003 要用的 fastVariant / ownerRoute / readSse /
// extractJsonText / JsonShapeError。复制而不是共享是本仓的家法:产品之间不
// 互相 import,`git rm -r` 删掉一个产品目录就等于完整下线(docs/conventions.md)。
//
// 四个模式:deepseek(生产默认,OpenAI 兼容 API 直连,不引第二个 SDK)、
// mock(零配置演示/fork 首跑)、anthropic / gateway(换模对照的退路)。
// 换供应商是配置变更,不是代码变更——这是接缝存在的意义。
//
// 入参是普通 config 对象而不是 Worker 的 AppEnv:运行时无关,Worker 侧由
// env.ts 适配。

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

/**
 * 这个**部署配错了**,不是这次调用失败了(003 相对 002 的加法)。
 *
 * 为什么要单列一类:它的 message 是写给站长看的英文配置报文,里面带着环境
 * 变量名(`gateway mode needs AI_GATEWAY_URL and AI_GATEWAY_KEY`、
 * `Unknown AI_PROVIDER "x"`)。而 types.ts 承诺 `error` 是**可以直接显示给
 * 用户**的中文文案,调用方那句 `err.message` 一透传,任何一个登录用户都能
 * 看见我们的变量名。分成一类之后,路由层可以「配置类进日志、给用户一句
 * 中文」,而上游故障那类照旧原样显示(那些本来就是写给用户的中文)。
 *
 * status 仍是 500:它确实是服务端的问题,而且重试无用——换一次调用也是同一份
 * 配置。(注意 shouldFallBack 对 >=500 会走退路,行为与拆分前一致。)
 */
export class AiConfigError extends AiError {
	constructor(message: string) {
		super(message, 500);
	}
}

/**
 * 上游 200 了,产出却不是合法 JSON。单列一类是因为它的处方和上游故障不同:
 * 有退路的走退路,没退路的原地重来一次——同样的输入,模型下一次多半就规矩了。
 * status 取 502 让它同时落进 shouldFallBack 的可退路档。
 */
export class JsonShapeError extends AiError {
	constructor(message = "模型没有返回合法 JSON。") {
		super(message, 502);
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
	/**
	 * 这份配置失败时的退路(由 applyOwnerRoute 填入,= 路由前的原配置)。
	 * complete() 在主配置抛出上游类错误时用它重试一次;正常配置没有这个字段。
	 */
	fallback?: AiConfig;
}

/**
 * 站长专线(主仓 backend/docs/01):某几个账号的调用改走另一套 provider——
 * 典型是站长自己走 `gateway`(EC2 上的 Claude Code 订阅网关),其他人照旧。
 * 谁走、走哪由部署期环境变量决定(OWNER_AI_*),产品 UI 里没有任何入口。
 */
export interface OwnerRoute {
	/** 小写邮箱列表。 */
	emails: string[];
	/** 覆盖到基础配置上的字段(provider / model / gatewayUrl / gatewayKey / maxOutputTokens)。 */
	cfg: Partial<AiConfig>;
	/** 轻任务档用的模型(没设就和 cfg.model 一样)。 */
	fastModel?: string;
}

/**
 * 从环境变量拼 OwnerRoute。OWNER_AI_EMAILS 没配 = 没有专线,返回 null,
 * 一切照旧——fork 零配置不受影响。
 */
export function ownerRouteFromEnv(env: Record<string, string | undefined>): OwnerRoute | null {
	const emails = (env.OWNER_AI_EMAILS ?? "")
		.split(",")
		.map((e) => e.trim().toLowerCase())
		.filter(Boolean);
	if (emails.length === 0) return null;
	const cfg: Partial<AiConfig> = {};
	if (env.OWNER_AI_PROVIDER) cfg.provider = env.OWNER_AI_PROVIDER;
	if (env.OWNER_AI_MODEL) cfg.model = env.OWNER_AI_MODEL;
	if (env.OWNER_AI_MAX_OUTPUT_TOKENS) cfg.maxOutputTokens = env.OWNER_AI_MAX_OUTPUT_TOKENS;
	if (env.OWNER_AI_GATEWAY_URL) cfg.gatewayUrl = env.OWNER_AI_GATEWAY_URL;
	if (env.OWNER_AI_GATEWAY_KEY) cfg.gatewayKey = env.OWNER_AI_GATEWAY_KEY;
	return { emails, cfg, fastModel: env.OWNER_FAST_AI_MODEL || undefined };
}

/**
 * 按账号决定用哪份配置:命中专线名单就把路由字段盖到 base 上,并把 base
 * 留作 fallback(专线挂了不能漏刊);没命中原样返回 base。
 * tier="fast" 用于轻任务档:模型换成 fastModel(没设就跟 cfg.model)。
 * 注意要在 fastVariant 之后调用——FAST_AI_MODEL 那种 deepseek 型号不能带进专线。
 */
export function applyOwnerRoute(
	email: string | undefined,
	base: AiConfig,
	route: OwnerRoute | null,
	tier: "base" | "fast" = "base",
): AiConfig {
	if (!route || !email || !route.emails.includes(email.trim().toLowerCase())) return base;
	const model = tier === "fast" ? (route.fastModel ?? route.cfg.model) : route.cfg.model;
	return { ...base, ...route.cfg, ...(model ? { model } : {}), fallback: base };
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
	throw new AiConfigError(`Unknown AI_PROVIDER "${p}" — use deepseek | mock | anthropic | gateway`);
}

export function makeClient(cfg: AiConfig, provider: AiProvider): Anthropic {
	if (provider === "gateway") {
		if (!cfg.gatewayUrl || !cfg.gatewayKey) {
			throw new AiConfigError("gateway mode needs AI_GATEWAY_URL and AI_GATEWAY_KEY");
		}
		// Any Anthropic-compatible /v1/messages endpoint works (private gateway,
		// LiteLLM proxy, ...). The virtual key goes out as `Authorization: Bearer`,
		// so the real provider credential only ever lives inside the gateway.
		return new Anthropic({ baseURL: cfg.gatewayUrl, authToken: cfg.gatewayKey });
	}
	// 只认 API key。Claude 订阅的 OAuth token(claude setup-token 的产物)不能
	// 在这里用:Anthropic 2026-01 起服务端只放行官方 Claude Code 客户端,02-19
	// 的条款也明写第三方产品/服务不得使用——要吃订阅额度只能让官方 CLI 自己
	// 发请求,那是 gateway 模式后面那台机器的事(主仓 backend/docs/01)。
	if (cfg.anthropicApiKey) return new Anthropic({ apiKey: cfg.anthropicApiKey });
	throw new AiConfigError("anthropic mode needs ANTHROPIC_API_KEY (or use AI_PROVIDER=deepseek / gateway)");
}

/**
 * 去掉模型偶尔包在 JSON 外面的 Markdown 代码围栏(```json … ```)。deepseek 走
 * response_format 不会有;SDK 路径(anthropic/gateway)靠提示词约束,sonnet 实测
 * 仍会包一层,所以 json 调用统一过一遍。不是围栏包裹的原样返回。
 */
export function stripJsonFence(text: string): string {
	// 手写而不是用正则:`^\s*```...\n?([\s\S]*?)\n?\s*```\s*$` 这种写法里几段空白
	// 匹配是互相二义的,遇到「开了围栏但没闭合 + 一串尾随空白」会灾难性回溯——实测
	// 1KB 换行就要 1.8 秒 CPU,几 KB 直接顶穿 Worker 的 CPU 上限。模型输出被
	// max_tokens 截断时正好长这样,不需要有人故意构造。下面是线性的,顺带把截断
	// 的半截围栏也处理掉(正则版对它是直接放弃)。
	const t = text.trim();
	if (!t.startsWith("```")) return text;
	const firstNl = t.indexOf("\n");
	const lastFence = t.lastIndexOf("```");
	if (firstNl < 0) return text;
	// 闭合围栏在首行之后 = 正常情况;否则是只有开头那个围栏(截断),取首行之后全部
	return lastFence > firstNl ? t.slice(firstNl + 1, lastFence).trim() : t.slice(firstNl + 1).trim();
}

/**
 * 从模型输出里取出可解析的 JSON 文本,三级递降:
 *   ① 原样    —— 规矩的输出(deepseek 有 response_format,基本都走这级)
 *   ② 去围栏  —— stripJsonFence,SDK 路径靠提示词约束时的常见形态
 *   ③ 捞花括号 —— 第一个 { 到最后一个 },给偶发的前言/后记兜底
 * 第三级是这次事故补的:stripJsonFence 只认「整段以围栏开头」,输出前面多一句
 * 「好的,我看完了:」它就原样放行,一路撞到 JSON.parse 才炸,而且报的是
 * 「模型没有返回合法 JSON」——把一次措辞抖动说成了模型坏掉。
 * 返回归一化后的文本(调用方后面还要自己 parse 一次);取不出来返回 null。
 */
export function extractJsonText(text: string): string | null {
	const start = text.indexOf("{");
	const end = text.lastIndexOf("}");
	const candidates = [text.trim(), stripJsonFence(text).trim(), start >= 0 && end > start ? text.slice(start, end + 1) : ""];
	for (const c of candidates) {
		if (!c) continue;
		try {
			JSON.parse(c);
			return c;
		} catch {
			// 换下一级
		}
	}
	return null;
}

/**
 * 解析不了时留证。只记首尾各 200 字:够认出是「前言」「围栏」还是「半截」,
 * 又不会把整篇产出灌进日志。2026-08-30 那次事故就卡在这儿——错误信息里一个
 * 字都没留,网关按设计也不记产出正文,事后无从复原它究竟吐了什么。
 */
function logUnparsable(provider: AiProvider, model: string, text: string): void {
	console.error(
		`json parse failed: provider=${provider} model=${model} chars=${text.length} ` +
			`head=${JSON.stringify(text.slice(0, 200))} tail=${JSON.stringify(text.slice(-200))}`,
	);
}

const JSON_ONLY_HINT = "只输出一个 JSON 对象本身,不要 Markdown 代码围栏,不要任何解释文字。";

export interface CompleteInput {
	prompt: string;
	system?: string;
	/** 要求模型只输出 JSON(deepseek 映射为 response_format json_object)。 */
	json?: boolean;
	/**
	 * 002 扩展(对 001 版的加法,不影响既有调用):每收到一段正文增量就回调,
	 * 快车道用它把生成进度透传给浏览器(经 CF 代理 100 秒无字节会 524)。
	 * 仅 deepseek 流式路径生效;thinking 阶段没有 content 增量,心跳由调用方自己打。
	 */
	onDelta?: (textDelta: string) => void;
	/**
	 * 002 扩展(docs/05 §2.2 第 4 条):思考力度。V4 默认 thinking 开且 effort=high;
	 * 逐章详写这种「按窗口如实展开」的调用把它调到 low——thinking 帮助小,却吃
	 * 输出预算和时间;大纲/判决/批判视角才需要 high。none = 关闭 thinking。
	 * 仅 deepseek 路径生效(OpenAI 兼容参数 reasoning_effort / thinking)。
	 */
	reasoning?: "none" | "low" | "high";
	/**
	 * 003 扩展:整趟调用的取消信号,**贯穿所有内部重试**。
	 *
	 * 为什么必须有它:这个接缝里叠了三层重试,而每一层都只知道自己那一层——
	 *   ① completeDeepseek 对「空 content / 流没带 finish_reason」自己再来一次;
	 *   ② complete() 对 JsonShapeError 原样再要一次;
	 *   ③ 调用方自己的补一轮(dossier.ts 的 round)。
	 * 三层相乘,最坏一次交互请求会发出 8 个真实生成请求。钱不是问题(flash 档
	 * 8 次约 $0.016),**墙钟是**:串行 8 次足以把一个交互端点拖过 CF 那条
	 * 100 秒线,用户拿到 524 而不是一句能看懂的中文,而额度早在调用前就扣掉了。
	 *
	 * 调用方传一个 `AbortSignal.timeout(...)` 就能给整趟设一个上界:信号一响,
	 * 后面每一次 fetch 立刻抛,层层重试自然停下。同款规矩见 index.ts 的
	 * PROBE_TIMEOUT_MS(2026-08-25 用户反馈「找信源无超时无重试」之后立的)。
	 */
	signal?: AbortSignal;
	/**
	 * 003 扩展:**主配置失败、即将拿 fallback 重试**时回调一次。
	 *
	 * 它补的是阶段 1-2 评审留下的那半个洞(guard.ts `spendsOffOurAccount` 的函数头)。
	 * 站长专线配好但网关当时挂了时,下面那条 fallback 分支会拿 base 配置(= 我们
	 * 自己的 DeepSeek key)重试一次,**钱落回我们账上**,而这一趟在闸口已经被
	 * 当作「不花我们的钱」放过了。占位必须发生在调用之前,闸口那一层看不见后面
	 * 会不会回落,所以结构上只能在这里补一句「记一笔账」。
	 *
	 * **在 fallback 调用发出之前就回调**,不是等它成功之后:回落那一发失败时
	 * token 一样烧掉了,等成功再记账等于给「失败的重试」开了一条免费通道。
	 *
	 * 回调本身是同步的,别在里面 await —— 调用方要落库就自己收集 promise 再
	 * 在外层等(report.ts 就是这么做的)。让这个接缝去 await 一次 D1 写,
	 * 等于把「这一次生成」的成败挂在记账能不能写成上,那是两件事。
	 */
	onFallback?: (info: { reason: string; from: AiProvider; to: AiProvider }) => void;
	/**
	 * 003 扩展:**因为产出不是合法 JSON、即将原样再要一次**时回调一次。
	 *
	 * 它补的是 2026-09-01 阶段 7 评审的建议修 7:没有 fallback 那一支在
	 * `JsonShapeError` 上会整发重来,于是一份报告最坏是 **4 次 pro 调用**,
	 * 而 `REPORT_EST_USD = 0.6` 是按 2 次估的。
	 *
	 * **为什么补记账而不是把估值调高。**把 `REPORT_EST_USD` 提到 1.2 会让
	 * $3 的全局闸从「一天 5 份」掉到「一天 2 份」,而重试是**少见路径**——
	 * 常见的一份报告就是 2 次调用。按最坏值预扣等于让常见情况替少见情况买单,
	 * 保险丝的意义(拦住失控的那一天)不需要这个代价。补记账拿到的是同一个
	 * 效果的另一半:这一趟照跑,但账面立刻真实,**下一个**请求撞到被顶高的
	 * 当日花费上就会被拦住。和 `onFallback` 完全同形,理由也同一条
	 * (store.ts `addSpend`:闸不拦,但账要有)。
	 *
	 * 和 `onFallback` 一样,**在重试发出去之前**回调:失败的那一发 token 一样
	 * 烧掉了。回调本身是同步的,别在里面 await。
	 */
	onRetry?: (info: { reason: string; provider: AiProvider }) => void;
}

export interface CompleteResult {
	text: string;
	provider: AiProvider;
	model: string;
	/**
	 * 主配置失败、走了 fallback 才为 true。
	 *
	 * **调用方要真的标注出来。**003 的 report.ts 在报告的 `notes` 里落一条
	 * `ai-fell-back`(2026-09-01 阶段 7 评审接上的:在那之前全仓没有一个地方
	 * 读这个字段,而这行注释已经承诺了「据此如实标注」)。
	 */
	fellBack?: boolean;
}

function maxTokens(cfg: AiConfig): number {
	const cap = Number.parseInt(cfg.maxOutputTokens ?? "", 10);
	return Number.isFinite(cap) && cap > 0 ? cap : 1024;
}

interface DeepseekStreamChunk {
	choices?: { delta?: { content?: string }; finish_reason?: string | null }[];
	/** stream_options.include_usage 时最后一个 chunk 带用量;缓存命中数是详细笔记成本的关键仪表(docs/05 风险 4)。 */
	usage?: { prompt_tokens?: number; completion_tokens?: number; prompt_cache_hit_tokens?: number; prompt_cache_miss_tokens?: number };
}

/**
 * 读 SSE 流,攒出最终 content 和 finish_reason。为什么必须流式:V4 Pro 默认开
 * thinking,选材这种大候选池调用整体要跑好几分钟;非流式时 5 分钟内一个字节
 * 都不来,Node(undici)默认的 body 空闲超时直接把连接掐断——本地和 Lambda
 * 都会踩。流式下 thinking 阶段就持续有增量字节,空闲超时永远不会触发。
 */
async function readSse(
	body: ReadableStream<Uint8Array>,
	onDelta?: (textDelta: string) => void,
): Promise<{ text: string; finish: string }> {
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
					const delta = chunk.choices?.[0]?.delta?.content ?? "";
					if (delta) {
						text += delta;
						onDelta?.(delta);
					}
					const f = chunk.choices?.[0]?.finish_reason;
					if (f) finish = f;
					if (chunk.usage) {
						const u = chunk.usage;
						console.log(`deepseek usage: prompt=${u.prompt_tokens ?? "?"} cache_hit=${u.prompt_cache_hit_tokens ?? "?"} cache_miss=${u.prompt_cache_miss_tokens ?? "?"} completion=${u.completion_tokens ?? "?"}`);
					}
				} catch {
					// 半截 JSON 或 keep-alive 注释,跳过
				}
			}
		}
	}
	return { text, finish };
}

async function completeDeepseek(cfg: AiConfig, input: CompleteInput): Promise<CompleteResult> {
	// deepseek-chat 已于 2026-07-24 彻底退役(调用直接报错)。V4 Pro 默认开
	// thinking(effort=high),且 thinking 下不接受 temperature/top_p 等采样
	// 参数——这里本来就没传,别加。省钱档是 deepseek-v4-flash。
	const model = cfg.model ?? "deepseek-v4-pro";
	// V4 的思考也占输出预算,预算太小时 content 会被吃成空串(finish=length);
	// JSON 模式另有偶发空 content 的官方已知问题——所以空结果重试一次再报错。
	for (let attempt = 0; ; attempt++) {
		const res = await fetch("https://api.deepseek.com/chat/completions", {
			method: "POST",
			// 信号贯穿这个 for 循环:第一次调用超时之后,内部重试的那一次会
			// 立刻抛,而不是再等一个完整的上游超时
			signal: input.signal,
			headers: {
				"content-type": "application/json",
				authorization: `Bearer ${cfg.deepseekApiKey}`,
			},
			body: JSON.stringify({
				model,
				max_tokens: maxTokens(cfg),
				stream: true,
				stream_options: { include_usage: true },
				...(input.json ? { response_format: { type: "json_object" } } : {}),
				...(input.reasoning === "none"
					? { thinking: { type: "disabled" } }
					: input.reasoning
						? { reasoning_effort: input.reasoning }
						: {}),
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
		if (!res.body) throw new AiError("上游 AI 错误,请稍后重试。", 502);
		const { text, finish } = await readSse(res.body, input.onDelta);
		// 有文本不等于这次调用成功。以前这里是 `if (text) return`,于是两种坏结果被
		// 当成好结果放行,半截 JSON 一路传到 parse 才炸:
		//   finish=length —— 预算(含思考)用尽,JSON 断在半路
		//   finish 缺失   —— 流在终止 chunk 之前就断了。优雅关闭,reader 不抛错,
		//                     usage chunk 也不会来,现场干净得像正常结束
		if (finish === "length") {
			throw new AiError("模型输出被 max_tokens 截断(思考也占预算),请调大 AI_MAX_OUTPUT_TOKENS。", 502);
		}
		if (text && finish === "stop") return { text, provider: "deepseek", model };
		if (text) {
			// 截断的流:重试一次(瞬时故障),再不行如实报连接问题,别赖模型
			console.error(`deepseek stream ended without finish_reason (finish=${finish}, chars=${text.length}), attempt=${attempt + 1}`);
			if (attempt >= 1) throw new AiError("上游连接中断,请重试。", 502);
			continue;
		}
		console.error(`deepseek empty content, finish_reason=${finish}, max_tokens=${maxTokens(cfg)}, attempt=${attempt + 1}`);
		if (attempt >= 1) throw new AiError("模型返回了空结果,请重试。", 502);
	}
}

/** 主配置的哪些失败值得用 fallback 重试:上游故障算,请求本身不合法不算。 */
function shouldFallBack(err: unknown): boolean {
	if (err instanceof AiError) return err.status >= 500;
	// SDK 的 APIError 带 status。4xx 是配置或请求本身的问题——模型别名网关不认、
	// 虚拟 key 被吊销、正文超了上下文——换一家只会把同一个错再犯一遍,还双倍计费,
	// 而且故障会被这层重试盖住、没人知道专线坏了。只有 429 与 5xx、以及压根没有
	// status 的连接错误/超时(那是网络或那台机器的问题)才走退路。
	const status = (err as { status?: unknown } | null)?.status;
	if (typeof status === "number") return status >= 500 || status === 429;
	return true;
}

/**
 * The single seam every AI call in this product goes through — Worker 的向导
 * 与「对编辑说一句」、Lambda 的编辑调用都从这里出去。
 * 带 fallback 的配置(站长专线)失败时用退路重试一次:任务失败比多花几毛钱严重。
 */
export async function complete(cfg: AiConfig, input: CompleteInput): Promise<CompleteResult> {
	if (!cfg.fallback) {
		try {
			return await completeOnce(cfg, input);
		} catch (err) {
			// 只重来这一类:上游是好的,只是这一次没按 JSON 说话。上游故障重来也是白花钱
			if (!(err instanceof JsonShapeError)) throw err;
			console.error("[json-retry] 产出解析不了,原样再要一次");
			// 记账在**发出去之前**:这一发失败时 token 同样烧掉了(见 onRetry 的注释)
			try {
				input.onRetry?.({ reason: err.message.slice(0, 200), provider: resolveProvider(cfg) });
			} catch (e) {
				// 记账挂了不该把这次生成一起拖下水(同 onFallback)
				console.error("[json-retry] onRetry threw", e);
			}
			return completeOnce(cfg, input);
		}
	}
	try {
		return await completeOnce(cfg, input);
	} catch (err) {
		if (!shouldFallBack(err)) throw err;
		const reason = err instanceof Error ? `${err.name}: ${err.message.slice(0, 200)}` : String(err);
		const from = resolveProvider(cfg);
		const to = resolveProvider(cfg.fallback);
		console.error(`[owner-route] ${from}/${cfg.model ?? "-"} failed, falling back to ${to}: ${reason}`);
		// 记账在**发出去之前**:这一发失败时 token 同样烧掉了(见 onFallback 的注释)
		try {
			input.onFallback?.({ reason, from, to });
		} catch (e) {
			// 记账挂了不该把这次生成一起拖下水
			console.error("[owner-route] onFallback threw", e);
		}
		const out = await completeOnce(cfg.fallback, input);
		return { ...out, fellBack: true };
	}
}

/**
 * 一次调用 + 交付前验收。json 调用在这里把「是不是合法 JSON」验掉,而不是留给
 * 各个调用方自己 JSON.parse:验在这一层,失败才落进 complete() 的退路/重试机制
 * (2026-08-30 那次就是坏 JSON 从这里溜出去,parseResult 才炸,退路根本没机会触发)。
 * 返回的 text 是归一化过的——调用方拿到的一定是能 parse 的那一段。
 */
async function completeOnce(cfg: AiConfig, input: CompleteInput): Promise<CompleteResult> {
	const res = await completeRaw(cfg, input);
	// mock 的产出本来就不是 JSON(零配置演示),不参与验收,行为与改动前一致
	if (!input.json || res.provider === "mock") return res;
	const json = extractJsonText(res.text);
	if (json === null) {
		logUnparsable(res.provider, res.model, res.text);
		throw new JsonShapeError();
	}
	return { ...res, text: json };
}

async function completeRaw(cfg: AiConfig, input: CompleteInput): Promise<CompleteResult> {
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
	// SDK 路径没有 response_format:json 调用靠一句系统提示约束,再由 stripJsonFence 兜底
	const system = input.json ? [input.system, JSON_ONLY_HINT].filter(Boolean).join("\n\n") : input.system;
	// 流式而不是一次性:长调用在 thinking 阶段几分钟没字节,非流式会撞 Node/边缘的
	// 空闲超时(deepseek 路径同一个教训);顺带把快车道的 onDelta 在这条路上也接通。
	const stream = client.messages.stream(
		{
			model,
			max_tokens: maxTokens(cfg),
			...(system ? { system } : {}),
			messages: [{ role: "user", content: input.prompt }],
		},
		// SDK 自己也会重试(默认 maxRetries),信号同样管得住它
		{ signal: input.signal },
	);
	if (input.onDelta) stream.on("text", (delta) => input.onDelta?.(delta));
	const message = await stream.finalMessage();

	// Safety classifiers can decline with HTTP 200 + stop_reason "refusal";
	// content may be empty, so check before reading it.
	if (message.stop_reason === "refusal") {
		throw new AiError("The model declined this request.", 422);
	}
	// 和 deepseek 的 finish=length 同一件事:产出被预算截断,拿到的是半截
	if (message.stop_reason === "max_tokens") {
		throw new AiError("模型输出被 max_tokens 截断,请调大 AI_MAX_OUTPUT_TOKENS。", 502);
	}

	const raw = message.content
		.filter((block) => block.type === "text")
		.map((block) => block.text)
		.join("");
	// 去围栏不在这里做了:json 调用统一由 completeOnce 的 extractJsonText 归一
	return { text: raw, provider, model: message.model };
}
