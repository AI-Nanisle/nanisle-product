// 阶段 3 · 一句话 → 关注档案(docs/01 决策 3、docs/02 决策 T2/T7)。
//
//   POST /api/dossier/draft   一句话拆成草稿(不落库,给用户先看先改)
//   GET  /api/dossier         取当前用户的档案(没有 = null,不是 404)
//   PUT  /api/dossier         保存(rev 服务端独占,四字段真变了才涨)
//   DELETE /api/dossier       删掉重来(连带清掉周扫/候选/排除/报告)
//
// 这个文件的相对 import 一律带 `.ts` 后缀,和 index.ts / sso.ts 的无后缀写法
// 不一样。理由同 guard.ts 顶部:`npm test` 用的是 node 的 --test,node 的 ESM
// 解析器不替你补后缀。校验函数和 rev 比对是这一阶段唯二有分支的纯逻辑,
// 必须能被 dossier.test.ts 直接 import 进来钉住。
//
// **这一层的立场**(来自 docs/01 决策 3,不是实现偏好):
//   1. sentence 是用户原话,AI 永不改写,保存时也不许改——它是用户判断
//      「我理解得对不对」的基准,基准动了这份档案就没法被质疑了。
//   2. notCaresAbout 比 caresAbout 值钱:它直接喂给周扫的排除清单,是这份
//      档案唯一能立刻产生可见效果的字段。
//   3. 模型在这里**只做翻译,不做回忆**:见 DRAFT_SYSTEM 里那一大段。

import { Hono } from "hono";
import { complete } from "../shared/ai.ts";
import { AiConfigError, AiError } from "../shared/ai.ts";
import type { AiConfig } from "../shared/ai.ts";
import { DOSSIER_LIMITS } from "../shared/types.ts";
import type { Dossier, DossierFields, GetDossierResponse } from "../shared/types.ts";
import { countDossierChildren, createDossier, deleteDossierCascade, getDossier, updateDossier } from "../shared/store.ts";
import type { Dossier as StoreDossier } from "../shared/store.ts";
import { draftBudgetMs, fastAiConfigFor } from "./env.ts";
import { reserveOrDeny, userAiGuard, userGuard } from "./guard.ts";
import type { Guarded } from "./guard.ts";

/**
 * 编译期钉死两份 Dossier 不许分叉:`shared/types.ts` 的那份给前端用
 * (不带 D1 类型),`shared/store.ts` 的那份是 D1 行映射出来的。两边加减字段
 * 都会让下面这两行报错,`npm run check` 当场拦住——比「前端少读一个字段,
 * 页面上安静地空着」好找一万倍。
 */
type _StoreIsWire = StoreDossier extends Dossier ? true : never;
type _WireIsStore = Dossier extends StoreDossier ? true : never;
const _wireMatchesStore: [_StoreIsWire, _WireIsStore] = [true, true];
void _wireMatchesStore;

// ---------------------------------------------------------------------------
// 校验:模型产出和用户改动**走同一份**
// ---------------------------------------------------------------------------

/**
 * 清洗结果。`ok: false` 时 missing 里是「整体缺失」的字段名——它同时是
 * 两种故障的形状:模型没按格式说话(draft),或者前端把字段传丢了(PUT)。
 */
export type CleanOutcome = { ok: true; fields: DossierFields } | { ok: false; missing: string[] };

/**
 * 一条列表的清洗:逐条 trim、去空、去重、截断,超出上限的直接丢弃。
 *
 * **去重是大小写不敏感的**:queries 是拿去 GitHub 全文搜索的,
 * "Context Engineering" 和 "context engineering" 会返回同一批仓,留两条只是
 * 白发一次请求、还把台账的分母做大;caresAbout 那边中文为主,大小写不敏感
 * 对它没有副作用。**保留先出现的那一条的原始大小写**——用户/模型写的
 * `KV cache` 不该被我们改成 `kv cache`,它要原样显示在页面上。
 *
 * 截断在**去重之后**发生(靠 out.length 判断),所以「前 5 条里有 3 条重复」
 * 时留下的是 5 条不同的,不是 2 条。
 */
function cleanList(raw: unknown, max: number): string[] {
	if (!Array.isArray(raw)) return [];
	const out: string[] = [];
	const seen = new Set<string>();
	for (const item of raw) {
		if (out.length >= max) break;
		if (typeof item !== "string") continue;
		// 换行也当空白折掉:模型偶尔会把一条写成两行,原样存进去会让页面上的
		// 一行输入框显示成半条
		const s = item.replace(/\s+/g, " ").trim().slice(0, DOSSIER_LIMITS.itemMax);
		if (!s) continue;
		const key = s.toLowerCase();
		if (seen.has(key)) continue;
		seen.add(key);
		out.push(s);
	}
	return out;
}

/**
 * 四个字段的清洗与校验。**模型产出和用户改动共用这一份**——两份校验迟早
 * 分叉,分叉之后「模型能存进去的东西用户存不进去」这种事没人能解释。
 * 这是 001 wizard.ts `cleanCandidates()` 那条家法的原样搬运:模型产出必须
 * 先过代码校验,字段不全就整条丢弃,别指望提示词能约束住格式。
 *
 * 三条硬要求(缺一个就是 missing):
 *   - domain 非空:没有领域边界,周扫连「这句话在说哪个圈子」都不知道;
 *   - caresAbout 非空:节 2 的每条 takeaway 都要标出它对应哪一条 caresAbout
 *     (docs/01 决策 7),这个列表空了那道硬门就自动失效;
 *   - queries 非空:它是召回的全部入口,空的档案 = 周扫一个仓都捞不回来。
 *
 * **notCaresAbout 允许为空**,虽然产品方案说它最值钱。理由恰恰是因为它值钱:
 * 它直接变成排除清单,而排除是**安静地丢东西**——逼模型或用户在没有依据时
 * 硬凑一条,凑出来的那条会在每周扫里默默滤掉一批真实的仓,没有人会发现
 * (docs/01 风险 1 那条「错得很安静」的同款病)。空的排除清单则是响的:
 * 它就明晃晃地摆在第一屏上。所以宁可让它空着。draft 那边另有一次
 * 「你没给排除项」的重试提醒(retryNudge),但重试完还是空就照收。
 */
export function cleanDossierFields(raw: unknown): CleanOutcome {
	const r = (raw ?? {}) as Record<string, unknown>;
	const fields: DossierFields = {
		domain: typeof r.domain === "string" ? r.domain.replace(/\s+/g, " ").trim().slice(0, DOSSIER_LIMITS.domainMax) : "",
		caresAbout: cleanList(r.caresAbout, DOSSIER_LIMITS.listMax),
		notCaresAbout: cleanList(r.notCaresAbout, DOSSIER_LIMITS.listMax),
		queries: cleanList(r.queries, DOSSIER_LIMITS.queriesMax),
	};
	const missing: string[] = [];
	if (!fields.domain) missing.push("domain");
	if (fields.caresAbout.length === 0) missing.push("caresAbout");
	if (fields.queries.length === 0) missing.push("queries");
	return missing.length > 0 ? { ok: false, missing } : { ok: true, fields };
}

/**
 * 这份产出值不值得**再要一次**(draft 专用,只用一次)。返回一句给模型看的
 * 补充说明;没什么可挑的就返回 null。
 *
 * 两种「格式合法但没干活」的形状:
 *   - queries 少于 queriesMin(3):档案的召回上限就是这几条词,给两条等于
 *     让周扫瞎一只眼。5-8 条是产品方案定的量,少于 3 条按「没干活」处理。
 *   - notCaresAbout 为空:排除清单没有原料。这一条只提醒,不强求(见
 *     cleanDossierFields 的注释)。
 *
 * **只补一轮,不循环**——沿用 001 wizard.ts `MIN_ALIVE` 那条注释的理由:
 * 补第二轮的边际收益已经很小,而每一轮都是真金白银的一次调用和几秒等待,
 * 循环补足在模型持续不配合时会把一个前端请求拖到边缘超时。补完仍然不达标
 * 就如实报错,不假装。
 */
export function retryNudge(fields: DossierFields): string | null {
	const problems: string[] = [];
	if (fields.queries.length < DOSSIER_LIMITS.queriesMin) {
		problems.push(
			`上一轮只给了 ${fields.queries.length} 条检索词(去重后),太少了。检索词是这份档案唯一的召回入口,` +
				`请给 5-8 条**互不包含**的检索词,至少一条用 topic: 限定。`,
		);
	}
	if (fields.notCaresAbout.length === 0) {
		problems.push("上一轮 notCaresAbout 是空的。这句话里能推出来的排除项都写上(推不出来就仍然留空,别硬凑)。");
	}
	return problems.length > 0 ? problems.join("\n") : null;
}

/**
 * 两份档案在**发现层看得见的地方**是不是一样的——决定要不要涨 rev。
 *
 * **数组按集合比,顺序变化不算改动。**这是个有后果的选择,理由:
 *
 *   rev 的语义不是「你动过这份档案没有」,而是「下一次周扫会不会因此产出
 *   不同的东西」(docs/01 决策 8:报告上印着它基于哪一版档案,跨周 diff 要靠
 *   它把「清单变了」归因到「你改了档案」还是「这周真有新东西」)。
 *
 *   而顺序改不了周扫的产出:queries 是每条各发一次 GitHub Search,结果合并
 *   之后由代码按 star / pushed_at 重排(决策 T3),发出的先后不进排序;
 *   caresAbout / notCaresAbout 分别喂给 takeaway 映射和排除清单,两边都是
 *   按条命中,也不看顺序。既然产出一样,顺序变化就不该涨 rev——否则用户在
 *   页面上拖一下顺序,第二周的 diff 就会告诉他「这周的变化是因为你改了档案」,
 *   那是一句**假话**,而假的归因比没有归因更糟。
 *
 *   注意「不涨 rev」不等于「不保存顺序」:用户排的顺序照常存进库、照常显示,
 *   它只是不构成一次版本变更。
 *
 * 用 [...x].sort() 而不是 x.sort():后者会原地改调用方的数组,而调用方那个
 * 数组马上就要被写进库/回给前端,顺序会被这次比较偷偷改掉。
 */
export function sameDossierFields(a: DossierFields, b: DossierFields): boolean {
	const sameSet = (x: string[], y: string[]) =>
		x.length === y.length && [...x].sort().every((v, i) => v === [...y].sort()[i]);
	return (
		a.domain === b.domain &&
		sameSet(a.caresAbout, b.caresAbout) &&
		sameSet(a.notCaresAbout, b.notCaresAbout) &&
		sameSet(a.queries, b.queries)
	);
}

// ---------------------------------------------------------------------------
// 提示词
// ---------------------------------------------------------------------------

/**
 * 一句话 → 四个字段。**整篇里最要紧的是 queries 那一段的立场**
 * (docs/01 决策 3 第三条):
 *
 *   让模型列举它记得的项目名,漏掉的它自己不知道漏了,而残缺的清单和完整的
 *   清单在页面上长得一模一样(docs/01 风险 1「错得很安静」);让它输出检索词,
 *   再由 GitHub Search 返回真实结果,召回上限就从「模型记得多少」变成
 *   「GitHub 索引了多少」。
 *
 * 所以提示词里既写了「翻译什么」,也明写了「不要写仓库名/公司名/作者名」——
 * 只说前者的话,模型会很自然地把 `langchain memory` 这种半个项目名当检索词
 * 交上来,那就是回忆伪装成翻译。
 */
const DRAFT_SYSTEM = `你把用户的一句话,拆成一份「关注档案」——它每周会被拿去 GitHub 上搜一遍,找这个领域值得看的开源项目。

只输出一个 JSON 对象:
{"domain": "...", "caresAbout": ["..."], "notCaresAbout": ["..."], "queries": ["..."]}

字段:
- domain:这句话划定的领域边界,一句话,≤40 字。用用户自己的说法,不要拔高,不要加他没说的范围。
- caresAbout:他在意什么,1-5 条,每条 ≤20 字。
- notCaresAbout:他不要什么,0-5 条,每条 ≤20 字。这几条会直接变成排除清单,是这份档案里最先产生可见效果的字段。从他这句话里推得出来的才写(说了「开源」就意味着不要闭源 SaaS;说了「工程实践」就意味着不要纯论文复现)。**推不出来就少写几条,宁可空着也不要硬凑**——凑出来的排除项会在每周扫里安静地滤掉一批真实的项目,没有人会发现。
- queries:5-8 条**检索词**,直接发给 GitHub 搜索用。

关于 queries,这是整份产出里最重要的一件事:

**你的活是翻译,不是回忆。**把用户的中文说法,翻译成这个领域的人在 GitHub 上真正会写的英文词,以及 GitHub 支持的限定语法(topic:xxx、language:xxx)。

**不要列举你记得的项目名、组织名、作者名。**你记错的、记漏的那部分,没有任何人能发现——包括你自己;而检索词交给 GitHub 去匹配,能捞回什么由 GitHub 的索引决定,不由你的记忆决定。一个你从没听说过的新项目,只要它的 README 里有那几个词,就会被捞回来。

具体要求:
- 每条 2-4 个英文词,不要写成一句话。GitHub 全文搜索要求所有词同时命中,词越多命中越少;
- 同一个概念给出圈内的不同叫法,这是查全率的主要来源(例:「上下文工程」→ context engineering / kv cache / prompt caching);
- 至少一条用 topic: 限定(topic 后面是小写连字符形式,如 topic:llm-memory);
- 条与条之间不要互相包含(有了 "agent memory" 就别再给 "agent memory system");
- 不写具体仓库名、公司名、产品名、作者名。

domain / caresAbout / notCaresAbout 用简体中文,queries 用英文。`

/** 用户那句话进提示词。三引号包起来,是为了让句子里的括号引号不被当成指令。 */
const draftPrompt = (sentence: string, nudge?: string): string =>
	`用户的一句话:\n"""\n${sentence}\n"""` + (nudge ? `\n\n上一轮的产出有问题,重来一次:\n${nudge}` : "");

/**
 * 这次调用的输出预算下限。ai.ts 里 maxOutputTokens 没配时默认 1024,而这份
 * JSON 光 queries 就有 8 条,加上中文字段,1024 顶得很紧——被 max_tokens 截断
 * 的产出会以「模型没返回合法 JSON」的面目出现,查起来完全指错方向。
 * 用**下限**语义(取两者较大)而不是直接写死:AI_MAX_OUTPUT_TOKENS 配了
 * 32768 时不该被这里压回 2048。同款写法见 001 wizard.ts 的 withTokenFloor。
 */
const DRAFT_TOKEN_FLOOR = 2048;

function withTokenFloor(cfg: AiConfig, floor: number): AiConfig {
	const cap = Number.parseInt(cfg.maxOutputTokens ?? "", 10);
	return { ...cfg, maxOutputTokens: String(Number.isFinite(cap) && cap >= floor ? cap : floor) };
}

// ---------------------------------------------------------------------------
// mock 拆解
// ---------------------------------------------------------------------------

/**
 * `AI_PROVIDER=mock`(或 deepseek 档没配 key 自动落回 mock)时的确定性假拆解。
 *
 * 为什么需要它:ai.ts 的 mock 产出是一句 `[mock] Received: "..."`,不是 JSON,
 * 拿它去 parse 必然失败——于是 fork 首跑、本地 dev、以及 mock 模式下的验收
 * 全都卡在第一步,产品的「零 key 端到端可跑」(docs/01 决策 2 第 3 条)也就
 * 破了。所以 mock 分支自己合成一份字段齐全的档案。
 *
 * **但它不走第二套校验**:合成出来的对象和真实模型产出一样,交给
 * cleanDossierFields 过同一遍。校验只有一份,mock 路径反而是它的免费用例——
 * 校验规则改坏了,mock 模式的验收会当场炸给你看。
 *
 * domain 带 `[mock]` 前缀,和 ai.ts 的 mock 文本同款:这份档案会被存进库、
 * 印在报告上,不标出来的话,几个月后没人分得清它是模型拆的还是假的。
 */
export function mockDraft(sentence: string): unknown {
	// 只从句子里取 ASCII 词做检索词。中文词做检索词在 GitHub 上几乎没有召回,
	// mock 也不该产出一份「看起来能用、真跑起来零结果」的假档案。
	const ascii = [...new Set((sentence.toLowerCase().match(/[a-z][a-z0-9+#.-]{1,}/g) ?? []))].slice(0, 2);
	const cn = (sentence.match(/[一-龥]{2,}/g) ?? []).slice(0, 3);
	const head = ascii[0] ?? "open source";
	return {
		domain: `[mock] 围绕「${sentence.slice(0, 40)}」的开源项目`,
		// 句子里的中文词原样当在意项:确定性、看得出是从哪句话来的
		caresAbout: [...cn, "还在活跃维护的项目"],
		notCaresAbout: ["已归档或停更超过一年的项目", "只有 demo 没有实现的仓库", "要好几把付费 key 才跑得起来的项目"],
		queries: [
			`topic:${head.replace(/[^a-z0-9-]/g, "-")}`,
			...ascii.map((w) => `${w} open source`),
			`${head} framework`,
			"awesome list",
			"self hosted",
		],
	};
}

// ---------------------------------------------------------------------------
// 路由
// ---------------------------------------------------------------------------

export const dossierRoutes = new Hono<Guarded>();

/**
 * 上游 AI 故障统一按它自己的状态码回;文案是 ai.ts 写好的中文,可直接显示。
 *
 * **AiConfigError 例外,它的报文不能给用户看**(2026-09-01 第二轮评审 ⑦):
 * makeClient / resolveProvider 抛的是写给站长的英文配置报文,形如
 * `gateway mode needs AI_GATEWAY_URL and AI_GATEWAY_KEY`、`Unknown AI_PROVIDER "x"`。
 * 原样透传等于把环境变量名露给任何一个登录用户,而 types.ts 承诺 error 是
 * 「可以直接显示给用户的中文文案」。只在配错的实例上才出现,但配错的实例
 * 恰恰是最可能被随手 fork 部署的那种。真正的报文进日志——那里才是站长看的地方。
 */
function aiFailure(err: unknown): { error: string; status: number } {
	if (err instanceof AiConfigError) {
		console.error("dossier: ai misconfigured —", err.message);
		return { error: "这个部署的 AI 配置有问题,已经记进日志了。稍后再试,或者联系站长。", status: 500 };
	}
	if (err instanceof AiError) return { error: err.message, status: err.status };
	console.error("dossier: unexpected ai failure", err);
	return { error: "出了点问题,稍后再试一次。", status: 500 };
}

/** 模型没按格式说话(和上游故障分开:这个重来一次多半就好了,那个不会)。 */
const shapeError = (missing: string[]) =>
	`模型这次没按格式说话(${missing.join(" / ")} 没给出来)。再点一次「拆解」通常就好了。`;

const THIN_QUERIES_MSG =
	`拆出来的检索词不足 ${DOSSIER_LIMITS.queriesMin} 条,这样的档案在 GitHub 上捞不回什么东西。` +
	"再点一次「拆解」,或者把这句话说得更具体一点(点名你在意的技术,而不是只说一个大方向)。";

/**
 * draft 整趟超时的文案。**要说清「额度已经扣了」**——这一趟在 reserveOrDeny
 * 之后失败,配额是真花掉的,不说的话用户会以为「什么都没发生」,连点五次,
 * 每次都花一格。
 */
const DRAFT_TIMEOUT_MSG =
	"拆解这句话花的时间超过了上限,先停下来了(模型偶尔连着几次不按格式说话,每重来一次都要等)。" +
	"这一次已经计入今天的额度。再点一次「拆解」通常就好了。";

/**
 * 一句话 → 档案草稿。**不落库**:用户看过、大概率还会改几条,改完再 PUT
 * (docs/01 决策 3:这份档案的意义就在于「看得见、改得动」,先斩后奏地存进去
 * 等于替他做了主)。
 *
 * 闸:userAiGuard(AI_DISABLED 总闸)+ reserveOrDeny(c, "ai")。estUsd 传默认 0
 * ——flash 档一次约 $0.002,过全局花费闸只会把 daily_spend 变成一张高频写入表,
 * 而它拦不住任何东西(要 1500 次才凑够 $3,ai 30 次/天的闸先满)。理由原文在
 * guard.ts reserveOrDeny 的函数头。
 */
dossierRoutes.post("/api/dossier/draft", userAiGuard, async (c) => {
	let body: unknown;
	try {
		body = await c.req.json();
	} catch {
		return c.json({ error: "请求体不是合法 JSON。" }, 400);
	}
	const sentence = typeof (body as { sentence?: unknown })?.sentence === "string" ? (body as { sentence: string }).sentence.trim() : "";
	if (!sentence) return c.json({ error: "先写一句话:你想跟踪什么?" }, 400);
	if (sentence.length > DOSSIER_LIMITS.sentenceMax) {
		return c.json({ error: `这句话太长了(${sentence.length} 字,上限 ${DOSSIER_LIMITS.sentenceMax} 字)。` }, 400);
	}

	const denied = await reserveOrDeny(c, "ai");
	if (denied) return denied;

	// AI_PROVIDER 配错时 resolveProvider 就在这一步抛(fastVariant 会调它)。
	// 拼配置放进 try 里,不然那个 AiConfigError 会从 handler 里逃出去,走 Hono
	// 的默认错误处理回一个**非 JSON 的 500**,前端只能显示「请求失败(HTTP 500)」。
	let cfg: AiConfig;
	try {
		cfg = withTokenFloor(fastAiConfigFor(c.env, c.get("email")), DRAFT_TOKEN_FLOOR);
	} catch (err) {
		const f = aiFailure(err);
		return c.json({ error: f.error }, f.status as 502);
	}

	/**
	 * **整趟 draft 的墙钟上界**(2026-09-01 第二轮评审 ④)。一次 draft 最坏会发出
	 * 几个真实生成请求,是三层重试相乘出来的:
	 *
	 *   round()                    最多 2 轮(下面那个补一轮)
	 *   × complete() 对 JsonShapeError 原样重试 1 次(ai.ts)      = 4 次 completeOnce
	 *   × completeDeepseek 对「空 content / 流没带 finish_reason」自己再来一次
	 *                                                              = 最坏 8 个上游请求
	 *
	 * 没有嵌套成指数,8 是硬上界。钱不是问题(flash 档 8 次约 $0.016),**墙钟是**:
	 * 8 次串行生成足以把这个交互端点拖过 CF 那条 100 秒线,用户拿到的是 524
	 * ——一个没有任何文案、看不出发生了什么的边缘错误页——而 ai 额度在
	 * reserveOrDeny 那一步就已经扣掉了。所以宁可在这里主动收手,回一句能读懂的话。
	 *
	 * 信号一响,后面每一次 fetch 立刻抛,三层重试同时停(ai.ts CompleteInput.signal)。
	 * 同款规矩见 index.ts 的 PROBE_TIMEOUT_MS。
	 */
	const signal = AbortSignal.timeout(draftBudgetMs(c.env));

	/** 一轮 = 一次调用 + 那一份校验。mock 与真实路径在这里合流,校验只有一份。 */
	const round = async (nudge?: string): Promise<CleanOutcome> => {
		const res = await complete(cfg, {
			prompt: draftPrompt(sentence, nudge),
			system: DRAFT_SYSTEM,
			json: true,
			// 结构化抽取不需要 thinking(docs/02 决策 T7 的分档表):思考在这里
			// 帮助很小,却要吃输出预算和几十秒等待,而这是个交互端点。
			reasoning: "none",
			signal,
		});
		if (res.provider === "mock") return cleanDossierFields(mockDraft(sentence));
		// json:true 时 ai.ts 已经在 completeOnce 里验过「能不能 parse」并做了
		// 一次重试,拿到的 text 一定 parse 得动;parse 得动不等于字段齐全,
		// 那一层归下面的 cleanDossierFields 管。
		return cleanDossierFields(JSON.parse(res.text));
	};

	try {
		let outcome = await round();
		// 补一轮的两种理由都在 retryNudge 里;**只补一轮,不循环**。
		const nudge = outcome.ok ? retryNudge(outcome.fields) : `上一轮缺了这些字段:${outcome.missing.join(" / ")}。`;
		if (nudge) {
			try {
				const second = await round(nudge);
				// 第二轮只在「不比第一轮差」时采用:模型偶尔会在补第二轮时把
				// 别的字段答崩,那种情况留着第一轮的产出比两手空空强。
				if (second.ok && (!outcome.ok || second.fields.queries.length >= outcome.fields.queries.length)) {
					outcome = second;
				}
			} catch (err) {
				// 补一轮失败不毁掉第一轮的结果(001 wizard.ts 同款):有多少给多少,
				// 不够的话下面那两道判断自然会拦住。
				console.error("dossier/draft: retry round failed", err);
			}
		}
		if (!outcome.ok) return c.json({ error: shapeError(outcome.missing) }, 400);
		if (outcome.fields.queries.length < DOSSIER_LIMITS.queriesMin) {
			return c.json({ error: THIN_QUERIES_MSG }, 400);
		}
		// sentence 原样回显 —— 前端据此当场证明「我没有改你的话」(docs/01 决策 3)
		return c.json({ sentence, ...outcome.fields });
	} catch (err) {
		// 先看信号:超时会以什么形状抛出来取决于走的是哪条路(fetch 抛
		// DOMException TimeoutError,Anthropic SDK 包成自己的 APIUserAbortError),
		// 按错误类型认全太脆。信号自己知道它响没响,直接问它。
		if (signal.aborted) {
			console.error(`dossier/draft: 超过 ${draftBudgetMs(c.env)}ms 预算,主动收手`, err);
			return c.json({ error: DRAFT_TIMEOUT_MSG }, 504);
		}
		const f = aiFailure(err);
		return c.json({ error: f.error }, f.status as 502);
	}
});

/**
 * 取档案。**没有档案时是 200 + null,不是 404**:前端要拿它区分「这是个新用户,
 * 该显示那个输入框」和「出错了,该显示错误」,而 404 两种都像。
 *
 * **counts 是阶段 3 的遗留**(那时候还没有周扫,没有端点能给这两个数):
 * 删档确认框要在**按下之前**就说清会删掉什么。DELETE 的响应里已经有一份
 * deleted 计数,但那是删完之后才说的,而删档是这个产品里唯一不可逆的动作
 * (docs/01 决策 3:换句子只能删档重建)。一个说不出后果的确认框等于没有确认。
 * 没有档案时全 0(没有 dossierId 可查,也确实没东西可删)。
 */
dossierRoutes.get("/api/dossier", userGuard, async (c) => {
	const dossier = await getDossier(c.env.TEARDOWN_DB, c.get("email"));
	const counts = dossier ? await countDossierChildren(c.env.TEARDOWN_DB, dossier.id) : { scans: 0, reports: 0 };
	const body: GetDossierResponse = { dossier, counts };
	return c.json(body);
});

/** 保存档案时,请求里那句话和库里对不上的文案。docs/01 决策 3 的直接落地。 */
const SENTENCE_LOCKED_MSG =
	"原话是你判断我理解得对不对的基准,改了这个基准就没了。要换句子请删掉这份档案重建(会一并清掉历史周扫和报告)。";

/** 档案在这次保存的中途被别处删掉了(另一个标签页点了「删掉重建」)。 */
const DOSSIER_GONE_MSG = "这份档案刚刚被删掉了,请刷新页面。";

/**
 * 两个标签页都停在种子屏、各自 draft 出一句话,几乎同时点保存时,后到的那个。
 * **不覆盖、也不静默合并**:它手里那四节是从**另一句话**推出来的,存进一份
 * 以第一句话为基准的档案里,页面上就会出现「原话是 S1、四节讲的是 S2」——
 * 而这个产品的全部立场就是「四节要能对着原话被质疑」(docs/01 决策 3)。
 */
const CREATE_RACED_MSG = "刚刚在另一个地方已经建好了一份档案(可能是另一个标签页)。刷新页面看那一份,要换句子就在那儿删掉重建。";

/**
 * 保存档案。
 *
 * **rev 服务端独占,请求体里的 rev 一律忽略**(不是报错——前端把整个档案对象
 * 原样 PUT 回来是最自然的写法,为一个它不该管的字段罚它太苛刻)。2026-09-01
 * 第一轮评审的第 ③ 条就是这个洞:客户端带回旧 rev 会让库里的版本号倒退,之后
 * weekly_scan.dossier_rev 会在**内容不同的两版档案上出现同一个 rev**,
 * 「清单变了是因为你改了档案,还是这周真有新东西」的归因直接答错,全程不报错。
 * 现在这里连构造 rev 的机会都没有了:store 层只暴露 createDossier(初值写死 1)
 * 和 updateDossier(SQL 里 `rev = rev + 0/1`),两个入参类型里都没有 rev 这个字段。
 *
 * **rev 只在四个字段真的变了时才涨**:顺序变化不算(见 sameDossierFields)。
 * 没变的那次只更新 updated_at —— 用户点一下保存总得有点动静,但那不是一次
 * 版本变更。**涨版本和写内容是同一条 UPDATE**(第二轮评审 ②),不再是先后两句:
 * 两句之间被打断过一次,库里就会永久停在「新内容配旧 rev」,而且自愈不了
 * (再点一次保存时内容已经相同,changed 为 false,那一版永远补不上 rev)。
 *
 * **sentence 不允许修改**:已有档案时,请求里的 sentence 和库里对不上就 400。
 * 这里的 getDossier 比对是**快路径**(给出好文案),真正的门在 updateDossier 的
 * `WHERE ... AND sentence = ?` 上——比对和写入之间隔着一次 await,两个标签页
 * 各存各的时,只有 SQL 里那个条件是可信的。
 *
 * **新建走 createDossier(INSERT + DO NOTHING),不是 upsert**:原来那个 upsert
 * 在「读到 null 之后另一个标签页刚好存进去」时会走冲突分支,把库里的 sentence
 * 直接改写成这一趟的(第二轮评审 ③);反方向「读到档案之后它被删掉」时又会
 * 走 INSERT 分支,拿旧 id/createdAt 把一份已被删掉的档案原地复活(评审 ② 的
 * 反向窗口)。两个方向现在都由 SQL 挡住,handler 只负责把 null 翻译成
 * 409 / 400 的中文。
 */
dossierRoutes.put("/api/dossier", userGuard, async (c) => {
	let body: unknown;
	try {
		body = await c.req.json();
	} catch {
		return c.json({ error: "请求体不是合法 JSON。" }, 400);
	}
	const raw = (body ?? {}) as Record<string, unknown>;
	const sentence = typeof raw.sentence === "string" ? raw.sentence.trim() : "";
	if (!sentence) return c.json({ error: "sentence 不能为空——它是这份档案的来源。" }, 400);
	if (sentence.length > DOSSIER_LIMITS.sentenceMax) {
		return c.json({ error: `这句话太长了(${sentence.length} 字,上限 ${DOSSIER_LIMITS.sentenceMax} 字)。` }, 400);
	}

	// 与 draft 完全同一份校验(不是「同样的规则」,是同一个函数)
	const cleaned = cleanDossierFields(raw);
	if (!cleaned.ok) {
		return c.json({ error: `这几个字段不能是空的:${cleaned.missing.join(" / ")}。` }, 400);
	}
	const fields = cleaned.fields;
	if (fields.queries.length < DOSSIER_LIMITS.queriesMin) {
		return c.json(
			{ error: `检索词至少要 ${DOSSIER_LIMITS.queriesMin} 条——它是每周扫描唯一的召回入口,少了就什么都捞不回来。` },
			400,
		);
	}

	const db = c.env.TEARDOWN_DB;
	const email = c.get("email");
	const now = Date.now();
	const existing = await getDossier(db, email);

	// ---- 新建 ----
	if (existing === null) {
		const created = await createDossier(db, {
			id: crypto.randomUUID(),
			userEmail: email,
			sentence,
			...fields,
			createdAt: now,
			updatedAt: now,
		});
		// null = 这中间已经有人(另一个标签页)建好了一份。**不覆盖**:refresh 让
		// 前端把「再试一次」换成「刷新页面」——重试这条路在这里是死的,他手里
		// 那句话永远存不进一份以另一句话为基准的档案。
		if (created === null) return c.json({ error: CREATE_RACED_MSG, refresh: true }, 409);
		// 第一版就是 rev 1,不算「涨版本」,前端不该提示「已更新到 v1」
		return c.json({ dossier: created, revBumped: false });
	}

	// ---- 更新 ----
	// 快路径:先给一句能读懂的话。真正的门在 updateDossier 的 WHERE 里。
	if (existing.sentence !== sentence) return c.json({ error: SENTENCE_LOCKED_MSG, refresh: true }, 400);

	const changed = !sameDossierFields(existing, fields);
	const dossier = await updateDossier(db, {
		userEmail: email,
		// 用库里那句而不是请求里那句:上面比对过一致,这里是第二道保险——
		// 大小写/空白的差异不该悄悄改写基准(而且它是 WHERE 的一半)
		sentence: existing.sentence,
		...fields,
		updatedAt: now,
		bumpRev: changed,
	});
	if (dossier === null) {
		// UPDATE 一行没改到。两种可能,分类只影响措辞:读一次库看它还在不在。
		// 这次读同样是 TOCTOU 的,但代价只是「偶尔指错一次方向」,而两种出路
		// 都是刷新页面——不像写入那样会留下坏数据。
		const stillThere = await getDossier(db, email);
		if (stillThere === null) return c.json({ error: DOSSIER_GONE_MSG, refresh: true }, 409);
		return c.json({ error: SENTENCE_LOCKED_MSG, refresh: true }, 400);
	}
	return c.json({ dossier, revBumped: changed });
});

/**
 * 删掉重来。连带清掉这个人的周扫/候选/排除/报告(schema 没有外键,孤儿要
 * 代码清,理由见 store.ts deleteDossierCascade)。
 *
 * 没有档案时也回 200:删一份不存在的东西是幂等成功,双击不该在第二下看到
 * 一个红色错误。deleted 全 0 已经如实说明了什么都没删。
 */
dossierRoutes.delete("/api/dossier", userGuard, async (c) => {
	const out = await deleteDossierCascade(c.env.TEARDOWN_DB, c.get("email"));
	return c.json({ ok: true, deleted: { scans: out?.scans ?? 0, reports: out?.reports ?? 0 } });
});
