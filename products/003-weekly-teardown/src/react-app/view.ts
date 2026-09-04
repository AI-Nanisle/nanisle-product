// 四屏之间的切换(阶段 5 两屏,阶段 7 加上报告屏,上线前终审加上跨周屏)。
// **纯函数,不碰 window**——
// 所以它能被测试直接调,而 App.tsx 里剩下的只有三行 history API 的胶水。
//
// 为什么用查询串 `?view=scan` 而不是路径段 `/scan`:
//   1. wrangler.jsonc 的 assets 是 single-page-application fallback,挂载点下
//      任何路径都拿到同一份 index.html —— 路径段也能用,但它和 worker 那边
//      `run_worker_first` 里写死的三条前缀是同一片命名空间,将来加一条真路由
//      (比如 /report/xxx)就要开始互相绕;查询串不占路径,不会撞。
//   2. SSO 的落点是 `/products/weekly-teardown/app`(worker/index.ts 的两处 302),
//      它没有查询串,所以自然落在「没有显式指定视图」这一支上,由 App 按
//      「有没有档案」决定去哪一屏。路径段的话得在 302 那边一起改。
//   3. 刷新不丢:查询串本来就在地址栏里。

import { WEEK_OF_RE } from "../shared/week.ts";

export type View = "dossier" | "scan" | "changes" | "report";

/**
 * 报告屏指的是哪一份。两种问法直接对上 `GET /api/report` 的两种查询:
 *   `id`   —— 某一份具体的报告(uuid)
 *   `repo` —— 某个仓**最近一次**的报告("owner/repo")
 *
 * 为什么两种都要(阶段 8 的门铃邮件是第一个下游):邮件是每周一早发的,它手里
 * 只有仓名——那时候报告还没跑,`id` 根本不存在。而站长把某一份报告的链接贴给
 * 别人看时,要的是**那一份**,不是「这个仓最近那一份」(重跑之后它会变)。
 * 两种问法在服务端本来就都支持,前端少一种,下游就得自己拼另一种。
 */
export interface ReportTarget {
	id?: string;
	repo?: string;
}

/**
 * 地址栏里指定的视图。没指定(或写了别的)时返回 null —— **不猜**,让调用方决定。
 *
 * 例外只有一条:`?id=` / `?repo=` 单独出现时算报告屏。这是给外部链接留的短
 * 形式——门铃邮件里那条链接不该被迫写成 `?view=report&repo=…`,多一个必填参数
 * 就多一处能写错、而且**写错了页面不报错只是安静地进了另一屏**的地方。
 * 显式的 `view=` 永远优先,所以 `?view=scan&repo=a/b`(从报告屏切回清单屏,
 * 地址栏里还留着 repo)读回来仍然是清单屏。
 */
export function viewInSearch(search: string): View | null {
	// URLSearchParams 认不认前导 "?" 都一样,直接喂原串
	const p = new URLSearchParams(search);
	const v = p.get("view");
	if (v === "scan" || v === "dossier" || v === "report" || v === "changes") return v;
	if (v !== null) return null; // 写了个不认识的值:当没指定,不猜
	return p.get("id") || p.get("repo") ? "report" : null;
}

/**
 * 跨周屏在翻哪一周。**形状不对就当没指定**(返回 null = 最近一周)。
 *
 * 为什么要校验(而不是原样塞进 state):这个值会被直接拼进
 * `GET /api/scan?weekOf=` 和 `GET /api/scan/changes?weekOf=`,而后端对形状不对的
 * 串回的是 **400**。不校验的话,一条被人手改坏的链接(`?view=changes&weekOf=上周`)
 * 换来的是一屏红色错误框,而正确的行为是「你没说是哪一周,那就给你最近一周」。
 * 校验用的是后端同一条正则(shared/week.ts),两边分叉的话就会出现「前端放行、
 * 后端 400」这种只有真点进来才看得见的洞。
 */
export function weekOfInSearch(search: string): string | null {
	const raw = new URLSearchParams(search).get("weekOf")?.trim();
	return raw && WEEK_OF_RE.test(raw) ? raw : null;
}

/** 地址栏里那份报告是哪一份。两个参数都没有时返回 null。 */
export function reportTargetInSearch(search: string): ReportTarget | null {
	const p = new URLSearchParams(search);
	const id = p.get("id")?.trim();
	if (id) return { id };
	const repo = p.get("repo")?.trim();
	return repo ? { repo } : null;
}

/**
 * 切到某一屏时地址栏该长什么样。档案页是默认屏,不留参数(地址短一点)。
 *
 * 报告屏**必须带上是哪一份**:光一个 `?view=report` 刷新之后就是一张空屏,
 * 而它长得和「这个仓还没拆过」一模一样(docs/01 风险 1 那个形状)。没给
 * target 时退回裸的 `?view=report`,由 App 显示「地址里没说是哪一份」。
 */
export function searchForView(v: View, target?: ReportTarget | null, weekOf?: string | null): string {
	if (v === "scan") return "?view=scan";
	// 跨周屏把「在翻哪一周」也写进地址栏。**这不是顺手**:门铃邮件是每周一封,
	// 它将来要链过来的是**那一封信说的那一周**,而不是「你现在最近的那一周」
	// —— 三周之后点开一封旧信,后者给的是另一周的结论,页面不会报错,只是安静地
	// 答非所问。顺带换来的是后退键能在翻过的几周之间来回。
	// 不带 weekOf 的裸 `?view=changes` 仍然合法,含义是「最近一周」。
	if (v === "changes") return weekOf ? `?view=changes&weekOf=${encodeURIComponent(weekOf)}` : "?view=changes";
	if (v !== "report") return "";
	const p = new URLSearchParams({ view: "report" });
	if (target?.id) p.set("id", target.id);
	else if (target?.repo) p.set("repo", target.repo);
	return `?${p.toString()}`;
}

/**
 * 没有显式指定时进哪一屏。
 *
 * 有档案 → 本周清单(那才是这个产品每周要看的东西);没档案 → 档案页
 * (没有档案就没有检索词,清单页只能显示一句「先建一份档案」,把人直接丢过去
 * 比让他自己找那个入口好)。
 */
export function defaultView(hasDossier: boolean): View {
	return hasDossier ? "scan" : "dossier";
}
