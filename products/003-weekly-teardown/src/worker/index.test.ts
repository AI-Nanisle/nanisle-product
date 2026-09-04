// index.ts 的测试。跑法:npm test。
//
// 这一份只管**入口那两件事**,业务逻辑各有各的测试文件:
//   GET /api/health   库到底能不能用(2026-09-01 上线前终审的 C3)
//   scheduled()       整趟炸了不许把异常抛进运行时(同一轮的 A3)
//
// 假 D1 抄自 store.test.ts(理由见那份顶部:node 的 test runner 会把被 import 的
// .test.ts 里的用例再注册一遍,所以不共用)。这一份只需要「能 prepare / 能 first」,
// 所以砍到最小 —— 健康检查只跑一条 SELECT。

import assert from "node:assert/strict";
import { DatabaseSync } from "node:sqlite";
import { readFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { describe, it } from "node:test";
import worker from "./index.ts";
import type { AppEnv } from "./env.ts";

const HERE = path.dirname(fileURLToPath(import.meta.url));
const MIGRATION = path.resolve(HERE, "../../migrations/0001_init.sql");

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
	async first<T>(): Promise<T | null> {
		return (this.db.prepare(this.sql).all(...(this.args as never[]))[0] as T) ?? null;
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
}

/** 跑过迁移的库。 */
function migratedDb(): D1Database {
	const raw = new DatabaseSync(":memory:");
	raw.exec(readFileSync(MIGRATION, "utf8"));
	return new FakeD1(raw) as unknown as D1Database;
}

/** **接上了但没跑过迁移**的库 —— 首次部署最可能踩的那个坑。 */
function emptyDb(): D1Database {
	return new FakeD1(new DatabaseSync(":memory:")) as unknown as D1Database;
}

const ctx = { waitUntil: () => {}, passThroughOnException: () => {} } as unknown as ExecutionContext;

async function health(over: Partial<AppEnv>): Promise<Record<string, unknown>> {
	const res = await worker.fetch(new Request("http://x/api/health"), { AI_PROVIDER: "mock", ...over } as AppEnv, ctx);
	return (await res.json()) as Record<string, unknown>;
}

describe("GET /api/health · 库到底能不能用(必须修 C3)", () => {
	it("表在 → ok", async () => {
		const body = await health({ TEARDOWN_DB: migratedDb() });
		assert.equal(body.db, "ok");
		assert.equal(body.hasDb, true);
		assert.equal(body.ok, true);
	});

	it("**binding 在但表不在 → no-tables,hasDb 必须是 false**", async () => {
		// 这就是整条改动的理由:原来 hasDb 是 `Boolean(env.TEARDOWN_DB)`,忘了跑
		// `wrangler d1 migrations apply --remote` 的话它照样回 true,然后每一个真
		// 端点 500 —— 一个只在什么都没坏时才说真话的健康检查。
		const body = await health({ TEARDOWN_DB: emptyDb() });
		assert.equal(body.db, "no-tables");
		assert.equal(body.hasDb, false);
	});

	it("binding 根本没接上 → no-binding(和「表不在」分开:处置动作不一样)", async () => {
		const body = await health({ TEARDOWN_DB: undefined });
		assert.equal(body.db, "no-binding");
		assert.equal(body.hasDb, false);
	});

	it("D1 不通 → error,而且健康检查本身**不许崩**(它是排障时唯一还能打的端点)", async () => {
		const broken = {
			prepare() {
				throw new Error("D1 这会儿不通");
			},
		} as unknown as D1Database;
		const body = await health({ TEARDOWN_DB: broken });
		assert.equal(body.db, "error");
		assert.equal(body.hasDb, false);
		assert.equal(body.ok, true, "健康检查自己不能被它测的东西拖垮");
	});

	it("库坏了不影响另外两个字段照常回", async () => {
		const body = await health({ TEARDOWN_DB: emptyDb(), GITHUB_PAT: "ghp_x" });
		assert.equal(body.hasPat, true);
		assert.equal(body.provider, "mock");
	});
});

describe("scheduled() · 整趟炸了不许抛进运行时(必须修 A3)", () => {
	it("D1 全挂时 waitUntil 里那个 promise **正常 resolve**,而且日志说得出话", async () => {
		const broken = {
			prepare() {
				throw new Error("D1 这会儿不通");
			},
			batch() {
				throw new Error("D1 这会儿不通");
			},
		} as unknown as D1Database;
		const pending: Promise<unknown>[] = [];
		const lines: string[] = [];
		const log = console.log;
		const err = console.error;
		console.log = (...a: unknown[]) => void lines.push(a.map(String).join(" "));
		console.error = (...a: unknown[]) => void lines.push(a.map(String).join(" "));
		try {
			worker.scheduled(
				{ cron: "0 8 * * 1", scheduledTime: Date.now(), noRetry: () => {} } as unknown as ScheduledController,
				{ TEARDOWN_DB: broken } as AppEnv,
				{ waitUntil: (p: Promise<unknown>) => void pending.push(p), passThroughOnException: () => {} } as unknown as ExecutionContext,
			);
			// **不许 reject**:cron 触发器不重试,一个未捕获的 rejection 只会变成
			// 运行时的一条错误,而这一周对所有人就这么过去了。
			await Promise.all(pending);
		} finally {
			console.log = log;
			console.error = err;
		}
		assert.ok(lines.some((l) => l.includes("起跑")));
		assert.ok(lines.some((l) => l.includes("收工")));
	});
});
