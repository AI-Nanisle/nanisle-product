// GitHub 接入层 + 双路召回的测试。跑法:npm test。
//
// 这里验的全是**「没跑过就等于没有」的那类代码**:User-Agent 漏了会 403、
// 退避写成固定 sleep 会在共享桶下继续吃 403、串行改成并发不会报错只会在某个
// 周一早上开始失败。这些东西在代码上看不出对错,只能让它真的跑一遍。
//
// 用 fetchImpl 注入而不是起 HTTP 服务器:这一层要断言的是**请求头和时序**,
// 假 fetch 能把它们原样记下来,起服务器反而要在中间多一层解析。端到端那一路
// (真的经过 fetch / Hono / D1)在 worker/scan.test.ts,那边用的是真服务器。

import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { GITHUB_UA, GithubClient, RATE_FLOOR, RateBudgetError, mapRepo } from "./github.ts";
import { collectRepos, rankSurvivors } from "./discovery.ts";
import type { DiscoveredRepo } from "./discovery.ts";

interface Call {
	url: string;
	headers: Record<string, string>;
	at: number;
}

/** 一个 search 返回体。字段名用 GitHub 的原样(snake_case)。 */
const repoJson = (fullName: string, over: Record<string, unknown> = {}) => ({
	full_name: fullName,
	stargazers_count: 100,
	pushed_at: "2026-08-01T00:00:00Z",
	created_at: "2022-01-01T00:00:00Z",
	archived: false,
	license: { spdx_id: "MIT" },
	description: "desc",
	topics: ["t1"],
	language: "TypeScript",
	fork: false,
	html_url: `https://github.com/${fullName}`,
	...over,
});

interface StubReply {
	status?: number;
	body?: unknown;
	headers?: Record<string, string>;
}

/**
 * 假 fetch。`plan` 按调用顺序给应答;用完之后一律回一个空 search 结果
 * (省得每个用例都要把 12 路排满)。
 */
function stubFetch(plan: StubReply[]) {
	const calls: Call[] = [];
	const clock = { t: 1_000_000 };
	const slept: number[] = [];
	let i = 0;
	const fetchImpl = (async (url: string | URL, init?: RequestInit) => {
		const headers: Record<string, string> = {};
		for (const [k, v] of Object.entries((init?.headers ?? {}) as Record<string, string>)) headers[k.toLowerCase()] = v;
		calls.push({ url: String(url), headers, at: clock.t });
		const reply = plan[i++] ?? { body: { items: [], total_count: 0 } };
		return new Response(JSON.stringify(reply.body ?? { items: [], total_count: 0 }), {
			status: reply.status ?? 200,
			headers: { "content-type": "application/json", ...(reply.headers ?? {}) },
		});
	}) as unknown as typeof fetch;
	return {
		calls,
		slept,
		fetchImpl,
		now: () => clock.t,
		// 假 sleep:只推进假时钟,不真的等。真等的话这一整个文件要跑一分钟。
		sleep: async (ms: number) => {
			slept.push(ms);
			clock.t += ms;
		},
	};
}

const client = (stub: ReturnType<typeof stubFetch>, over: Record<string, unknown> = {}) =>
	new GithubClient({
		apiBase: "https://api.github.test",
		fetchImpl: stub.fetchImpl,
		now: stub.now,
		sleep: stub.sleep,
		...over,
	});

describe("GithubClient · 请求头", () => {
	it("每个请求都带 User-Agent —— 漏了就是 403,而且看起来像 IP 被封", async () => {
		const stub = stubFetch([{ body: { items: [repoJson("a/b")], total_count: 1 } }]);
		const c = client(stub);
		await c.search("q", "stars");
		await c.getRepo("a/b");
		assert.equal(stub.calls.length, 2);
		for (const call of stub.calls) assert.equal(call.headers["user-agent"], GITHUB_UA);
	});

	it("配了 PAT 才带 Authorization;不配就是匿名档(真跑,只是额度低)", async () => {
		const anon = stubFetch([]);
		await client(anon).search("q", "stars");
		assert.equal(anon.calls[0]?.headers.authorization, undefined);
		assert.equal(client(anon).rate.authenticated, false);

		const authed = stubFetch([]);
		const c = client(authed, { pat: "ghp_x" });
		await c.search("q", "stars");
		assert.equal(authed.calls[0]?.headers.authorization, "Bearer ghp_x");
		assert.equal(c.rate.authenticated, true);
	});

	it("search 带 sort 与 per_page;不翻页(1000 条上限下翻页换不到查全)", async () => {
		const stub = stubFetch([]);
		await client(stub).search("agent memory", "updated");
		const url = stub.calls[0]!.url;
		assert.match(url, /\/search\/repositories\?q=agent%20memory/);
		assert.match(url, /sort=updated/);
		assert.match(url, /per_page=30/);
		assert.doesNotMatch(url, /[?&]page=/);
	});
});

describe("GithubClient · 按响应头退避(不是固定 sleep)", () => {
	it(`remaining < ${RATE_FLOOR} 时睡到 reset 那一刻,而不是睡一个写死的秒数`, async () => {
		const stub = stubFetch([
			// 第一次回来就报「只剩 2 次了,45 秒后重置」
			{ headers: { "x-ratelimit-remaining": "2", "x-ratelimit-reset": String(Math.floor(1_000_000 / 1000) + 45) } },
			{ headers: { "x-ratelimit-remaining": "29" } },
		]);
		const c = client(stub);
		await c.search("q1", "stars");
		await c.search("q1", "updated");
		// 睡了一次,时长 = reset 时刻 - 当前 + 1 秒余量。**不是**某个常数
		assert.equal(stub.slept.length, 1);
		assert.equal(stub.slept[0], 46_000);
		assert.equal(c.waitedMs, 46_000);
		// 睡完之后第二发才出去
		assert.equal(stub.calls[1]!.at - stub.calls[0]!.at, 46_000);
	});

	it(`remaining ≥ ${RATE_FLOOR} 时一秒都不等`, async () => {
		const stub = stubFetch([
			{ headers: { "x-ratelimit-remaining": "5", "x-ratelimit-reset": String(Math.floor(1_000_000 / 1000) + 45) } },
		]);
		const c = client(stub);
		await c.search("q1", "stars");
		await c.search("q1", "updated");
		assert.deepEqual(stub.slept, []);
	});

	it("search 和 core 是两个桶:search 抽干了不该拖住 GET /repos", async () => {
		const stub = stubFetch([
			{ headers: { "x-ratelimit-remaining": "0", "x-ratelimit-reset": String(Math.floor(1_000_000 / 1000) + 40) } },
			{ body: repoJson("a/b"), headers: { "x-ratelimit-remaining": "4900" } },
		]);
		const c = client(stub);
		await c.search("q", "stars");
		await c.getRepo("a/b"); // core 桶还没被打过,不该继承 search 的 0
		assert.deepEqual(stub.slept, []);
		assert.equal(c.rate.search.remaining, 0);
		assert.equal(c.rate.core.remaining, 4900);
	});

	it("要睡过这趟的预算时抛 RateBudgetError —— 跑不完和跑挂了是两件事", async () => {
		const stub = stubFetch([
			{ headers: { "x-ratelimit-remaining": "0", "x-ratelimit-reset": String(Math.floor(1_000_000 / 1000) + 600) } },
		]);
		const c = client(stub, { deadline: 1_000_000 + 30_000 });
		await c.search("q", "stars");
		await assert.rejects(() => c.search("q", "updated"), (e: unknown) => e instanceof RateBudgetError);
		assert.deepEqual(stub.slept, []); // 一秒都没白等
	});

	it("403 + retry-after 走二次限流那一路:睡一次再打一次", async () => {
		const stub = stubFetch([
			{ status: 403, headers: { "retry-after": "20" }, body: { message: "secondary rate limit" } },
			{ body: { items: [repoJson("a/b")], total_count: 1 } },
		]);
		const c = client(stub);
		const out = await c.search("q", "stars");
		assert.deepEqual(stub.slept, [20_000]);
		assert.equal(out.repos.length, 1);
		assert.equal(c.calls.search, 2);
	});

	it("retry-after 睡完还打不了一整发时不睡,直接抛 RateBudgetError(别白等一轮)", async () => {
		const stub = stubFetch([{ status: 403, headers: { "retry-after": "60" }, body: { message: "secondary" } }]);
		// 预算只剩 61 秒:睡 60 秒醒来只剩 1 秒,一发 12 秒的请求肯定打不完
		const c = client(stub, { deadline: 1_000_000 + 61_000 });
		await assert.rejects(() => c.search("q", "stars"), (e: unknown) => e instanceof RateBudgetError);
		assert.deepEqual(stub.slept, []);
		assert.equal(stub.calls.length, 1, "第二发不该发出去");
	});
});

// ---------------------------------------------------------------------------
// 二次限流的第二发:**真 setTimeout**
//
// 上面所有用例的 sleep 都是假的(只推假时钟,真实耗时 0ms),于是「每一发请求
// 自己的超时定时器」在它们那里**永远不会响**。2026-09-01 阶段 4/5 评审实测到的
// bug 恰恰只在真定时器下出现:第一发的 12 秒超时在 sleep(retry-after,典型 60 秒)
// 期间烧掉,第二发拿到一个已经 aborted 的信号,当场 reject 成一个假的「超时」。
//
//   THREW: Error | github: 12000ms 超时 | calls= 2 elapsed= 13039
//
// 所以这一组用**真 setTimeout**:超时 50ms、sleep 100ms,同一个 bug 在 0.1 秒里
// 复现,又不拖慢 npm test。**反证方式**:把 attempt() 里新建信号那一行退回成
// 复用 request() 外层的一个 link.signal,这两条用例当场红。
// ---------------------------------------------------------------------------

describe("GithubClient · 二次限流的第二发(真定时器)", () => {
	/** 记下每一发拿到的信号当时是不是已经 abort 了 —— 真 fetch 在那种信号上直接 reject。 */
	function realTimerStub(replies: StubReply[]) {
		const abortedAt: boolean[] = [];
		const fetchImpl = (async (url: string | URL, init?: RequestInit) => {
			const signal = init?.signal;
			abortedAt.push(Boolean(signal?.aborted));
			// 真 fetch 收到一个已经 aborted 的信号会立刻 reject,这里照做
			if (signal?.aborted) throw signal.reason ?? new Error("aborted");
			const reply = replies[abortedAt.length - 1] ?? { body: { items: [], total_count: 0 } };
			return new Response(JSON.stringify(reply.body ?? {}), {
				status: reply.status ?? 200,
				headers: { "content-type": "application/json", ...(reply.headers ?? {}) },
			});
		}) as unknown as typeof fetch;
		return { abortedAt, fetchImpl };
	}

	it("sleep 比单发超时长时,第二发照样打得出去(修复前这里是假的「超时」)", async () => {
		const stub = realTimerStub([
			{ status: 403, headers: { "retry-after": "1" }, body: { message: "secondary rate limit" } },
			{ body: { items: [repoJson("a/b")], total_count: 7 } },
		]);
		const c = new GithubClient({
			apiBase: "https://api.github.test",
			fetchImpl: stub.fetchImpl,
			timeoutMs: 50,
			// 真的等 100ms(> 50ms 的单发超时)。retry-after 说的是 1 秒,
			// 记账仍按 1000ms 走,这里只是不想让 npm test 真等一秒。
			sleep: () => new Promise<void>((r) => setTimeout(r, 100)),
		});
		const out = await c.search("q", "stars");

		assert.equal(stub.abortedAt.length, 2, "第二发根本没发出去 —— 第一发的超时定时器烧到它头上了");
		assert.equal(stub.abortedAt[1], false, "第二发拿到的必须是一个全新的、没 abort 的信号");
		assert.equal(out.repos.length, 1, "第二发的结果要真的被用上");
		assert.equal(out.totalCount, 7);
		assert.equal(c.calls.search, 2);
		assert.equal(c.waitedMs, 1000, "等的时间按 retry-after 记账,不按真实 sleep 记");
	});

	// 2026-09-01 阶段 7 评审必须修 1 之后这条用例的判据变了:原来断言的是
	// 「睡满 100ms 再打一发,那一发拿到的是已经 abort 的信号」——正确但浪费,
	// 而在真档上 retry-after 的典型值是 60 秒、GitHub 真发过 3600。现在
	// `nap()` 认整趟信号:睡到一半外面不要了就**当场醒**,第二发根本不发。
	// **反证方式**:把 throttle / request 里的 `this.nap(...)` 退回
	// `this.rawSleep(...)`,这条用例当场红(它会睡满 100ms、发出第二发)。
	it("整趟信号在 sleep 期间响了 → 当场醒,不睡满、不再打一发", async () => {
		const stub = realTimerStub([
			{ status: 429, headers: { "retry-after": "1" }, body: { message: "secondary" } },
			{ body: { items: [repoJson("a/b")], total_count: 1 } },
		]);
		const outer = new AbortController();
		const c = new GithubClient({
			apiBase: "https://api.github.test",
			fetchImpl: stub.fetchImpl,
			timeoutMs: 50,
			signal: outer.signal,
			sleep: () =>
				new Promise<void>((r) => {
					// 睡到一半整趟被取消(预算到了 / 客户端断开)
					setTimeout(() => outer.abort(new Error("整趟预算到了")), 20);
					setTimeout(r, 400);
				}),
		});
		const began = Date.now();
		await assert.rejects(
			() => c.search("q", "stars"),
			(e: unknown) => e instanceof Error && e.message === "整趟预算到了",
			"抛的应该是外层给的取消原因,不是一个假的超时",
		);
		const took = Date.now() - began;
		assert.ok(took < 300, `睡满了才醒(${took}ms)—— 裸 setTimeout 不认 AbortSignal,这正是必须修 1 的形状`);
		assert.equal(stub.abortedAt.length, 1, "整趟都取消了还往外打,才是真的漏");
	});
});

describe("GithubClient · 门 1 与字段映射", () => {
	it("404 / 451 回 null(仓没了),5xx 抛错(GitHub 挂了)—— 两件事必须分开", async () => {
		const stub = stubFetch([{ status: 404, body: {} }, { status: 451, body: {} }, { status: 500, body: {} }]);
		const c = client(stub);
		assert.equal(await c.getRepo("a/gone"), null);
		assert.equal(await c.getRepo("a/dmca"), null);
		await assert.rejects(() => c.getRepo("a/boom"));
	});

	it("license: null → null(没有许可证);spdx NOASSERTION 原样保留", () => {
		assert.equal(mapRepo(repoJson("a/b", { license: null }))!.license, null);
		assert.equal(mapRepo(repoJson("a/b", { license: { spdx_id: "NOASSERTION" } }))!.license, "NOASSERTION");
		assert.equal(mapRepo(repoJson("a/b"))!.license, "MIT");
	});

	it("full_name 不成形的条目直接丢掉,不是给个空壳", () => {
		assert.equal(mapRepo({ full_name: "" }), null);
		assert.equal(mapRepo({}), null);
		assert.equal(mapRepo({ full_name: "no-slash" }), null);
	});
});

describe("collectRepos · 双路检索", () => {
	it("每条词发两次(stars + updated),串行,顺序是「一条词走完两路」", async () => {
		const stub = stubFetch([]);
		const c = client(stub);
		await collectRepos(c, ["q1", "q2", "q3"]);
		assert.equal(stub.calls.length, 6);
		const sorts = stub.calls.map((call) => new URL(call.url).searchParams.get("sort"));
		const qs = stub.calls.map((call) => new URL(call.url).searchParams.get("q"));
		assert.deepEqual(sorts, ["stars", "updated", "stars", "updated", "stars", "updated"]);
		// 不是「先跑完所有 stars 再跑 updated」:被截断时前者留下的是完整双路
		assert.deepEqual(qs, ["q1", "q1", "q2", "q2", "q3", "q3"]);
	});

	it("合并去重,并标出这个仓是哪条路捞到的", async () => {
		const stub = stubFetch([
			{ body: { items: [repoJson("old/big"), repoJson("both/x")], total_count: 8000 } }, // q1 stars
			{ body: { items: [repoJson("both/x"), repoJson("new/fresh")], total_count: 8000 } }, // q1 updated
		]);
		const out = await collectRepos(client(stub), ["q1"]);
		const route = (n: string) => out.repos.find((r) => r.repo.fullName === n)?.route;
		assert.equal(out.repos.length, 3); // both/x 只算一个
		assert.equal(route("old/big"), "stars");
		assert.equal(route("new/fresh"), "updated");
		assert.equal(route("both/x"), "both");
	});

	it("记下每条词捞回几个、GitHub 声称有多少(诚实声明的分母来源)", async () => {
		const stub = stubFetch([{ body: { items: [repoJson("a/b")], total_count: 81234 } }]);
		const out = await collectRepos(client(stub), ["q1"]);
		assert.equal(out.trace.length, 2);
		assert.equal(out.trace[0]!.totalCount, 81234);
		assert.equal(out.trace[0]!.returned, 1);
	});

	it("单条词失败只毁那一路,后面照跑;失败原因进 trace 不静默", async () => {
		const stub = stubFetch([
			{ status: 422, body: { message: "bad query" } }, // q1 stars 炸了
			{ body: { items: [repoJson("a/b")], total_count: 1 } }, // q1 updated 照跑
			{ body: { items: [repoJson("c/d")], total_count: 1 } }, // q2 stars
		]);
		const out = await collectRepos(client(stub), ["q1", "q2"]);
		assert.equal(out.repos.length, 2);
		assert.ok(out.trace[0]!.error?.includes("422"));
		assert.equal(out.stopped, undefined);
	});

	it("额度不够时整趟停下并记 stopped —— 继续打只会打出更多 403", async () => {
		const reset = String(Math.floor(1_000_000 / 1000) + 600);
		const stub = stubFetch([{ headers: { "x-ratelimit-remaining": "0", "x-ratelimit-reset": reset } }]);
		const out = await collectRepos(client(stub, { deadline: 1_000_000 + 5_000 }), ["q1", "q2", "q3"]);
		assert.equal(stub.calls.length, 1); // 第二路就撞上了,后面一发都没出去
		assert.ok(out.stopped?.includes("配额"));
	});
});

describe("rankSurvivors · 名次两路交替", () => {
	const mk = (fullName: string, stars: number, pushedAt: string): DiscoveredRepo => ({
		repo: {
			fullName,
			stars,
			pushedAt,
			createdAt: "2020-01-01T00:00:00Z",
			archived: false,
			license: "MIT",
			description: null,
			topics: [],
			language: null,
			isFork: false,
			htmlUrl: `https://github.com/${fullName}`,
		},
		route: "stars",
		viaQueries: ["q"],
	});

	it("新项目挤得进前 5:纯 star 排序会把它们全部排到 20 名开外", () => {
		const survivors = [
			mk("old/a", 9000, "2026-01-01T00:00:00Z"),
			mk("old/b", 8000, "2026-01-02T00:00:00Z"),
			mk("old/c", 7000, "2026-01-03T00:00:00Z"),
			mk("old/d", 6000, "2026-01-04T00:00:00Z"),
			mk("old/e", 5000, "2026-01-05T00:00:00Z"),
			mk("new/x", 40, "2026-08-31T00:00:00Z"),
			mk("new/y", 30, "2026-08-30T00:00:00Z"),
		];
		const top5 = rankSurvivors(survivors).slice(0, 5).map((d) => d.repo.fullName);
		// 第 1 名仍然是星数榜首(要经得起「这周就这?」的第一眼质疑),
		// 但 5 个位置里有 2 个留给了最近真的有人在动的仓
		assert.equal(top5[0], "old/a");
		assert.ok(top5.includes("new/x"), top5.join(","));
		assert.ok(top5.includes("new/y"), top5.join(","));
	});

	it("确定性:同一批输入(顺序打乱)算出同一个名次", () => {
		const base = [
			mk("a/1", 100, "2026-05-01T00:00:00Z"),
			mk("a/2", 100, "2026-05-01T00:00:00Z"), // 星数与时间全并列 → 靠 fullName 断
			mk("a/3", 50, "2026-08-01T00:00:00Z"),
			mk("a/4", 10, "2026-08-02T00:00:00Z"),
		];
		const one = rankSurvivors(base).map((d) => d.repo.fullName);
		const two = rankSurvivors([...base].reverse()).map((d) => d.repo.fullName);
		assert.deepEqual(one, two);
		// 每个仓恰好出现一次,一个都不丢
		assert.equal(new Set(one).size, base.length);
	});

	it("空输入不炸", () => {
		assert.deepEqual(rankSurvivors([]), []);
	});
});
