// 发现层的召回与排序(docs/02 决策 T3)。**不碰 D1、不碰模型、不碰 Hono**——
// 输入是一串检索词和一个 GithubClient,输出是去重后的仓集合和一个确定性的名次。
//
// 单独成文件的实际理由:scripts/recall-check.ts(查全验收,真跑网络)要原样跑
// 这一段。验收如果跑的是「另一份长得很像的代码」,那它验的就不是线上那条路。

import { SEARCH_PER_PAGE, type GithubClient, type GithubRepo, type SearchSort } from "./github.ts";

/** 双路检索里这个仓是哪条路捞到的。与 store.ts 的 SourceRoute 同形(那边是 D1 列)。 */
export type SourceRoute = "stars" | "updated" | "both";

export interface DiscoveredRepo {
	repo: GithubRepo;
	route: SourceRoute;
	/** 哪几条检索词捞到了它。用户改检索词时,这是「改哪条会影响什么」的依据。 */
	viaQueries: string[];
}

export interface QueryTrace {
	query: string;
	sort: SearchSort;
	/** 这一路真的拿回几条(≤ SEARCH_PER_PAGE)。 */
	returned: number;
	/** GitHub 声称匹配到多少个(可能是几万)。诚实声明的「上万个」就是它。 */
	totalCount: number;
	/** 这一路失败了的话,失败原因。**失败不静默**:它要能出现在台账上。 */
	error?: string;
}

export interface CollectResult {
	/** 去重后的仓,顺序是首次出现的顺序(不是名次)。 */
	repos: DiscoveredRepo[];
	trace: QueryTrace[];
	/** 提前收工的原因(额度不够 / 预算到了)。空 = 十二路全跑完了。 */
	stopped?: string;
}

/**
 * 双路检索 + 合并去重。
 *
 * **为什么每条词要发两次**(这是决策 T3 的全部内容,值得原样写在这里):
 * 只按 `sort=stars` 取头部会**系统性**漏掉新项目——一个上周才开源的仓,
 * 无论多对路,星数都排不进任何一个成熟领域的前 30。而 003 是**周更**产品,
 * 新项目恰恰是「本周增量」里最该出现的东西。也就是说,单路 star 排序等于
 * 每周都在系统性地漏掉这个产品最想给你看的那一类东西——不是偶尔漏,是
 * 结构上必然漏,而且漏掉的部分在页面上看不出来(docs/01 风险 1)。
 * `sort=updated` 那一路把「最近有人动过」的仓捞进来,两路合并才是完整的漏斗。
 *
 * **串行**:每一次 await 一个请求。理由在 GithubClient 的类注释里(账号级
 * 共享桶),这里只强调一点——`for` 循环里的 await 是这个约束的**实现**,
 * 改成 `Promise.all` 不会报错,只会在某个周一早上开始吃 403。
 *
 * **循环顺序是「每条词先走完两路」,不是「先跑完所有 stars 再跑 updated」。**
 * 额度不够提前收工时,前者留下的是「前 4 条词的完整双路」,后者留下的是
 * 「8 条词但只有 star 那一路」——而后者恰恰是这个决策要消灭的偏差,在一次
 * 被截断的运行里原封不动地长了回来。
 */
export async function collectRepos(client: GithubClient, queries: string[]): Promise<CollectResult> {
	const byName = new Map<string, DiscoveredRepo>();
	const trace: QueryTrace[] = [];
	const routes: SearchSort[] = ["stars", "updated"];
	let stopped: string | undefined;

	outer: for (const query of queries) {
		for (const sort of routes) {
			try {
				const { repos, totalCount } = await client.search(query, sort);
				trace.push({ query, sort, returned: repos.length, totalCount });
				for (const repo of repos) {
					const hit = byName.get(repo.fullName);
					if (!hit) {
						byName.set(repo.fullName, { repo, route: sort, viaQueries: [query] });
						continue;
					}
					// 两路都捞到 = 'both'。这一栏要显示在台账上,读者据此看得见
					// 「哪些是 updated 那一路新冒出来的」——双路做了没做,用户
					// 自己能验,不用信我们说。
					if (hit.route !== sort && hit.route !== "both") hit.route = "both";
					if (!hit.viaQueries.includes(query)) hit.viaQueries.push(query);
					// 同一个仓两路的元数据可能差一点(索引更新时差),留先到的那份。
					// 反正真正进清单的那 5 个会在门 1 里重新拿一次权威值。
				}
			} catch (err) {
				const msg = err instanceof Error ? err.message : String(err);
				trace.push({ query, sort, returned: 0, totalCount: 0, error: msg });
				// 额度/预算类的失败是「这趟跑不完了」,继续打下去只会打更多 403。
				// 别的失败(单条词语法错、偶发 5xx)只毁这一路,后面照跑。
				if (err instanceof Error && err.name === "RateBudgetError") {
					stopped = msg;
					break outer;
				}
			}
		}
	}
	return { repos: [...byName.values()], trace, ...(stopped ? { stopped } : {}) };
}

/** 排序用的比较器工厂:主键之后一律拿 fullName 兜底,保证**完全确定性**。 */
const byStars = (a: DiscoveredRepo, b: DiscoveredRepo): number =>
	b.repo.stars - a.repo.stars ||
	Date.parse(b.repo.pushedAt) - Date.parse(a.repo.pushedAt) ||
	a.repo.fullName.localeCompare(b.repo.fullName);

const byFresh = (a: DiscoveredRepo, b: DiscoveredRepo): number =>
	Date.parse(b.repo.pushedAt) - Date.parse(a.repo.pushedAt) ||
	b.repo.stars - a.repo.stars ||
	a.repo.fullName.localeCompare(b.repo.fullName);

/**
 * 通过规则的那批仓 → 一个确定性的名次。
 *
 * **不能按 star 单排**——那会让整个双路检索白做。想清楚这条链:`sort=updated`
 * 那一路捞回来的新项目,星数天然比不过领域里的老仓;如果最后的名次只看星数,
 * 它们就永远排在第 20 名开外,而每周只挑 5 个(docs/01 决策 4)。结果是双路
 * 老老实实跑了、台账上也显示「updated 路捞回 40 个」,但用户看到的 5 个全是
 * 每周都一样的那几个老仓——**偏差从召回搬到了排序,一个字都没少**。
 *
 * 所以名次是**两路交替**取的:星数榜第一、活跃榜第一、星数榜第二……已经取过
 * 的跳过。5 个位置里因此必然有 2 个留给「最近真的有人在动」的仓,而不是靠
 * 运气。交替的起点是星数榜,理由是第 1 名要经得起「这周就这?」的第一眼质疑。
 *
 * 两个榜都用三级排序键(主键 → 次键 → fullName),所以同一批输入永远算出
 * 同一个名次:重跑 putWeeklyScan 覆盖旧行时,名次不会莫名其妙抖动,跨周 diff
 * 也就不会把「排序抖了一下」报成「这周有新东西」。
 */
export function rankSurvivors(survivors: DiscoveredRepo[]): DiscoveredRepo[] {
	const starsOrder = [...survivors].sort(byStars);
	const freshOrder = [...survivors].sort(byFresh);
	const out: DiscoveredRepo[] = [];
	const taken = new Set<string>();
	const cursor = { stars: 0, updated: 0 };
	// 循环次数写死成 survivors.length:两个榜装的是同一批仓,理论上每一轮都
	// 必然能取到一个,但「理论上」不该是一个 while 循环唯一的终止依据——
	// 排序键里混进一个 NaN 就能让人在生产日志里看到一个转不完的 Worker。
	for (let n = 0; n < survivors.length; n++) {
		const key = n % 2 === 0 ? "stars" : "updated";
		const list = key === "stars" ? starsOrder : freshOrder;
		let idx = cursor[key];
		while (idx < list.length && taken.has(list[idx]!.repo.fullName)) idx += 1;
		cursor[key] = idx;
		const pick = list[idx];
		if (!pick) continue;
		taken.add(pick.repo.fullName);
		out.push(pick);
	}
	return out;
}

/** 一条检索词最多能带回多少个仓(双路各一页)。诚实声明里的分母上界。 */
export const MAX_PER_QUERY = SEARCH_PER_PAGE * 2;
