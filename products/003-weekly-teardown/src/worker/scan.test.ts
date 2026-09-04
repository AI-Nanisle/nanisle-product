// scan.ts 的端点层测试。跑法:npm test。
//
// 这一份走的是**真的整条路**:真 fetch → 一个本地假 GitHub → 真的规则层 →
// 真的 putWeeklyScan → 真的 SQLite。只有两处是假的:GitHub 的应答内容,
// 以及 AI(不配 key,resolveProvider 落回 mock,形态描述走 mockOneLiner)。
//
// 为什么值得这么重:台账那四个数是诚实声明的分子分母,而它们跨了「召回 →
// 规则 → 门 1 → 落库 → 读回来」五层。任何一层单测都证明不了
// `returned = admitted + excluded + fetchFailed` 这一条,而这一条不成立的话,
// 页面顶部那句话就是假话(docs/01 风险 1 的正面回应会变成风险 1 本身)。
//
// 假 D1 抄自 store.test.ts / dossier.test.ts,理由见 dossier.test.ts 顶部
// (node 的 test runner 会把被 import 的 .test.ts 里的用例再注册一遍)。

import assert from "node:assert/strict";
import { createServer, type Server } from "node:http";
import { DatabaseSync } from "node:sqlite";
import { readFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { after, before, beforeEach, describe, it } from "node:test";
import { assignOneLiners, scanRoutes } from "./scan.ts";
import { githubApiBase } from "./env.ts";
import type { GithubRepo } from "../shared/github.ts";
import { dossierRoutes } from "./dossier.ts";
import { createDossier, getWeeklyScan, putWeeklyChange, putWeeklyScan } from "../shared/store.ts";
import type { WeekDiff } from "../shared/scan-diff.ts";
import { SCAN_PICK_LIMIT } from "../shared/types.ts";
import type { AppEnv } from "./env.ts";

const HERE = path.dirname(fileURLToPath(import.meta.url));
const MIGRATION = path.resolve(HERE, "../../migrations/0001_init.sql");

// ---------------------------------------------------------------------------
// 假 D1
// ---------------------------------------------------------------------------

interface FakeResult {
	results: Record<string, unknown>[];
	success: true;
	meta: { changes: number; last_row_id: number };
}

function runOne(db: DatabaseSync, sql: string, args: unknown[]): FakeResult {
	const st = db.prepare(sql);
	const results = st.all(...(args as never[])) as Record<string, unknown>[];
	const m = db.prepare("SELECT changes() AS c, last_insert_rowid() AS r").get() as { c: number; r: number };
	return { results, success: true, meta: { changes: Number(m.c), last_row_id: Number(m.r) } };
}

class FakeStatement {
	db: DatabaseSync;
	sql: string;
	args: unknown[];
	constructor(db: DatabaseSync, sql: string, args: unknown[] = []) {
		this.db = db;
		this.sql = sql;
		this.args = args;
	}
	bind(...args: unknown[]): FakeStatement {
		return new FakeStatement(this.db, this.sql, args);
	}
	exec(): FakeResult {
		return runOne(this.db, this.sql, this.args);
	}
	async first<T>(): Promise<T | null> {
		return (this.exec().results[0] as T) ?? null;
	}
	async all<T>(): Promise<{ results: T[]; success: true }> {
		return { results: this.exec().results as T[], success: true };
	}
	async run(): Promise<FakeResult> {
		return this.exec();
	}
}

class FakeD1 {
	db: DatabaseSync;
	constructor(db: DatabaseSync) {
		this.db = db;
	}
	prepare(sql: string): FakeStatement {
		return new FakeStatement(this.db, sql);
	}
	async batch(stmts: FakeStatement[]): Promise<FakeResult[]> {
		this.db.exec("BEGIN");
		try {
			const out = stmts.map((s) => s.exec());
			this.db.exec("COMMIT");
			return out;
		} catch (err) {
			this.db.exec("ROLLBACK");
			throw err;
		}
	}
}

function freshDb(): D1Database {
	const raw = new DatabaseSync(":memory:");
	raw.exec(readFileSync(MIGRATION, "utf8"));
	return new FakeD1(raw) as unknown as D1Database;
}

// ---------------------------------------------------------------------------
// 假 GitHub(真 HTTP,经真 fetch;GITHUB_API_BASE 指过来)
// ---------------------------------------------------------------------------

type RepoOver = Record<string, unknown>;

const repo = (fullName: string, over: RepoOver = {}) => ({
	full_name: fullName,
	stargazers_count: 500,
	pushed_at: "2026-08-25T00:00:00Z",
	created_at: "2022-03-01T00:00:00Z",
	archived: false,
	license: { spdx_id: "MIT" },
	description: `${fullName} 的简介`,
	topics: ["video"],
	language: "TypeScript",
	fork: false,
	html_url: `https://github.com/${fullName}`,
	...over,
});

/** 一台假 GitHub:search 按 sort 给不同的池子,GET /repos 按名字查表。 */
interface GhPlan {
	/** sort → 返回的仓列表。 */
	search: { stars: RepoOver[]; updated: RepoOver[] };
	/** fullName → 详情;不在表里的一律 404(门 1 抓不通)。 */
	detail: Map<string, RepoOver>;
	totalCount: number;
	/**
	 * 非 0 = `GET /repos/*` 一律回这个状态码,不查 detail 表。
	 * 用来演「GitHub 挂了 / 限流了」——它和「这个仓不存在」必须被分开处理,
	 * 而阶段 4 的实现把两者拌成了一锅(见门 1 那组用例)。
	 */
	repoStatus: number;
	/** 非 null = search 的响应头这么报额度(演退避与提前收工)。 */
	searchRate: { remaining: number; resetIn: number } | null;
	/** 每条路径被打了几次。 */
	hits: string[];
}

let server: Server;
let base = "";
let plan: GhPlan;

function resetPlan(): void {
	plan = {
		search: { stars: [], updated: [] },
		detail: new Map(),
		totalCount: 0,
		repoStatus: 0,
		searchRate: null,
		hits: [],
	};
}

before(async () => {
	resetPlan();
	server = createServer((req, res) => {
		const url = new URL(req.url ?? "/", "http://x");
		plan.hits.push(url.pathname + url.search);
		const json = (status: number, body: unknown, rate?: { remaining: number; resetIn: number }) => {
			res.writeHead(status, {
				"content-type": "application/json",
				// 额度头照 GitHub 的样子给,让退避那段代码在这条路上也真的跑到
				"x-ratelimit-remaining": String(rate ? rate.remaining : 29),
				"x-ratelimit-reset": String(Math.floor(Date.now() / 1000) + (rate ? rate.resetIn : 60)),
				"x-ratelimit-limit": "30",
			});
			res.end(JSON.stringify(body));
		};
		if (url.pathname === "/search/repositories") {
			const sort = url.searchParams.get("sort") === "updated" ? "updated" : "stars";
			return json(200, { total_count: plan.totalCount, items: plan.search[sort] }, plan.searchRate ?? undefined);
		}
		const m = url.pathname.match(/^\/repos\/(.+)$/);
		if (m) {
			// 「GitHub 挂了」优先于查表:这条路要能演出 5xx / 403,而不只是 404
			if (plan.repoStatus) return json(plan.repoStatus, { message: `forced ${plan.repoStatus}` });
			const hit = plan.detail.get(m[1]!);
			return hit ? json(200, hit) : json(404, { message: "Not Found" });
		}
		return json(404, { message: "no route" });
	});
	await new Promise<void>((r) => server.listen(0, "127.0.0.1", r));
	const addr = server.address();
	base = typeof addr === "object" && addr ? `http://127.0.0.1:${addr.port}` : "";
});

after(() => server.close());

// ---------------------------------------------------------------------------
// 打端点
// ---------------------------------------------------------------------------

const USER = "someone@example.com";
const SENTENCE = "我想跟踪长视频总结这个方向的开源项目";

function env(db: D1Database, over: Partial<AppEnv> = {}): AppEnv {
	// 不配 NANISLE_SSO_SECRET → guard 走 DEV_EMAIL;不配 AI key → 落回 mock
	return { TEARDOWN_DB: db, DEV_EMAIL: USER, GITHUB_API_BASE: base, ...over } as AppEnv;
}

type Json = Record<string, any>;

async function call(
	app: typeof scanRoutes,
	db: D1Database,
	method: string,
	pathname: string,
	over: Partial<AppEnv> = {},
): Promise<{ status: number; json: Json }> {
	const res = await app.request(pathname, { method }, env(db, over));
	return { status: res.status, json: (await res.json()) as Json };
}

const scan = (db: D1Database, method: string, pathname: string, over: Partial<AppEnv> = {}) =>
	call(scanRoutes, db, method, pathname, over);

let db: D1Database;
let dossierId: string;

beforeEach(async () => {
	db = freshDb();
	resetPlan();
	const d = await createDossier(db, {
		id: "dossier-1",
		userEmail: USER,
		sentence: SENTENCE,
		domain: "长视频总结与转写",
		caresAbout: ["字幕优先", "时间戳跳转"],
		notCaresAbout: ["闭源 SaaS"],
		queries: ["video summarize", "youtube transcript", "topic:bilibili"],
		createdAt: 1,
		updatedAt: 1,
	});
	dossierId = d!.id;
});

describe("POST /api/scan · 台账", () => {
	it("四个数对得上:returned = admitted + excluded + fetchFailed", async () => {
		plan.totalCount = 81234;
		plan.search.stars = [
			repo("ok/one", { stargazers_count: 9000 }),
			repo("bad/archived", { archived: true }),
			repo("bad/agpl", { license: { spdx_id: "AGPL-3.0" } }),
			repo("bad/nolicense", { license: null }),
			repo("gone/deleted"), // 门 1 抓不通(detail 表里没有)
		];
		plan.search.updated = [repo("ok/fresh", { stargazers_count: 20, pushed_at: "2026-08-31T00:00:00Z" })];
		for (const name of ["ok/one", "ok/fresh"]) plan.detail.set(name, repo(name));

		const { status, json } = await scan(db, "POST", "/api/scan");
		assert.equal(status, 200);
		const s = json.scan;
		assert.equal(s.returned, 6);
		assert.equal(s.admitted + s.excluded + s.fetchFailed, s.returned);
		assert.equal(s.admitted, 2);
		assert.equal(s.fetchFailed, 1);
		assert.equal(s.excluded, 3);
	});

	it("每条检索词发两次(stars + updated),不是一次", async () => {
		await scan(db, "POST", "/api/scan");
		const searches = plan.hits.filter((h) => h.startsWith("/search/repositories"));
		assert.equal(searches.length, 3 * 2); // 3 条检索词 × 2 路
		assert.equal(searches.filter((h) => h.includes("sort=stars")).length, 3);
		assert.equal(searches.filter((h) => h.includes("sort=updated")).length, 3);
	});

	it("source_route 标出这个仓是哪条路捞到的", async () => {
		plan.search.stars = [repo("only/stars"), repo("in/both")];
		plan.search.updated = [repo("in/both"), repo("only/updated")];
		for (const n of ["only/stars", "in/both", "only/updated"]) plan.detail.set(n, repo(n));
		const { json } = await scan(db, "POST", "/api/scan");
		const route = (n: string) => json.candidates.find((c: Json) => c.fullName === n)?.sourceRoute;
		assert.equal(route("only/stars"), "stars");
		assert.equal(route("in/both"), "both");
		assert.equal(route("only/updated"), "updated");
	});

	it("排除理由分两类,规则筛的写 reason_source: 'rule' 并带上可核对的字", async () => {
		plan.search.stars = [
			repo("bad/archived", { archived: true }),
			repo("bad/stale", { pushed_at: "2023-02-14T00:00:00Z" }),
			repo("bad/agpl", { license: { spdx_id: "AGPL-3.0-or-later" } }),
			repo("bad/nolicense", { license: null }),
			repo("bad/tiny", { stargazers_count: 4, created_at: "2019-01-01T00:00:00Z" }),
		];
		const { json } = await scan(db, "POST", "/api/scan");
		const why = (n: string) => json.exclusions.find((e: Json) => e.fullName === n);
		assert.equal(why("bad/archived").reason, "已归档(GitHub 字段)");
		assert.equal(why("bad/stale").reason, "最后一次 push 在 2023-02");
		assert.equal(why("bad/agpl").reason, "AGPL 会污染 MIT");
		assert.equal(why("bad/nolicense").reason, "没有许可证,法律上不可用");
		assert.equal(why("bad/tiny").reason, "一年了还不到 10 星");
		for (const e of json.exclusions) assert.equal(e.reasonSource, "rule");
		assert.equal(json.scan.admitted, 0);
	});

	it(`每周只挑 ${SCAN_PICK_LIMIT} 个,多出来的进排除清单并说明排第几`, async () => {
		plan.search.stars = Array.from({ length: 9 }, (_, i) => repo(`o/r${i}`, { stargazers_count: 1000 - i }));
		for (let i = 0; i < 9; i++) plan.detail.set(`o/r${i}`, repo(`o/r${i}`, { stargazers_count: 1000 - i }));
		const { json } = await scan(db, "POST", "/api/scan");
		assert.equal(json.candidates.length, SCAN_PICK_LIMIT);
		assert.equal(json.scan.excluded, 4);
		// 名次连续:1..5 进清单,6..9 在排除清单里逐条写明第几
		assert.deepEqual(json.candidates.map((c: Json) => c.rank), [1, 2, 3, 4, 5]);
		for (const e of json.exclusions) {
			assert.match(e.reason, /排在第 [6-9] 位/);
			assert.equal(e.reasonSource, "rule");
		}
	});

	it("门 1:抓不通的仓计进 fetch_failed 但**不显示**", async () => {
		plan.search.stars = [repo("live/one"), repo("ghost/two")];
		plan.detail.set("live/one", repo("live/one")); // ghost/two 故意不入表 → 404
		const { json } = await scan(db, "POST", "/api/scan");
		assert.equal(json.scan.fetchFailed, 1);
		assert.deepEqual(json.candidates.map((c: Json) => c.fullName), ["live/one"]);
		assert.equal(json.exclusions.find((e: Json) => e.fullName === "ghost/two"), undefined);
	});

	it("门 1 用 REST 的字段覆盖 search 的:索引里还活着、其实已经归档了", async () => {
		plan.search.stars = [repo("stale/index", { archived: false })];
		plan.detail.set("stale/index", repo("stale/index", { archived: true }));
		const { json } = await scan(db, "POST", "/api/scan");
		assert.equal(json.candidates.length, 0);
		assert.equal(json.exclusions[0].reason, "已归档(GitHub 字段)");
	});

	it("形态描述来自模型(mock 档带 [mock] 前缀),但不决定谁进清单", async () => {
		plan.search.stars = [repo("a/b")];
		plan.detail.set("a/b", repo("a/b"));
		const { json } = await scan(db, "POST", "/api/scan");
		assert.match(json.candidates[0].oneLiner, /^\[mock\]/);
	});
});

// ---------------------------------------------------------------------------
// 门 1 出错时的分栏(2026-09-01 阶段 4/5 评审的第二个 bug)
// ---------------------------------------------------------------------------

describe("POST /api/scan · 门 1 出错 ≠ 这个仓不存在", () => {
	/** 9 个通过规则的仓,detail 表里全都有 —— 抓不通只可能是被 repoStatus 逼的。 */
	function nineGoodRepos(): void {
		plan.totalCount = 4242;
		plan.search.stars = Array.from({ length: 9 }, (_, i) => repo(`o/r${i}`, { stargazers_count: 1000 - i }));
		for (let i = 0; i < 9; i++) plan.detail.set(`o/r${i}`, repo(`o/r${i}`, { stargazers_count: 1000 - i }));
	}

	it("GitHub 全线 503:连着几次就收工,不许把 240 个仓一个个试过去", async () => {
		// 评审实测的形状:`GET /repos` 全回 503,旧实现给出一份 **HTTP 200 的
		// 「这周什么都没有」**,台账写 fetchFailed: 9、stopped 空 —— 页面把
		// 「GitHub 全挂」渲染成一份正常的空结果(docs/01 风险 1「错得很安静」)。
		nineGoodRepos();
		plan.repoStatus = 503;
		const { status, json } = await scan(db, "POST", "/api/scan");
		assert.equal(status, 200);

		const gets = plan.hits.filter((h) => h.startsWith("/repos/"));
		assert.equal(gets.length, 3, "连续 3 次 GitHub 侧错误就该停,而不是把幸存者全试一遍");
		assert.ok(json.scan.stopped, "整趟提前收工了,台账必须说出来");
		assert.match(json.scan.stopped, /连续 3 次抓不通/);
		assert.equal(json.scan.admitted, 0);
		// 试过的那 3 个确实没过门 1;剩下 6 个**根本没被验证过**,不许冒充「抓不通」
		assert.equal(json.scan.fetchFailed, 3);
		const kinds = json.exclusions.map((e: Json) => e.reasonKind);
		assert.equal(kinds.filter((k: string) => k === "not-reached").length, 6);
		assert.equal(kinds.filter((k: string) => k === "ranked-out").length, 0, "提前收工时不许说「每周只挑 5 个」");
		// 站长拍板的那条等式仍然成立 —— 它是一个划分,不是三个独立计数器
		const s2 = json.scan;
		assert.equal(s2.admitted + s2.excluded + s2.fetchFailed, s2.returned);
	});

	it("门 1 撞上 403 限流:立刻停,一次都不多打(继续打换来更长的惩罚窗口)", async () => {
		nineGoodRepos();
		plan.repoStatus = 403;
		const { json } = await scan(db, "POST", "/api/scan");
		const gets = plan.hits.filter((h) => h.startsWith("/repos/"));
		assert.equal(gets.length, 1, "限流不等连续 3 次 —— 决策 T5:403 之后继续打会被拉进更长的惩罚窗口");
		assert.match(json.scan.stopped, /限流/);
		// **这个仓没被验证过**,所以不计 fetchFailed,和后面 8 个一起记 not-reached
		assert.equal(json.scan.fetchFailed, 0);
		assert.equal(json.exclusions.filter((e: Json) => e.reasonKind === "not-reached").length, 9);
		const s2 = json.scan;
		assert.equal(s2.admitted + s2.excluded + s2.fetchFailed, s2.returned);
	});

	it("偶发的单次 503 只毁那一个仓,整趟照跑(3 次是「连续」,不是「累计」)", async () => {
		// 一个真 404(仓没了)+ 一堆好仓:404 计 fetchFailed,清单照常出
		plan.search.stars = [repo("ghost/one", { stargazers_count: 9000 }), repo("live/two")];
		plan.detail.set("live/two", repo("live/two"));
		const { json } = await scan(db, "POST", "/api/scan");
		assert.equal(json.scan.fetchFailed, 1);
		assert.equal(json.scan.stopped, null, "一个仓没了不是「整趟跑不完」");
		assert.deepEqual(json.candidates.map((c: Json) => c.fullName), ["live/two"]);
	});
});

describe("POST /api/scan · 诚实声明的数字", () => {
	it("数字全部来自台账,不是写死的;分子分母来自同一趟", async () => {
		plan.totalCount = 81234;
		plan.search.stars = [repo("a/b"), repo("bad/x", { archived: true })];
		plan.detail.set("a/b", repo("a/b"));
		const { json } = await scan(db, "POST", "/api/scan");
		const h = json.honesty;
		assert.equal(h.searchCap, 1000);
		assert.equal(h.queryCount, 3); // 档案里 3 条检索词,全跑到了
		assert.equal(h.routeCount, 2);
		assert.equal(h.returned, json.scan.returned);
		assert.equal(h.excluded, json.scan.excluded);
		assert.equal(h.admitted, json.scan.admitted);
		assert.equal(h.fetchFailed, json.scan.fetchFailed);
		assert.equal(h.claimedTotal, 81234); // 「可能有上万个」的实据
	});

	it("台账里露出走的是哪一档配额(匿名 / PAT)", async () => {
		const anon = await scan(db, "POST", "/api/scan");
		assert.equal(anon.json.rate.authenticated, false);
		assert.equal(anon.json.rate.searchCalls, 6);
		const authed = await scan(db, "POST", "/api/scan", { GITHUB_PAT: "ghp_fake" });
		assert.equal(authed.json.rate.authenticated, true);
	});
});

// ---------------------------------------------------------------------------
// 被截断的那一趟:刷新之后那句诚实声明必须一字不差
// (2026-09-01 阶段 4/5 评审的第三个 bug)
// ---------------------------------------------------------------------------

describe("被截断的一趟:POST 和 GET 说的是同一句话", () => {
	/**
	 * 造一趟真的提前收工的扫描:第一路 search 就报「额度 0,600 秒后重置」,
	 * 而这一趟的预算只有几秒 —— 第二路在 throttle 里抛 RateBudgetError。
	 *
	 * 为什么必须真的跑出来而不是手工造一行台账:这条 bug 的全部形状就是
	 * 「跑出来的那一份和存下去的那一份不一样」,手工造的台账两边都是我写的。
	 */
	async function truncatedRun(): Promise<Json> {
		plan.totalCount = 81234;
		plan.search.stars = [repo("ok/one", { stargazers_count: 9000 }), repo("bad/x", { license: null })];
		plan.detail.set("ok/one", repo("ok/one"));
		plan.searchRate = { remaining: 0, resetIn: 600 };
		// deadline = now + max(1000, budget - 5000):留 1 秒,远小于 601 秒的退避
		const { status, json } = await scan(db, "POST", "/api/scan", { SCAN_BUDGET_MS: "6000" });
		assert.equal(status, 200);
		assert.ok(json.scan.stopped, "这一趟本该被截断 —— 用例本身失效了");
		return json;
	}

	it("POST 的诚实声明说的是实际发生的事:1 条查询、1 种排序,外加一句 stopped", async () => {
		const ran = await truncatedRun();
		assert.equal(ran.honesty.queryCount, 1, "档案里有 3 条,只跑通了 1 条 —— 说 3 就是在说没发生过的事");
		assert.equal(ran.honesty.routeCount, 1, "updated 那一路根本没发出去");
		assert.equal(ran.honesty.claimedTotal, 81234);
		assert.match(ran.scan.stopped, /配额/);
		// 台账里存的检索词就是真的跑通的那一条,不是档案里的三条
		assert.deepEqual(ran.scan.queries, ["video summarize"]);
	});

	it("**刷新之后一字不差**:GET 读回来的诚实声明 = POST 那一份", async () => {
		const ran = await truncatedRun();
		const back = await scan(db, "GET", "/api/scan");

		// 这是这条修复的核心断言。修复之前:queryCount 从 1 变回档案里的 3、
		// claimedTotal 掉成 0、stopped 整个消失 —— 页面把一份残缺扫描渲染成
		// 一份正常结果,而顶上还挂着一句理直气壮的诚实声明。
		assert.deepEqual(back.json.honesty, ran.honesty, "诚实声明的八个数必须完全一致");
		assert.equal(back.json.scan.stopped, ran.scan.stopped, "刷新之后警示不许消失");
		assert.deepEqual(back.json.scan.queries, ran.scan.queries);
		assert.equal(back.json.scan.routeCount, ran.scan.routeCount);
		assert.equal(back.json.scan.claimedTotal, ran.scan.claimedTotal);
		// 顺带确认这一趟确实是残的(不然上面几条在「都跑完了」的情况下也会绿)
		assert.equal(ran.honesty.queryCount, 1);
		assert.ok(back.json.scan.stopped);
	});

	it("下一趟跑全了,stopped 要跟着清掉 —— 警示不能挂在一份完整的清单上", async () => {
		await truncatedRun();
		plan.searchRate = null; // 额度恢复
		const again = await scan(db, "POST", "/api/scan");
		assert.equal(again.json.scan.stopped, null);
		assert.equal(again.json.honesty.queryCount, 3);
		const back = await scan(db, "GET", "/api/scan");
		assert.equal(back.json.scan.stopped, null, "库里那句旧警示没被覆盖掉");
		assert.deepEqual(back.json.honesty, again.json.honesty);
	});
});

describe("POST /api/scan · 落库与幂等", () => {
	it("落进 D1,读回来和响应一致", async () => {
		plan.search.stars = [repo("a/b"), repo("bad/x", { license: null })];
		plan.detail.set("a/b", repo("a/b"));
		const { json } = await scan(db, "POST", "/api/scan");
		const back = await getWeeklyScan(db, dossierId, json.scan.weekOf);
		assert.ok(back);
		assert.equal(back.scan.returned, json.scan.returned);
		assert.equal(back.candidates.length, json.candidates.length);
		assert.equal(back.exclusions.length, json.exclusions.length);
		assert.equal(back.scan.dossierRev, 1);
		assert.deepEqual(back.scan.queries, ["video summarize", "youtube transcript", "topic:bilibili"]);
	});

	it("同一周重跑覆盖,不堆两份(确定性 id + ux_scan)", async () => {
		plan.search.stars = [repo("a/b"), repo("c/d")];
		for (const n of ["a/b", "c/d"]) plan.detail.set(n, repo(n));
		const first = await scan(db, "POST", "/api/scan");
		assert.equal(first.json.scan.admitted, 2);

		// 第二趟世界变了:只剩一个仓
		plan.search.stars = [repo("a/b")];
		const second = await scan(db, "POST", "/api/scan");
		assert.equal(second.json.scan.id, first.json.scan.id);
		assert.equal(second.json.scan.admitted, 1);

		const history = await scan(db, "GET", "/api/scan/history");
		assert.equal(history.json.scans.length, 1); // 覆盖,不是两行
		const back = await getWeeklyScan(db, dossierId, first.json.scan.weekOf);
		assert.equal(back!.candidates.length, 1); // 旧候选整批换掉,不混在一起
	});
});

describe("POST /api/scan · 闸与前置条件", () => {
	it("没有档案 → 400,而且**不扣额度**(注定跑不动的请求)", async () => {
		const empty = freshDb();
		const { status, json } = await scan(empty, "POST", "/api/scan");
		assert.equal(status, 400);
		assert.match(json.error, /还没有档案/);
		const used = (empty as unknown as FakeD1).db.prepare("SELECT COUNT(*) AS n FROM quota").get() as { n: number };
		assert.equal(Number(used.n), 0);
	});

	it("跑一趟真的占掉一格 ai 额度(先占位后干活)", async () => {
		await scan(db, "POST", "/api/scan");
		const rows = (db as unknown as FakeD1).db
			.prepare("SELECT subject, kind, used FROM quota ORDER BY subject")
			.all() as { subject: string; kind: string; used: number }[];
		const mine = rows.find((r) => r.subject === USER);
		assert.equal(mine?.kind, "ai");
		assert.equal(Number(mine?.used), 1);
	});

	it("AI_DISABLED=1 时整条端点关掉(userAiGuard)", async () => {
		const { status } = await scan(db, "POST", "/api/scan", { AI_DISABLED: "1" });
		assert.equal(status, 503);
	});
});

describe("GET /api/scan · 读取", () => {
	it("没跑过 → { scan: null } + 200(不是 404)", async () => {
		const { status, json } = await scan(db, "GET", "/api/scan");
		assert.equal(status, 200);
		assert.equal(json.scan, null);
		assert.deepEqual(json.candidates, []);
		assert.equal(json.honesty, null);
	});

	it("不传 weekOf 取最近一周;传了就取那一周", async () => {
		plan.search.stars = [repo("a/b")];
		plan.detail.set("a/b", repo("a/b"));
		const ran = await scan(db, "POST", "/api/scan");
		const week = ran.json.scan.weekOf;

		const latest = await scan(db, "GET", "/api/scan");
		assert.equal(latest.json.scan.weekOf, week);
		assert.equal(latest.json.candidates.length, 1);
		// 历史那一路没有 trace,honesty 退回台账里的 queries 长度,数字仍然对得上
		assert.equal(latest.json.honesty.queryCount, 3);
		assert.equal(latest.json.honesty.returned, ran.json.scan.returned);

		const asked = await scan(db, "GET", `/api/scan?weekOf=${week}`);
		assert.equal(asked.json.scan.weekOf, week);
		const missing = await scan(db, "GET", "/api/scan?weekOf=1999-W01");
		assert.equal(missing.status, 200);
		assert.equal(missing.json.scan, null);
	});

	it("weekOf 形状不对 → 400,不拿脏串去查库", async () => {
		const { status, json } = await scan(db, "GET", "/api/scan?weekOf=2026-9");
		assert.equal(status, 400);
		assert.match(json.error, /2026-W36/);
	});
});

describe("GET /api/scan/history", () => {
	it("只回台账不回明细,按 week_of 倒序", async () => {
		// 直接落两周,免得为了造历史去改系统时钟
		const { putWeeklyScan } = await import("../shared/store.ts");
		for (const weekOf of ["2026-W34", "2026-W35", "2026-W36"]) {
			await putWeeklyScan(
				db,
				{
					dossierId,
					weekOf,
					dossierRev: 1,
					queries: ["q"],
					returned: 9,
					admitted: 5,
					excluded: 4,
					fetchFailed: 0,
					routeCount: 2,
					claimedTotal: 42,
					stopped: null,
					createdAt: 1,
				},
				[],
				[],
			);
		}
		const { json } = await scan(db, "GET", "/api/scan/history");
		assert.deepEqual(json.scans.map((s: Json) => s.weekOf), ["2026-W36", "2026-W35", "2026-W34"]);
		assert.equal(json.scans[0].candidates, undefined); // 明细不在这条路上
		const capped = await scan(db, "GET", "/api/scan/history?n=2");
		assert.equal(capped.json.scans.length, 2);
	});

	it("没有档案 → 空列表,不是 404", async () => {
		const { status, json } = await scan(freshDb(), "GET", "/api/scan/history");
		assert.equal(status, 200);
		assert.deepEqual(json.scans, []);
	});
});

describe("GET /api/dossier · counts(删档确认框要在按下之前知道后果)", () => {
	it("周扫和报告的行数跟着档案一起回来", async () => {
		const before0 = await call(dossierRoutes, db, "GET", "/api/dossier");
		assert.deepEqual(before0.json.counts, { scans: 0, reports: 0 });

		plan.search.stars = [repo("a/b")];
		plan.detail.set("a/b", repo("a/b"));
		await scan(db, "POST", "/api/scan");
		const { putReport } = await import("../shared/store.ts");
		await putReport(db, {
			id: "r1",
			dossierId,
			fullName: "a/b",
			commitSha: "sha",
			dossierRev: 1,
			payloadJson: "{}",
			estUsd: 0.5,
			anchoredRatio: 1,
			createdAt: 1,
		});

		const after0 = await call(dossierRoutes, db, "GET", "/api/dossier");
		assert.deepEqual(after0.json.counts, { scans: 1, reports: 1 });
	});

	it("没有档案时全 0(没有 dossierId 可查,也确实没东西可删)", async () => {
		const { json } = await call(dossierRoutes, freshDb(), "GET", "/api/dossier");
		assert.equal(json.dossier, null);
		assert.deepEqual(json.counts, { scans: 0, reports: 0 });
	});
});

// ---------------------------------------------------------------------------
// POST /api/scan/appeal(阶段 5 · docs/01 决策 4「这个该进来」)
// ---------------------------------------------------------------------------

/** 带 JSON body 的调用。上面那个 call() 只管 method + path,申诉要传两个字段。 */
async function appeal(db: D1Database, body: unknown, over: Partial<AppEnv> = {}): Promise<{ status: number; json: Json }> {
	const res = await scanRoutes.request(
		"/api/scan/appeal",
		{ method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(body) },
		env(db, over),
	);
	return { status: res.status, json: (await res.json()) as Json };
}

/** 先跑一周,拿到 weekOf 和一个被规则筛掉的仓。 */
async function seedWeek(): Promise<{ weekOf: string; excludedName: string }> {
	plan.totalCount = 4242;
	plan.search.stars = [repo("ok/one", { stargazers_count: 9000 }), repo("bad/nolicense", { license: null })];
	plan.detail.set("ok/one", repo("ok/one"));
	// 申诉那一趟要能 GET 到它 —— 门 1 对申诉同样有效
	plan.detail.set("bad/nolicense", repo("bad/nolicense", { license: null, stargazers_count: 77 }));
	const ran = await scan(db, "POST", "/api/scan");
	assert.equal(ran.status, 200);
	return { weekOf: ran.json.scan.weekOf, excludedName: "bad/nolicense" };
}

describe("POST /api/scan/appeal", () => {
	it("捞回来之后台账等式仍然成立:admitted +1 / excluded -1 / returned 不动", async () => {
		const { weekOf, excludedName } = await seedWeek();
		const before = (await scan(db, "GET", "/api/scan")).json.scan;

		const { status, json } = await appeal(db, { weekOf, fullName: excludedName });
		assert.equal(status, 200);

		const s = json.scan;
		assert.equal(s.returned, before.returned, "returned 是「拿回来多少个」,申诉一个都没多拿");
		assert.equal(s.admitted, before.admitted + 1);
		assert.equal(s.excluded, before.excluded - 1);
		assert.equal(s.admitted + s.excluded + s.fetchFailed, s.returned, "站长拍板要保的那条等式");
		// 诚实声明的数字跟着走(它是从台账算的,不是前端凑的)
		assert.equal(json.honesty.admitted, s.admitted);
		assert.equal(json.honesty.excluded, s.excluded);
	});

	it("那个仓真的进了候选清单,排在算法挑的那几个后面", async () => {
		const { weekOf, excludedName } = await seedWeek();
		const { json } = await appeal(db, { weekOf, fullName: excludedName });
		const got = json.candidates.find((c: Json) => c.fullName === excludedName);
		assert.ok(got, "候选清单里没有它");
		assert.equal(got.sourceRoute, "appealed", "不是搜出来的,不许谎称是哪一路捞的");
		assert.equal(got.rank, json.candidates.length, "名次接在算法那几个后面,不打乱原来的顺序");
		// 门 1 抓回来的是**此刻**的真值,不是一周前的快照
		assert.equal(got.stars, 77);
		assert.equal(json.appealed.fullName, excludedName);
	});

	it("**候选行自己带着「当初因为什么被排除」**,不靠调用方去排除清单里配对", async () => {
		// 阶段 5 的第一屏是在同一个响应里按名字 join 的,那对第一屏是安全的;
		// 但阶段 8 的门铃邮件只拿候选清单渲染,那枚「你捞回来的」徽记和这句理由
		// 会安静地消失。所以 join 挪到了 store 层(getWeeklyScan),读取路径全都
		// 经过它 —— 下游拿不到一份缺了这件事的候选清单。
		const { weekOf, excludedName } = await seedWeek();
		const { json } = await appeal(db, { weekOf, fullName: excludedName });
		const got = json.candidates.find((c: Json) => c.fullName === excludedName);
		assert.match(got.appealedFrom, /没有许可证/, "候选行上没有当初的排除理由");
		// 算法挑进来的那些不许平白多出这句话
		const normal = json.candidates.find((c: Json) => c.fullName === "ok/one");
		assert.equal(normal.appealedFrom, null);

		// 刷新之后(GET 那一路)照样在 —— 它是读取时 join 的,不是响应里临时拼的
		const back = await scan(db, "GET", "/api/scan");
		const again = back.json.candidates.find((c: Json) => c.fullName === excludedName);
		assert.equal(again.appealedFrom, got.appealedFrom);
	});

	it("排除行留着(带 appealedAt),当初的理由不丢", async () => {
		const { weekOf, excludedName } = await seedWeek();
		const { json } = await appeal(db, { weekOf, fullName: excludedName });
		const row = json.exclusions.find((e: Json) => e.fullName === excludedName);
		assert.ok(row, "排除行不能删 —— 「当初为什么被筛掉」是这个动作最该留下的痕迹");
		assert.ok(row.appealedAt > 0);
		assert.match(row.reason, /没有许可证/);
	});

	it("**只重跑受影响的部分**:整周的 search 一次都不重跑", async () => {
		const { weekOf, excludedName } = await seedWeek();
		plan.hits.length = 0; // 只数申诉这一趟打了什么
		const { json } = await appeal(db, { weekOf, fullName: excludedName });

		const searches = plan.hits.filter((h) => h.startsWith("/search/repositories"));
		assert.deepEqual(searches, [], "申诉不许重跑 GitHub 搜索");
		const repos = plan.hits.filter((h) => h.startsWith("/repos/"));
		assert.equal(repos.length, 1, "只抓这一个仓");
		assert.equal(repos[0], `/repos/${excludedName}`);
		assert.equal(json.rerun.searchRerun, false);
		assert.equal(json.rerun.repoFetched, true);
	});

	it("重复申诉幂等:等式不会被点第二下点坏,而且一个请求都不发", async () => {
		const { weekOf, excludedName } = await seedWeek();
		const first = await appeal(db, { weekOf, fullName: excludedName });
		plan.hits.length = 0;
		const second = await appeal(db, { weekOf, fullName: excludedName });

		assert.equal(second.status, 200);
		assert.equal(second.json.scan.admitted, first.json.scan.admitted, "不许再 +1");
		assert.equal(second.json.scan.excluded, first.json.scan.excluded, "不许再 -1");
		assert.equal(
			second.json.scan.admitted + second.json.scan.excluded + second.json.scan.fetchFailed,
			second.json.scan.returned,
		);
		assert.equal(second.json.appealed, null, "没搬东西就别报喜");
		assert.deepEqual(plan.hits, [], "已经捞回过的,一次网络都不该发");
	});

	// -------------------------------------------------------------------------
	// 重跑之后申诉还在(2026-09-01 上线前终审的 A2)
	//
	// 这一组用例替换掉了原来那条「重跑整周会把申诉冲掉 —— 这是已知边界」。
	// 那条边界不该被接受:`putWeeklyScan` 先 DELETE 这一周的子行再整批重灌,
	// 于是用户花掉三次 ai 额度捞回来的三行会被一次重跑静默删掉,**而台账是
	// 重新算的,四个数照样自洽,页面看起来完全正常** —— 这个产品最怕的那种错。
	// 更难受的是台账对不上时页面给的提示原文就是「请把这一周重跑一次」。
	// -------------------------------------------------------------------------

	it("**重跑之后申诉被恢复**:那一行回到清单里,理由和徽记都还在", async () => {
		const { weekOf, excludedName } = await seedWeek();
		await appeal(db, { weekOf, fullName: excludedName });

		const again = await scan(db, "POST", "/api/scan");
		const got = again.json.candidates.find((c: Json) => c.fullName === excludedName);
		assert.ok(got, "重跑把用户自己捞回来的那一行冲掉了");
		assert.equal(got.sourceRoute, "appealed", "恢复回来的仍然不是搜出来的");
		assert.match(got.appealedFrom, /没有许可证/, "当初的排除理由要跟着回来");
		assert.deepEqual(again.json.appeals, { restored: [excludedName], missing: [] });

		const s = again.json.scan;
		assert.equal(s.admitted + s.excluded + s.fetchFailed, s.returned, "恢复之后台账等式照样成立");
		// 搬回来的那个仓**不再计进 excluded**(口径同 appealExclusion:admitted +1、
		// excluded -1、returned 不动)。排除行本身留着,只是不被数进去。
		assert.ok(
			again.json.exclusions.some((e: Json) => e.fullName === excludedName && e.appealedAt > 0),
			"排除行要留着并带上申诉戳",
		);
	});

	it("恢复走门 1:那个仓现在 404 了就不硬塞回清单(记 missing)", async () => {
		const { weekOf, excludedName } = await seedWeek();
		await appeal(db, { weekOf, fullName: excludedName });
		// search 照样返回它(所以它还在这一趟的排除清单里),但 GET /repos 抓不到:
		// 删库 / 改名 / 被下架。一条一周前的申诉记录不该让一个已经没了的仓复活。
		plan.detail.delete(excludedName);

		const again = await scan(db, "POST", "/api/scan");
		assert.ok(!again.json.candidates.some((c: Json) => c.fullName === excludedName));
		assert.deepEqual(again.json.appeals, { restored: [], missing: [excludedName] });
		const s = again.json.scan;
		assert.equal(s.admitted + s.excluded + s.fetchFailed, s.returned);
	});

	it("**这一趟根本没搜到它 → 不搬,但要说出来**(硬搬会让台账说谎)", async () => {
		const { weekOf, excludedName } = await seedWeek();
		await appeal(db, { weekOf, fullName: excludedName });
		// 这一趟的检索结果里没有它(排名掉出去了 / 检索词改过 / 提前收工)。
		plan.search.stars = [repo("ok/one", { stargazers_count: 9000 })];

		const again = await scan(db, "POST", "/api/scan");
		assert.ok(!again.json.candidates.some((c: Json) => c.fullName === excludedName));
		assert.deepEqual(again.json.appeals, { restored: [], missing: [excludedName] });
		// 它不在 returned 里,凭空加进 admitted 就会让这条划分等式说谎。
		const s = again.json.scan;
		assert.equal(s.admitted + s.excluded + s.fetchFailed, s.returned);
	});

	it("下一次搜到它的重跑会把它捞回来 —— scan_appeal 那一行不随重跑消失", async () => {
		const { weekOf, excludedName } = await seedWeek();
		await appeal(db, { weekOf, fullName: excludedName });
		// 第一次重跑:没搜到 → missing
		plan.search.stars = [repo("ok/one", { stargazers_count: 9000 })];
		const miss = await scan(db, "POST", "/api/scan");
		assert.deepEqual(miss.json.appeals.missing, [excludedName]);
		// 第二次重跑:又搜到了 → 自动恢复,用户不用再点一次、也不用再花一次额度
		plan.search.stars = [repo("ok/one", { stargazers_count: 9000 }), repo(excludedName, { license: null })];
		const back = await scan(db, "POST", "/api/scan");
		assert.deepEqual(back.json.appeals.restored, [excludedName]);
		assert.ok(back.json.candidates.some((c: Json) => c.fullName === excludedName));
	});

	it("**别的周的申诉不许漏进这一周**:恢复是按 (档案, 周) 查的", async () => {
		const { weekOf, excludedName } = await seedWeek();
		await appeal(db, { weekOf, fullName: excludedName });
		// 手工把那条申诉挪到另一周,再重跑本周 —— 它不该被搬回来
		// (「申诉不学习」是站长拍板的立场:下周照样按规则筛,照样要再点一次)。
		await db.prepare("UPDATE scan_appeal SET week_of = ?1").bind("2026-W01").run();
		const again = await scan(db, "POST", "/api/scan");
		assert.ok(!again.json.candidates.some((c: Json) => c.fullName === excludedName));
		assert.deepEqual(again.json.appeals, { restored: [], missing: [] });
	});

	it("fullName 形状不对一律 400,连 fetch 都不发(URL 路径注入)", async () => {
		const { weekOf } = await seedWeek();
		for (const bad of ["a/b/../../users/x", "a/b?per_page=1", "notaslash", "a//b", "a/b#x", "a b/c", ""]) {
			plan.hits.length = 0;
			const { status } = await appeal(db, { weekOf, fullName: bad });
			assert.equal(status, 400, `${bad} 应该被形状校验挡下`);
			assert.deepEqual(plan.hits, [], `${bad} 不该发出任何请求`);
		}
	});

	it("weekOf 形状不对 → 400", async () => {
		const { status } = await appeal(db, { weekOf: "2026-9", fullName: "a/b" });
		assert.equal(status, 400);
	});

	it("不在这一周的排除清单里 → 404,不动任何东西", async () => {
		const { weekOf } = await seedWeek();
		const before = (await scan(db, "GET", "/api/scan")).json.scan;
		const { status } = await appeal(db, { weekOf, fullName: "never/seen" });
		assert.equal(status, 404);
		const after = (await scan(db, "GET", "/api/scan")).json.scan;
		assert.deepEqual(after, before);
	});

	it("GitHub 上抓不到(删了/改名了/下架了)→ 404,门 1 对申诉同样有效", async () => {
		const { weekOf, excludedName } = await seedWeek();
		plan.detail.delete(excludedName);
		const before = (await scan(db, "GET", "/api/scan")).json.scan;
		const { status, json } = await appeal(db, { weekOf, fullName: excludedName });
		assert.equal(status, 404);
		assert.match(json.error, /抓不到/);
		const after = (await scan(db, "GET", "/api/scan")).json.scan;
		assert.deepEqual(after, before, "抓不通就什么都不该改");
	});

	it("AI_DISABLED=1 时也关掉(它确实要花一次模型调用)", async () => {
		const { weekOf, excludedName } = await seedWeek();
		const { status } = await appeal(db, { weekOf, fullName: excludedName }, { AI_DISABLED: "1" });
		assert.equal(status, 503);
	});
});

// ---------------------------------------------------------------------------
// 形态描述的兜底:同名仓不许张冠李戴(2026-09-01 阶段 4/5 评审)
// ---------------------------------------------------------------------------

describe("assignOneLiners · 裸仓名兜底", () => {
	const gh = (fullName: string): GithubRepo => ({
		fullName,
		stars: 0,
		pushedAt: "2026-08-01T00:00:00Z",
		createdAt: "2022-01-01T00:00:00Z",
		archived: false,
		license: "MIT",
		description: null,
		topics: [],
		language: null,
		isFork: false,
		htmlUrl: `https://github.com/${fullName}`,
	});

	it("模型按 owner/repo 返回时,原样取用", () => {
		const out = assignOneLiners([gh("a/x"), gh("b/y")], { "a/x": "第一句", "b/y": "第二句" });
		assert.equal(out.get("a/x"), "第一句");
		assert.equal(out.get("b/y"), "第二句");
	});

	it("模型按裸仓名返回、而这一批里裸名唯一时,兜得住", () => {
		const out = assignOneLiners([gh("a/vidbee"), gh("b/other")], { vidbee: "网页应用", other: "命令行工具" });
		assert.equal(out.get("a/vidbee"), "网页应用");
		assert.equal(out.get("b/other"), "命令行工具");
	});

	it("**两个同名仓时,宁可两个都留空,也不许把一句描述挂在错的仓上**", () => {
		// 「长视频总结」这种领域里,A/youtube_summarizer 和 B/youtube_summarizer
		// 同时进候选清单毫不稀奇。兜底一旦在这里生效,两行会拿到同一句话,
		// 其中一句必然是假的 —— 而页面上看不出来。
		const repos = [gh("A/youtube_summarizer"), gh("B/youtube_summarizer")];
		const out = assignOneLiners(repos, { youtube_summarizer: "一个网页应用" });
		assert.equal(out.get("A/youtube_summarizer"), undefined);
		assert.equal(out.get("B/youtube_summarizer"), undefined);
		assert.equal(out.size, 0, "宁可一句都不给:少一句话是可见的降级,挂错了不是");
	});

	it("同名仓里,按全名给的那一句仍然算数(兜底关掉不等于整条路关掉)", () => {
		const repos = [gh("A/dup"), gh("B/dup")];
		const out = assignOneLiners(repos, { "A/dup": "A 的描述", dup: "谁也不知道这是谁的" });
		assert.equal(out.get("A/dup"), "A 的描述");
		assert.equal(out.get("B/dup"), undefined);
	});
});

// ---------------------------------------------------------------------------
// GITHUB_API_BASE 的启动校验(2026-09-01 阶段 4/5 评审的提醒项)
// ---------------------------------------------------------------------------

describe("githubApiBase · 配错要响,不能静默换掉数据源", () => {
	const base = (v?: string) => githubApiBase({ GITHUB_API_BASE: v } as AppEnv);

	it("没配 = undefined(客户端回落到 api.github.com)", () => {
		assert.equal(base(undefined), undefined);
		assert.equal(base("   "), undefined);
	});

	it("https 照收", () => {
		assert.equal(base("https://api.github.com"), "https://api.github.com");
	});

	it("本地 http 照收 —— 测试的假 GitHub 就是一台本地 http 服务器", () => {
		assert.equal(base("http://127.0.0.1:1234"), "http://127.0.0.1:1234");
		assert.equal(base("http://localhost:1234"), "http://localhost:1234");
	});

	it("非 https 的远程地址 / 不成形的串一律忽略,回落到真的 GitHub", () => {
		// 这不是 SSRF(只能由 env 注入),但它是一个**配错就静默换掉整个数据源**
		// 的开关:周扫会安安静静地从另一台服务器拿「GitHub 数据」,台账照常算、
		// 诚实声明照常印。忽略 + 记一条日志,比一行「生产不配」的注释硬。
		assert.equal(base("http://evil.example.com"), undefined);
		assert.equal(base("api.github.com"), undefined);
		assert.equal(base("ftp://api.github.com"), undefined);
	});
});

// ---------------------------------------------------------------------------
// GET /api/scan/changes(2026-09-01 上线前终审,站长拍板)
//
// 这条端点是 docs/01 风险 4 那条判据在产品里的落点:「如果站长从不去翻上一周的
// 结果,就该退回 skill 形态」—— 在这之前**产品里没有「翻上一周」这个动作可翻**。
// ---------------------------------------------------------------------------

describe("GET /api/scan/changes", () => {
	const DIFF: WeekDiff = {
		prevWeekOf: "2026-W35",
		appeared: ["new/one"],
		archivedNow: [],
		licenseChanged: [{ fullName: "lic/two", from: "MIT", to: "AGPL-3.0" }],
		starJumps: [],
		recheck: {
			checked: 3,
			changed: 1,
			unchecked: 1,
			changes: [{ fullName: "gone/three", kind: "gone", stillListed: false }],
			unavailable: [{ fullName: "shy/four", why: "GitHub 这会儿不通" }],
			resolved: ["gone/three", "fine/five"],
			unchanged: ["fine/five"],
		},
		changed: true,
	};

	it("没有那一周的记录 → 200 + change:null(**不是 404**,前端要分得出「还没有」和「出错了」)", async () => {
		const { status, json } = await scan(db, "GET", "/api/scan/changes");
		assert.equal(status, 200);
		assert.equal(json.change, null);
	});

	it("不传 weekOf 取最近一周;明细和计数一起回,前端不用再算一遍", async () => {
		await putWeeklyChange(db, { dossierId, weekOf: "2026-W35", diff: DIFF, createdAt: 1 });
		await putWeeklyChange(db, { dossierId, weekOf: "2026-W36", diff: DIFF, createdAt: 2 });
		const { json } = await scan(db, "GET", "/api/scan/changes");
		assert.equal(json.change.weekOf, "2026-W36");
		assert.equal(json.change.scanId, `${dossierId}#2026-W36`);
		assert.equal(json.change.prevWeekOf, "2026-W35");
		assert.equal(json.change.prevWeekOf, json.change.diff.prevWeekOf, "两处投影必须相等");
		assert.deepEqual(json.change.diff.appeared, ["new/one"]);
		assert.equal(json.change.counts.appeared, 1);
		assert.equal(json.change.counts.recheckChecked, 3);
		assert.equal(json.change.counts.recheckUnchecked, 1, "「没查成」和「没了」是两栏");
		assert.equal(json.change.counts.changed, true);
	});

	it("`?weekOf=` 取指定的那一周", async () => {
		await putWeeklyChange(db, { dossierId, weekOf: "2026-W35", diff: DIFF, createdAt: 1 });
		await putWeeklyChange(db, { dossierId, weekOf: "2026-W36", diff: DIFF, createdAt: 2 });
		const { json } = await scan(db, "GET", "/api/scan/changes?weekOf=2026-W35");
		assert.equal(json.change.weekOf, "2026-W35");
		// 没跑过的那一周照样是 null,而不是回最近一周(那会让人以为他翻到了那一周)
		const other = await scan(db, "GET", "/api/scan/changes?weekOf=2026-W01");
		assert.equal(other.json.change, null);
	});

	it("weekOf 格式不对 → 400,脏串不拿去查库", async () => {
		const { status, json } = await scan(db, "GET", "/api/scan/changes?weekOf=上周");
		assert.equal(status, 400);
		assert.match(json.error, /2026-W36/);
	});

	it("**别人的那一周查不到**:dossierId 由登录账号算出来,越权在结构上不成立", async () => {
		await putWeeklyChange(db, { dossierId: "别人的档案", weekOf: "2026-W36", diff: DIFF, createdAt: 1 });
		const { json } = await scan(db, "GET", "/api/scan/changes?weekOf=2026-W36");
		assert.equal(json.change, null);
	});
});

describe("scan_candidate.topics(决策 8 那条规则的原料)", () => {
	it("落库并原样回来 —— 在这之前那条规则连主语都没有", async () => {
		plan.search.stars = [repo("ok/one", { topics: ["agent", "memory", "rag"] })];
		plan.detail.set("ok/one", repo("ok/one", { topics: ["agent", "memory", "rag"] }));
		const ran = await scan(db, "POST", "/api/scan");
		const got = ran.json.candidates.find((c: Json) => c.fullName === "ok/one");
		assert.deepEqual(got.topics, ["agent", "memory", "rag"]);
		// 刷新之后还在(它是一列,不是响应里临时拼的)
		const back = await scan(db, "GET", "/api/scan");
		assert.deepEqual(back.json.candidates[0].topics, ["agent", "memory", "rag"]);
	});

	it("没有主题词的仓落 [] 而不是 null,下游不用到处判空", async () => {
		plan.search.stars = [repo("ok/one", { topics: [] })];
		plan.detail.set("ok/one", repo("ok/one", { topics: [] }));
		const ran = await scan(db, "POST", "/api/scan");
		assert.deepEqual(ran.json.candidates[0].topics, []);
	});
});

// ---------------------------------------------------------------------------
// week_view · 「他有没有去翻上一周」(2026-09-01 冻结前最后一轮,站长拍板)
//
// docs/01 风险 4 的仪器:「第二个月诚实复盘一次:如果站长从不去翻上一周的结果,
// 那就该把这个产品退回 skill 形态。」上一轮把「翻上一周」这个动作造出来了,但
// 没有任何东西记录他有没有真的去翻 —— 复盘时能拿出来的只有记忆,而人对自己行为
// 的回忆偏向乐观,**而这条判据的全部意义就是在你不想承认时逼你承认**。
// ---------------------------------------------------------------------------

/** 一份能落库的 WeekDiff(内容不是这一组用例的重点,形状对就行)。 */
const DIFF_FIXTURE: WeekDiff = {
	prevWeekOf: "2026-W35",
	appeared: [],
	archivedNow: [],
	licenseChanged: [],
	starJumps: [],
	recheck: { checked: 0, changed: 0, unchecked: 0, changes: [], unavailable: [], resolved: [], unchanged: [] },
	changed: false,
};

describe("week_view · 翻阅台账", () => {
	/** 直接读表(这份数据不上页面,没有端点能读它 —— 它只为第二个月的复盘存在)。 */
	const views = async (): Promise<Json[]> => {
		const out = await db
			.prepare("SELECT * FROM week_view WHERE dossier_id = ?1 ORDER BY at, surface")
			.bind(dossierId)
			.all<Json>();
		return out.results ?? [];
	};

	/** 灌一周真的周扫台账(latest_week_of 的参照系是 weekly_scan)。 */
	const seedScan = (weekOf: string) =>
		putWeeklyScan(
			db,
			{
				dossierId,
				weekOf,
				dossierRev: 1,
				queries: ["q"],
				returned: 0,
				admitted: 0,
				excluded: 0,
				fetchFailed: 0,
				routeCount: 2,
				claimedTotal: 0,
				stopped: null,
				createdAt: 1,
			},
			[],
			[],
		);

	it("显式翻一周 → 两条端点各记一行,surface 分得开", async () => {
		await seedScan("2026-W35");
		await seedScan("2026-W36");
		await scan(db, "GET", "/api/scan/changes?weekOf=2026-W35");
		await scan(db, "GET", "/api/scan?weekOf=2026-W35");
		const rows = await views();
		assert.equal(rows.length, 2, "跨周屏一次翻阅并发打两条,所以落两行");
		assert.deepEqual(
			rows.map((r) => r.surface).sort(),
			["changes", "scan"],
			"两条端点各记各的 —— 不区分来源的话 COUNT(*) 就是真实次数的两倍",
		);
		for (const r of rows) {
			assert.equal(r.week_of, "2026-W35", "记的是**翻到的那一周**");
			assert.equal(r.latest_week_of, "2026-W36", "而最新的那一周是 W36");
			assert.equal(r.explicit, 1);
			assert.ok(Number(r.at) > 0);
		}
	});

	it("**这就是「翻上一周」**:week_of < latest_week_of,判据数的正是这一类", async () => {
		await seedScan("2026-W35");
		await seedScan("2026-W36");
		await scan(db, "GET", "/api/scan/changes?weekOf=2026-W36"); // 只看本周,不算
		await scan(db, "GET", "/api/scan/changes?weekOf=2026-W35"); // 回头翻旧的,算
		const back = await db
			.prepare(
				"SELECT COUNT(*) AS n FROM week_view WHERE dossier_id = ?1 AND surface = 'changes' AND latest_week_of IS NOT NULL AND week_of < latest_week_of",
			)
			.bind(dossierId)
			.first<Json>();
		assert.equal(Number(back!.n), 1, "只看本周的那一次不算「翻上一周」");
	});

	it("首次自动加载(不带 weekOf)照样记一行,但 explicit = 0", async () => {
		await seedScan("2026-W36");
		await putWeeklyChange(db, { dossierId, weekOf: "2026-W36", diff: DIFF_FIXTURE, createdAt: 1 });
		await scan(db, "GET", "/api/scan/changes");
		const rows = await views();
		assert.equal(rows.length, 1);
		assert.equal(rows[0]!.explicit, 0, "他打开了这一屏(动作发生了),但不是他挑的周");
		assert.equal(rows[0]!.week_of, "2026-W36");
		assert.equal(rows[0]!.latest_week_of, "2026-W36", "落到最新那一周 → 天然归进「只看了本周」");
	});

	it("那一周没有跨周记录也照记 —— 把一次没找到东西的翻阅算成没翻过是最不能出的错", async () => {
		await seedScan("2026-W36");
		const { json } = await scan(db, "GET", "/api/scan/changes?weekOf=2026-W20");
		assert.equal(json.change, null);
		const rows = await views();
		assert.equal(rows.length, 1);
		assert.equal(rows[0]!.week_of, "2026-W20");
	});

	it("**清单屏那条不带 weekOf 的默认加载不记**:它和跨周一点关系都没有", async () => {
		await seedScan("2026-W36");
		await scan(db, "GET", "/api/scan");
		assert.deepEqual(await views(), [], "记了就是往判据的数据源里灌噪声");
	});

	it("同一周翻第二次落第二行(「他又回去看了一次」是更强的信号)", async () => {
		await seedScan("2026-W36");
		await scan(db, "GET", "/api/scan/changes?weekOf=2026-W35");
		await new Promise((r) => setTimeout(r, 2)); // at 进主键,同毫秒会被 DO NOTHING 吃掉
		await scan(db, "GET", "/api/scan/changes?weekOf=2026-W35");
		const rows = await views();
		assert.equal(rows.length, 2, "合并成一行只答得了「翻到过哪几周」,答不了「翻过几次」");
		assert.notEqual(rows[0]!.at, rows[1]!.at);
	});

	it("一次周扫都没跑过时 latest_week_of 为 NULL,而不是编一个出来", async () => {
		await scan(db, "GET", "/api/scan/changes?weekOf=2026-W36");
		const rows = await views();
		assert.equal(rows.length, 1);
		assert.equal(rows[0]!.latest_week_of, null);
	});

	it("形状不对的 weekOf 回 400,而且**一行都不记**(那不是一次翻阅)", async () => {
		await seedScan("2026-W36");
		const { status } = await scan(db, "GET", "/api/scan/changes?weekOf=nope");
		assert.equal(status, 400);
		assert.deepEqual(await views(), []);
	});

	it("**没有档案时也不记**:没有 dossier_id 可挂,而且那个人根本没在翻自己的东西", async () => {
		const other = freshDb();
		const { json } = await scan(other, "GET", "/api/scan/changes?weekOf=2026-W36");
		assert.equal(json.change, null);
		const out = await other.prepare("SELECT COUNT(*) AS n FROM week_view").first<Json>();
		assert.equal(Number(out!.n), 0);
	});
});

// ---------------------------------------------------------------------------
// weekOf 校验的位置:**总是**检查,不是「有档案的时候才检查」
// (2026-09-01 冻结前最后一轮。原来它排在 getDossier 的早退之后。)
// ---------------------------------------------------------------------------

describe("weekOf 形状校验排在取档案之前", () => {
	it("**没有档案时 `?weekOf=nope` 照样 400**(两条端点都是)", async () => {
		const empty = freshDb();
		const a = await scan(empty, "GET", "/api/scan/changes?weekOf=nope");
		assert.equal(a.status, 400, "改之前这里是 200 + {change:null} —— 一道有时候才检查的门");
		assert.match(a.json.error, /2026-W36/);
		const b = await scan(empty, "GET", "/api/scan?weekOf=nope");
		assert.equal(b.status, 400, "GET /api/scan 是同一个洞");
		assert.match(b.json.error, /2026-W36/);
	});

	it("有档案时当然也 400(改之前只有这一半是对的)", async () => {
		assert.equal((await scan(db, "GET", "/api/scan/changes?weekOf=nope")).status, 400);
		assert.equal((await scan(db, "GET", "/api/scan?weekOf=nope")).status, 400);
	});
});
