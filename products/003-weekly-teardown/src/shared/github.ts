// GitHub 接入层(docs/02 决策 T3 / T5)。**只管「怎么把请求安全地发出去」**,
// 不认识档案、不认识周扫、不碰 D1——发现层的编排在 worker/scan.ts,规则判断在
// scan-rules.ts。分开是为了让 scripts/recall-check.ts 能在 Worker 之外原样用它
// 跑真实网络查全验收(那个脚本没有 D1、没有 env、没有 Hono)。
//
// 这一层要处理的硬约束全在 docs/02,逐条落在下面的注释里:
//   ① 强制 User-Agent,不带直接 403;
//   ② Search 每查询最多翻到 1000 条,per_page 上限 100;
//   ③ Search 限额 30 次/分钟,**账号级共享桶**(PAT 不是按用户分的);
//   ④ REST core:PAT 5000/h、匿名 60/h;
//   ⑤ 所有对外 fetch 必须挂超时。

import type { RuleInput } from "./scan-rules.ts";

/**
 * GitHub API **强制**要求 User-Agent,不设直接 403。
 *
 * 写在这里当唯一真源(index.ts 的 spike 有一份同名常量,那是阶段 0 的独立
 * 探针,故意不互相依赖)。**「Worker 请求 GitHub 报 403」最常见的原因就是它,
 * 别误判成出口 IP 被封**——两者的排查方向完全相反,一个改一行头,一个要
 * 换整个方案。
 */
export const GITHUB_UA = "nanisle-weekly-teardown";

/** 默认 API 根。测试把它指向本地假服务器(见 scan.test.ts),生产不配。 */
export const GITHUB_API_BASE = "https://api.github.com";

/** 源码正文的默认根(阶段 7 节 2)。它不吃 API 额度,也不回 x-ratelimit-* 头。 */
export const GITHUB_RAW_BASE = "https://raw.githubusercontent.com";

/** github.com 的默认根:releases.atom 和所有永久回链的宿主。 */
export const GITHUB_WEB_BASE = "https://github.com";

/**
 * 单份源码正文截断到多少个字符(阶段 7 节 2,docs/01 决策 7 第 3 步的「前 12KB」)。
 *
 * **按字符不按字节**:12KB 是文档里的说法,而 slice 是按 UTF-16 码元切的。
 * 按字节切要先编码再解码,而中文注释密集的源码在字节边界上切下去会截出半个字
 * (渲染成 �),那半个字还会进锚定的底本 —— 一条本来该命中的引文会因为底本
 * 缺了半个字而判失败。宁可让「12KB」在中文文件上实际是 12288 个字符(约 36KB),
 * 也不要一个会安静地把锚定判错的边界。
 */
export const RAW_FILE_MAX_CHARS = 12_288;

/**
 * 单次请求的超时。002 的教训(2026-08-25 用户反馈「找信源无超时无重试」):
 * 无超时的 fetch 遇上黑洞丢包**永不 settle**,整趟周扫挂死到边缘 524,
 * 而站长拿到的是一个没有任何信息的错误页。同款规矩见 index.ts 的
 * PROBE_TIMEOUT_MS 和 002 的 extract.ts / interop.ts。
 */
export const GITHUB_TIMEOUT_MS = 12_000;

/**
 * Search 结果的硬顶:每个查询最多只能翻到 1000 条(`total_count` 显示 8 万
 * 也一样),`per_page` 上限 100。这个数字要出现在诚实声明里——它把
 * docs/01 风险 1「残缺但看起来完整」从「取决于提示词写得好不好」变成了
 * **「部分残缺是 API 层面注定的」**,那是两种不同的话,不能混着说。
 */
export const SEARCH_RESULT_CAP = 1000;

/** 每条检索词每一路取多少个。取头部即可(docs/02:每路 30 条量级)。 */
export const SEARCH_PER_PAGE = 30;

/**
 * 剩余额度低于它就先睡到 reset。留 5 次余量而不是等到 0:
 * ① 同一个 PAT 是**账号级共享桶**,别的用户(或周一早上的 cron 扇出)随时
 *    可能在我们两次请求之间把桶抽干,留 0 等于把「还能不能发」这件事赌在
 *    没有别人上;② 撞到 403 之后 GitHub 会把我们拉进更长的惩罚窗口,
 *    代价远大于提前几秒钟睡一觉。
 */
export const RATE_FLOOR = 5;

/**
 * 一份空的额度状态。cron 在整趟开头建一个,传给每个用户的 client
 * (GithubClientOptions.rateState),让退避跨用户连续。
 */
export function newRateState(): RateState {
	return {
		search: { limit: null, remaining: null, reset: null },
		core: { limit: null, remaining: null, reset: null },
		authenticated: false,
	};
}

export type SearchSort = "stars" | "updated";

/** 我们真正用得上的那几个字段。search 和 GET /repos 返回的形状在这几列上是一致的。 */
export interface GithubRepo extends RuleInput {
	/** "owner/repo"。全流程的唯一键(D1 里 scan_candidate 的联合主键之一)。 */
	fullName: string;
	description: string | null;
	topics: string[];
	language: string | null;
	/** fork 出来的仓。规则层不判它(docs/02 没这条规则),但形态描述那一步要知道。 */
	isFork: boolean;
	htmlUrl: string;
	/**
	 * 默认分支名。阶段 7 加的:节 2 要把它解析成一个 **commit sha**
	 * (`GET /repos/{o}/{r}/commits/{branch}`),永久回链才写得出
	 * `blob/<sha>/<path>#L12`。缺省 "main" —— GitHub 从 2020 起新仓都是 main,
	 * 老仓 master 的返回里这个字段一定在,落到缺省值的只有「字段整个没返回」
	 * 这种畸形响应,那时候猜 main 和猜别的一样,至少不炸。
	 */
	defaultBranch: string;
}

/** 一个额度桶的即时快照(直接来自响应头)。null = 这个桶还没被打过。 */
export interface RateSnapshot {
	limit: number | null;
	remaining: number | null;
	/** epoch **秒**,GitHub 的 x-ratelimit-reset 原样。 */
	reset: number | null;
}

/** 两个桶:search 和 core 是分开计的,不能混用一个计数器。 */
export interface RateState {
	search: RateSnapshot;
	core: RateSnapshot;
	/** 带 PAT = 5000/h + search 30/min;不带 = 60/h + search 10/min。台账要露出来。 */
	authenticated: boolean;
}

export class GithubError extends Error {
	readonly status: number;
	constructor(message: string, status: number) {
		super(message);
		this.name = "GithubError";
		this.status = status;
	}
}

/**
 * 「要等的时间超过了这趟的预算」。**不是故障**,是这趟跑不完了——调用方要把
 * 它翻译成台账上一句诚实的「这周只跑了 N 条检索词就停了」,而不是 500。
 */
export class RateBudgetError extends GithubError {
	readonly waitMs: number;
	constructor(waitMs: number) {
		super(`GitHub 配额要等 ${Math.round(waitMs / 1000)} 秒,超过这趟的预算`, 429);
		this.name = "RateBudgetError";
		this.waitMs = waitMs;
	}
}

/**
 * 「这个错该不该让整条循环停下来」——**判据只有一份**,措辞各调用点自己写。
 *
 * 为什么要抽出来:门 1(scan.ts gateStopReason)和阶段 9 的复查(cron.ts
 * recheckStopReason)问的是同一个问题——「这一发失败是这个仓的事,还是 GitHub
 * 侧的事」。而它们的答案必须一致:限流之后继续打会被 GitHub 拉进**更长的惩罚
 * 窗口**(决策 T5),而那个桶是全站共用的。两处各写一份 `instanceof` 链的话,
 * 迟早有一处漏掉某一类(最可能漏的是 RateBudgetError 必须排在 GithubError
 * 之前 —— 它是 GithubError 的子类,status 恰好也是 429),而漏掉的症状是
 * 「限流之后又打了十几发」,只有在 GitHub 那边看得见。
 *
 * 只回**类别**不回句子:两个调用点的场景不同(「门 1 撞上限流,这一趟停在这里」
 * vs「复查停在这里」),硬凑一句通用文案只会两边都别扭。
 *
 *   budget     RateBudgetError:要睡的时间超过这趟预算。**不是故障**。
 *   ratelimit  403 / 429:GitHub 在限流。继续打会更糟。
 *   aborted    整趟的信号响了(AbortSignal.timeout 抛 name=TimeoutError 的 DOMException)。
 *              **不含单发请求自己的 12 秒超时**——那一发超时只说明这一个仓
 *              抓不通,下一个仓完全可能正常。两者的 name 一样,靠的是单发超时
 *              被 linkedSignal 包在 request() 里、抛出来的是同一个 name 但由
 *              调用方按「普通失败」计数(见 scan.ts GATE_ERROR_STREAK)。
 *   null       只是这一发失败,循环该继续。
 */
export type HardStop = "budget" | "ratelimit" | "aborted";

export function hardStopKind(err: unknown): HardStop | null {
	// RateBudgetError 必须排在 GithubError 前面:它是子类,status 也是 429。
	if (err instanceof RateBudgetError) return "budget";
	if (err instanceof GithubError && (err.status === 403 || err.status === 429)) return "ratelimit";
	if (err instanceof Error && (err.name === "TimeoutError" || err.name === "AbortError")) return "aborted";
	return null;
}

interface RawRepo {
	full_name?: unknown;
	stargazers_count?: unknown;
	pushed_at?: unknown;
	created_at?: unknown;
	archived?: unknown;
	license?: { spdx_id?: unknown } | null;
	description?: unknown;
	topics?: unknown;
	language?: unknown;
	fork?: unknown;
	html_url?: unknown;
	default_branch?: unknown;
}

/**
 * 原始 JSON → GithubRepo。字段缺失一律给保守缺省值(不是抛错):GitHub 偶尔
 * 会在某些仓上省掉 topics/language,为此丢掉整条结果不划算。
 *
 * **license 的 null 有两种来源,这里只认一种**:`license: null`(仓库根本没有
 * 许可证文件)映射成 null,规则层据此判「没有许可证」。而 `spdx_id` 为
 * "NOASSERTION"(GitHub 认出有许可证文件但识别不出是哪个)原样保留成
 * "NOASSERTION" —— 它**不该**被当成「没有许可证」,那句排除理由会是假的。
 * 它也不在 COPYLEFT_SPDX 里,所以两条许可证规则都不命中,仓照常进清单。
 */
export function mapRepo(raw: RawRepo): GithubRepo | null {
	const fullName = typeof raw.full_name === "string" ? raw.full_name : "";
	if (!fullName.includes("/")) return null;
	const spdx = raw.license && typeof raw.license === "object" ? raw.license.spdx_id : null;
	return {
		fullName,
		stars: typeof raw.stargazers_count === "number" ? raw.stargazers_count : 0,
		pushedAt: typeof raw.pushed_at === "string" ? raw.pushed_at : "",
		createdAt: typeof raw.created_at === "string" ? raw.created_at : "",
		archived: raw.archived === true,
		license: typeof spdx === "string" && spdx ? spdx : null,
		description: typeof raw.description === "string" ? raw.description : null,
		topics: Array.isArray(raw.topics) ? raw.topics.filter((t): t is string => typeof t === "string") : [],
		language: typeof raw.language === "string" ? raw.language : null,
		isFork: raw.fork === true,
		htmlUrl: typeof raw.html_url === "string" ? raw.html_url : `https://github.com/${fullName}`,
		defaultBranch: typeof raw.default_branch === "string" && raw.default_branch ? raw.default_branch : "main",
	};
}

/**
 * 把 "owner/repo" 编码进 URL 路径。**逐段编码后再拼**,不是整串编码——
 * 整串编码会把那条斜杠也变成 %2F,路径就不对了。
 *
 * 为什么需要它(2026-09-01 阶段 4 评审 + 阶段 5):`fullName` 原来只可能来自
 * GitHub 自己的返回值,直接插值是安全的;而阶段 5 的申诉端点
 * (`POST /api/scan/appeal`)是**第一个把用户输入送进这条路的调用方**。
 * 不编码的话 `a/b/../../users/x` 会被 URL 规范化成另一个端点,`a/b?per_page=1`
 * 能往查询串里塞东西——请求语义被调用方以外的人改写了,而 mapRepo 对 fullName
 * 的唯一校验只有 `includes("/")`,拦不住这两种。
 *
 * 编码是**第二道**门:申诉端点在调进来之前还有一条 `^[A-Za-z0-9._-]+/[...]+$`
 * 的形状校验(scan.ts APPEAL_NAME_RE)。两道都留着,因为将来会有第三个调用方,
 * 而它不一定记得抄那条正则。
 */
function encodePath(fullName: string): string {
	return fullName.split("/").map(encodeURIComponent).join("/");
}

const intHeader = (h: Headers, name: string): number | null => {
	const raw = h.get(name);
	if (raw === null) return null;
	const n = Number.parseInt(raw, 10);
	return Number.isFinite(n) ? n : null;
};

export interface GithubClientOptions {
	/** 不设 = 匿名档。真跑真数据,只是额度从 5000/h 掉到 60/h(docs/02 决策 T5)。 */
	pat?: string;
	/** 整趟的截止时刻(epoch ms)。退避要睡过这条线时不睡,抛 RateBudgetError。 */
	deadline?: number;
	/** 整趟的取消信号。每个请求的超时会和它合并,两者任一响就立刻停。 */
	signal?: AbortSignal;
	/** 测试用:指向本地假服务器。生产不配。 */
	apiBase?: string;
	/**
	 * 源码正文的根(默认 https://raw.githubusercontent.com)。测试用。
	 *
	 * 为什么和 apiBase 分开而不是从它推:节 2 要打三个**不同的主机**
	 * (api.github.com / raw.githubusercontent.com / github.com),生产上它们
	 * 各是各的;测试里三个都指到同一台假服务器的不同前缀。让调用方显式说清楚
	 * 三个根分别是什么(env.ts 的 githubBases),比在这里写一段「如果配了
	 * apiBase 就把 /__raw 接在后面」的隐式规则好——那种规则只有写的人知道。
	 */
	contentBase?: string;
	/** github.com 的根(releases.atom 和永久回链的宿主)。默认 https://github.com。测试用。 */
	webBase?: string;
	/**
	 * **整趟共用的额度状态**(阶段 8 的 cron 用)。传进来就不再新建一份,
	 * 于是多个 client 实例读写的是同一份 remaining / reset。
	 *
	 * 为什么需要它:PAT 是**账号级共享桶**(决策 T5),而 cron 要串行给 N 个用户
	 * 各跑一趟周扫。每个用户各 new 一个 client 的话,新 client 的 remaining 是
	 * null——throttle() 直接放行,第一发就打出去了。上一个用户刚好把桶抽到 0、
	 * reset 还在 40 秒之后时,这一发换回来的是 403,而 **403 之后继续打会被
	 * GitHub 拉进更长的惩罚窗口**。也就是说「每人一个 client」等于每个用户开头
	 * 都把退避归零一次,退避写了等于没写。
	 *
	 * 只共享额度状态,不共享 deadline / signal / calls / waitedMs:那几样是
	 * **每个用户各自的**(每人一份台账、每人一份预算),混在一起反而说不清。
	 */
	rateState?: RateState;
	fetchImpl?: typeof fetch;
	/**
	 * 测试用:单次请求的超时,默认 GITHUB_TIMEOUT_MS(12 秒)。
	 *
	 * 为什么需要它:二次限流那条路要「先 sleep 再打第二发」,而它的 bug 形态
	 * 正是「第一发的超时定时器烧到了第二发头上」(见 request() 的注释)。要在
	 * 单测里复现,必须让**超时比 sleep 短**——而真实的 12 秒超时意味着测试要
	 * 真等 12 秒以上。把这个值调成 50ms、sleep 调成 100ms,同一个 bug 用
	 * **真 setTimeout** 就能在 0.1 秒里复现出来。生产不配。
	 */
	timeoutMs?: number;
	now?: () => number;
	/** 测试用:把真的 sleep 换成记账,免得单测真等 60 秒。 */
	sleep?: (ms: number) => Promise<void>;
}

const realSleep = (ms: number) => new Promise<void>((r) => setTimeout(r, ms));

/**
 * 整趟信号响了的时候用它当抛出去的东西。`AbortSignal.timeout()` 的 reason 是
 * 一个 `TimeoutError` DOMException,原样抛出去和 fetch 被掐断时抛的是同一个,
 * 调用方的 catch 不用为「在睡觉时被取消」多写一个分支。
 */
function abortReason(signal: AbortSignal): unknown {
	return signal.reason ?? new Error("github: 整趟已取消");
}

/**
 * 把「整趟的信号」和「这一次请求的超时」合成一个。
 *
 * 不用 `AbortSignal.any()`:它在 workerd 和 node 上都有,但这一层是
 * recall-check 脚本也要用的,而那个脚本是拿 node 直接跑的裸 TS——多一个
 * 运行时特性依赖就多一处「在另一台机器上莫名其妙不工作」。十行手写的
 * 组合器没有这个问题,而且看得见它到底在等什么。
 *
 * 返回值里的 `done()` 必须在请求结束后调:不解绑监听器的话,一个长命的
 * 整趟信号会挂着几十个已经用完的 controller(周扫一趟几十个请求)。
 */
function linkedSignal(outer: AbortSignal | undefined, timeoutMs: number): { signal: AbortSignal; done: () => void } {
	const ac = new AbortController();
	const timer = setTimeout(() => ac.abort(new Error(`github: ${timeoutMs}ms 超时`)), timeoutMs);
	const onOuter = () => ac.abort(outer?.reason);
	if (outer) {
		if (outer.aborted) ac.abort(outer.reason);
		else outer.addEventListener("abort", onOuter, { once: true });
	}
	return {
		signal: ac.signal,
		done: () => {
			clearTimeout(timer);
			outer?.removeEventListener("abort", onOuter);
		},
	};
}

/** 递归文件树里的一个 blob。目录(tree)和子模块(commit)在 getTree 里就滤掉了。 */
export interface TreeEntry {
	path: string;
	/** 字节数。GitHub 只对 blob 给这个字段,>100KB 的在挑文件那一步被排除。 */
	size: number;
	sha: string;
}

/** changelog atom 截断到多少字符。10 条 release 的 atom 通常 20-40KB。 */
export const ATOM_MAX_CHARS = 64_000;

/**
 * GitHub contents API 的 base64(带换行)→ UTF-8 文本。解不出来回 null。
 *
 * 为什么不能直接用 `atob()` 的结果:atob 回的是一个「每个字符 = 一个字节」的
 * 二进制串,里面的中文是拆散的 UTF-8 字节。直接当字符串用,README 里的中文
 * 会变成一串乱码 —— 而这份文本是**锚定的底本**,底本乱了,模型引对了的句子
 * 也会判成没锚上。必须过一遍 TextDecoder 把字节重新拼成字符。
 */
export function decodeBase64Utf8(b64: string): string | null {
	try {
		const bin = atob(b64.replace(/\s+/g, ""));
		const bytes = new Uint8Array(bin.length);
		for (let i = 0; i < bin.length; i++) bytes[i] = bin.charCodeAt(i);
		return new TextDecoder().decode(bytes);
	} catch {
		return null;
	}
}

/**
 * 串行的 GitHub 客户端。**这个类没有任何并发入口**——所有方法都是
 * `await` 一次一个请求,而且共享同一份额度状态。
 *
 * 为什么必须串行(docs/02 决策 T5):PAT 是**账号级共享桶**,search 限额
 * 30 次/分钟对整个账号有效,不是按用户分的。`Promise.all(queries.map(...))`
 * 在单个用户身上就能瞬间打出 12 个 search,周一早上 cron 扇出几个用户就
 * 直接吃 403;而 403 之后不退避会被 GitHub 拉进更长的惩罚窗口。并发在这里
 * 换不到吞吐,只换来惩罚——共享桶的约束不会因为并发而消失。
 *
 * 退避**按响应头**而不是固定 sleep:固定 sleep 要么太短(还是撞墙)要么
 * 太长(白等),而 x-ratelimit-remaining / x-ratelimit-reset 是 GitHub 自己
 * 报的真实剩余,睡到 reset 那一刻醒来就一定有额度。
 */
export class GithubClient {
	readonly rate: RateState;
	private readonly pat: string | undefined;
	private readonly base: string;
	private readonly contentBase: string;
	private readonly webBase: string;
	private readonly doFetch: typeof fetch;
	private readonly timeoutMs: number;
	private readonly now: () => number;
	private readonly deadline: number | undefined;
	private readonly signal: AbortSignal | undefined;
	/** 注入的假 sleep(测试用假时钟);真档是 realSleep。**别直接调它,调 nap()。** */
	private readonly rawSleep: (ms: number) => Promise<void>;
	/**
	 * 实际发出去的请求数,分桶记。台账和成本讨论都要它。
	 *
	 * `raw` 是阶段 7 加的第三个桶:raw.githubusercontent.com 和 github.com 的
	 * releases.atom **不吃 API 的额度**(它们不回 x-ratelimit-* 头),所以不能
	 * 记进 core —— 记进去会让退避逻辑按一个假的剩余额度去睡觉。单独一个计数器
	 * 只为了「这趟到底打了多少次外网」说得清。
	 */
	readonly calls = { search: 0, core: 0, raw: 0 };
	/** 因为额度不够真的睡了多久(毫秒)。跑得慢的时候要能说清是谁的锅。 */
	waitedMs = 0;

	constructor(opts: GithubClientOptions = {}) {
		this.pat = opts.pat?.trim() || undefined;
		this.base = (opts.apiBase ?? GITHUB_API_BASE).replace(/\/+$/, "");
		this.contentBase = (opts.contentBase ?? GITHUB_RAW_BASE).replace(/\/+$/, "");
		this.webBase = (opts.webBase ?? GITHUB_WEB_BASE).replace(/\/+$/, "");
		// **必须包一层,不能写成 `opts.fetchImpl ?? fetch`。**
		//
		// 把全局 fetch 存进一个字段再用 `this.doFetch(...)` 调,receiver 就从
		// globalThis 变成了这个 GithubClient 实例。node 不管这件事,workerd 管:
		// 它会抛 `Illegal invocation: function called with incorrect 'this'
		// reference`。2026-09-01 阶段 4 实测踩到——`npm test`(node)全绿、
		// recall-check(node)5/5,一放到 `wrangler dev` 上 16 路 search **全部**
		// 失败,而且失败得很体面:每一路都进了 trace 的 error,台账如实写着
		// returned: 0,页面上会显示一份「这周什么都没捞到」的正常结果。
		// 也就是说这个 bug 在两个纯 node 的验证里都看不见,只有真的在 workerd
		// 上跑一次才现形。
		this.doFetch = opts.fetchImpl ?? ((input, init) => fetch(input, init));
		this.timeoutMs = opts.timeoutMs && opts.timeoutMs > 0 ? opts.timeoutMs : GITHUB_TIMEOUT_MS;
		this.now = opts.now ?? Date.now;
		this.rawSleep = opts.sleep ?? realSleep;
		this.deadline = opts.deadline;
		this.signal = opts.signal;
		// 注入了就用注入的那一份(cron 整趟共用);没注入就是自己一份。
		// authenticated 无论如何都按本实例的 pat 重写一次:同一趟里 pat 是同一个,
		// 但让它取决于「谁先建的 client」是一种没必要的隐式依赖。
		this.rate = opts.rateState ?? {
			search: { limit: null, remaining: null, reset: null },
			core: { limit: null, remaining: null, reset: null },
			authenticated: false,
		};
		this.rate.authenticated = Boolean(this.pat);
	}

	/**
	 * 睡一觉,**但整趟信号响了就当场醒**(2026-09-01 阶段 7 评审的必须修 1)。
	 *
	 * 为什么必须这么写:`realSleep` 是一个裸 `setTimeout`,它不认 AbortSignal。
	 * 于是 `AbortSignal.timeout(180_000)` 只能掐断 fetch,**掐不断 sleep**——
	 * 二次限流那条路上 `retry-after` 的值由上游给(兜底默认 60 秒,GitHub 真
	 * 发过 3600),主限流那条路上 `waitMs` 最大接近一小时。整趟预算早就过了,
	 * 这个 Promise 还老老实实躺在那儿等,而外面的 `waitUntil` 就跟着挂那么久:
	 * 页面每 10 秒收一个心跳、一直转圈,`inflight` 挡着重试,额度已经扣掉。
	 *
	 * `deadline` 挡的是「明知睡不起就别睡」(assertRoomToWait),这一条挡的是
	 * 「睡到一半外面已经不要了」。两条都要:前者算的是预算,后者认的是事实。
	 */
	private async nap(ms: number): Promise<void> {
		const outer = this.signal;
		if (!outer) return this.rawSleep(ms);
		if (outer.aborted) throw abortReason(outer);
		let onAbort: () => void = () => {};
		try {
			await Promise.race([
				this.rawSleep(ms),
				new Promise<never>((_resolve, reject) => {
					onAbort = () => reject(abortReason(outer));
					outer.addEventListener("abort", onAbort, { once: true });
				}),
			]);
		} finally {
			// 不解绑的话,一个长命的整趟信号会挂着几十个已经睡完的监听器
			outer.removeEventListener("abort", onAbort);
		}
	}

	private headers(): Record<string, string> {
		const h: Record<string, string> = {
			// ① 这一行不能少,少了就是 403(见 GITHUB_UA 的注释)
			"user-agent": GITHUB_UA,
			accept: "application/vnd.github+json",
			"x-github-api-version": "2022-11-28",
		};
		if (this.pat) h.authorization = `Bearer ${this.pat}`;
		return h;
	}

	/**
	 * 发请求之前先看看这个桶还剩多少。剩余 < RATE_FLOOR 就睡到 reset。
	 *
	 * 睡之前先和这趟的预算比:睡过头会让一个 HTTP 请求撞上 CF 那条 100 秒线,
	 * 用户拿到 524(什么都看不见)而不是一份「只跑了 3 条检索词」的诚实台账。
	 * 所以宁可抛 RateBudgetError 让调用方提前收工——**跑不完和跑挂了是两件事,
	 * 台账要能分得出来**。
	 */
	private async throttle(bucket: "search" | "core"): Promise<void> {
		const snap = this.rate[bucket];
		if (snap.remaining === null || snap.remaining >= RATE_FLOOR || snap.reset === null) return;
		// +1000ms:reset 是秒级的,踩着那一秒醒来有可能还差一点
		const waitMs = snap.reset * 1000 - this.now() + 1000;
		if (waitMs <= 0) return;
		this.assertRoomToWait(waitMs);
		this.waitedMs += waitMs;
		await this.nap(waitMs);
	}

	/**
	 * 「睡完还来得及打一发吗」。睡不起就一秒都别等,直接抛 RateBudgetError。
	 *
	 * **算的是 sleep + 一整发请求,不只是 sleep**(2026-09-01 阶段 4/5 评审):
	 * 只比 sleep 的话,会出现「老老实实等满 60 秒,醒来发现预算只剩 2 秒,
	 * 第二发当场超时」——白等一轮,还换回来一个假的「超时」错误。等不起就
	 * 提前收工,让调用方写一句诚实的 stopped,那才是这个类对预算的全部承诺。
	 */
	private assertRoomToWait(waitMs: number): void {
		if (this.deadline === undefined) return;
		if (this.now() + waitMs + this.timeoutMs > this.deadline) throw new RateBudgetError(waitMs);
	}

	/**
	 * 发一发。**每一发都新建自己的超时信号**,这是这个方法存在的唯一理由。
	 *
	 * 2026-09-01 阶段 4/5 评审实测的 bug:原来 `request()` 在最外层建一次
	 * `linkedSignal`,然后二次限流那条路先 `sleep(retry-after)` 再拿**同一个**
	 * signal 打第二发。而 retry-after 的典型值是 60 秒、代码自己的兜底默认也是
	 * 60,超时定时器(12 秒)在 sleep 期间就烧掉了,第二发拿到一个已经 aborted
	 * 的信号,当场 reject:
	 *
	 *   THREW: Error | github: 12000ms 超时 | calls= 2 elapsed= 13039
	 *
	 * 后果不是「慢」,是**白等一轮再报一个假的超时**——而调用方(scan.ts)把
	 * 「超时」当普通失败继续往下打,正是决策 T5 说的「403 之后不退避会被 GitHub
	 * 拉进更长的惩罚窗口」。
	 *
	 * 为什么单测没抓到:github.test.ts 的 sleep 是假的(只推假时钟,真实耗时
	 * 0ms),12 秒的**真**定时器根本没机会响。和 workerd 那条
	 * `Illegal invocation` 是同一个形状——纯 node 的绿不构成保证。所以那条新
	 * 用例用的是真 setTimeout(超时 50ms、sleep 100ms)。
	 */
	private async attempt(url: string): Promise<Response> {
		// ⑤ 每一次对外 fetch 都挂超时,一次都不能漏
		const link = linkedSignal(this.signal, this.timeoutMs);
		try {
			return await this.doFetch(url, { headers: this.headers(), signal: link.signal });
		} finally {
			link.done();
		}
	}

	/** 把响应头里的额度抄进状态。GitHub 每个响应都带,不用额外打 /rate_limit。 */
	private absorb(bucket: "search" | "core", h: Headers): void {
		const remaining = intHeader(h, "x-ratelimit-remaining");
		const reset = intHeader(h, "x-ratelimit-reset");
		const limit = intHeader(h, "x-ratelimit-limit");
		const snap = this.rate[bucket];
		if (remaining !== null) snap.remaining = remaining;
		if (reset !== null) snap.reset = reset;
		if (limit !== null) snap.limit = limit;
	}

	/**
	 * @param bucket null = 这个 URL 不吃 API 额度(raw.githubusercontent.com /
	 *   github.com)。不限速、不读额度头,只记 calls.raw —— 拿一个不存在的额度
	 *   去 throttle,会让一次 raw 取正文因为 API 桶快空了而白睡 60 秒。
	 *   超时、整趟信号、二次限流的 retry-after 这三样对它照样有效。
	 */
	private async request(bucket: "search" | "core" | null, url: string): Promise<Response> {
		if (bucket) await this.throttle(bucket);
		if (bucket) this.calls[bucket] += 1;
		else this.calls.raw += 1;
		const res = await this.attempt(url);
		if (bucket) this.absorb(bucket, res.headers);
		// 二次限流:GitHub 在突发时会回 403/429 + retry-after(秒),这一路
		// 不走 x-ratelimit-remaining。睡一次再来一次,仍然失败就交给调用方。
		if ((res.status === 403 || res.status === 429) && res.headers.has("retry-after")) {
			const retryMs = (Number.parseInt(res.headers.get("retry-after") ?? "", 10) || 60) * 1000;
			await res.body?.cancel();
			this.assertRoomToWait(retryMs);
			this.waitedMs += retryMs;
			await this.nap(retryMs);
			if (bucket) this.calls[bucket] += 1;
			else this.calls.raw += 1;
			// **新的超时信号**,不是上面那一发用剩的那个(见 attempt() 的注释)。
			const again = await this.attempt(url);
			if (bucket) this.absorb(bucket, again.headers);
			return again;
		}
		return res;
	}

	/**
	 * 一路检索。`sort` 就是双路里的那个「路」。
	 *
	 * per_page 钉在 SEARCH_PER_PAGE(30)、只取第一页:**不翻页**。翻页对查全
	 * 的帮助远小于它的代价——1000 条上限意味着翻到底也只是 1000/8 万,而每一页
	 * 都要吃一次那个 30 次/分钟的共享桶。多几条检索词、多一路排序,比在同一条
	 * 词上翻到第 10 页有用得多(docs/02 决策 T3 的整个立论)。
	 */
	async search(query: string, sort: SearchSort): Promise<{ repos: GithubRepo[]; totalCount: number }> {
		const url =
			`${this.base}/search/repositories?q=${encodeURIComponent(query)}` +
			`&sort=${sort}&order=desc&per_page=${SEARCH_PER_PAGE}`;
		const res = await this.request("search", url);
		if (!res.ok) {
			const body = await res.text().catch(() => "");
			throw new GithubError(`search ${sort} 失败:HTTP ${res.status} ${body.slice(0, 160)}`, res.status);
		}
		const json = (await res.json()) as { items?: unknown; total_count?: unknown };
		const items = Array.isArray(json.items) ? json.items : [];
		const repos: GithubRepo[] = [];
		for (const raw of items) {
			const repo = mapRepo(raw as RawRepo);
			if (repo) repos.push(repo);
		}
		return { repos, totalCount: typeof json.total_count === "number" ? json.total_count : repos.length };
	}

	/**
	 * 门 1(docs/02「结构性防捏造」):进候选清单的每个仓必须真的拿到 200。
	 *
	 * 404 / 451 / 410 返回 null(不是抛错)——那正是这道门要挡的东西:仓不在了、
	 * 改名了、被 DMCA 下架了。抛错会让调用方分不清「这个仓没了」和「GitHub 挂了」,
	 * 而前者要计进 fetch_failed 继续跑,后者该停下来。5xx 和别的状态照常抛。
	 */
	async getRepo(fullName: string): Promise<GithubRepo | null> {
		const res = await this.request("core", `${this.base}/repos/${encodePath(fullName)}`);
		if (res.status === 404 || res.status === 410 || res.status === 451) {
			await res.body?.cancel();
			return null;
		}
		if (!res.ok) {
			const body = await res.text().catch(() => "");
			throw new GithubError(`GET /repos/${fullName} 失败:HTTP ${res.status} ${body.slice(0, 160)}`, res.status);
		}
		return mapRepo((await res.json()) as RawRepo);
	}

	// -------------------------------------------------------------------------
	// 阶段 7 · 深度报告要的材料(docs/01 决策 7)
	// -------------------------------------------------------------------------

	/**
	 * 把一个分支名解析成**当时那一刻的 commit sha**。整个「永久回链」就靠它。
	 *
	 * `blob/main/foo.ts#L12` 这种链接会在对方下一次提交之后指向完全不同的代码,
	 * 而 `blob/<sha>/foo.ts#L12` 永远指向我们当时读到的那几行。**这就是「永久
	 * 回链」里「永久」两个字的全部含义**,不是修辞。
	 *
	 * 顺带回提交时间:节 1 的时间线要一个能核对的日期,而 `pushed_at` 是仓级的
	 * 聚合字段(fork 的 push 也会动它),这里拿到的是这条 sha 自己的时间。
	 *
	 * 404 → null(分支改名了 / 仓刚被删)。调用方据此收场,不是 500。
	 */
	async resolveCommit(fullName: string, ref: string): Promise<{ sha: string; date: string } | null> {
		const res = await this.request("core", `${this.base}/repos/${encodePath(fullName)}/commits/${encodeURIComponent(ref)}`);
		if (res.status === 404 || res.status === 409 || res.status === 422) {
			// 409/422:空仓(一个提交都没有)。它不是故障,是「没有源码可读」。
			await res.body?.cancel();
			return null;
		}
		if (!res.ok) {
			const body = await res.text().catch(() => "");
			throw new GithubError(`GET /commits/${ref} 失败:HTTP ${res.status} ${body.slice(0, 160)}`, res.status);
		}
		const json = (await res.json()) as { sha?: unknown; commit?: { committer?: { date?: unknown }; author?: { date?: unknown } } };
		const sha = typeof json.sha === "string" ? json.sha : "";
		if (!sha) return null;
		const date = json.commit?.committer?.date ?? json.commit?.author?.date;
		return { sha, date: typeof date === "string" ? date : "" };
	}

	/**
	 * 递归文件树。**GitHub 的硬顶是 10 万条目 / 7MB,超了它回 `truncated: true`
	 * 并且悄悄少给你一批条目** —— 少给的那批没有任何标记。
	 *
	 * 所以 `truncated` 必须原样回给调用方,由它决定退化行为(docs/02 开放问题:
	 * 截断就只读 README 并在报告里标注,**不做分层递归拉取**)。把 truncated
	 * 咽下去当没看见,产出的会是一份「我读了这个项目的源码」的报告,而它读的是
	 * 树的前一截 —— 那正是 docs/01 风险 1「残缺但看起来完整」。
	 */
	async getTree(fullName: string, sha: string): Promise<{ entries: TreeEntry[]; truncated: boolean } | null> {
		const res = await this.request(
			"core",
			`${this.base}/repos/${encodePath(fullName)}/git/trees/${encodeURIComponent(sha)}?recursive=1`,
		);
		if (res.status === 404 || res.status === 409 || res.status === 422) {
			await res.body?.cancel();
			return null;
		}
		if (!res.ok) {
			const body = await res.text().catch(() => "");
			throw new GithubError(`GET /git/trees 失败:HTTP ${res.status} ${body.slice(0, 160)}`, res.status);
		}
		const json = (await res.json()) as { tree?: unknown; truncated?: unknown };
		const entries: TreeEntry[] = [];
		if (Array.isArray(json.tree)) {
			for (const raw of json.tree) {
				const e = raw as { path?: unknown; type?: unknown; size?: unknown; sha?: unknown };
				if (typeof e.path !== "string" || e.type !== "blob") continue;
				entries.push({ path: e.path, size: typeof e.size === "number" ? e.size : 0, sha: typeof e.sha === "string" ? e.sha : "" });
			}
		}
		return { entries, truncated: json.truncated === true };
	}

	/**
	 * README 的**真实路径**和正文。走 `GET /repos/{o}/{r}/readme?ref=<sha>`,
	 * 而不是猜 `README.md` 去 raw 上拿。
	 *
	 * 为什么多花这一次 core 调用:README 的文件名有 README.md / README.rst /
	 * readme.markdown / docs/README.md 十几种写法,猜错的代价不是「少一个文件」
	 * —— 是节 2 在文件树被截断时**一个源都没有**,而那正是最需要它的时候。
	 * 让 GitHub 自己说它认哪个文件是 README,比我们维护一张后缀表可靠。
	 *
	 * 返回的 content 是 base64,而且带换行(GitHub 每 60 字符折一次)。
	 */
	async getReadme(fullName: string, ref: string): Promise<{ path: string; text: string } | null> {
		const res = await this.request("core", `${this.base}/repos/${encodePath(fullName)}/readme?ref=${encodeURIComponent(ref)}`);
		if (res.status === 404 || res.status === 403 || res.status === 422) {
			// 403 也当「没有」:超大 README 会被 contents API 拒掉,而那不是故障
			await res.body?.cancel();
			return null;
		}
		if (!res.ok) {
			const body = await res.text().catch(() => "");
			throw new GithubError(`GET /readme 失败:HTTP ${res.status} ${body.slice(0, 160)}`, res.status);
		}
		const json = (await res.json()) as { path?: unknown; content?: unknown; encoding?: unknown };
		const path = typeof json.path === "string" ? json.path : "README.md";
		if (typeof json.content !== "string" || json.encoding !== "base64") return null;
		const text = decodeBase64Utf8(json.content);
		return text === null ? null : { path, text: text.slice(0, RAW_FILE_MAX_CHARS) };
	}

	/**
	 * 一份源码正文,截断到 RAW_FILE_MAX_CHARS。**这是锚定的底本**:模型待会儿
	 * 给的引文要在这一份(且只在这一份)里逐字对得上,所以这里截了多少,
	 * 后面就只能认多少 —— 截断位置之后的内容对这份报告等于不存在。
	 *
	 * 走 raw.githubusercontent.com 而不是 contents API:contents API 回 base64
	 * 且对 >1MB 的文件直接拒,raw 是纯文本、没有大小门槛,还不吃 API 额度。
	 */
	async getRawFile(fullName: string, sha: string, filePath: string): Promise<string | null> {
		const encoded = filePath.split("/").map(encodeURIComponent).join("/");
		const res = await this.request(null, `${this.contentBase}/${encodePath(fullName)}/${encodeURIComponent(sha)}/${encoded}`);
		if (!res.ok) {
			await res.body?.cancel();
			return null;
		}
		return (await res.text()).slice(0, RAW_FILE_MAX_CHARS);
	}

	/**
	 * changelog:`github.com/{o}/{r}/releases.atom`(docs/01 决策 7 节 1)。
	 *
	 * 为什么用 atom 而不是 `GET /releases`:atom 不吃 API 额度,而节 1 只要
	 * 「哪天发了什么、说了什么」这几行,REST 那份多出来的 20 个字段一个都用不上。
	 * 拿不到就是 null —— 没有 release 的仓多得是,那不是错误,是一条时间线上
	 * 少两个节点。
	 */
	async getReleasesAtom(fullName: string): Promise<string | null> {
		const res = await this.request(null, `${this.webBase}/${encodePath(fullName)}/releases.atom`);
		if (!res.ok) {
			await res.body?.cancel();
			return null;
		}
		return (await res.text()).slice(0, ATOM_MAX_CHARS);
	}
}
