// cron.ts 的测试(周扫扇出 + 门铃邮件 + 一键退订)。跑法:npm test。
//
// 这一份走的是**真的整条路**:真 fetch → 一台本地假 GitHub → 真的规则层 →
// 真的 putWeeklyScan → 真的 SQLite → 真的 aws4fetch 签名 → 一台被拦下来的假 SES。
// 假的只有三处:GitHub 的应答内容、SES 的应答、AI(不配 key 落回 mock)。
//
// **为什么 SES 要拦在 fetch 这一层而不是注入一个假发信函数**:注入假函数会把
// aws4fetch 的签名整段跳过去,于是「SigV4 到底签没签对、List-Unsubscribe 头有没有
// 真的挂上去」这两件事永远处在没验过的状态——而它们恰恰是 002 当年踩过的
// (SES 沙箱的 IAM 授权必须写 identity/*)。拦 fetch 至少让请求体是真的被造出来的。
//
// 假 D1 抄自 store.test.ts / scan.test.ts,理由见那两份顶部(node 的 test runner
// 会把被 import 的 .test.ts 里的用例再注册一遍,所以不共用)。这一份多了一个
// **poison** 开关:让某个用户的写库调用抛异常,用来验「一个用户失败不拖垮整趟」。

import assert from "node:assert/strict";
import { createServer, type Server } from "node:http";
import { DatabaseSync } from "node:sqlite";
import { readFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { after, before, beforeEach, describe, it } from "node:test";
import { RECHECK_MAX, emailRoutes, recheckPrevious, runWeeklyCron, sendDoorbell, settleWeek } from "./cron.ts";
import type { RecheckProbe } from "./cron.ts";
import type { AppEnv } from "./env.ts";
import { unsubToken } from "../shared/email.ts";
import { isoWeek } from "../shared/week.ts";
import type { RepoSnapshot } from "../shared/scan-diff.ts";
import { GithubError } from "../shared/github.ts";
import {
	appealExclusion,
	createDossier,
	deleteDossierCascade,
	getWeeklyChange,
	getWeeklyEmail,
	getWeeklyScan,
	isOptedOut,
	listRecentScans,
	weeklyScanId,
} from "../shared/store.ts";
import type { Dossier } from "../shared/store.ts";

const HERE = path.dirname(fileURLToPath(import.meta.url));
const MIGRATION = path.resolve(HERE, "../../migrations/0001_init.sql");

// ---------------------------------------------------------------------------
// 假 D1(带 poison:让指定档案的写库调用抛异常)
// ---------------------------------------------------------------------------

interface FakeResult {
	results: Record<string, unknown>[];
	success: true;
	meta: { changes: number; last_row_id: number };
}

/** 命中它的绑定参数一律抛异常,用来演「这个用户这一趟挂了」。 */
let poison: string | null = null;

function runOne(db: DatabaseSync, sql: string, args: unknown[]): FakeResult {
	if (poison && args.some((a) => typeof a === "string" && a.includes(poison!))) {
		throw new Error(`D1 挂了(测试注入:${poison})`);
	}
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

let raw: DatabaseSync;

function freshDb(): D1Database {
	raw = new DatabaseSync(":memory:");
	raw.exec(readFileSync(MIGRATION, "utf8"));
	return new FakeD1(raw) as unknown as D1Database;
}

// ---------------------------------------------------------------------------
// 假 GitHub(真 HTTP)+ 假 SES(拦 fetch)
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
	topics: ["agent"],
	language: "TypeScript",
	fork: false,
	html_url: `https://github.com/${fullName}`,
	...over,
});

interface GhPlan {
	search: RepoOver[];
	detail: Map<string, RepoOver>;
	/** 强制某个仓的 `GET /repos` 回这个状态码。演「GitHub 挂了」,和 404 分开。 */
	status: Map<string, number>;
}

let server: Server;
let base = "";
let plan: GhPlan;

/**
 * 同一时刻有几个 GitHub 请求在飞,以及整趟的峰值。
 *
 * **串行这件事必须被直接量出来**(docs/02 决策 T5)。间接断言(耗时、顺序、
 * 台账)全都拦不住 `Promise.all(users.map(...))`——那样写出来的 cron 每一条
 * 台账都对、每一封信都发、每一个计数都正确,只有 GitHub 那边会在真实负载下
 * 开始回 403,而那要等到有第三个用户、且在线上才看得见。
 *
 * 为了让重叠**看得见**,假 GitHub 的应答故意延后几毫秒:同步 res.end 的话,
 * 并发和串行在这台服务器上长得一模一样。
 */
let inFlight = 0;
let maxInFlight = 0;
const RESPONSE_DELAY_MS = 5;

/** 被拦下来的每一封 SES 请求。断言发了几封、发给谁、正文是什么,全看它。 */
interface SesCall {
	to: string;
	subject: string;
	text: string;
	html: string;
	headers: { Name: string; Value: string }[];
	authorization: string;
}
let sesCalls: SesCall[] = [];
/** 非 200 = 演「SES 报错」。 */
let sesStatus = 200;

const realFetch = globalThis.fetch;

function resetPlan(): void {
	plan = { search: [], detail: new Map(), status: new Map() };
	sesCalls = [];
	sesStatus = 200;
	poison = null;
	inFlight = 0;
	maxInFlight = 0;
}

before(async () => {
	resetPlan();
	server = createServer((req, res) => {
		const url = new URL(req.url ?? "/", "http://x");
		inFlight += 1;
		maxInFlight = Math.max(maxInFlight, inFlight);
		const json = (status: number, body: unknown) => {
			setTimeout(() => {
				res.writeHead(status, {
					"content-type": "application/json",
					"x-ratelimit-remaining": "29",
					"x-ratelimit-reset": String(Math.floor(Date.now() / 1000) + 60),
					"x-ratelimit-limit": "30",
				});
				res.end(JSON.stringify(body));
				inFlight -= 1;
			}, RESPONSE_DELAY_MS);
		};
		if (url.pathname === "/search/repositories") return json(200, { total_count: 4321, items: plan.search });
		const m = url.pathname.match(/^\/repos\/(.+)$/);
		if (m) {
			// 强制状态优先:**5xx 和 404 必须能分别演出来**,它们在产品里是
			// 两件完全不同的事(「GitHub 挂了」vs「这个仓不在了」)。
			const forced = plan.status.get(m[1]!);
			if (forced) return json(forced, { message: `forced ${forced}` });
			const hit = plan.detail.get(m[1]!);
			return hit ? json(200, hit) : json(404, { message: "Not Found" });
		}
		return json(404, { message: "no route" });
	});
	await new Promise<void>((r) => server.listen(0, "127.0.0.1", r));
	const addr = server.address();
	base = typeof addr === "object" && addr ? `http://127.0.0.1:${addr.port}` : "";

	// SES 拦在全局 fetch 上:aws4fetch 的签名、请求体拼装、头部一个都不跳过。
	globalThis.fetch = (async (input: RequestInfo | URL, init?: RequestInit) => {
		const href = typeof input === "string" ? input : input instanceof URL ? input.href : input.url;
		if (!href.includes("amazonaws.com")) return realFetch(input as never, init as never);
		const body = (await (input as Request).json()) as {
			Destination: { ToAddresses: string[] };
			Content: { Simple: { Subject: { Data: string }; Body: { Text: { Data: string }; Html: { Data: string } }; Headers: { Name: string; Value: string }[] } };
		};
		sesCalls.push({
			to: body.Destination.ToAddresses[0]!,
			subject: body.Content.Simple.Subject.Data,
			text: body.Content.Simple.Body.Text.Data,
			html: body.Content.Simple.Body.Html.Data,
			headers: body.Content.Simple.Headers,
			authorization: (input as Request).headers.get("authorization") ?? "",
		});
		return sesStatus === 200
			? new Response(JSON.stringify({ MessageId: "fake" }), { status: 200, headers: { "content-type": "application/json" } })
			: new Response(JSON.stringify({ message: "Email address is not verified" }), {
					status: sesStatus,
					headers: { "content-type": "application/json" },
				});
	}) as typeof fetch;
});

after(() => {
	globalThis.fetch = realFetch;
	server.close();
});

// ---------------------------------------------------------------------------
// 夹具
// ---------------------------------------------------------------------------

/** 2026-09-07 是周一 → ISO 2026-W37。**在真实「今天」之后**,免得 GithubClient 的 deadline 落在过去。 */
const MONDAY = Date.UTC(2026, 8, 7, 8, 0, 0);
const WEEK_A = isoWeek(MONDAY);
const WEEK_B = isoWeek(MONDAY + 7 * 86_400_000);

const SES_ENV = {
	EMAIL_UNSUB_SECRET: "unsub-secret",
	AWS_ACCESS_KEY_ID: "AKIAFAKE",
	AWS_SECRET_ACCESS_KEY: "fake-secret",
	AWS_REGION: "us-east-1",
} as const;

let db: D1Database;

function env(over: Partial<AppEnv> = {}): AppEnv {
	// 不配 AI key → mock;GITHUB_API_BASE 指向假 GitHub;APP_URL 让链接可断言
	return {
		TEARDOWN_DB: db,
		GITHUB_API_BASE: base,
		APP_URL: "https://nanisle.com/products/weekly-teardown",
		...SES_ENV,
		...over,
	} as AppEnv;
}

/** 固定时钟。cron 的预算判断和 weekOf 都读它,不传就永远是同一时刻。 */
const at = (t: number) => () => t;

async function makeDossier(id: string, email: string): Promise<Dossier> {
	const d = await createDossier(db, {
		id,
		userEmail: email,
		sentence: "我想跟踪 AI agent 的记忆与上下文工程",
		domain: "agent 记忆与上下文工程",
		caresAbout: ["长期记忆", "上下文压缩"],
		notCaresAbout: ["闭源 SaaS"],
		queries: ["agent memory", "context engineering"],
		createdAt: 1,
		updatedAt: 1,
	});
	return d!;
}

beforeEach(async () => {
	db = freshDb();
	resetPlan();
	plan.search = [repo("a/one", { stargazers_count: 900 }), repo("b/two", { stargazers_count: 800 })];
	plan.detail.set("a/one", repo("a/one", { stargazers_count: 900 }));
	plan.detail.set("b/two", repo("b/two", { stargazers_count: 800 }));
});

// ---------------------------------------------------------------------------
// 遍历与失败隔离
// ---------------------------------------------------------------------------

describe("cron · 遍历哪些人", () => {
	it("一个档案都没有时,一趟什么也不做(但过期行照样扫)", async () => {
		const out = await runWeeklyCron(env(), { clock: at(MONDAY) });
		assert.equal(out.users, 0);
		assert.equal(out.scanned, 0);
		assert.equal(sesCalls.length, 0);
	});

	it("**只扫有档案的用户**:删了档案的人下一趟就不在名单里了", async () => {
		await makeDossier("d-keep", "keep@example.com");
		await makeDossier("d-gone", "gone@example.com");
		// 删档 —— store.ts deleteDossierCascade 那个窄窗口的解法就是这一条:
		// cron 的名单来自 dossier 表本身,删掉的人下一趟根本不在里面。
		await deleteDossierCascade(db, "gone@example.com");

		const out = await runWeeklyCron(env(), { clock: at(MONDAY) });
		assert.equal(out.users, 1);
		assert.equal(out.scanned, 1);
		assert.equal(sesCalls.length, 1);
		assert.equal(sesCalls[0]!.to, "keep@example.com");
		// 删掉的那个人一行周扫都不该有
		assert.deepEqual(await listRecentScans(db, "d-gone", 5), []);
	});
});

describe("cron · 串行,绝不并发(决策 T5)", () => {
	it("三个用户跑下来,任何时刻只有一个 GitHub 请求在飞", async () => {
		await makeDossier("d-1", "one@example.com");
		await makeDossier("d-2", "two@example.com");
		await makeDossier("d-3", "three@example.com");

		const out = await runWeeklyCron(env(), { clock: at(MONDAY) });
		assert.equal(out.scanned, 3);
		// **1,不是 3。**改成 Promise.all(users.map(...)) 之后,台账、计数、邮件
		// 全都还是对的,只有这一行会红 —— 而线上的症状是第三个用户开始吃 403,
		// 而且 403 之后继续打会被 GitHub 拉进更长的惩罚窗口(共享桶)。
		assert.equal(maxInFlight, 1, `同时最多 ${maxInFlight} 个请求在飞,说明扇出并发了`);
	});
});

describe("cron · 一个用户失败不拖垮整趟", () => {
	it("中间那个人写库炸了,前后两个照跑,而且失败数看得见", async () => {
		await makeDossier("d-1", "one@example.com");
		await makeDossier("d-2", "two@example.com");
		await makeDossier("d-3", "three@example.com");
		// d-2 的任何一次带 id 的写库都抛异常(putWeeklyScan 的 batch 会整批回滚)
		poison = "d-2";

		const out = await runWeeklyCron(env(), { clock: at(MONDAY) });
		assert.equal(out.users, 3);
		assert.equal(out.scanned, 2);
		// **失败必须数得出来**:一个安静吞异常的循环和一个跑通了的循环,
		// 在日志里长得一模一样,而这一趟一周才跑一次。
		assert.equal(out.failed, 1);
		assert.equal(out.email.sent, 2);
		assert.deepEqual(
			sesCalls.map((c) => c.to).sort(),
			["one@example.com", "three@example.com"],
		);
		// 炸掉的那个人没有半截周扫留下(batch 回滚了)。先撤掉注入,否则连这次
		// 读都会被自己的假故障挡住。
		poison = null;
		assert.deepEqual(await listRecentScans(db, "d-2", 5), []);
	});
});

describe("cron · 预算", () => {
	it("整趟预算用完之后,剩下的人记 notReached,不是被静默掐断", async () => {
		await makeDossier("d-1", "one@example.com");
		await makeDossier("d-2", "two@example.com");
		// 时钟每次读都往前跳 2 秒,而整趟预算只有 1 秒 → 第一个人就已经过线
		let t = MONDAY;
		const clock = () => {
			const v = t;
			t += 2_000;
			return v;
		};
		const out = await runWeeklyCron(env({ CRON_BUDGET_MS: "1000" }), { clock });
		assert.equal(out.users, 2);
		assert.equal(out.scanned, 0);
		assert.equal(out.notReached, 2);
		assert.equal(sesCalls.length, 0);
	});
});

describe("cron · 顺带清过期行", () => {
	it("sweepExpired 真的被调到了(D1 没有原生 TTL,不扫就一直长)", async () => {
		raw.exec("INSERT INTO quota (subject, day, kind, used) VALUES ('who', '2020-01-01', 'ai', 3)");
		raw.exec("INSERT INTO daily_spend (day, est_usd) VALUES ('2020-01-01', 1.5)");
		const out = await runWeeklyCron(env(), { clock: at(MONDAY) });
		assert.equal(out.sweep.quota, 1);
		assert.equal(out.sweep.spend, 1);
		assert.equal((raw.prepare("SELECT COUNT(*) AS n FROM quota").get() as { n: number }).n, 0);
	});
});

// ---------------------------------------------------------------------------
// 门铃邮件
// ---------------------------------------------------------------------------

describe("cron · 邮件只发一次", () => {
	it("同一周跑两次:扫描幂等(还是一行),信只发一封", async () => {
		await makeDossier("d-1", "one@example.com");

		const first = await runWeeklyCron(env(), { clock: at(MONDAY) });
		assert.equal(first.email.sent, 1);
		assert.equal(sesCalls.length, 1);

		// cron 重试 / 站长补跑 —— 同一周再来一趟
		const second = await runWeeklyCron(env(), { clock: at(MONDAY + 60_000) });
		assert.equal(second.scanned, 1); // 周扫照跑
		assert.equal(second.email.sent, 0);
		assert.equal(second.email.duplicate, 1); // **信没再发**
		assert.equal(sesCalls.length, 1);

		// 周扫幂等:同一 (档案, 周) 只有一行
		const scans = await listRecentScans(db, "d-1", 10);
		assert.equal(scans.length, 1);
		assert.equal(scans[0]!.weekOf, WEEK_A);
	});

	it("发信台账记下了这一封:sent_at 有值、error 为空", async () => {
		await makeDossier("d-1", "one@example.com");
		await runWeeklyCron(env(), { clock: at(MONDAY) });
		const rec = await getWeeklyEmail(db, weeklyScanId("d-1", WEEK_A));
		assert.ok(rec);
		assert.equal(rec.userEmail, "one@example.com");
		assert.equal(rec.error, null);
		assert.ok(rec.sentAt !== null);
	});
});

describe("cron · 发不出去的时候", () => {
	it("没配 EMAIL_UNSUB_SECRET:不发信,周扫照常落库(其余功能完整)", async () => {
		await makeDossier("d-1", "one@example.com");
		const out = await runWeeklyCron(env({ EMAIL_UNSUB_SECRET: undefined }), { clock: at(MONDAY) });
		assert.equal(out.scanned, 1);
		assert.equal(out.email.unconfigured, 1);
		assert.equal(sesCalls.length, 0);
		// **没认领**:等站长把密钥配上,同一周补跑一次仍然发得出去
		assert.equal(await getWeeklyEmail(db, weeklyScanId("d-1", WEEK_A)), null);
		const bundle = await getWeeklyScan(db, "d-1", WEEK_A);
		assert.equal(bundle?.candidates.length, 2);
	});

	it("SES 报错:记进台账、整趟不崩,而且同一周不会重发", async () => {
		await makeDossier("d-1", "one@example.com");
		sesStatus = 400;
		const out = await runWeeklyCron(env(), { clock: at(MONDAY) });
		assert.equal(out.scanned, 1);
		assert.equal(out.email.failed, 1);
		assert.equal(out.failed, 0); // 发信失败不算「这个用户这一趟失败」
		const rec = await getWeeklyEmail(db, weeklyScanId("d-1", WEEK_A));
		assert.equal(rec?.sentAt, null);
		assert.match(rec?.error ?? "", /SES send failed/);

		// 认领行留着 —— 丢一封 vs 发两封,选丢一封(cron.ts sendDoorbell 的取舍)
		sesStatus = 200;
		const again = await runWeeklyCron(env(), { clock: at(MONDAY + 60_000) });
		assert.equal(again.email.duplicate, 1);
		assert.equal(sesCalls.length, 1); // 那一封失败的,没有第二次
	});
});

describe("cron · 邮件内容", () => {
	it("第一周:清单 + 「没有可比的上一周」+ 一个回网页的按钮,没有报告正文", async () => {
		await makeDossier("d-1", "one@example.com");
		await runWeeklyCron(env(), { clock: at(MONDAY) });
		const mail = sesCalls[0]!;
		assert.match(mail.subject, /领域拆解 · 2026-W37 · 2 个候选/);
		assert.match(mail.text, /a\/one/);
		assert.match(mail.text, /这是第一周,没有可比的上一周/);
		assert.ok(mail.text.includes("https://nanisle.com/products/weekly-teardown/app"));
		for (const marker of ["takeaway", "引文", "#L"]) assert.ok(!mail.text.includes(marker));
	});

	it("List-Unsubscribe 头挂上了,链接就是正文里那一个(Gmail 2024 起的硬要求)", async () => {
		await makeDossier("d-1", "one@example.com");
		await runWeeklyCron(env(), { clock: at(MONDAY) });
		const mail = sesCalls[0]!;
		const unsub = mail.headers.find((h) => h.Name === "List-Unsubscribe")!;
		const oneClick = mail.headers.find((h) => h.Name === "List-Unsubscribe-Post")!;
		assert.match(unsub.Value, /^<https:\/\/nanisle\.com\/products\/weekly-teardown\/unsub\?token=.+>$/);
		assert.equal(oneClick.Value, "List-Unsubscribe=One-Click");
		assert.ok(mail.text.includes(unsub.Value.slice(1, -1)));
		// 顺带证明 SigV4 真的签了(注入假发信函数就看不到这一行)
		assert.match(mail.authorization, /^AWS4-HMAC-SHA256 Credential=AKIAFAKE/);
	});

	it("第二周:四类变化真的出现在信里", async () => {
		await makeDossier("d-1", "one@example.com");
		await runWeeklyCron(env(), { clock: at(MONDAY) });

		// 下一周:a/one 涨了 400 星(1000 的阈值是 200)、b/two 转归档换许可证、
		// c/three 是新冒出来的
		plan.search = [
			repo("a/one", { stargazers_count: 1300 }),
			repo("b/two", { stargazers_count: 800, archived: true }),
			repo("c/three", { stargazers_count: 700 }),
		];
		plan.detail.set("a/one", repo("a/one", { stargazers_count: 1300 }));
		// 归档的仓进不了候选清单(规则筛掉),所以「转归档」要靠申诉才看得到 ——
		// 这里改成只换许可证,把「转归档」留给下面那条直接喂快照的用例。
		plan.detail.set("b/two", repo("b/two", { stargazers_count: 800, license: { spdx_id: "Apache-2.0" } }));
		plan.search[1] = repo("b/two", { stargazers_count: 800 });
		plan.detail.set("c/three", repo("c/three", { stargazers_count: 700 }));

		await runWeeklyCron(env(), { clock: at(MONDAY + 7 * 86_400_000) });
		assert.equal(sesCalls.length, 2);
		const mail = sesCalls[1]!;
		assert.ok(mail.text.includes(`与上一次(${WEEK_A})比`));
		assert.match(mail.subject, new RegExp(WEEK_B));
		assert.match(mail.text, /新进清单:c\/three/);
		assert.ok(mail.text.includes("换许可证:b/two(MIT → Apache-2.0)"));
		assert.ok(mail.text.includes("star 跃迁:a/one(900 → 1,300,+400)"));
	});

	it("申诉捞回来的那些:邮件里有「你捞回来的」和当初的排除理由", async () => {
		const d = await makeDossier("d-1", "one@example.com");
		// 先跑一趟(不配邮件,免得占掉认领),再申诉,再单独发一次门铃
		await runWeeklyCron(env({ EMAIL_UNSUB_SECRET: undefined }), { clock: at(MONDAY) });
		const scanId = weeklyScanId("d-1", WEEK_A);
		// 这一趟里 ranked-out 一个都没有,手工塞一条排除再申诉它
		raw.exec(
			`INSERT INTO scan_exclusion (scan_id, full_name, reason, reason_kind, reason_source, appealed_at, pushed_at)
			 VALUES ('${scanId}', 'saved/one', '没有许可证,法律上不可用', 'no-license', 'rule', NULL, '2026-08-01T00:00:00Z')`,
		);
		const moved = await appealExclusion(
			db,
			{ dossierId: "d-1", weekOf: WEEK_A },
			{
				fullName: "saved/one",
				stars: 42,
				pushedAt: "2026-08-01T00:00:00Z",
				archived: false,
				license: null,
				repoCreatedAt: "2021-01-01T00:00:00Z",
				oneLiner: "一个自己部署的记忆服务",
				topics: [],
				sourceRoute: "appealed",
			},
			MONDAY,
		);
		assert.equal(moved, true);

		const settled = await settleWeek(env(), d, WEEK_A, MONDAY);
		const outcome = await sendDoorbell(env(), d, WEEK_A, MONDAY, settled);
		assert.equal(outcome, "sent");
		const mail = sesCalls[0]!;
		assert.match(mail.text, /你捞回来的/);
		assert.match(mail.text, /没有许可证,法律上不可用/);
		// **不截断**:算法挑的 2 个 + 捞回来的 1 个 = 3 行都在
		for (const n of ["a/one", "b/two", "saved/one"]) assert.ok(mail.text.includes(n), `${n} 不见了`);
	});
});

// ---------------------------------------------------------------------------
// 一键退订
// ---------------------------------------------------------------------------

describe("退订端点 GET/POST /unsub", () => {
	const call = (method: string, token: string, over: Partial<AppEnv> = {}) =>
		emailRoutes.request(`/unsub?token=${encodeURIComponent(token)}`, { method }, env(over));

	it("有效 token:退订成功,之后 cron 不再给他发信(但周扫照跑)", async () => {
		await makeDossier("d-1", "one@example.com");
		const res = await call("GET", await unsubToken(SES_ENV.EMAIL_UNSUB_SECRET, "one@example.com"));
		assert.equal(res.status, 200);
		assert.equal(await isOptedOut(db, "one@example.com"), true);

		const out = await runWeeklyCron(env(), { clock: at(MONDAY) });
		assert.equal(out.scanned, 1); // **周扫照跑**:退订的是门铃,不是产品
		assert.equal(out.email.optout, 1);
		assert.equal(sesCalls.length, 0);
		assert.equal((await getWeeklyScan(db, "d-1", WEEK_A))?.candidates.length, 2);
	});

	it("篡改过的 token:400,而且没有任何人被退订", async () => {
		const t = await unsubToken(SES_ENV.EMAIL_UNSUB_SECRET, "one@example.com");
		const res = await call("GET", `${t.split(".")[0]}.AAAA`);
		assert.equal(res.status, 400);
		assert.equal(await isOptedOut(db, "one@example.com"), false);
	});

	it("没配 EMAIL_UNSUB_SECRET 的实例:503(是服务端没开,不是链接坏了)", async () => {
		const res = await call("GET", "whatever", { EMAIL_UNSUB_SECRET: undefined });
		assert.equal(res.status, 503);
	});

	it("POST(Gmail 的一键退订)走同一条路,回 JSON", async () => {
		const res = await call("POST", await unsubToken(SES_ENV.EMAIL_UNSUB_SECRET, "one@example.com"));
		assert.equal(res.status, 200);
		assert.deepEqual(await res.json(), { ok: true });
		assert.equal(await isOptedOut(db, "one@example.com"), true);
	});

	it("退订幂等:点两次不出错", async () => {
		const t = await unsubToken(SES_ENV.EMAIL_UNSUB_SECRET, "one@example.com");
		assert.equal((await call("GET", t)).status, 200);
		assert.equal((await call("POST", t)).status, 200);
	});
});

// ---------------------------------------------------------------------------
// 复查:上一周清单上的那些仓,这一周怎么样了(阶段 9)
// ---------------------------------------------------------------------------

const NEXT_MONDAY = MONDAY + 7 * 86_400_000;

describe("cron · 复查上一周的候选(端到端,真 GET /repos)", () => {
	/** 第一周:a/one + b/two 进清单。 */
	async function firstWeek(): Promise<void> {
		await makeDossier("d-1", "one@example.com");
		await runWeeklyCron(env(), { clock: at(MONDAY) });
		assert.equal(sesCalls.length, 1);
	}

	it("**掉出清单 + 已归档**:两件事一起报,而且后者是重点", async () => {
		await firstWeek();
		// 第二周 a/one 连搜索结果里都没有了(它从 star 榜上掉下去了),
		// 而且它在 GitHub 上已经归档 —— 只比「上周清单 vs 本周清单」的话,
		// 它就只是安静地消失,而那正是阶段 8 留下的洞。
		plan.search = [repo("b/two", { stargazers_count: 800 }), repo("c/three", { stargazers_count: 700 })];
		plan.detail.set("a/one", repo("a/one", { stargazers_count: 900, archived: true }));
		plan.detail.set("c/three", repo("c/three", { stargazers_count: 700 }));

		const out = await runWeeklyCron(env(), { clock: at(NEXT_MONDAY) });
		assert.equal(out.recheck.checked, 2); // 上一周清单上就是两个
		assert.equal(out.recheck.changed, 1);
		assert.equal(out.recheck.unchecked, 0);

		const mail = sesCalls[1]!;
		assert.match(mail.text, /转归档:a\/one/);
		assert.ok(mail.text.includes("不在上面那份清单里了"));
		assert.ok(mail.text.includes("复查了上一周清单上的 2 个仓:1 个有变化,0 个没查成"));
		// 本周清单里确实已经没有它了 —— 「它掉出清单了」这件事是真的
		assert.ok(!mail.text.includes("1. a/one"));
	});

	it("仓被删(404)照样报,措辞是「已经没了」不是「没查成」", async () => {
		await firstWeek();
		plan.search = [repo("b/two", { stargazers_count: 800 })];
		plan.detail.delete("a/one"); // 假 GitHub 对未知仓回 404

		const out = await runWeeklyCron(env(), { clock: at(NEXT_MONDAY) });
		assert.equal(out.recheck.changed, 1);
		assert.equal(out.recheck.unchecked, 0); // **404 是答案,不是失败**

		const mail = sesCalls[1]!;
		assert.match(mail.text, /已经没了:a\/one/);
		assert.ok(mail.text.includes("404"));
		assert.ok(!mail.text.includes("没查成的不代表"));
	});

	it("**GitHub 挂了(503)不是「仓没了」**:记没查成,一个字都不说它出事了", async () => {
		await firstWeek();
		plan.search = [repo("b/two", { stargazers_count: 800 })];
		plan.status.set("a/one", 503);

		const out = await runWeeklyCron(env(), { clock: at(NEXT_MONDAY) });
		assert.equal(out.recheck.checked, 2);
		assert.equal(out.recheck.changed, 0);
		assert.equal(out.recheck.unchecked, 1);

		const mail = sesCalls[1]!;
		assert.ok(mail.text.includes("复查了上一周清单上的 2 个仓:0 个有变化,1 个没查成"));
		assert.ok(mail.text.includes("没查成的不代表它们出事了"));
		assert.ok(mail.text.includes("a/one"));
		// 这一条是这整段改动最该守住的:503 绝不能被写成「它没了」
		assert.ok(!mail.text.includes("已经没了"));
		assert.ok(!mail.text.includes("转归档:a/one"));
	});

	it("第一周没有上一周可复查,账上如实是 0,信里一个字都不提复查", async () => {
		await makeDossier("d-1", "one@example.com");
		const out = await runWeeklyCron(env(), { clock: at(MONDAY) });
		assert.equal(out.recheck.checked, 0);
		assert.ok(!sesCalls[0]!.text.includes("复查"));
	});

	// **这条用例掉了个方向**(2026-09-01 上线前终审,站长拍板)。阶段 9 原来钉的是
	// 「退订的人一次都不复查」,理由是「信都不发了,没有理由花全站共用的额度」。
	// 那条理由把退订读成了「别帮我看了」,而退订的意思只是「别给我发邮件」——
	// 周扫照跑、清单照落库,跨周变化凭什么例外?而且复查是「你上周在看的那个项目
	// 死了」的唯一出处,退订之后网页上恰恰只能从这里看到它(那个仓已经不在清单上)。
	it("**退订的人照算照落库,只是不发信**(退订是「别发邮件」,不是「别帮我看了」)", async () => {
		await firstWeek();
		raw.exec(`INSERT INTO email_optout (user_email, at) VALUES ('one@example.com', 1)`);
		const out = await runWeeklyCron(env(), { clock: at(NEXT_MONDAY) });
		assert.equal(out.email.optout, 1);
		assert.equal(sesCalls.length, 1, "第二周一封信都不该发");
		// 复查照做(上一周清单上有 2 个仓)
		assert.equal(out.recheck.checked, 2);
		// **而且跨周结论落库了** —— 这才是这一条改动的目的
		const change = await getWeeklyChange(db, "d-1", WEEK_B);
		assert.ok(change, "退订的人这一周没有跨周记录 = 网页上没有东西可翻");
		assert.equal(change.prevWeekOf, WEEK_A);
		assert.equal(change.counts.recheckChecked, 2);
	});
});

describe("recheckPrevious · 三种结局与硬停", () => {
	const snap = (fullName: string, over: Partial<RepoSnapshot> = {}): RepoSnapshot => ({
		fullName,
		stars: 100,
		archived: false,
		license: "MIT",
		...over,
	});

	/** 按名字给结局:函数抛异常 = GitHub 侧错误,返回 null = 404。 */
	const probe = (f: (name: string) => Promise<RepoSnapshot | null>): RecheckProbe => ({ getRepo: f });

	it("200 / 404 / 抛异常 分别落进 ok / gone / unchecked", async () => {
		const out = await recheckPrevious(
			probe(async (n) => {
				if (n === "gone/x") return null;
				if (n === "bad/x") throw new Error("GET /repos/bad/x 失败:HTTP 503");
				return snap(n, { archived: true });
			}),
			[snap("ok/x"), snap("gone/x"), snap("bad/x")],
		);
		assert.equal(out.get("ok/x")!.kind, "ok");
		assert.equal(out.get("gone/x")!.kind, "gone");
		assert.equal(out.get("bad/x")!.kind, "unchecked");
	});

	it("普通失败**不停**循环:一个仓的 503 不该让后面的仓失去复查机会", async () => {
		const seen: string[] = [];
		const out = await recheckPrevious(
			probe(async (n) => {
				seen.push(n);
				if (n === "bad/x") throw new Error("HTTP 503");
				return snap(n);
			}),
			[snap("bad/x"), snap("a/x"), snap("b/x")],
		);
		assert.deepEqual(seen, ["bad/x", "a/x", "b/x"]);
		assert.equal(out.get("a/x")!.kind, "ok");
	});

	it("限流(403)当场停,后面的仓一个都不打 —— 但每一个都要在账上留下「没查成」", async () => {
		const seen: string[] = [];
		const out = await recheckPrevious(
			probe(async (n) => {
				seen.push(n);
				throw new GithubError("rate limited", 403);
			}),
			[snap("a/x"), snap("b/x"), snap("c/x")],
		);
		// **只打了一发**:403 之后继续打会被 GitHub 拉进更长的惩罚窗口(决策 T5)
		assert.deepEqual(seen, ["a/x"]);
		for (const n of ["a/x", "b/x", "c/x"]) {
			const o = out.get(n)!;
			assert.equal(o.kind, "unchecked");
			assert.match(o.kind === "unchecked" ? o.why : "", /限流/);
		}
	});

	it(`超过 ${RECHECK_MAX} 个的部分记「没查成」并说明为什么,不假装查过`, async () => {
		let calls = 0;
		const many = Array.from({ length: RECHECK_MAX + 3 }, (_, i) => snap(`o/r${i}`));
		const out = await recheckPrevious(
			probe(async (n) => {
				calls += 1;
				return snap(n);
			}),
			many,
		);
		assert.equal(calls, RECHECK_MAX);
		const last = out.get(`o/r${RECHECK_MAX + 2}`)!;
		assert.equal(last.kind, "unchecked");
		assert.match(last.kind === "unchecked" ? last.why : "", new RegExp(`前 ${RECHECK_MAX} 个`));
	});
});

// ---------------------------------------------------------------------------
// 订阅开关 GET/PUT /api/email(阶段 9)
// ---------------------------------------------------------------------------
//
// 这一段要钉死的是**「两处写的是同一张表」**。它出错的形状很特别:开关自己
// 一切正常(点了、保存了、页面上状态也变了),只有 cron 读到的是另一个值,
// 于是用户在页面上看着「在收」却永远收不到信 —— 没有报错,没有红字。
// 所以下面每一条都要跨过那道缝去断言:改完之后真的跑一趟 cron,看信发没发。

describe("订阅开关 · 和退订链接写的是同一张表", () => {
	const prefs = (init?: RequestInit, over: Partial<AppEnv> = {}) =>
		emailRoutes.request("/api/email", init, env(over));

	it("GET:告诉用户当前是什么状态,以及关的是发给哪个地址的信", async () => {
		const res = await prefs();
		assert.equal(res.status, 200);
		assert.deepEqual(await res.json(), { email: "dev@local", optedOut: false, configured: true });
	});

	it("PUT true → cron 不再发信;PUT false → 下一周又发得出来(**双向**)", async () => {
		await makeDossier("d-1", "dev@local");

		// 关掉
		const off = await prefs({ method: "PUT", body: JSON.stringify({ optedOut: true }) });
		assert.equal(((await off.json()) as { optedOut: boolean }).optedOut, true);
		const w1 = await runWeeklyCron(env(), { clock: at(MONDAY) });
		assert.equal(w1.email.optout, 1);
		assert.equal(sesCalls.length, 0);

		// 打开 —— 阶段 8 之后这条路根本不存在,退订是一条单行道
		const on = await prefs({ method: "PUT", body: JSON.stringify({ optedOut: false }) });
		assert.equal(((await on.json()) as { optedOut: boolean }).optedOut, false);
		const w2 = await runWeeklyCron(env(), { clock: at(MONDAY + 7 * 86_400_000) });
		assert.equal(w2.email.sent, 1);
		assert.equal(sesCalls.length, 1);
	});

	it("**邮件里那条退订链接点完,开关读出来就是「已退订」**", async () => {
		const token = await unsubToken(SES_ENV.EMAIL_UNSUB_SECRET, "dev@local");
		assert.equal((await emailRoutes.request(`/unsub?token=${encodeURIComponent(token)}`, {}, env())).status, 200);
		assert.equal(((await (await prefs()).json()) as { optedOut: boolean }).optedOut, true);
	});

	it("**开关关掉之后,一键退订链接再点一次也不出错**(同一行,幂等)", async () => {
		await prefs({ method: "PUT", body: JSON.stringify({ optedOut: true }) });
		const token = await unsubToken(SES_ENV.EMAIL_UNSUB_SECRET, "dev@local");
		assert.equal((await emailRoutes.request(`/unsub?token=${encodeURIComponent(token)}`, {}, env())).status, 200);
		assert.equal(await isOptedOut(db, "dev@local"), true);
	});

	it("重新订阅是幂等的:没退订过的人点「继续收」不报错", async () => {
		const res = await prefs({ method: "PUT", body: JSON.stringify({ optedOut: false }) });
		assert.equal(res.status, 200);
		assert.equal(await isOptedOut(db, "dev@local"), false);
	});

	it("只认真正的布尔:漏传 / 传字符串一律 400,**不猜一个方向**", async () => {
		for (const body of ["{}", '{"optedOut":"false"}', '{"optedOut":1}', "不是 JSON"]) {
			const res = await prefs({ method: "PUT", body });
			assert.equal(res.status, 400, `body=${body} 应该被拒`);
		}
		assert.equal(await isOptedOut(db, "dev@local"), false);
	});

	it("没配发信凭证的实例:configured=false,开关照常读写但如实说没信可发", async () => {
		const res = await prefs(undefined, { EMAIL_UNSUB_SECRET: undefined });
		assert.equal(((await res.json()) as { configured: boolean }).configured, false);
	});

	it("**删档不删退订**(阶段 8 的取舍保持),但开关能把它改回来", async () => {
		await makeDossier("d-1", "dev@local");
		await prefs({ method: "PUT", body: JSON.stringify({ optedOut: true }) });
		await deleteDossierCascade(db, "dev@local");
		// 删档重建**不是**一条重新订阅的路径
		assert.equal(await isOptedOut(db, "dev@local"), true);
		// 但用户自己能改回来 —— 这正是阶段 8 开放问题里缺的那个入口
		await prefs({ method: "PUT", body: JSON.stringify({ optedOut: false }) });
		assert.equal(await isOptedOut(db, "dev@local"), false);
	});

	it("按账号各管各的:退订一个人不影响另一个人", async () => {
		await emailRoutes.request("/api/email", { method: "PUT", body: JSON.stringify({ optedOut: true }) }, env({ DEV_EMAIL: "a@example.com" }));
		assert.equal(await isOptedOut(db, "a@example.com"), true);
		assert.equal(await isOptedOut(db, "b@example.com"), false);
	});
});

// ---------------------------------------------------------------------------
// 上线前终审(2026-09-01):跨周结论落库 + 整趟失败要留下痕迹
// ---------------------------------------------------------------------------

describe("cron · 跨周结论落库(站长拍板,最重要的一条)", () => {
	/** 第一周 + 第二周,第二周里 c/three 是新进清单的。 */
	async function twoWeeks(over: Partial<AppEnv> = {}): Promise<void> {
		await makeDossier("d-1", "one@example.com");
		await runWeeklyCron(env(over), { clock: at(MONDAY) });
		plan.search = [
			repo("a/one", { stargazers_count: 1300 }),
			repo("b/two", { stargazers_count: 800 }),
			repo("c/three", { stargazers_count: 700 }),
		];
		plan.detail.set("a/one", repo("a/one", { stargazers_count: 1300 }));
		plan.detail.set("c/three", repo("c/three", { stargazers_count: 700 }));
		await runWeeklyCron(env(over), { clock: at(MONDAY + 7 * 86_400_000) });
	}

	it("第一周也落一行:prevWeekOf 为 null,四类全空 —— **「没记过」和「没变化」是两句话**", async () => {
		await makeDossier("d-1", "one@example.com");
		await runWeeklyCron(env(), { clock: at(MONDAY) });
		const change = await getWeeklyChange(db, "d-1", WEEK_A);
		assert.ok(change, "第一周也要有记录,否则网页分不出「还没跑过」和「跑了没变化」");
		assert.equal(change.prevWeekOf, null);
		assert.equal(change.counts.changed, false);
		assert.equal(change.counts.recheckChecked, 0);
	});

	it("第二周:库里那一份和邮件正文说的是同一件事", async () => {
		await twoWeeks();
		const change = await getWeeklyChange(db, "d-1", WEEK_B);
		assert.ok(change);
		assert.equal(change.prevWeekOf, WEEK_A);
		assert.deepEqual(change.diff.appeared, ["c/three"]);
		assert.equal(change.counts.appeared, 1);
		assert.equal(change.counts.changed, true);
		// star 跃迁那条也在(900 → 1300,阈值 180)
		assert.deepEqual(
			change.diff.starJumps.map((j) => j.fullName),
			["a/one"],
		);
		// 邮件正文里说的是同一批 —— 两边读的是同一份 diff,不是各算一遍
		const mail = sesCalls[1]!;
		assert.match(mail.text, /新进清单:c\/three/);
		assert.ok(mail.text.includes(`与上一次(${WEEK_A})比`));
	});

	it("**SES 报错也不丢结论**(这就是这条改动要修的那个 bug 的实物)", async () => {
		sesStatus = 403;
		await twoWeeks();
		// 阶段 8 的取舍:认领行不删、不重试 —— 所以这一周的门铃**永远不会补发**
		const claim = await getWeeklyEmail(db, weeklyScanId("d-1", WEEK_B));
		assert.equal(claim?.sentAt, null);
		assert.match(claim?.error ?? "", /SES send failed/);
		// 而那一趟的换血结论必须还在库里,网页照样翻得到
		const change = await getWeeklyChange(db, "d-1", WEEK_B);
		assert.ok(change, "信发失败把这一周的跨周结论一起带走了");
		assert.deepEqual(change.diff.appeared, ["c/three"]);
	});

	it("没配发信凭证的实例(fork 的人)照样落库", async () => {
		await twoWeeks({ EMAIL_UNSUB_SECRET: undefined });
		assert.equal(sesCalls.length, 0);
		assert.ok(await getWeeklyChange(db, "d-1", WEEK_B), "没配邮件不该等于没有跨周状态");
	});

	it("**落库在发信之前**:结算这一步炸了就不该发信(顺序不能倒过来)", async () => {
		await makeDossier("d-1", "one@example.com");
		await runWeeklyCron(env(), { clock: at(MONDAY) });
		sesCalls = [];
		// 让 weekly_change 这一行写不进去(表名进不了绑定参数,所以直接删表)
		raw.exec("DROP TABLE weekly_change");
		const out = await runWeeklyCron(env(), { clock: at(MONDAY + 7 * 86_400_000) });
		assert.equal(out.failed, 1, "结算失败要被数出来");
		assert.equal(sesCalls.length, 0, "结论没落库却把信发了 = 又回到了那个 bug");
	});
});

describe("cron · 整趟失败也要留下痕迹(A3)", () => {
	/** 一个每次 prepare 都炸的 D1(演「周一早上 D1 抖了一下」)。 */
	const brokenDb = {
		prepare() {
			throw new Error("D1 这会儿不通");
		},
		batch() {
			throw new Error("D1 这会儿不通");
		},
	} as unknown as D1Database;

	it("起手的库操作炸了:**不抛异常**,记进 tripError,而且起跑和收工两条日志都在", async () => {
		const lines: string[] = [];
		const log = console.log;
		const err = console.error;
		console.log = (...a: unknown[]) => void lines.push(a.map(String).join(" "));
		console.error = (...a: unknown[]) => void lines.push(a.map(String).join(" "));
		try {
			// **不许 reject**:cron 触发器不重试,往外抛只会变成一条谁也不会去看的
			// 未捕获错误,而这一周对所有人就这么过去了。
			const out = await runWeeklyCron(env({ TEARDOWN_DB: brokenDb }), { clock: at(MONDAY), cron: "0 8 * * 1" });
			assert.match(out.tripError ?? "", /D1 这会儿不通/);
			assert.equal(out.users, 0);
			assert.equal(out.scanned, 0);
		} finally {
			console.log = log;
			console.error = err;
		}
		assert.ok(
			lines.some((l) => l.includes("起跑")),
			"没有「起跑」日志 = 这一趟到底有没有被触发都说不清",
		);
		assert.ok(
			lines.some((l) => l.includes("收工")),
			"没有「收工」日志 = 整趟失败和跑通了长得一模一样",
		);
		assert.ok(lines.some((l) => l.includes("整趟失败")));
	});

	it("清过期行失败**不拦路**:它是顺手做的事,不该让所有人这周什么都收不到", async () => {
		await makeDossier("d-1", "one@example.com");
		// sweepExpired 绑的是保留窗口那天(2026-09-07 往前 7 天)
		poison = "2026-08-31";
		const out = await runWeeklyCron(env(), { clock: at(MONDAY) });
		poison = null;
		assert.equal(out.tripError, null, "清理挂了不算整趟失败");
		assert.deepEqual(out.sweep, { quota: 0, spend: 0 });
		assert.equal(out.scanned, 1, "周扫照跑");
		assert.equal(out.email.sent, 1, "信照发");
	});
});
