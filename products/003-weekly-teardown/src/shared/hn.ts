// HN Algolia 接入层(阶段 7 · 节 1,docs/01 决策 7)。
//
// **这一层是节 1 存在的理由。**所有深度调研工具都在用后见之明重写历史——它们
// 读的是今天的文章,讲的是「这家为什么成功」。而当年那条 Show HN 底下最高分的
// 质疑帖说的是别的东西,那才是判断层的好原料。Perplexity 和 Gemini Notebook
// 结构上都不去这个语料,所以这个文件不是「多一个数据源」,是这一节的全部差异。
//
// 家法和 github.ts 一致,逐条对齐:
//   ① 所有对外 fetch 挂超时(002 那条「找信源无超时无重试」的教训);
//   ② 带 User-Agent(HN Algolia 不强制,但被限流时对方要认得出我们是谁);
//   ③ **排序和取数一律由代码做**——模型在节 1 唯一被允许的动作是从代码取回来
//      的 30 条候选评论里挑 3 条。候选池的顺序取自 HN 官方 API 的 `kids` 数组,
//      理由见 fetchKids()。
//
// **2026-09-01 实测修订(阶段 7 评审必须修 2)。**这个文件原来按 `points` 给评论
// 排序,而 **HN 不公开评论分数**:Algolia 索引里 comment 命中根本没有 `points`
// 这个键(实测 `hn.algolia.com/api/v1/search?tags=comment,story_3742902`,
// 88 条命中的 hit 里 `points` 字段不存在),旧代码的 `int(undefined)` 一律得 0,
// 于是「按分数降序」退化成「按时间升序」,而候选池又是 Algolia 按 objectID 降序
// (最新的在前)给的前 90 条 —— 一条热帖的候选池实际是「最新 90 条里最早的 30 条」,
// 一个没人设计过的口径。更糟的是页面上把那个 0 当事实印了出来(「(0 分)」),
// 在一个把反捏造写进立场 4 的产品里,那是页面上唯一一个凭空来的数字。
//
// 无 key、无配额签名:Algolia 的 HN 索引是公开的。
//
// 相对 import 带 `.ts` 后缀,理由同 guard.ts 顶部。

/** 公开的 HN 搜索 API 根。测试指到本地假服务器。 */
export const HN_API_BASE = "https://hn.algolia.com/api/v1";

/**
 * HN **官方** API 根(Firebase)。候选池的排序只能从这里拿。
 *
 * Algolia 是第三方索引,它知道正文、知道时间、知道作者,**唯独不知道排序**
 * ——HN 不公开评论分数,所以任何第三方都排不出「当年这条帖子底下最上面那几条」。
 * 官方接口不给分数,但给 `kids`:那个数组的**顺序**就是 HN 自己的排序
 * (真实反映投票与降权),这正是 docs/01 决策 7 要的「当年那条最高分的质疑帖」。
 */
export const HN_FIREBASE_BASE = "https://hacker-news.firebaseio.com/v0";

/** HN 的条目页,永久回链就是它。id 是 objectID(story 和 comment 共用一个空间)。 */
export const HN_ITEM_BASE = "https://news.ycombinator.com/item?id=";

/** 单次请求超时。同 github.ts 的理由:黑洞丢包时无超时的 fetch 永不 settle。 */
export const HN_TIMEOUT_MS = 10_000;

export const HN_UA = "nanisle-weekly-teardown";

/**
 * 取回多少条评论当**候选池**。docs/01 决策 7:「模型唯一被允许的动作是从
 * 30 条候选评论里挑 3 条」。
 *
 * 30 不是随手写的数:它要大到能装下一条热帖里真正有信息量的那几条(HN 上
 * 一条 200 评论的帖子,前 30 名之后基本是「+1」和吵架),又要小到能整段塞进
 * 提示词里 —— 模型必须看见全部候选才谈得上「挑」,分批喂等于让它在看不见
 * 全局的情况下选,那就不是挑了。
 */
export const HN_COMMENT_CANDIDATES = 30;

/**
 * `kids` 拿不到时的降级口径。**不是「换一种排序」,是「承认我们不知道排序」**——
 * 这时候候选池按发表时间升序,并且整条链路(报告的 note、提示词、页面文案)
 * 都改口说「这不是 HN 的排序」。
 *
 * 为什么降级成时间而不是「Algolia 给什么顺序就用什么顺序」:Algolia 对
 * `tags=comment,story_X` 是按 objectID 降序返回的,取前 N 条等于「最新的 N 条」,
 * 而那个口径既不是 HN 的排序也不稳定(它取决于索引内部状态)。时间升序至少是
 * **我们真的知道、而且说得出口**的一件事,还顺带对上节 1 要的东西:早发的评论
 * 是在没有后见之明的情况下写的。
 */
export type HnCommentOrder = "kids" | "chronological";

/** 一条 story 的候选上限。够代码从里面挑出发布帖了,多取只是浪费一次网络。 */
const STORY_HITS = 20;

/** 单条评论正文喂给模型时截到多少字。HN 上偶有几千字的长评,整条喂会挤掉别的候选。 */
export const HN_COMMENT_MAX_CHARS = 1_200;

export interface HnStory {
	/** objectID。永久回链 = HN_ITEM_BASE + 它。 */
	id: string;
	title: string;
	/** 帖子指向的外链;Ask HN 这类自帖为 null。 */
	url: string | null;
	points: number;
	numComments: number;
	/** ISO 字符串,GitHub 那边的 created_at 是同一种格式,时间线上可以直接排。 */
	createdAt: string;
	author: string;
}

export interface HnComment {
	id: string;
	/** 已经去过 HTML 标签的纯文本。锚定的底本就是它。 */
	text: string;
	createdAt: string;
	author: string;
	/**
	 * **HN 自己把这一条排在第几条**(1 起,取自官方 `kids` 数组的下标)。
	 *
	 * 这是我们真的知道的事,所以它能印在页面上;分数不是——HN 不公开评论分数,
	 * 这个字段的位置上原来放的是一个恒等于 0 的 `points`。
	 *
	 * `kids` 里第 2 条对不上正文时,第 3 条的 rank 仍然是 3 而不是 2:
	 * 少给一条不改变 HN 把它排在第几。
	 *
	 * `null` = 这一趟拿不到 `kids`,候选池按时间升序,**没有名次可言**。
	 */
	rank: number | null;
}

/** 一趟取回来的候选池 + 它的口径。口径要一路传到报告的 note、提示词和页面上。 */
export interface HnCommentPool {
	comments: HnComment[];
	order: HnCommentOrder;
	/**
	 * `kids` 里有、但 Algolia 没给出正文的条数(删帖 / 索引缺失)。
	 * **如实少给,不拿别的顺序补齐**——补一条进来就等于说「HN 把它排在这儿」,
	 * 而那是我们编的。
	 */
	missing: number;
}

interface AlgoliaHit {
	objectID?: unknown;
	title?: unknown;
	story_title?: unknown;
	url?: unknown;
	/** **只有 story 有。**comment 命中里这个键根本不存在(2026-09-01 实测)。 */
	points?: unknown;
	num_comments?: unknown;
	created_at?: unknown;
	author?: unknown;
	comment_text?: unknown;
}

/** `GET /api/v1/items/<storyId>` 的一个孩子。字段名和 search 那边不一样,别混。 */
interface AlgoliaChild {
	/** 数字 id,不叫 objectID。和官方 `kids` 里的数字是同一个空间。 */
	id?: unknown;
	text?: unknown;
	author?: unknown;
	created_at?: unknown;
}

/**
 * HN 的 comment_text 是一段 HTML 片段(`<p>`、`<a href>`、`&#x27;`)。
 * 锚定的底本必须是**读者点开 HN 会看到的那些字**,不是标签——留着 `<p>` 的话,
 * 模型引一句正常的话,底本里那句话中间夹着标签,逐字比对当场判失败,
 * 而失败的原因和这条引文对不对毫无关系。
 *
 * 反过来也不能把标签直接删成空:`a<p>b` 删成 `ab` 会把两个词粘成一个不存在的词。
 * `<p>` 换成两个换行,其余标签换成一个空格。
 */
export function htmlToText(html: string): string {
	return html
		.replace(/<\s*br\s*\/?\s*>/gi, "\n")
		.replace(/<\s*\/?\s*p\s*>/gi, "\n\n")
		.replace(/<[^>]*>/g, " ")
		.replace(/&#x([0-9a-f]+);/gi, (_m, h: string) => String.fromCodePoint(Number.parseInt(h, 16)))
		.replace(/&#(\d+);/g, (_m, d: string) => String.fromCodePoint(Number.parseInt(d, 10)))
		.replace(/&quot;/g, '"')
		.replace(/&apos;/g, "'")
		.replace(/&lt;/g, "<")
		.replace(/&gt;/g, ">")
		.replace(/&nbsp;/g, " ")
		// &amp; 必须最后换:先换它的话 `&amp;lt;` 会被两步连着解成 `<`
		.replace(/&amp;/g, "&")
		.replace(/[ \t]+/g, " ")
		.replace(/\n{3,}/g, "\n\n")
		.trim();
}

const str = (v: unknown, fallback = ""): string => (typeof v === "string" ? v : fallback);
const int = (v: unknown): number => (typeof v === "number" && Number.isFinite(v) ? v : 0);

export interface HnClientOptions {
	apiBase?: string;
	/** HN 官方 API 根(排序来源)。测试指到本地假服务器。 */
	firebaseBase?: string;
	fetchImpl?: typeof fetch;
	/** 整趟的取消信号(报告的墙钟预算)。 */
	signal?: AbortSignal;
	timeoutMs?: number;
	/**
	 * 整趟的截止时刻(epoch ms)。**和 GithubClient 的同名参数是同一条规矩**:
	 * 剩下的时间不够打一整发就不打了,而不是打出去等超时。
	 *
	 * 差别在于「打不了」的后果:GitHub 那边抛 RateBudgetError 让整趟收工,
	 * 这边只是少一块材料(报告里会写「拿不到 HN 自己的排序」),所以这里
	 * 返回 null 降级,不抛。
	 */
	deadline?: number;
	now?: () => number;
}

/**
 * 一趟报告里对 HN 的全部调用。**最多两次网络**:一次找帖、一次取评论。
 *
 * 为什么不做重试:HN Algolia 在阶段 0 的出口 spike 里 20/20 成功、p95 < 2 秒
 * (docs/02 阶段 0 的通过判据就是这一条)。这条链上真正会失败的是「这个项目
 * 在 HN 上根本没有记录」,而那不是网络问题,重试一百次也一样 —— 它要变成
 * 报告里一句「这个项目在 HN 上没有记录」,不是一个错误。
 */
export class HnClient {
	private readonly base: string;
	private readonly fbBase: string;
	private readonly doFetch: typeof fetch;
	private readonly signal: AbortSignal | undefined;
	private readonly timeoutMs: number;
	private readonly deadline: number | undefined;
	private readonly now: () => number;
	/** 实际发出去的请求数。台账和「这趟到底打了多少次外网」要它。 */
	calls = 0;

	constructor(opts: HnClientOptions = {}) {
		this.base = (opts.apiBase ?? HN_API_BASE).replace(/\/+$/, "");
		this.fbBase = (opts.firebaseBase ?? HN_FIREBASE_BASE).replace(/\/+$/, "");
		this.deadline = opts.deadline;
		this.now = opts.now ?? Date.now;
		// 必须包一层,不能写成 `opts.fetchImpl ?? fetch`——把全局 fetch 存进字段
		// 再用 this.doFetch(...) 调,receiver 从 globalThis 变成实例,workerd 抛
		// `Illegal invocation`。2026-09-01 阶段 4 在 github.ts 上实测踩过,
		// 而两个纯 node 的验证(npm test / recall-check)都看不见它。
		this.doFetch = opts.fetchImpl ?? ((input, init) => fetch(input, init));
		this.signal = opts.signal;
		this.timeoutMs = opts.timeoutMs && opts.timeoutMs > 0 ? opts.timeoutMs : HN_TIMEOUT_MS;
	}

	/** 剩下的时间还够打一整发吗。不够就一发都不打(见 HnClientOptions.deadline)。 */
	private roomToCall(): boolean {
		if (this.deadline === undefined) return true;
		return this.now() + this.timeoutMs <= this.deadline;
	}

	private async getJson(path: string, root = this.base): Promise<Record<string, unknown> | null> {
		if (!this.roomToCall()) {
			console.error("hn: 这趟的预算不够再打一发了,跳过", path);
			return null;
		}
		const ac = new AbortController();
		const timer = setTimeout(() => ac.abort(new Error(`hn: ${this.timeoutMs}ms 超时`)), this.timeoutMs);
		const onOuter = () => ac.abort(this.signal?.reason);
		if (this.signal) {
			if (this.signal.aborted) ac.abort(this.signal.reason);
			else this.signal.addEventListener("abort", onOuter, { once: true });
		}
		this.calls += 1;
		try {
			const res = await this.doFetch(`${root}${path}`, {
				headers: { "user-agent": HN_UA, accept: "application/json" },
				signal: ac.signal,
			});
			if (!res.ok) {
				await res.body?.cancel();
				return null;
			}
			return (await res.json()) as Record<string, unknown>;
		} finally {
			clearTimeout(timer);
			this.signal?.removeEventListener("abort", onOuter);
		}
	}

	/**
	 * 找这个仓在 HN 上的**发布帖**。找不到回 null —— 那是常态,不是故障。
	 *
	 * 两次查询是有先后的,不是并发:第一次带引号搜 `"owner/repo"` 精确得多,
	 * 命中了就不发第二次。第二次退回裸仓名,是给那些标题写成
	 * 「Show HN: BibiGPT – …」而正文链接指向自己官网的帖子(GitHub 链接不在
	 * `url` 字段里)留的口子。
	 *
	 * **中文项目在 HN 上覆盖为零**(docs/02 的开放问题):这两条查询在中文项目上
	 * 大概率都回空,而那时候正确的行为是让调用方在报告里写「这个项目在 HN 上
	 * 没有记录」,**不假装有**。所以这里宁可返回 null,也不做「挑一个最像的」。
	 */
	async findStory(fullName: string): Promise<HnStory | null> {
		const [owner, repo] = fullName.split("/");
		if (!owner || !repo) return null;
		const first = await this.searchStories(`"${fullName}"`);
		const hits = first.length > 0 ? first : await this.searchStories(repo);
		return pickStory(hits, fullName);
	}

	private async searchStories(query: string): Promise<HnStory[]> {
		const json = await this.getJson(
			`/search?query=${encodeURIComponent(query)}&tags=story&hitsPerPage=${STORY_HITS}`,
		).catch((err) => {
			console.error("hn: 找发布帖失败", err);
			return null;
		});
		const hits = Array.isArray(json?.hits) ? (json.hits as AlgoliaHit[]) : [];
		return hits
			.map((h) => ({
				id: str(h.objectID),
				title: str(h.title, str(h.story_title)),
				url: typeof h.url === "string" && h.url ? h.url : null,
				points: int(h.points),
				numComments: int(h.num_comments),
				createdAt: str(h.created_at),
				author: str(h.author),
			}))
			.filter((s) => s.id !== "" && s.title !== "");
	}

	/**
	 * **HN 自己的评论排序。**`GET /v0/item/<storyId>.json` 的 `kids` 数组,
	 * 顺序即排序(真实反映投票与降权),只是它不告诉你具体分数。
	 *
	 * 拿不到就回 null,由调用方降级并**如实说出来**——这条不能悄悄退回别的顺序:
	 * 一个我们说不出口径的顺序,配上「这是 HN 排在最前面的几条」这句话,
	 * 就是一条带着假凭证的证据(同 anchorAcross 拒跨源的那条理由)。
	 *
	 * `kids` 只有**顶层**评论。这正好是节 1 要的:当年帖子第一屏上的那几条。
	 */
	async fetchKids(storyId: string): Promise<string[] | null> {
		const json = await this.getJson(`/item/${encodeURIComponent(storyId)}.json`, this.fbBase).catch((err) => {
			console.error("hn: 官方 API 取 kids 失败", err);
			return null;
		});
		const kids = json?.kids;
		if (!Array.isArray(kids)) return null;
		const ids = kids.map((k) => (typeof k === "number" ? String(k) : typeof k === "string" ? k : "")).filter((k) => k !== "");
		return ids.length > 0 ? ids : null;
	}

	/**
	 * 一条 story 底下**顶层评论的正文**,一次批量取回,按 id 索引。
	 *
	 * 走 `GET /api/v1/items/<storyId>` 而不是 `/search?tags=comment,story_X`:
	 * search 那条路按 objectID 降序只给最新的 N 条,而我们要对齐的是 `kids` 的
	 * **前 30 条**(热帖里那多半是很早的评论)——两个口径对不上时,一条热帖能
	 * 匹配上的正文寥寥无几。`/items/` 一次给全整棵树,按 id 对得严丝合缝
	 * (2026-09-01 实测 story 3742902:kids 前 12 条 12/12 命中)。
	 *
	 * 只读顶层 `children`,不递归:`kids` 本来就只有顶层,多走一层只会把
	 * 「候选池是哪一批」这件事搅浑。
	 */
	private async fetchTopLevel(storyId: string): Promise<Map<string, HnComment>> {
		const json = await this.getJson(`/items/${encodeURIComponent(storyId)}`).catch((err) => {
			console.error("hn: 取评论正文失败", err);
			return null;
		});
		const kids = Array.isArray(json?.children) ? (json.children as AlgoliaChild[]) : [];
		const out = new Map<string, HnComment>();
		for (const c of kids) {
			const id = typeof c.id === "number" ? String(c.id) : str(c.id);
			const text = htmlToText(str(c.text));
			// 太短的多半是 [dead] / 已删除留下的空壳,当它不存在
			if (!id || text.length < 20) continue;
			out.set(id, {
				id,
				text: text.slice(0, HN_COMMENT_MAX_CHARS),
				createdAt: str(c.created_at),
				author: str(c.author),
				rank: null,
			});
		}
		return out;
	}

	/**
	 * 一条 story 底下的评论候选池。**顺序由 HN 自己给,取数由代码做,模型只挑。**
	 *
	 * 两次网络,顺序不能换:先问官方要排序,再问 Algolia 要正文,最后按 id 对齐。
	 * 对不上的(Algolia 没索引到)**如实少给**——`missing` 记下来,报告里会写。
	 */
	async fetchComments(storyId: string, limit = HN_COMMENT_CANDIDATES): Promise<HnCommentPool> {
		const kids = await this.fetchKids(storyId);
		const bodies = await this.fetchTopLevel(storyId);

		if (!kids) {
			// 降级:承认不知道排序,按时间升序,并且让调用方把这件事写进报告
			const chrono = [...bodies.values()].sort((a, b) => a.createdAt.localeCompare(b.createdAt) || a.id.localeCompare(b.id));
			return { comments: chrono.slice(0, limit), order: "chronological", missing: 0 };
		}

		const comments: HnComment[] = [];
		let missing = 0;
		kids.forEach((id, i) => {
			if (comments.length >= limit) return;
			const body = bodies.get(id);
			if (!body) {
				missing += 1;
				return;
			}
			// rank 是它在 kids 里的下标,不是它在候选池里的下标:
			// 少给一条不改变 HN 把它排在第几
			comments.push({ ...body, rank: i + 1 });
		});
		return { comments, order: "kids", missing };
	}
}

/**
 * 从一批搜索命中里挑出**这个仓的**发布帖。纯函数,导出是为了能单测。
 *
 * 顺序:先按「是不是真的指向这个仓」过滤,再按 points 取最高的一条。
 *
 * 为什么不直接拿 API 相关性排序的第一条:Algolia 的相关性是按标题词打分的,
 * 而 `repo` 这种裸名在 HN 上撞名极其容易(`summarize`、`agent`、`router`)。
 * 拿第一条等于把「这条帖子说的是不是同一个项目」这个判断外包给一个不知道
 * owner 是谁的排序器 —— 挑错了的症状是节 1 挂着一整条别人项目的讨论,
 * 而每条引文都真的能锚定,凭证看上去硬得很。
 */
export function pickStory(hits: HnStory[], fullName: string): HnStory | null {
	const [owner = "", repo = ""] = fullName.split("/");
	const lowerRepo = repo.toLowerCase();
	const matches = hits.filter((h) => {
		const url = (h.url ?? "").toLowerCase();
		// ① 链接直指这个仓:最硬的证据
		if (url.includes(`github.com/${owner.toLowerCase()}/${lowerRepo}`)) return true;
		// ② 标题里出现仓名(词边界,免得 `sum` 命中 `summarize`)。这条要弱一些,
		//    所以只在标题里而不是全文,而且仓名短于 4 个字符时干脆不认——
		//    `hn`、`ai` 这种名字在标题里出现和这个项目毫无关系。
		if (lowerRepo.length < 4) return false;
		return new RegExp(`(^|[^a-z0-9])${escapeRe(lowerRepo)}([^a-z0-9]|$)`, "i").test(h.title);
	});
	if (matches.length === 0) return null;
	// 同一个项目常有多条帖(重复提交、后来的 v2 发布)。取分最高的那条:
	// 「当年反应最大的那一次」才是节 1 要的语料,不是最新的那一次。
	return matches.reduce((best, h) => (h.points > best.points ? h : best));
}

function escapeRe(s: string): string {
	return s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

/** 一条 HN 条目的永久回链。story 和 comment 用同一个空间的 objectID。 */
export function hnPermalink(id: string): string {
	return `${HN_ITEM_BASE}${encodeURIComponent(id)}`;
}
