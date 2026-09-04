// store.ts 的测试。跑法:npm test(node --experimental-strip-types --test)。
//
// **假 D1 是怎么造的,以及为什么这么造。**
//
// D1 在 node 测试里没有真实例。手写一个「够跑我这几条 SQL」的内存假货是能写的,
// 但那样测的就是我自己写的那个假货的语义,而这一阶段最需要验的恰恰是
// `ON CONFLICT ... DO UPDATE ... WHERE ... RETURNING` 这一句在**真 SQLite** 下
// 的行为(docs/02 技术风险 1 点名的就是这个)。手写假货必然把这句实现成
// 「if used < limit then ...」,那测出来的原子性是我自己写的 if,不是数据库的。
//
// 所以这里不手写 SQL 语义,而是把 node 22.5+ 自带的 `node:sqlite` 包成 D1 的
// 接口形状。D1 底层就是 SQLite,同一句 SQL 在两边解析器上的行为一致。
// 这不需要新增任何依赖(node 内置),符合「不为测试加依赖」的约束。
//
// **这样能测到什么、测不到什么**(别高估这份测试):
//   能测:  单条语句在多个交错的异步调用者之间是否守得住上限;
//          upsert 的 WHERE 子句是不是真的挡住了超限的那一次自增;
//          RETURNING 无行 = 占位失败这个约定;
//          batch 的事务性(BEGIN/COMMIT 包住,失败整批回滚)。
//   测不到:D1 是分布式的(Worker 到 D1 有网络、有主从、有重试),真正的
//          并发行为要在阶段 2 的线上验收里打两个同时的请求看
//          (docs/02 技术风险 1 里那条验收就是为这个设的,不是走形式)。
//          node:sqlite 是同步驱动,同一时刻只有一条语句在跑——这正是
//          「单条语句原子」的模型,但不是「两个进程真并行」的模型。
//
// 为了证明这份测试**不是空转**,下面有一个 raceyReserve 的对照组:同样的假 D1、
// 同样的并发写法,只是把一句 SQL 拆成「读 → 判断 → 写」,它必须超发。
// 对照组不超发的话,说明这个测试台根本交错不起来,原子性那条也就没测到东西。

import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { DatabaseSync } from "node:sqlite";
import { readFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { beforeEach, describe, it } from "node:test";
import {
	DAILY_SPEND_CAP_USD,
	IP_QUOTA_LIMITS,
	QUOTA_LIMITS,
	clearInflight,
	createDossier,
	findReport,
	getDossier,
	getInflight,
	getQuota,
	getReport,
	getWeeklyScan,
	ipQuotaSubject,
	listRecentScans,
	appealExclusion,
	getWeeklyChange,
	latestReport,
	latestWeeklyChange,
	listScanAppeals,
	putInflight,
	putReport,
	putWeeklyChange,
	putWeeklyScan,
	recordCandidateOpen,
	refundQuota,
	reserveQuota,
	addSpend,
	reserveSpend,
	spendToday,
	sweepExpired,
	todayUtc,
	updateDossier,
	weeklyScanId,
} from "./store.ts";
import type { NewDossier, NewScanCandidate, NewScanExclusion, NewWeeklyScan, Report } from "./store.ts";
import type { WeekDiff } from "./scan-diff.ts";

const HERE = path.dirname(fileURLToPath(import.meta.url));
const MIGRATION = path.resolve(HERE, "../../migrations/0001_init.sql");
const STORE_MODULE = path.resolve(HERE, "store.ts");

// ---------------------------------------------------------------------------
// 假 D1(node:sqlite 包成 D1 的接口形状)
// ---------------------------------------------------------------------------

/** D1Result 的最小形状:store.ts 只读 results 和 meta.changes。 */
interface FakeResult {
	results: Record<string, unknown>[];
	success: true;
	meta: { changes: number; last_row_id: number };
}

function runOne(db: DatabaseSync, sql: string, args: unknown[]): FakeResult {
	const st = db.prepare(sql);
	// all() 会把语句步进到底,所以 INSERT/UPDATE/DELETE 也照样生效,
	// 只是没有 RETURNING 时返回空数组 —— 正好对上 D1 的行为。
	const results = st.all(...(args as never[])) as Record<string, unknown>[];
	// changes() 只被增删改重置,中间这条 SELECT 不会污染它
	const m = db.prepare("SELECT changes() AS c, last_insert_rowid() AS r").get() as { c: number; r: number };
	return { results, success: true, meta: { changes: Number(m.c), last_row_id: Number(m.r) } };
}

// 字段全部显式声明:node 的 --experimental-strip-types 是「只删类型」模式,
// TS 的构造器参数属性(private readonly db: ...)会生成运行时代码,它不支持。
class FakeStatement {
	db: DatabaseSync;
	sql: string;
	args: unknown[];
	constructor(db: DatabaseSync, sql: string, args: unknown[] = []) {
		this.db = db;
		this.sql = sql;
		this.args = args;
	}
	/** D1 的 bind() 返回一条新语句,不改自己 —— putWeeklyScan 就是靠这一点复用同一个 prepare。 */
	bind(...args: unknown[]): FakeStatement {
		return new FakeStatement(this.db, this.sql, args);
	}
	exec(): FakeResult {
		return runOne(this.db, this.sql, this.args);
	}
	// async:D1 的这三个方法都是 Promise,await 会让出微任务队列 —— 交错就发生在这里
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
	/** D1 把一个 batch 放进同一个隐式事务;这里显式 BEGIN/COMMIT 复现它。 */
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

/** 建一个应用了 0001_init.sql 的内存库。表结构和线上逐字一致(读的是同一个文件)。 */
function freshDb(): D1Database {
	const raw = new DatabaseSync(":memory:");
	raw.exec(readFileSync(MIGRATION, "utf8"));
	return new FakeD1(raw) as unknown as D1Database;
}

const DAY = "2026-09-01";

let db: D1Database;
beforeEach(() => {
	db = freshDb();
});

// ---------------------------------------------------------------------------
// 1. 配额:原子性
// ---------------------------------------------------------------------------

describe("reserveQuota", () => {
	it("放行到上限,第 N+1 次失败", async () => {
		for (let i = 1; i <= QUOTA_LIMITS.gen; i++) {
			assert.deepEqual(await reserveQuota(db, "a@x.com", "gen", QUOTA_LIMITS.gen, DAY), { ok: true, used: i });
		}
		// 上限之外那一次:ok=false,used 停在 limit(不是 limit+1 —— 那次自增根本没发生)
		assert.deepEqual(await reserveQuota(db, "a@x.com", "gen", QUOTA_LIMITS.gen, DAY), {
			ok: false,
			used: QUOTA_LIMITS.gen,
		});
		assert.deepEqual(await getQuota(db, "a@x.com", DAY), { gen: QUOTA_LIMITS.gen, ai: 0 });
	});

	it("并发占位只有前 limit 个能成功(两个标签页同时点)", async () => {
		const limit = 3;
		const attempts = 10;
		const out = await Promise.all(
			Array.from({ length: attempts }, () => reserveQuota(db, "b@x.com", "gen", limit, DAY)),
		);
		assert.equal(out.filter((r) => r.ok).length, limit, "放行数必须正好等于上限");
		// 成功的那几次拿到的 used 必须是 1..limit 的一个排列 —— 有重复就说明两次自增撞在了一起
		assert.deepEqual(
			out
				.filter((r) => r.ok)
				.map((r) => r.used)
				.sort((x, y) => x - y),
			[1, 2, 3],
		);
		assert.equal((await getQuota(db, "b@x.com", DAY)).gen, limit);
	});

	it("对照组:读→判断→写 在同样的并发下必然超发(证明这个测试台交错得起来)", async () => {
		// 这不是 store.ts 里的实现,是**故意写坏的**版本,用来验证上面那条测试
		// 不是空转。它长得就像最自然的那个直觉写法。
		const raceyReserve = async (subject: string, limit: number): Promise<boolean> => {
			const row = await db
				.prepare("SELECT used FROM quota WHERE subject = ?1 AND day = ?2 AND kind = 'gen'")
				.bind(subject, DAY)
				.first<{ used: number }>();
			const used = row?.used ?? 0;
			if (used >= limit) return false;
			await db
				.prepare(
					"INSERT INTO quota(subject, day, kind, used) VALUES (?1, ?2, 'gen', 1) ON CONFLICT(subject, day, kind) DO UPDATE SET used = used + 1",
				)
				.bind(subject, DAY)
				.run();
			return true;
		};
		const out = await Promise.all(Array.from({ length: 6 }, () => raceyReserve("racey@x.com", 2)));
		assert.ok(out.filter(Boolean).length > 2, "对照组没有超发 = 测试台不会交错 = 原子性那条没测到东西");
	});

	it("IP 主体走 IP_QUOTA_LIMITS,和账号主体是两个独立的桶", async () => {
		const ip = ipQuotaSubject("1.2.3.4");
		for (let i = 0; i < IP_QUOTA_LIMITS.gen; i++) {
			assert.equal((await reserveQuota(db, ip, "gen", IP_QUOTA_LIMITS.gen, DAY)).ok, true);
		}
		assert.equal((await reserveQuota(db, ip, "gen", IP_QUOTA_LIMITS.gen, DAY)).ok, false);
		// 同一天同一个 kind,账号那个桶一点没被动过
		assert.equal((await reserveQuota(db, "a@x.com", "gen", QUOTA_LIMITS.gen, DAY)).ok, true);
	});

	it("gen 与 ai 是两个计数器,跨天是新桶", async () => {
		await reserveQuota(db, "a@x.com", "gen", QUOTA_LIMITS.gen, DAY);
		assert.deepEqual(await getQuota(db, "a@x.com", DAY), { gen: 1, ai: 0 });
		await reserveQuota(db, "a@x.com", "ai", QUOTA_LIMITS.ai, DAY);
		assert.deepEqual(await getQuota(db, "a@x.com", DAY), { gen: 1, ai: 1 });
		assert.deepEqual(await getQuota(db, "a@x.com", "2026-09-02"), { gen: 0, ai: 0 });
	});

	it("limit < 1 直接拒绝(那句 SQL 的 WHERE 只挂在 DO UPDATE 上,拦不住第一次 INSERT)", async () => {
		assert.deepEqual(await reserveQuota(db, "a@x.com", "gen", 0, DAY), { ok: false, used: 0 });
		// 关键:必须**没有**留下任何行,否则就是那一次 INSERT 溜进去了
		assert.deepEqual(await getQuota(db, "a@x.com", DAY), { gen: 0, ai: 0 });
	});
});

describe("refundQuota", () => {
	it("退还一次就腾出一格", async () => {
		for (let i = 0; i < QUOTA_LIMITS.gen; i++) await reserveQuota(db, "a@x.com", "gen", QUOTA_LIMITS.gen, DAY);
		assert.equal((await reserveQuota(db, "a@x.com", "gen", QUOTA_LIMITS.gen, DAY)).ok, false);
		await refundQuota(db, "a@x.com", "gen", DAY);
		assert.equal((await reserveQuota(db, "a@x.com", "gen", QUOTA_LIMITS.gen, DAY)).ok, true);
	});

	it("没占过位就退不会写成负数", async () => {
		await refundQuota(db, "nobody@x.com", "gen", DAY);
		await refundQuota(db, "nobody@x.com", "gen", DAY);
		assert.deepEqual(await getQuota(db, "nobody@x.com", DAY), { gen: 0, ai: 0 });
	});
});

// ---------------------------------------------------------------------------
// 2. 花费闸
// ---------------------------------------------------------------------------

describe("reserveSpend", () => {
	// 用 0.5 这种二进制精确的数:0.1/0.2 的浮点误差会让断言变成在测 IEEE754
	it("累计超过 DAILY_SPEND_CAP_USD 之后必须失败", async () => {
		const each = 0.5;
		const fit = DAILY_SPEND_CAP_USD / each; // 6
		for (let i = 1; i <= fit; i++) {
			assert.deepEqual(await reserveSpend(db, each, DAILY_SPEND_CAP_USD, DAY), { ok: true, spent: each * i });
		}
		assert.deepEqual(await reserveSpend(db, each, DAILY_SPEND_CAP_USD, DAY), { ok: false, spent: DAILY_SPEND_CAP_USD });
		// 失败那一次不能把账加上去 —— 否则闸门自己在污染自己的读数
		assert.equal(await spendToday(db, DAY), DAILY_SPEND_CAP_USD);
	});

	it("刚好装不下的那一笔被整笔拒绝,不做部分占位", async () => {
		assert.equal((await reserveSpend(db, 2.5, DAILY_SPEND_CAP_USD, DAY)).ok, true);
		// 剩 $0.5,来一笔 $1 —— 拒掉,而不是「先扣 0.5」
		assert.deepEqual(await reserveSpend(db, 1, DAILY_SPEND_CAP_USD, DAY), { ok: false, spent: 2.5 });
		assert.equal(await spendToday(db, DAY), 2.5);
	});

	it("单笔就超过上限时,当天第一笔也要拒(INSERT 分支绕不过 WHERE)", async () => {
		assert.deepEqual(await reserveSpend(db, DAILY_SPEND_CAP_USD + 1, DAILY_SPEND_CAP_USD, DAY), {
			ok: false,
			spent: 0,
		});
		assert.equal(await spendToday(db, DAY), 0);
	});

	it("并发占位的总额不会越过上限", async () => {
		const each = 0.25;
		const fit = DAILY_SPEND_CAP_USD / each; // 12
		const out = await Promise.all(
			Array.from({ length: fit + 8 }, () => reserveSpend(db, each, DAILY_SPEND_CAP_USD, DAY)),
		);
		assert.equal(out.filter((r) => r.ok).length, fit);
		assert.equal(await spendToday(db, DAY), DAILY_SPEND_CAP_USD);
	});

	it("负数和 NaN 被挡在 SQL 之外(NaN 进 SQL 会把整列变成 NULL)", async () => {
		assert.equal((await reserveSpend(db, -1, DAILY_SPEND_CAP_USD, DAY)).ok, false);
		assert.equal((await reserveSpend(db, Number.NaN, DAILY_SPEND_CAP_USD, DAY)).ok, false);
		assert.equal(await spendToday(db, DAY), 0);
	});

	// 2026-09-01 阶段 7 评审建议修 4:这条链路(ai.ts 的触发时机 → report.ts 的
	// 接线 → 这里的无条件写)一处测试都没有,而它管着一天 $3 的保险丝。
	it("addSpend 无条件写,越过上限也照记 —— 保险丝烧断之后电表不能跟着停", async () => {
		await reserveSpend(db, DAILY_SPEND_CAP_USD, DAILY_SPEND_CAP_USD, DAY);
		assert.equal(await spendToday(db, DAY), DAILY_SPEND_CAP_USD);
		// 这里换成 reserveSpend 的话:ok:false + **什么都不写**,账上永远停在 $3
		assert.equal(await addSpend(db, 0.3, DAY), DAILY_SPEND_CAP_USD + 0.3);
		assert.equal(await spendToday(db, DAY), DAILY_SPEND_CAP_USD + 0.3);
		// 而且它真的把下一个请求拦住了 —— 这才是记这笔账的全部作用
		assert.equal((await reserveSpend(db, 0.01, DAILY_SPEND_CAP_USD, DAY)).ok, false);
	});

	it("addSpend 当天第一笔走 INSERT 分支,也不看上限", async () => {
		assert.equal(await addSpend(db, DAILY_SPEND_CAP_USD + 5, DAY), DAILY_SPEND_CAP_USD + 5);
	});

	it("addSpend 挡掉 NaN / 负数(它们进了 SQL 会把整列污染成 NULL 或往回退)", async () => {
		await addSpend(db, 1, DAY);
		assert.equal(await addSpend(db, -1, DAY), 1);
		assert.equal(await addSpend(db, Number.NaN, DAY), 1);
		assert.equal(await spendToday(db, DAY), 1);
	});

	it("跨天是新预算", async () => {
		await reserveSpend(db, DAILY_SPEND_CAP_USD, DAILY_SPEND_CAP_USD, DAY);
		assert.equal(await spendToday(db, DAY), DAILY_SPEND_CAP_USD);
		assert.equal(await spendToday(db, "2026-09-02"), 0);
		assert.equal((await reserveSpend(db, 1, DAILY_SPEND_CAP_USD, "2026-09-02")).ok, true);
	});
});

// ---------------------------------------------------------------------------
// 3. todayUtc 的跨时区口径
// ---------------------------------------------------------------------------

describe("todayUtc", () => {
	it("按 UTC 切天,不是本地时区", () => {
		// 00:00:00Z —— 任何西半球时区的本地日期都还停在前一天
		assert.equal(todayUtc(Date.UTC(2026, 8, 1, 0, 0, 0)), "2026-09-01");
		// 23:59:59Z —— 任何东半球时区的本地日期都已经翻到下一天
		assert.equal(todayUtc(Date.UTC(2026, 8, 1, 23, 59, 59)), "2026-09-01");
		// 跨天那一毫秒
		assert.equal(todayUtc(Date.UTC(2026, 8, 1, 23, 59, 59, 999)), "2026-09-01");
		assert.equal(todayUtc(Date.UTC(2026, 8, 2, 0, 0, 0, 0)), "2026-09-02");
	});

	it("换掉进程时区结果不变(这条只能在子进程里验 —— TZ 改不了当前进程)", () => {
		// 上面那条测试在一台 TZ=UTC 的机器上是空转的:本地实现也会全过。
		// 真正的验法是拿两个偏移方向相反的时区各起一个 node 进程跑一遍。
		const url = pathToFileURL(STORE_MODULE).href;
		const script =
			`const m = await import(${JSON.stringify(url)});` +
			"process.stdout.write(m.todayUtc(Date.UTC(2026,8,1,0,0,0)) + ' ' + m.todayUtc(Date.UTC(2026,8,1,23,59,59)));";
		for (const tz of ["America/New_York", "Asia/Shanghai", "Pacific/Kiritimati"]) {
			const out = execFileSync(process.execPath, ["--experimental-strip-types", "--input-type=module", "-e", script], {
				env: { ...process.env, TZ: tz },
				encoding: "utf8",
				stdio: ["ignore", "pipe", "ignore"],
			});
			assert.equal(out.trim(), "2026-09-01 2026-09-01", `TZ=${tz} 下切天口径漂了`);
		}
	});
});

// ---------------------------------------------------------------------------
// 4. 周扫:UNIQUE(dossier_id, week_of) 的重跑幂等
// ---------------------------------------------------------------------------

function scanOf(over: Partial<NewWeeklyScan> = {}): NewWeeklyScan {
	return {
		// id 不在这里 —— 它由 (dossierId, weekOf) 算出来,调用方给不了也不该给
		dossierId: "dos-1",
		weekOf: "2026-W36",
		dossierRev: 1,
		queries: ["ai agent memory"],
		returned: 87,
		admitted: 5,
		excluded: 82,
		fetchFailed: 0,
		routeCount: 2,
		claimedTotal: 81_234,
		stopped: null,
		createdAt: 1_756_684_800_000,
		...over,
	};
}

function candOf(fullName: string, rank: number): NewScanCandidate {
	return {
		fullName,
		stars: 1234,
		pushedAt: "2026-08-30T12:00:00Z",
		archived: false,
		license: "MIT",
		repoCreatedAt: "2024-01-02T00:00:00Z",
		oneLiner: "一句话形态描述",
		topics: ["agent", "memory"],
		sourceRoute: "both",
		rank,
	};
}

function exclOf(fullName: string): NewScanExclusion {
	return {
		fullName,
		reason: "已归档(GitHub 字段)",
		reasonKind: "archived",
		reasonSource: "rule",
		appealedAt: null,
		pushedAt: "2026-08-30T12:00:00Z",
	};
}

describe("putWeeklyScan", () => {
	it("一次写入台账 + 候选 + 排除,读回来是一整包", async () => {
		const id = await putWeeklyScan(db, scanOf(), [candOf("o/a", 1), candOf("o/b", 2)], [exclOf("o/dead")]);
		assert.equal(id, "dos-1#2026-W36", "id 是算出来的,不是随机的");
		assert.equal(id, weeklyScanId("dos-1", "2026-W36"));
		const bundle = await getWeeklyScan(db, "dos-1", "2026-W36");
		assert.ok(bundle);
		assert.equal(bundle.scan.returned, 87);
		assert.deepEqual(bundle.scan.queries, ["ai agent memory"]);
		assert.deepEqual(
			bundle.candidates.map((c) => c.fullName),
			["o/a", "o/b"],
		);
		// 0/1 要还原成 boolean,NULL 要还原成 null —— 映射层的坑都在这几列上
		assert.equal(bundle.candidates[0]?.archived, false);
		assert.equal(bundle.candidates[0]?.sourceRoute, "both");
		assert.deepEqual(
			bundle.exclusions.map((e) => e.reasonSource),
			["rule"],
		);
		assert.equal(bundle.exclusions[0]?.appealedAt, null);
	});

	it("同一周重跑是幂等的:不报错、不重复、落在同一个 scan id 上", async () => {
		await putWeeklyScan(db, scanOf(), [candOf("o/a", 1), candOf("o/b", 2)], [exclOf("o/dead")]);
		// cron 重试 / 站长补跑 / 用户改档案重扫都打这里。id 由 (档案, 周) 算出来,
		// 所以第二趟天然落回同一行 —— 不需要先查库认出旧 id(那次查询正是竞态的来源)
		const id2 = await putWeeklyScan(db, scanOf({ returned: 91, admitted: 3, dossierRev: 2 }), [candOf("o/c", 1)], []);
		assert.equal(id2, "dos-1#2026-W36", "重跑必须落在同一个 id 上,否则子行会变孤儿");

		const rows = await listRecentScans(db, "dos-1", 10);
		assert.equal(rows.length, 1, "同一 (档案, 周) 只能有一行");
		assert.equal(rows[0]?.returned, 91, "台账要被新数据覆盖");
		assert.equal(rows[0]?.dossierRev, 2);

		const bundle = await getWeeklyScan(db, "dos-1", "2026-W36");
		assert.deepEqual(
			bundle?.candidates.map((c) => c.fullName),
			["o/c"],
			"旧候选必须被整批换掉,不能和新的混在一起",
		);
		assert.equal(bundle?.exclusions.length, 0, "旧排除也要清干净");
	});

	it("不同周互不干扰,listRecentScans 按 week_of 倒序", async () => {
		await putWeeklyScan(db, scanOf({ weekOf: "2026-W35" }), [candOf("o/a", 1)], []);
		// W37 故意给一个**更早**的 created_at:按 created_at 排序的话它会掉到最后
		await putWeeklyScan(db, scanOf({ weekOf: "2026-W37", createdAt: 1 }), [candOf("o/z", 1)], []);
		await putWeeklyScan(db, scanOf({ weekOf: "2026-W36" }), [candOf("o/b", 1)], []);
		assert.deepEqual(
			(await listRecentScans(db, "dos-1", 10)).map((s) => s.weekOf),
			["2026-W37", "2026-W36", "2026-W35"],
		);
		assert.deepEqual(
			(await listRecentScans(db, "dos-1", 2)).map((s) => s.weekOf),
			["2026-W37", "2026-W36"],
		);
	});

	it("没有那一周就是 null,不是空包", async () => {
		assert.equal(await getWeeklyScan(db, "dos-1", "2026-W01"), null);
	});

	// -------------------------------------------------------------------------
	// 并发重跑(2026-09-01 评审的第 ① 条)
	//
	// 触发源有三个:每周一的 cron、站长手动补跑、**用户改完档案重扫**。第三个是
	// 用户点出来的,双击就能并发,也能和周一早上的 cron 撞上。所以这里要的不是
	// 「不会撞」,是「撞了也拆不散」。
	//
	// 下面两条测试是一对:后一条(对照组)必须失败形状,前一条才算测到了东西。
	// -------------------------------------------------------------------------

	/** 库里所有子行用到的 scan_id(去重排序)。多于一个 = 有孤儿。 */
	async function childScanIds(): Promise<string[]> {
		const [c, e] = await db.batch<{ scan_id: string }>([
			db.prepare("SELECT DISTINCT scan_id FROM scan_candidate"),
			db.prepare("SELECT DISTINCT scan_id FROM scan_exclusion"),
		]);
		return [...new Set([...(c?.results ?? []), ...(e?.results ?? [])].map((r) => r.scan_id))].sort();
	}

	it("两趟并发重跑之后:只有一行台账,且分子分母来自同一趟,没有孤儿子行", async () => {
		// A 和 B 是同一 (档案, 周) 的两趟重扫,数据故意可区分:
		// returned 是「分母」(页面顶部那句诚实声明),候选清单是「分子」。
		await Promise.all([
			putWeeklyScan(db, scanOf({ returned: 100, dossierRev: 1 }), [candOf("a/1", 1)], [exclOf("a/x")]),
			putWeeklyScan(db, scanOf({ returned: 200, dossierRev: 2 }), [candOf("b/1", 1)], [exclOf("b/x")]),
		]);

		const rows = await listRecentScans(db, "dos-1", 10);
		assert.equal(rows.length, 1, "并发重跑之后同一 (档案, 周) 仍然只能有一行");

		const bundle = await getWeeklyScan(db, "dos-1", "2026-W36");
		assert.ok(bundle);
		assert.equal(bundle.scan.id, weeklyScanId("dos-1", "2026-W36"));

		// **核心断言**:谁赢不重要(后到的整体覆盖前一次),重要的是赢的那一趟
		// 要整趟都赢 —— 台账计数、档案版本、候选、排除全是同一趟的产物。
		const trip = bundle.scan.returned === 100 ? "a" : "b";
		assert.equal(bundle.scan.returned, trip === "a" ? 100 : 200, "台账计数不是任何一趟的原值");
		assert.equal(bundle.scan.dossierRev, trip === "a" ? 1 : 2, "dossier_rev 和计数来自不同趟");
		assert.deepEqual(
			bundle.candidates.map((c) => c.fullName),
			[`${trip}/1`],
			"候选来自另一趟 = 分子分母错配(页面会用 B 的分母展示 A 的清单)",
		);
		assert.deepEqual(
			bundle.exclusions.map((e) => e.fullName),
			[`${trip}/x`],
			"排除清单来自另一趟",
		);

		// 输的那一趟不能在库里留下任何读不到、也删不掉的行
		// (没有代码路径按别的 scan_id 读子行,sweepExpired 也只扫 quota / daily_spend)
		assert.deepEqual(await childScanIds(), [bundle.scan.id], "有子行挂在别的 scan_id 上 = 永久孤儿");
	});

	it("对照组:靠查库复用旧 id 的旧写法在同样的并发下必然拆散(证明上面那条不是空转)", async () => {
		// 这**不是** store.ts 现在的实现,是 2026-09-01 改掉的那一版,原样搬来当
		// 对照组。它和 raceyReserve 那条对照组是同一个机制:交错点就在 batch 之外
		// 那次读的 await 上 —— 两趟都在对方提交前读到「这一周还没跑过」。
		const raceyPut = async (id: string, returned: number, cand: NewScanCandidate) => {
			const existing = await db
				.prepare("SELECT id FROM weekly_scan WHERE dossier_id = ?1 AND week_of = ?2")
				.bind("dos-1", "2026-W36")
				.first<{ id: string }>();
			const scanId = existing ? existing.id : id;
			await db.batch([
				db.prepare("DELETE FROM scan_candidate WHERE scan_id = ?1").bind(scanId),
				db
					.prepare(
						`INSERT INTO weekly_scan (id, dossier_id, week_of, dossier_rev, queries, returned, admitted, excluded, fetch_failed,
						                          route_count, claimed_total, stopped, created_at)
						 VALUES (?1, 'dos-1', '2026-W36', 1, '[]', ?2, 0, 0, 0, 2, 0, NULL, 0)
						 ON CONFLICT(dossier_id, week_of) DO UPDATE SET returned = excluded.returned`,
					)
					.bind(scanId, returned),
				db
					.prepare(
						`INSERT INTO scan_candidate (scan_id, full_name, stars, pushed_at, archived, license, repo_created_at, one_liner, topics, source_route, "rank")
						 VALUES (?1, ?2, 0, '', 0, NULL, '', NULL, '[]', 'both', 1)`,
					)
					.bind(scanId, cand.fullName),
			]);
		};

		await Promise.all([raceyPut("随机-A", 100, candOf("a/1", 1)), raceyPut("随机-B", 200, candOf("b/1", 1))]);

		const bundle = await getWeeklyScan(db, "dos-1", "2026-W36");
		// 这就是评审在真 SQLite 上复现的那个形状:台账行还是 A 的 id、A 的子行,
		// 计数却被 B 的 upsert 换掉了。分母 B、分子 A。
		assert.equal(bundle?.scan.id, "随机-A");
		assert.equal(bundle?.scan.returned, 200, "对照组的分母没被后到那趟换掉 = 测试台交错不起来");
		assert.deepEqual(
			bundle?.candidates.map((c) => c.fullName),
			["a/1"],
			"对照组没有拆散 = 这个测试台交错不起来 = 上面那条并发测试没测到东西",
		);
		// B 的候选挂在 '随机-B' 上,没有任何代码路径读得到、也没有路径删得掉
		assert.deepEqual(await childScanIds(), ["随机-A", "随机-B"], "对照组没留下孤儿 = 同上");
	});
});

// ---------------------------------------------------------------------------
// 5. 档案 / 报告 / inflight 的往返(守住 snake_case ↔ camelCase 的映射)
// ---------------------------------------------------------------------------

function dossierOf(over: Partial<NewDossier> = {}): NewDossier {
	return {
		id: "dos-1",
		userEmail: "a@x.com",
		sentence: "我想跟踪 AI agent 的记忆与上下文工程",
		domain: "AI agent 记忆",
		caresAbout: ["长期记忆", "上下文压缩"],
		notCaresAbout: ["聊天机器人套壳"],
		queries: ["agent memory", "context engineering"],
		createdAt: 1_000,
		updatedAt: 1_000,
		...over,
	};
}

/** updateDossier 的入参:默认就是 dossierOf 那份内容,只是换了个形状。 */
function updateOf(over: Partial<Parameters<typeof updateDossier>[1]> = {}): Parameters<typeof updateDossier>[1] {
	const d = dossierOf();
	return {
		userEmail: d.userEmail,
		sentence: d.sentence,
		domain: d.domain,
		caresAbout: d.caresAbout,
		notCaresAbout: d.notCaresAbout,
		queries: d.queries,
		updatedAt: 2_000,
		bumpRev: false,
		...over,
	};
}

describe("dossier", () => {
	it("往返,JSON 列还原成数组", async () => {
		await createDossier(db, dossierOf());
		const d = await getDossier(db, "a@x.com");
		assert.deepEqual(d?.caresAbout, ["长期记忆", "上下文压缩"]);
		assert.deepEqual(d?.queries, ["agent memory", "context engineering"]);
		assert.equal(d?.sentence, "我想跟踪 AI agent 的记忆与上下文工程");
		assert.equal(d?.rev, 1, "第一版永远是 1,不从入参来");
		assert.equal(await getDossier(db, "别人@x.com"), null);
	});

	// —— 2026-09-01 第二轮评审 ②③:写入路径拆成 create / update ——

	it("createDossier 在已有档案时一行都不写,返回 null(不覆盖、更不换 sentence)", async () => {
		const first = await createDossier(db, dossierOf());
		assert.ok(first);
		// 两个标签页各 draft 出一句话、几乎同时点保存:后到的那趟走的就是这条路。
		// 原来那个 upsert 会在这里把 sentence 直接改写成 S2 —— 产品文档管这个字段
		// 叫「基准」,被一次竞态安静换掉,而且 rev 也不涨。
		const raced = await createDossier(
			db,
			dossierOf({ id: "dos-2", sentence: "我改主意了,想跟踪别的", domain: "另一个领域", createdAt: 9_999 }),
		);
		assert.equal(raced, null, "第二趟必须写不进去");
		const back = await getDossier(db, "a@x.com");
		assert.equal(back?.id, "dos-1");
		assert.equal(back?.sentence, dossierOf().sentence, "基准被换掉了");
		assert.equal(back?.domain, "AI agent 记忆", "内容也不许被第二趟覆盖");
		assert.equal(back?.createdAt, 1_000);
	});

	it("updateDossier 改内容不改 id / created_at / sentence", async () => {
		await createDossier(db, dossierOf());
		const back = await updateDossier(db, updateOf({ domain: "改过了" }));
		assert.equal(back?.id, "dos-1");
		assert.equal(back?.createdAt, 1_000);
		assert.equal(back?.updatedAt, 2_000);
		assert.equal(back?.domain, "改过了");
		assert.equal(back?.sentence, dossierOf().sentence);
	});

	it("rev 由 bumpRev 决定,而且和内容在**同一条语句**里改", async () => {
		await createDossier(db, dossierOf());
		// 不算一次版本变更(只调了顺序):内容更新、rev 不动
		const same = await updateDossier(db, updateOf({ domain: "只调了顺序", bumpRev: false }));
		assert.equal(same?.rev, 1);
		assert.equal(same?.domain, "只调了顺序");
		// 真变了:rev +1,和内容一起落库。原来这是两句 await,中间断一次就会
		// 留下「新内容配旧 rev」,而且自愈不了(下次保存时内容已经相同)
		const bumped = await updateDossier(db, updateOf({ domain: "真的改了", bumpRev: true }));
		assert.equal(bumped?.rev, 2);
		assert.equal(bumped?.domain, "真的改了");
		assert.equal((await getDossier(db, "a@x.com"))?.rev, 2);
		assert.equal((await updateDossier(db, updateOf({ bumpRev: true })))?.rev, 3);
	});

	it("档案在这中间被删掉 → updateDossier 返回 null,**不会把它复活**", async () => {
		await createDossier(db, dossierOf());
		await db.prepare("DELETE FROM dossier WHERE id = ?1").bind("dos-1").run();
		assert.equal(await updateDossier(db, updateOf({ domain: "还想改" })), null);
		assert.equal(await getDossier(db, "a@x.com"), null, "被删掉的档案不许原地复活");
	});

	it("sentence 和库里对不上 → 一行都改不到(TOCTOU 的第二道门)", async () => {
		await createDossier(db, dossierOf());
		const out = await updateDossier(db, updateOf({ sentence: "另一句话", domain: "别的领域", bumpRev: true }));
		assert.equal(out, null);
		const back = await getDossier(db, "a@x.com");
		assert.equal(back?.domain, "AI agent 记忆", "被拒绝的那次更新不许有任何副作用");
		assert.equal(back?.rev, 1);
	});

	it("只改自己那一行:别人的档案不受影响", async () => {
		await createDossier(db, dossierOf());
		await createDossier(db, dossierOf({ id: "dos-b", userEmail: "b@x.com" }));
		await updateDossier(db, updateOf({ domain: "我改了", bumpRev: true }));
		assert.equal((await getDossier(db, "b@x.com"))?.domain, "AI agent 记忆");
		assert.equal((await getDossier(db, "b@x.com"))?.rev, 1);
	});
});

describe("report", () => {
	const rep: Report = {
		id: "rep-1",
		dossierId: "dos-1",
		fullName: "o/a",
		commitSha: "abc123",
		dossierRev: 3,
		payloadJson: JSON.stringify({ sections: 2 }),
		estUsd: 0.47,
		anchoredRatio: 0.86,
		createdAt: 5_000,
	};

	it("往返 + 按 commit 找回(同一个 commit 已经跑过就别重跑)", async () => {
		await putReport(db, rep);
		assert.equal((await getReport(db, "rep-1"))?.anchoredRatio, 0.86);
		assert.equal((await getReport(db, "rep-1"))?.dossierRev, 3);
		assert.equal((await findReport(db, "dos-1", "o/a", "abc123", 3))?.id, "rep-1");
		// 换了 commit 就该重跑 —— 找不到才是对的
		assert.equal(await findReport(db, "dos-1", "o/a", "def456", 3), null);
		assert.equal(await findReport(db, "别的档案", "o/a", "abc123", 3), null);
	});

	// 站长 2026-09-01 拍板(阶段 7 评审必须修 3)。失败场景正是 docs/01 风险 3
	// 的缓解动作本身:用户看到一堆「真但无用」的 takeaway,回去改 caresAbout
	// (rev + 1),再点同一个仓 —— 少了这一条,拿回的是按旧 caresAbout 跑的旧
	// 报告,而页面上没有任何东西说这一份过时了。
	it("档案改过之后不算命中:dossier_rev 也在去重键里", async () => {
		await putReport(db, rep);
		assert.equal(await findReport(db, "dos-1", "o/a", "abc123", 4), null, "rev 变了就该重跑");
		assert.equal((await findReport(db, "dos-1", "o/a", "abc123", 3))?.id, "rep-1", "rev 没变照旧复用");
		// 新 rev 跑出来的那一份存进去之后,两版各找各的,互不覆盖
		await putReport(db, { ...rep, id: "rep-v4", dossierRev: 4, createdAt: 9_000 });
		assert.equal((await findReport(db, "dos-1", "o/a", "abc123", 4))?.id, "rep-v4");
		assert.equal((await findReport(db, "dos-1", "o/a", "abc123", 3))?.id, "rep-1");
	});

	it("同一个 commit 有多份时取最新那份", async () => {
		await putReport(db, rep);
		await putReport(db, { ...rep, id: "rep-2", createdAt: 9_000, anchoredRatio: 0.91 });
		assert.equal((await findReport(db, "dos-1", "o/a", "abc123", 3))?.id, "rep-2");
	});
});

describe("inflight", () => {
	it("一人至多一趟:重复 put 是覆盖不是新增", async () => {
		await putInflight(db, "a@x.com", { fullName: "o/a", phase: "discovering", startedAt: 1, updatedAt: 1 });
		await putInflight(db, "a@x.com", { fullName: "o/a", phase: "anchoring", startedAt: 1, updatedAt: 2 });
		assert.deepEqual(await getInflight(db, "a@x.com"), {
			fullName: "o/a",
			phase: "anchoring",
			startedAt: 1,
			updatedAt: 2,
		});
		await clearInflight(db, "a@x.com");
		assert.equal(await getInflight(db, "a@x.com"), null);
	});
});

// ---------------------------------------------------------------------------
// 6. 过期清理(D1 没有 DynamoDB 那种原生 TTL,得自己删)
// ---------------------------------------------------------------------------

describe("sweepExpired", () => {
	it("删掉 7 天前的配额和 30 天前的日花费,留下窗口内的", async () => {
		const now = Date.UTC(2026, 8, 30, 12, 0, 0); // 2026-09-30
		const day = (offset: number) => todayUtc(now - offset * 86_400_000);
		// 6 天前还在窗口内(留),8 天前出窗口(删)
		await reserveQuota(db, "a@x.com", "gen", 5, day(6));
		await reserveQuota(db, "a@x.com", "gen", 5, day(8));
		await reserveSpend(db, 1, DAILY_SPEND_CAP_USD, day(29));
		await reserveSpend(db, 1, DAILY_SPEND_CAP_USD, day(31));

		assert.deepEqual(await sweepExpired(db, now), { quota: 1, spend: 1 });
		assert.equal((await getQuota(db, "a@x.com", day(6))).gen, 1);
		assert.equal((await getQuota(db, "a@x.com", day(8))).gen, 0);
		assert.equal(await spendToday(db, day(29)), 1);
		assert.equal(await spendToday(db, day(31)), 0);
	});
});

// ---------------------------------------------------------------------------
// 7. 上线前终审新增的三张表 + 跨周落库(2026-09-01)
// ---------------------------------------------------------------------------

/** 一份最小的 WeekDiff。四类各给一条,复查给一条,好验计数和明细对得上。 */
function diffOf(over: Partial<WeekDiff> = {}): WeekDiff {
	return {
		prevWeekOf: "2026-W35",
		appeared: ["new/one"],
		archivedNow: ["dead/two"],
		licenseChanged: [{ fullName: "lic/three", from: "MIT", to: "AGPL-3.0" }],
		starJumps: [{ fullName: "hot/four", from: 900, to: 1400, delta: 500 }],
		recheck: {
			checked: 5,
			changed: 2,
			unchecked: 1,
			changes: [{ fullName: "gone/five", kind: "gone", stillListed: false }],
			unavailable: [{ fullName: "shy/six", why: "GitHub 这会儿不通" }],
			resolved: ["gone/five", "fine/seven", "fine/eight"],
			// 「查过、真的没事」的那两个。resolved 里那三个包含刚被删库的 gone/five ——
			// 两个字段的区别就在这里(scan-diff.ts 的 docblock 写死了)。
			unchanged: ["fine/seven", "fine/eight"],
		},
		changed: true,
		...over,
	};
}

describe("weekly_change:跨周结论落库", () => {
	it("落一周、读回来:计数和明细来自同一份 diff,一个字不差", async () => {
		const diff = diffOf();
		const id = await putWeeklyChange(db, { dossierId: "dos-1", weekOf: "2026-W36", diff, createdAt: 1700 });
		assert.equal(id, weeklyScanId("dos-1", "2026-W36"), "和 weekly_scan 同键");

		const got = await getWeeklyChange(db, "dos-1", "2026-W36");
		assert.ok(got);
		assert.equal(got.weekOf, "2026-W36");
		assert.equal(got.prevWeekOf, "2026-W35");
		assert.equal(got.createdAt, 1700);
		// **明细原样回来**:网页要读的就是邮件用的那一份,不是一份摘要
		assert.deepEqual(got.diff, diff);
		// **计数是后端算好的**,前端不必也不该再数一遍明细数组的长度
		assert.deepEqual(got.counts, {
			appeared: 1,
			archived: 1,
			licenseChanged: 1,
			starJumps: 1,
			recheckChecked: 5,
			recheckChanged: 2,
			recheckUnchecked: 1,
			changed: true,
		});
		// 而且两者必须一致 —— 这是「不许分叉」那条家法的直接断言
		assert.equal(got.counts.appeared, got.diff.appeared.length);
		assert.equal(got.counts.licenseChanged, got.diff.licenseChanged.length);
		assert.equal(got.counts.recheckChecked, got.diff.recheck.checked);
	});

	it("第一周:prevWeekOf 为 null,四类全空,changed=false —— **不假装有增量**", async () => {
		const first: WeekDiff = {
			prevWeekOf: null,
			appeared: [],
			archivedNow: [],
			licenseChanged: [],
			starJumps: [],
			recheck: { checked: 0, changed: 0, unchecked: 0, changes: [], unavailable: [], resolved: [], unchanged: [] },
			changed: false,
		};
		await putWeeklyChange(db, { dossierId: "dos-1", weekOf: "2026-W35", diff: first, createdAt: 1 });
		const got = await getWeeklyChange(db, "dos-1", "2026-W35");
		assert.equal(got?.prevWeekOf, null);
		assert.equal(got?.counts.changed, false);
	});

	it("**「复查报出来的变化」也算变化**:四类全空但 changed 照样是 true", async () => {
		// 一个「上周那个仓这周归档了、别的什么都没动」的星期。changed 如果按
		// 「四类之和 > 0」去算,这一周会被落库成「没有变化」—— 而那正是复查
		// 这一整条改动要报的事。
		const only = diffOf({ appeared: [], archivedNow: [], licenseChanged: [], starJumps: [] });
		await putWeeklyChange(db, { dossierId: "dos-1", weekOf: "2026-W36", diff: only, createdAt: 1 });
		const got = await getWeeklyChange(db, "dos-1", "2026-W36");
		assert.equal(got?.counts.appeared, 0);
		assert.equal(got?.counts.changed, true);
	});

	it("同一周重跑覆盖,不堆两份互相矛盾的结论", async () => {
		await putWeeklyChange(db, { dossierId: "dos-1", weekOf: "2026-W36", diff: diffOf(), createdAt: 1 });
		await putWeeklyChange(db, {
			dossierId: "dos-1",
			weekOf: "2026-W36",
			diff: diffOf({ appeared: ["a/1", "b/2"] }),
			createdAt: 2,
		});
		const got = await getWeeklyChange(db, "dos-1", "2026-W36");
		assert.equal(got?.counts.appeared, 2);
		assert.equal(got?.createdAt, 2);
	});

	it("latestWeeklyChange 按 week_of 倒序,不按 created_at(补跑的那一周不许排到最新)", async () => {
		await putWeeklyChange(db, { dossierId: "dos-1", weekOf: "2026-W36", diff: diffOf(), createdAt: 100 });
		// W35 是**后**补跑的(created_at 更大),但它是更早的一周
		await putWeeklyChange(db, { dossierId: "dos-1", weekOf: "2026-W35", diff: diffOf(), createdAt: 999 });
		assert.equal((await latestWeeklyChange(db, "dos-1"))?.weekOf, "2026-W36");
		assert.equal(await latestWeeklyChange(db, "dos-nobody"), null);
	});

	it("**明细坏了就当这一周没有记录**,不拿一组完整的计数配一份空明细去画页面", async () => {
		await putWeeklyChange(db, { dossierId: "dos-1", weekOf: "2026-W36", diff: diffOf(), createdAt: 1 });
		await db.prepare("UPDATE weekly_change SET changes_json = ?1").bind("{ 这不是 JSON").run();
		assert.equal(await getWeeklyChange(db, "dos-1", "2026-W36"), null);
		// 形状不对(能 parse,但不是 WeekDiff)也一样
		await db.prepare("UPDATE weekly_change SET changes_json = ?1").bind('{"prevWeekOf":"x"}').run();
		assert.equal(await getWeeklyChange(db, "dos-1", "2026-W36"), null);
	});

	it("**recheck 里少了 unchanged 的行也算坏行**,不给它兜一个空数组", async () => {
		// 这一行是这一轮之前写下的形状(2026-09-01 冻结前最后一轮加的 unchanged)。
		// 兜成空数组的话,一份 5 个仓全都平安的复查会渲染成「查过没事:0 个」——
		// 字面不报错,读起来却像什么都没查到,而下游拿不到任何提示。
		const stale = { ...diffOf() } as Record<string, unknown>;
		const rc = { ...(stale.recheck as Record<string, unknown>) };
		delete rc.unchanged;
		stale.recheck = rc;
		await putWeeklyChange(db, { dossierId: "dos-1", weekOf: "2026-W36", diff: diffOf(), createdAt: 1 });
		await db.prepare("UPDATE weekly_change SET changes_json = ?1").bind(JSON.stringify(stale)).run();
		assert.equal(await getWeeklyChange(db, "dos-1", "2026-W36"), null);
	});
});

describe("scan_appeal:申诉的永久台账", () => {
	const cand = {
		fullName: "won/back",
		stars: 42,
		pushedAt: "2026-08-01T00:00:00Z",
		archived: false,
		license: null,
		repoCreatedAt: "2021-01-01T00:00:00Z",
		oneLiner: null,
		topics: ["rag"],
		sourceRoute: "appealed" as const,
	};

	async function seedExcluded(weekOf: string): Promise<void> {
		await putWeeklyScan(
			db,
			scanOf({ weekOf, returned: 2, admitted: 1, excluded: 1 }),
			[candOf("o/a", 1)],
			[{ ...exclOf("won/back"), reason: "没有许可证,法律上不可用", reasonKind: "no-license" }],
		);
	}

	it("申诉时同一个 batch 里多写一行台账,listScanAppeals 读得到", async () => {
		await seedExcluded("2026-W36");
		assert.equal(await appealExclusion(db, { dossierId: "dos-1", weekOf: "2026-W36" }, cand, 555), true);
		const appeals = await listScanAppeals(db, "dos-1", "2026-W36");
		assert.deepEqual([...appeals], [["won/back", 555]]);
		// 别的周查不到 —— 「申诉不学习」是拍板过的立场,下周照样要再点一次
		assert.equal((await listScanAppeals(db, "dos-1", "2026-W37")).size, 0);
	});

	it("**重跑冲不掉它**:排除行上的 appealed_at 没了,台账那一行还在", async () => {
		await seedExcluded("2026-W36");
		await appealExclusion(db, { dossierId: "dos-1", weekOf: "2026-W36" }, cand, 555);
		// 重跑:putWeeklyScan 把这一周的候选和排除整批删掉重灌
		await seedExcluded("2026-W36");
		const bundle = await getWeeklyScan(db, "dos-1", "2026-W36");
		assert.equal(bundle?.exclusions[0]?.appealedAt, null, "投影确实被冲掉了(这就是那个 bug 的成因)");
		assert.equal(bundle?.candidates.length, 1, "捞回来的那一行也没了");
		// 而正本还在 —— runWeeklyScan 靠它把申诉搬回来
		assert.deepEqual([...(await listScanAppeals(db, "dos-1", "2026-W36"))], [["won/back", 555]]);
	});

	it("重复申诉保留第一次的时刻(那才是真正发生的事)", async () => {
		await seedExcluded("2026-W36");
		await appealExclusion(db, { dossierId: "dos-1", weekOf: "2026-W36" }, cand, 555);
		assert.equal(await appealExclusion(db, { dossierId: "dos-1", weekOf: "2026-W36" }, cand, 999), false);
		assert.deepEqual([...(await listScanAppeals(db, "dos-1", "2026-W36"))], [["won/back", 555]]);
	});

	it("决策 8 那条「被申诉过两次」现在数得出来了(跨周计数)", async () => {
		for (const w of ["2026-W35", "2026-W36"]) {
			await seedExcluded(w);
			await appealExclusion(db, { dossierId: "dos-1", weekOf: w }, cand, 1);
		}
		const row = await db
			.prepare(
				"SELECT full_name, COUNT(DISTINCT week_of) AS weeks FROM scan_appeal WHERE dossier_id = ?1 GROUP BY full_name HAVING weeks >= 2",
			)
			.bind("dos-1")
			.first<{ full_name: string; weeks: number }>();
		assert.equal(row?.full_name, "won/back");
		assert.equal(row?.weeks, 2);
	});
});

describe("candidate_open:点击台账", () => {
	it("一次点击一行;同一个仓点两次留两行,而「几个仓被点过」照样数得出来", async () => {
		const scanId = weeklyScanId("dos-1", "2026-W36");
		await recordCandidateOpen(db, scanId, "a/one", 100);
		await recordCandidateOpen(db, scanId, "a/one", 200);
		await recordCandidateOpen(db, scanId, "b/two", 300);
		const all = await db.prepare("SELECT COUNT(*) AS n FROM candidate_open").first<{ n: number }>();
		assert.equal(all?.n, 3, "点了几下");
		// 风险 2 的判据就是这一句:第二周结束时点开的报告少于 2 份就停下来复盘
		const distinct = await db
			.prepare("SELECT COUNT(DISTINCT full_name) AS n FROM candidate_open WHERE scan_id LIKE ?1")
			.bind("dos-1#%")
			.first<{ n: number }>();
		assert.equal(distinct?.n, 2, "几个仓被点过");
	});

	it("同一毫秒重复写不报错(幂等),不会因为一次重试把整条路炸掉", async () => {
		const scanId = weeklyScanId("dos-1", "2026-W36");
		await recordCandidateOpen(db, scanId, "a/one", 100);
		await recordCandidateOpen(db, scanId, "a/one", 100);
		const n = await db.prepare("SELECT COUNT(*) AS n FROM candidate_open").first<{ n: number }>();
		assert.equal(n?.n, 1);
	});
});

describe("latestReport(从 report.ts 搬进 store 的那条)", () => {
	const rep = (id: string, fullName: string, createdAt: number): Report => ({
		id,
		dossierId: "dos-1",
		fullName,
		commitSha: "sha-" + id,
		dossierRev: 1,
		payloadJson: "{}",
		estUsd: 0.5,
		anchoredRatio: 1,
		createdAt,
	});

	it("同一个仓取最近一次,不限 commit;别的仓不串", async () => {
		await putReport(db, rep("r1", "a/one", 100));
		await putReport(db, rep("r2", "a/one", 300));
		await putReport(db, rep("r3", "b/two", 400));
		assert.equal((await latestReport(db, "dos-1", "a/one"))?.id, "r2");
		assert.equal((await latestReport(db, "dos-1", "b/two"))?.id, "r3");
		assert.equal(await latestReport(db, "dos-1", "c/none"), null);
		assert.equal(await latestReport(db, "dos-other", "a/one"), null, "别人的报告一律当不存在");
	});
});
