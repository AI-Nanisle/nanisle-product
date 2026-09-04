// dossier.ts 的测试。跑法:npm test(node --experimental-strip-types --test)。
//
// 分两层:
//   ① 纯函数层(cleanDossierFields / retryNudge / sameDossierFields)——校验、
//      重试判据、rev 比对,这三样是这一阶段全部的分支逻辑;
//   ② 端点层(dossierRoutes.request(...) 打真的 Hono 路由)——rev 归谁管、
//      sentence 能不能改、删档案连带清什么,这些跨了「路由 + store + SQL」
//      三层,只测纯函数是测不到的。
//
// **假 D1 是从 shared/store.test.ts 原样抄过来的**(node:sqlite 包成 D1 的接口
// 形状,读同一个 0001_init.sql 建表)。抄而不是从那边 import,是因为 node 的
// test runner 会把被 import 的 .test.ts 里的用例在这个进程里再注册一遍,
// store 的 70 多条用例会凭空多跑一次、报告里两份同名结果。抽成第三个文件也
// 可以,但那要往 src/ 里放一个只有测试用得着的模块,不划算——这段代码是
// 死的,不会变。原始出处和「能测到什么、测不到什么」的完整说明在 store.test.ts
// 顶部,那份论证不在这里重复。

import assert from "node:assert/strict";
import { createServer, type Server } from "node:http";
import { DatabaseSync } from "node:sqlite";
import { readFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { after, before, beforeEach, describe, it } from "node:test";
import { cleanDossierFields, dossierRoutes, mockDraft, retryNudge, sameDossierFields } from "./dossier.ts";
import { WEEKLY_SCAN_SCHEDULE } from "../shared/types.ts";
import { getDossier, getWeeklyScan, putReport, putWeeklyScan } from "../shared/store.ts";
import type { AppEnv } from "./env.ts";
import type { DossierFields } from "../shared/types.ts";

const HERE = path.dirname(fileURLToPath(import.meta.url));
const MIGRATION = path.resolve(HERE, "../../migrations/0001_init.sql");

// ---------------------------------------------------------------------------
// 假 D1(抄自 store.test.ts,理由见文件头)
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
	/** 造它的那个 FakeD1;用来记 SQL 台账和触发交错钩子。 */
	owner: FakeD1 | null;
	constructor(db: DatabaseSync, sql: string, args: unknown[] = [], owner: FakeD1 | null = null) {
		this.db = db;
		this.sql = sql;
		this.args = args;
		this.owner = owner;
	}
	bind(...args: unknown[]): FakeStatement {
		return new FakeStatement(this.db, this.sql, args, this.owner);
	}
	exec(): FakeResult {
		this.owner?.log.push(this.sql);
		return runOne(this.db, this.sql, this.args);
	}
	async first<T>(): Promise<T | null> {
		const row = (this.exec().results[0] as T) ?? null;
		// **读完之后**才让别人插一手 —— 这正是 TOCTOU 那个窗口的位置
		this.owner?.afterRead?.(this.sql);
		return row;
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
	/** 每条真的执行过的 SQL。用来数「这次保存到底写了几条语句」。 */
	log: string[] = [];
	/**
	 * 每次 `.first()` 读完之后调一次(拿到 SQL 原文)。测试用它在
	 * 「handler 读完档案」和「它写回去」之间插进另一个标签页的动作——
	 * 那个窗口是 2026-09-01 第二轮评审 ② ③ 两条的共同现场。
	 */
	afterRead: ((sql: string) => void) | null = null;
	constructor(db: DatabaseSync) {
		this.db = db;
	}
	prepare(sql: string): FakeStatement {
		return new FakeStatement(this.db, sql, [], this);
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

/** 拿回那个 FakeD1(D1Database 的类型里没有 log / afterRead)。 */
const fake = (db: D1Database): FakeD1 => db as unknown as FakeD1;

/**
 * 让另一个标签页在**下一次**读档案之后立刻插一手,只插一次。
 * `what` 里做的写入对 handler 来说就是「我读完之后世界变了」。
 */
function raceAfterDossierRead(db: D1Database, what: () => void): void {
	const f = fake(db);
	f.afterRead = (sql) => {
		if (!sql.includes("FROM dossier")) return;
		f.afterRead = null; // 一次性:分类那次重读不该再被打扰
		what();
	};
}

function freshDb(): D1Database {
	const raw = new DatabaseSync(":memory:");
	raw.exec(readFileSync(MIGRATION, "utf8"));
	return new FakeD1(raw) as unknown as D1Database;
}

// ---------------------------------------------------------------------------
// 打端点的小工具
// ---------------------------------------------------------------------------

const USER = "someone@example.com";

/**
 * 测试用 env。**不配 NANISLE_SSO_SECRET**,于是 guard.ts 的 sessionEmail 走
 * 「没有登录闸口的实例」那条回落,认 DEV_EMAIL —— 这样不用在测试里签会话票。
 * 不配任何 AI key = resolveProvider 落回 mock(和 fork 首跑同一条路径)。
 */
function env(db: D1Database, over: Partial<AppEnv> = {}): AppEnv {
	return { TEARDOWN_DB: db, DEV_EMAIL: USER, ...over } as AppEnv;
}

type Json = Record<string, any>;

async function call(
	db: D1Database,
	method: string,
	pathname: string,
	body?: unknown,
	over: Partial<AppEnv> = {},
): Promise<{ status: number; json: Json }> {
	const res = await dossierRoutes.request(
		pathname,
		{
			method,
			...(body === undefined ? {} : { body: JSON.stringify(body), headers: { "content-type": "application/json" } }),
		},
		env(db, over),
	);
	return { status: res.status, json: (await res.json()) as Json };
}

const SENTENCE = "我想跟踪 AI agent 的记忆与上下文工程";

/** 一份合法的四字段,给 PUT 用。 */
const fields = (over: Partial<DossierFields> = {}): DossierFields => ({
	domain: "AI agent 的记忆与上下文工程",
	caresAbout: ["长上下文的工程实践", "记忆的落库方式"],
	notCaresAbout: ["纯论文复现"],
	queries: ["context engineering", "agent memory", "kv cache", "topic:llm-memory", "prompt caching"],
	...over,
});

let db: D1Database;
beforeEach(() => {
	db = freshDb();
});

// ---------------------------------------------------------------------------
// 1. 校验函数(模型产出和用户改动共用的那一份)
// ---------------------------------------------------------------------------

describe("cleanDossierFields", () => {
	it("超出上限的条目被截断:列表 5 条、检索词 8 条", () => {
		const out = cleanDossierFields({
			domain: "d",
			caresAbout: ["a1", "a2", "a3", "a4", "a5", "a6", "a7"],
			notCaresAbout: ["b1", "b2", "b3", "b4", "b5", "b6"],
			queries: ["q1", "q2", "q3", "q4", "q5", "q6", "q7", "q8", "q9", "q10"],
		});
		assert.equal(out.ok, true);
		if (!out.ok) return;
		assert.deepEqual(out.fields.caresAbout, ["a1", "a2", "a3", "a4", "a5"]);
		assert.deepEqual(out.fields.notCaresAbout, ["b1", "b2", "b3", "b4", "b5"]);
		assert.equal(out.fields.queries.length, 8);
		assert.equal(out.fields.queries[7], "q8");
	});

	it("空串、纯空白、非字符串被丢掉;换行折成空格", () => {
		const out = cleanDossierFields({
			domain: "  领域\n边界  ",
			caresAbout: ["", "   ", "真的一条", null, 42, { x: 1 }, "另一条  "],
			notCaresAbout: [],
			queries: ["  agent memory\n", "\t"],
		});
		assert.equal(out.ok, true);
		if (!out.ok) return;
		assert.equal(out.fields.domain, "领域 边界");
		assert.deepEqual(out.fields.caresAbout, ["真的一条", "另一条"]);
		assert.deepEqual(out.fields.queries, ["agent memory"]);
	});

	it("去重不分大小写,保留先出现那条的原始写法;截断发生在去重之后", () => {
		const out = cleanDossierFields({
			domain: "d",
			caresAbout: ["KV cache", "kv cache", "KV Cache", "第二条", "第三条", "第四条", "第五条", "第六条"],
			notCaresAbout: ["x", "X"],
			queries: ["Context Engineering", "context engineering"],
		});
		assert.equal(out.ok, true);
		if (!out.ok) return;
		// 前 3 条是同一个东西 → 去重后仍然攒够 5 条不同的,而不是只剩 3 条
		assert.deepEqual(out.fields.caresAbout, ["KV cache", "第二条", "第三条", "第四条", "第五条"]);
		assert.deepEqual(out.fields.notCaresAbout, ["x"]);
		assert.deepEqual(out.fields.queries, ["Context Engineering"]);
	});

	it("单条过长按 itemMax 截断(模型偶尔会把一整段话塞进一条)", () => {
		const long = "很".repeat(300);
		const out = cleanDossierFields({ domain: "d", caresAbout: [long], notCaresAbout: [], queries: ["q"] });
		assert.equal(out.ok, true);
		if (!out.ok) return;
		assert.equal(out.fields.caresAbout[0]?.length, 120);
	});

	it("domain / caresAbout / queries 整体缺失 → 报出缺了哪几个", () => {
		assert.deepEqual(cleanDossierFields({}), { ok: false, missing: ["domain", "caresAbout", "queries"] });
		// 类型不对(给了对象而不是数组)和没给一样,不半信半疑地收下
		assert.deepEqual(cleanDossierFields({ domain: "d", caresAbout: { a: 1 }, queries: "q1,q2" }), {
			ok: false,
			missing: ["caresAbout", "queries"],
		});
		assert.deepEqual(cleanDossierFields(null), { ok: false, missing: ["domain", "caresAbout", "queries"] });
	});

	it("notCaresAbout 允许为空(硬凑出来的排除项会安静地滤掉真实的仓)", () => {
		const out = cleanDossierFields({ domain: "d", caresAbout: ["a"], notCaresAbout: [], queries: ["q"] });
		assert.equal(out.ok, true);
	});
});

describe("retryNudge", () => {
	it("检索词少于 3 条 = 模型没干活,值得再要一次", () => {
		const nudge = retryNudge(fields({ queries: ["a", "b"] }));
		assert.ok(nudge && nudge.includes("2 条检索词"), "补充说明里要写清上一轮给了几条");
	});

	it("正好 3 条不再补(下限是 3,不是 5)", () => {
		assert.equal(retryNudge(fields({ queries: ["a", "b", "c"] })), null);
	});

	it("notCaresAbout 为空也提醒一次(排除清单没有原料)", () => {
		const nudge = retryNudge(fields({ notCaresAbout: [] }));
		assert.ok(nudge && nudge.includes("notCaresAbout"));
	});

	it("两样都齐了就不补——每一轮都是一次真调用,没理由的补足是白烧钱", () => {
		assert.equal(retryNudge(fields()), null);
	});
});

describe("sameDossierFields", () => {
	it("顺序变化不算改动(顺序改不了周扫的产出,不该涨 rev)", () => {
		const a = fields();
		const b = fields({ queries: [...a.queries].reverse(), caresAbout: [...a.caresAbout].reverse() });
		assert.equal(sameDossierFields(a, b), true);
	});

	it("比较不会把调用方的数组原地重排", () => {
		const a = fields();
		const before = [...a.queries];
		sameDossierFields(a, fields({ queries: [...a.queries].reverse() }));
		assert.deepEqual(a.queries, before);
	});

	it("四个字段任意一个真变了都算改动", () => {
		const a = fields();
		assert.equal(sameDossierFields(a, fields({ domain: "别的领域" })), false);
		assert.equal(sameDossierFields(a, fields({ caresAbout: ["只剩一条"] })), false);
		assert.equal(sameDossierFields(a, fields({ notCaresAbout: [] })), false);
		assert.equal(sameDossierFields(a, fields({ queries: [...a.queries, "new query"] })), false);
	});
});

// ---------------------------------------------------------------------------
// 2. 端点:draft
// ---------------------------------------------------------------------------

describe("POST /api/dossier/draft", () => {
	it("mock 模式下也产出一份字段齐全的档案(fork 零 key 首跑走的就是这条路)", async () => {
		const { status, json } = await call(db, "POST", "/api/dossier/draft", { sentence: SENTENCE });
		assert.equal(status, 200);
		// sentence 原样回显 —— 这是「我没有改你的话」的当场证明
		assert.equal(json.sentence, SENTENCE);
		assert.ok(json.domain);
		assert.ok(json.caresAbout.length > 0);
		assert.ok(json.notCaresAbout.length > 0);
		assert.ok(json.queries.length >= 3, `检索词至少 3 条,实际 ${json.queries.length}`);
		// mock 的产出也过同一份校验,所以上限一样管得住
		assert.ok(json.caresAbout.length <= 5 && json.queries.length <= 8);
		// 假的就要标出来:这份档案会被存进库、印在报告上
		assert.ok(String(json.domain).startsWith("[mock]"));
	});

	it("mock 拆解是确定性的(同一句话两次拆出同一份)", () => {
		assert.deepEqual(mockDraft(SENTENCE), mockDraft(SENTENCE));
	});

	it("draft 不落库 —— 用户还没看过,更没点保存", async () => {
		await call(db, "POST", "/api/dossier/draft", { sentence: SENTENCE });
		assert.equal(await getDossier(db, USER), null);
	});

	it("空句子 / 超长句子 400", async () => {
		assert.equal((await call(db, "POST", "/api/dossier/draft", { sentence: "   " })).status, 400);
		assert.equal((await call(db, "POST", "/api/dossier/draft", {})).status, 400);
		const long = await call(db, "POST", "/api/dossier/draft", { sentence: "长".repeat(501) });
		assert.equal(long.status, 400);
		assert.ok(long.json.error.includes("501"));
	});

	it("AI_DISABLED=1 时是 503(实例级急停,不是 400)", async () => {
		const { status } = await call(db, "POST", "/api/dossier/draft", { sentence: SENTENCE }, { AI_DISABLED: "1" });
		assert.equal(status, 503);
	});

	it("打满账号当日 ai 额度之后 429", async () => {
		// QUOTA_LIMITS.ai = 30。占满就该被闸拦下,而不是继续调模型。
		for (let i = 0; i < 30; i++) {
			assert.equal((await call(db, "POST", "/api/dossier/draft", { sentence: SENTENCE })).status, 200, `第 ${i + 1} 次`);
		}
		const denied = await call(db, "POST", "/api/dossier/draft", { sentence: SENTENCE });
		assert.equal(denied.status, 429);
		assert.equal(denied.json.scope, "account");
	});
});

// ---------------------------------------------------------------------------
// 3. 端点:draft 的重试(真的打一次「模型」,看它到底重不重试、重几次)
// ---------------------------------------------------------------------------

/**
 * 一台假模型:走 gateway 档(Anthropic 兼容 SSE),这样重试次数是**数出来的**,
 * 不是从代码结构上推出来的。同款写法见 shared/ai.test.ts。
 *
 * 它按提示词里有没有那句「上一轮的产出有问题」决定返回什么:
 *   第一轮 → 只给 2 条检索词(格式合法,但没干活)
 *   第二轮 → 给足 5 条(除非 alwaysThin,那是用来验「只补一轮」的)
 */
describe("POST /api/dossier/draft · 补一轮", () => {
	let server: Server;
	let base = "";
	let calls: string[] = [];
	let alwaysThin = false;

	const THIN = { domain: "领域", caresAbout: ["在意"], notCaresAbout: ["不在意"], queries: ["q1", "q2"] };
	const FULL = {
		domain: "领域",
		caresAbout: ["在意"],
		notCaresAbout: ["不在意"],
		queries: ["context engineering", "agent memory", "kv cache", "topic:llm-memory", "prompt caching"],
	};

	before(async () => {
		server = createServer((req, res) => {
			let raw = "";
			req.on("data", (c) => (raw += c));
			req.on("end", () => {
				const body = JSON.parse(raw) as { messages: { content: string }[] };
				const prompt = body.messages[0]?.content ?? "";
				calls.push(prompt);
				const retrying = prompt.includes("上一轮的产出有问题");
				const text = JSON.stringify(retrying && !alwaysThin ? FULL : THIN);
				res.writeHead(200, { "content-type": "text/event-stream" });
				const ev = (type: string, data: Record<string, unknown>) =>
					res.write(`event: ${type}\ndata: ${JSON.stringify({ type, ...data })}\n\n`);
				ev("message_start", {
					message: {
						id: "msg_1",
						type: "message",
						role: "assistant",
						model: "fake-flash",
						content: [],
						stop_reason: null,
						stop_sequence: null,
						usage: { input_tokens: 1, output_tokens: 0 },
					},
				});
				ev("content_block_start", { index: 0, content_block: { type: "text", text: "" } });
				for (const piece of text.match(/[\s\S]{1,8}/g) ?? []) {
					ev("content_block_delta", { index: 0, delta: { type: "text_delta", text: piece } });
				}
				ev("content_block_stop", { index: 0 });
				ev("message_delta", { delta: { stop_reason: "end_turn", stop_sequence: null }, usage: { output_tokens: 3 } });
				ev("message_stop", {});
				res.end();
			});
		});
		await new Promise<void>((r) => server.listen(0, "127.0.0.1", r));
		base = `http://127.0.0.1:${(server.address() as { port: number }).port}`;
	});
	after(() => {
		server.closeAllConnections();
		server.close();
	});

	const gw = (): Partial<AppEnv> => ({
		AI_PROVIDER: "gateway",
		AI_MODEL: "fake-flash",
		AI_GATEWAY_URL: base,
		AI_GATEWAY_KEY: "k",
	});

	beforeEach(() => {
		calls = [];
		alwaysThin = false;
	});

	it("检索词不够时补一轮,补回来了就照常返回", async () => {
		const { status, json } = await call(db, "POST", "/api/dossier/draft", { sentence: SENTENCE }, gw());
		assert.equal(status, 200);
		assert.equal(json.queries.length, 5);
		assert.equal(calls.length, 2, "正好两次调用:第一轮 + 补一轮");
		assert.ok(calls[1]?.includes("只给了 2 条检索词"), "补的那一轮要把上一轮的问题带给模型");
		// 原话在两轮里都原样带着,没有被我们改写过
		assert.ok(calls.every((p) => p.includes(SENTENCE)));
	});

	it("补完还是不够 → 400,而且**只补一轮**(不循环)", async () => {
		alwaysThin = true;
		const { status, json } = await call(db, "POST", "/api/dossier/draft", { sentence: SENTENCE }, gw());
		assert.equal(status, 400);
		assert.equal(calls.length, 2, "不能无限补足:模型持续不配合时会把请求拖到边缘超时");
		assert.ok(json.error.includes("检索词"));
	});
});

// ---------------------------------------------------------------------------
// 4. 端点:GET / PUT / DELETE
// ---------------------------------------------------------------------------

describe("GET /api/dossier", () => {
	it("新用户是 200 + null,不是 404(前端要靠它区分「新用户」和「出错了」)", async () => {
		const { status, json } = await call(db, "GET", "/api/dossier");
		assert.equal(status, 200);
		assert.equal(json.dossier, null);
	});
});

describe("PUT /api/dossier", () => {
	it("首次保存 rev = 1,revBumped = false(第一版不算「更新到 v1」)", async () => {
		const { status, json } = await call(db, "PUT", "/api/dossier", { sentence: SENTENCE, ...fields() });
		assert.equal(status, 200);
		assert.equal(json.revBumped, false);
		assert.equal(json.dossier.rev, 1);
		assert.equal(json.dossier.sentence, SENTENCE);
		assert.equal(json.dossier.userEmail, USER);
		// 存进去的就是回来的那份
		const back = await getDossier(db, USER);
		assert.deepEqual(back?.queries, fields().queries);
	});

	it("同样的内容 PUT 两次,第二次 revBumped = false 且 rev 不动", async () => {
		await call(db, "PUT", "/api/dossier", { sentence: SENTENCE, ...fields() });
		const second = await call(db, "PUT", "/api/dossier", { sentence: SENTENCE, ...fields() });
		assert.equal(second.json.revBumped, false);
		assert.equal(second.json.dossier.rev, 1);
	});

	it("只改顺序不涨 rev,但顺序照存(顺序改不了周扫的产出)", async () => {
		await call(db, "PUT", "/api/dossier", { sentence: SENTENCE, ...fields() });
		const reordered = [...fields().queries].reverse();
		const res = await call(db, "PUT", "/api/dossier", { sentence: SENTENCE, ...fields({ queries: reordered }) });
		assert.equal(res.json.revBumped, false);
		assert.equal(res.json.dossier.rev, 1);
		assert.deepEqual((await getDossier(db, USER))?.queries, reordered);
	});

	it("四个字段真变了才涨 rev", async () => {
		await call(db, "PUT", "/api/dossier", { sentence: SENTENCE, ...fields() });
		const changed = await call(db, "PUT", "/api/dossier", {
			sentence: SENTENCE,
			...fields({ queries: [...fields().queries, "vector database"] }),
		});
		assert.equal(changed.json.revBumped, true);
		assert.equal(changed.json.dossier.rev, 2);
		assert.equal((await getDossier(db, USER))?.rev, 2);
	});

	it("**rev 不接受客户端传入**:请求里塞 rev: 99 一律忽略", async () => {
		await call(db, "PUT", "/api/dossier", { sentence: SENTENCE, ...fields(), rev: 99 });
		assert.equal((await getDossier(db, USER))?.rev, 1);
		// 涨过一次之后再拿旧 rev 存回去,库里也不许倒退(2026-09-01 评审第 ③ 条)
		await call(db, "PUT", "/api/dossier", { sentence: SENTENCE, ...fields({ domain: "改了领域" }), rev: 99 });
		assert.equal((await getDossier(db, USER))?.rev, 2);
		const back = await call(db, "PUT", "/api/dossier", { sentence: SENTENCE, ...fields(), rev: 1 });
		assert.equal(back.json.dossier.rev, 3, "rev 只会涨,不会被请求体里的旧值打回去");
	});

	it("sentence 不许改:与库里不一致 → 400,且库里那份一个字都没动", async () => {
		await call(db, "PUT", "/api/dossier", { sentence: SENTENCE, ...fields() });
		const res = await call(db, "PUT", "/api/dossier", {
			sentence: "我改主意了,想跟踪别的",
			...fields({ domain: "别的领域" }),
		});
		assert.equal(res.status, 400);
		assert.ok(res.json.error.includes("基准"), "文案要说清为什么不许改");
		const back = await getDossier(db, USER);
		assert.equal(back?.sentence, SENTENCE);
		assert.equal(back?.domain, fields().domain, "被拒绝的那次保存不许有任何副作用");
		assert.equal(back?.rev, 1);
	});

	it("四个字段缺失 / 检索词不够 3 条 → 400(和 draft 同一份校验)", async () => {
		const missing = await call(db, "PUT", "/api/dossier", { sentence: SENTENCE, ...fields({ caresAbout: [] }) });
		assert.equal(missing.status, 400);
		assert.ok(missing.json.error.includes("caresAbout"));
		const thin = await call(db, "PUT", "/api/dossier", { sentence: SENTENCE, ...fields({ queries: ["a", "b"] }) });
		assert.equal(thin.status, 400);
		assert.ok(thin.json.error.includes("检索词"));
		// 一条都没存进去
		assert.equal(await getDossier(db, USER), null);
	});

	it("超出上限的条目在保存路径上同样被截断", async () => {
		const many = ["q1", "q2", "q3", "q4", "q5", "q6", "q7", "q8", "q9"];
		await call(db, "PUT", "/api/dossier", {
			sentence: SENTENCE,
			...fields({ queries: many, caresAbout: ["a", "b", "c", "d", "e", "f"] }),
		});
		const back = await getDossier(db, USER);
		assert.equal(back?.queries.length, 8);
		assert.equal(back?.caresAbout.length, 5);
	});

	// —— 2026-09-01 第二轮评审 ②③:读和写之间那个窗口 ——

	it("撞「原话不许改」的 400 带 refresh(重试在这条路上永远是同一个 400)", async () => {
		await call(db, "PUT", "/api/dossier", { sentence: SENTENCE, ...fields() });
		const res = await call(db, "PUT", "/api/dossier", { sentence: "我改主意了", ...fields() });
		assert.equal(res.status, 400);
		assert.equal(res.json.refresh, true, "没有 refresh 的话前端会给「再试一次」,而重试永远是同一个 400");
	});

	it("读到「没有档案」之后别人先建好了 → 409,**不覆盖、不换基准**", async () => {
		// 两个标签页都停在种子屏,各 draft 出一句话,几乎同时点保存。
		// 原来那个 upsert 会走冲突分支,把库里的 sentence 直接改写成这一趟的。
		raceAfterDossierRead(db, () => {
			db.prepare(
				`INSERT INTO dossier (id, user_email, sentence, domain, cares_about, not_cares_about, queries, rev, created_at, updated_at)
				 VALUES ('dos-别人', ?1, ?2, '别人的领域', '["x"]', '[]', '["q1","q2","q3"]', 1, 1, 1)`,
			)
				.bind(USER, "另一个标签页的那句话")
				.run();
		});
		const res = await call(db, "PUT", "/api/dossier", { sentence: SENTENCE, ...fields() });
		assert.equal(res.status, 409);
		assert.equal(res.json.refresh, true);
		const back = await getDossier(db, USER);
		assert.equal(back?.sentence, "另一个标签页的那句话", "基准被后到的那趟安静换掉了");
		assert.equal(back?.domain, "别人的领域", "内容也被覆盖了");
		assert.equal(back?.rev, 1);
	});

	it("读到档案之后它被删了 → 409,**不许原地复活**", async () => {
		await call(db, "PUT", "/api/dossier", { sentence: SENTENCE, ...fields() });
		// 另一个标签页点了「删掉重建」。原来的 upsert 会走 INSERT 分支,拿着
		// existing.id / createdAt 把一份已经被删掉的档案又插回去,而它名下的
		// 周扫和报告已经删干净了。
		raceAfterDossierRead(db, () => {
			db.prepare("DELETE FROM dossier WHERE user_email = ?1").bind(USER).run();
		});
		const res = await call(db, "PUT", "/api/dossier", { sentence: SENTENCE, ...fields({ domain: "改了领域" }) });
		assert.equal(res.status, 409);
		assert.equal(res.json.refresh, true);
		assert.equal(await getDossier(db, USER), null, "被删掉的档案不许复活");
	});

	it("读完之后库里那句话变了 → 400(比对和写入之间隔着一次 await)", async () => {
		await call(db, "PUT", "/api/dossier", { sentence: SENTENCE, ...fields() });
		raceAfterDossierRead(db, () => {
			db.prepare("UPDATE dossier SET sentence = ?2 WHERE user_email = ?1").bind(USER, "换过的原话").run();
		});
		const res = await call(db, "PUT", "/api/dossier", { sentence: SENTENCE, ...fields({ domain: "改了领域" }) });
		assert.equal(res.status, 400);
		assert.equal(res.json.refresh, true);
		const back = await getDossier(db, USER);
		assert.equal(back?.domain, fields().domain, "handler 那次比对通过了,但 SQL 那道门把它挡住了");
		assert.equal(back?.rev, 1);
	});

	it("**内容和 rev 是同一条语句写的**:一次保存只对 dossier 发一条写语句", async () => {
		await call(db, "PUT", "/api/dossier", { sentence: SENTENCE, ...fields() });
		fake(db).log.length = 0;
		const res = await call(db, "PUT", "/api/dossier", { sentence: SENTENCE, ...fields({ domain: "真的改了" }) });
		assert.equal(res.json.dossier.rev, 2);
		const writes = fake(db).log.filter((sql) => /^\s*(INSERT INTO|UPDATE) dossier/i.test(sql));
		// 原来是 putDossier + bumpDossierRev 两句,中间没有事务:用户点完保存
		// 立刻刷新(请求被取消)就会留下「新内容配旧 rev」,而且自愈不了。
		assert.equal(writes.length, 1, `内容和 rev 不在同一条语句里(发了 ${writes.length} 条写)`);
	});

	it("两个用户各存各的(v1 一人一份,互不覆盖)", async () => {
		await call(db, "PUT", "/api/dossier", { sentence: SENTENCE, ...fields() });
		await call(db, "PUT", "/api/dossier", { sentence: "另一个人的一句话", ...fields({ domain: "另一个领域" }) }, { DEV_EMAIL: "other@example.com" });
		assert.equal((await getDossier(db, USER))?.domain, fields().domain);
		assert.equal((await getDossier(db, "other@example.com"))?.domain, "另一个领域");
	});
});

describe("DELETE /api/dossier", () => {
	it("连带清掉周扫/候选/排除/报告,并如实报出删了几周几份", async () => {
		const created = await call(db, "PUT", "/api/dossier", { sentence: SENTENCE, ...fields() });
		const id = created.json.dossier.id as string;
		for (const weekOf of ["2026-W35", "2026-W36"]) {
			await putWeeklyScan(
				db,
				{
					dossierId: id,
					weekOf,
					dossierRev: 1,
					queries: fields().queries,
					returned: 87,
					admitted: 5,
					excluded: 82,
					fetchFailed: 4,
					routeCount: 2,
					claimedTotal: 4242,
					stopped: null,
					createdAt: Date.now(),
				},
				[
					{
						fullName: "owner/repo",
						stars: 100,
						pushedAt: "2026-08-01T00:00:00Z",
						archived: false,
						license: "MIT",
						repoCreatedAt: "2024-01-01T00:00:00Z",
						oneLiner: null,
						topics: [],
						sourceRoute: "stars",
						rank: 1,
					},
				],
				[
					{
						fullName: "owner/dead",
						reason: "停更超过一年",
						reasonKind: "stale",
						reasonSource: "rule",
						appealedAt: null,
						pushedAt: "2024-01-01T00:00:00Z",
					},
				],
			);
		}
		await putReport(db, {
			id: "r1",
			dossierId: id,
			fullName: "owner/repo",
			commitSha: "abc123",
			dossierRev: 1,
			payloadJson: "{}",
			estUsd: 0.5,
			anchoredRatio: 0.9,
			createdAt: Date.now(),
		});

		const res = await call(db, "DELETE", "/api/dossier");
		assert.equal(res.status, 200);
		assert.deepEqual(res.json, { ok: true, deleted: { scans: 2, reports: 1 } });
		assert.equal(await getDossier(db, USER), null);
		assert.equal(await getWeeklyScan(db, id, "2026-W36"), null);
		// 子行不许留孤儿(schema 没有外键,只能靠代码清)
		// 逐字段断言而不是 deepEqual 整个对象:node:sqlite 返回的行是
		// null 原型对象,deepStrictEqual 会因为原型不同而失败(值其实是对的)
		const orphans = await db
			.prepare("SELECT (SELECT COUNT(*) FROM scan_candidate) AS c, (SELECT COUNT(*) FROM scan_exclusion) AS e")
			.first<{ c: number; e: number }>();
		assert.equal(orphans?.c, 0, "候选行留了孤儿");
		assert.equal(orphans?.e, 0, "排除行留了孤儿");
	});

	it("没有档案时也回 200(幂等,双击不该在第二下报错)", async () => {
		const res = await call(db, "DELETE", "/api/dossier");
		assert.deepEqual(res.json, { ok: true, deleted: { scans: 0, reports: 0 } });
	});

	it("只删自己的:别人的档案和周扫一行不动", async () => {
		const mine = await call(db, "PUT", "/api/dossier", { sentence: SENTENCE, ...fields() });
		const other = await call(
			db,
			"PUT",
			"/api/dossier",
			{ sentence: "另一个人的一句话", ...fields() },
			{ DEV_EMAIL: "other@example.com" },
		);
		await putWeeklyScan(
			db,
			{
				dossierId: other.json.dossier.id,
				weekOf: "2026-W36",
				dossierRev: 1,
				queries: ["q"],
				returned: 1,
				admitted: 1,
				excluded: 0,
				fetchFailed: 0,
				routeCount: 2,
				claimedTotal: 1,
				stopped: null,
				createdAt: Date.now(),
			},
			[],
			[],
		);
		const res = await call(db, "DELETE", "/api/dossier");
		assert.deepEqual(res.json.deleted, { scans: 0, reports: 0 });
		assert.equal(await getDossier(db, USER), null);
		assert.equal((await getDossier(db, "other@example.com"))?.id, other.json.dossier.id);
		assert.ok(await getWeeklyScan(db, other.json.dossier.id, "2026-W36"));
		assert.ok(mine.json.dossier.id !== other.json.dossier.id);
	});
});

// ---------------------------------------------------------------------------
// 5. draft 的墙钟预算(2026-09-01 第二轮评审 ④)
// ---------------------------------------------------------------------------

/**
 * 一台**永远不回应**的假网关:接了请求就不写响应。上游黑洞丢包(不是拒连)
 * 就长这样,而这正是 draft 那三层重试相乘之后最危险的形态——每一层都在等
 * 一个永远不来的字节,墙钟一路涨到 CF 那条 100 秒线,用户拿到的是 524。
 *
 * 这条用例真正验的是**信号有没有接通**(dossier.ts 的 AbortSignal.timeout →
 * ai.ts CompleteInput.signal → SDK / fetch)。没接通的话代码看起来一模一样,
 * 只是超时永远不生效——没被跑过的超时等于没有超时。
 */
describe("POST /api/dossier/draft · 整趟超时", () => {
	let server: Server;
	let base = "";

	before(async () => {
		server = createServer((req) => {
			// 把请求体读干净但永不响应
			req.resume();
		});
		await new Promise<void>((r) => server.listen(0, "127.0.0.1", r));
		base = `http://127.0.0.1:${(server.address() as { port: number }).port}`;
	});
	after(() => {
		server.closeAllConnections();
		server.close();
	});

	it("上游不回应时回 504 + 一句中文,而不是把请求拖到边缘超时", async () => {
		const t0 = Date.now();
		const { status, json } = await call(db, "POST", "/api/dossier/draft", { sentence: SENTENCE }, {
			AI_PROVIDER: "gateway",
			AI_MODEL: "fake-flash",
			AI_GATEWAY_URL: base,
			AI_GATEWAY_KEY: "k",
			// 生产是 45 秒;这里调到 300ms 才跑得动这条用例
			DRAFT_BUDGET_MS: "300",
		});
		assert.equal(status, 504);
		assert.ok(json.error.includes("额度"), "要说清这一次额度已经花掉了,否则用户会连点五次");
		assert.ok(Date.now() - t0 < 10_000, "预算没生效,请求一直挂着");
	});
});

// ---------------------------------------------------------------------------
// 6. 配置报文不透传给用户(2026-09-01 第二轮评审 ⑦)
// ---------------------------------------------------------------------------

describe("AI 配错的实例", () => {
	/** 这些字眼一个都不许出现在给用户的 error 里。 */
	const LEAKS = ["AI_GATEWAY_URL", "AI_GATEWAY_KEY", "ANTHROPIC_API_KEY", "AI_PROVIDER"];

	it("gateway 档少配了地址 → 500 + 中文,不露环境变量名", async () => {
		const { status, json } = await call(db, "POST", "/api/dossier/draft", { sentence: SENTENCE }, {
			AI_PROVIDER: "gateway",
		});
		assert.equal(status, 500);
		for (const leak of LEAKS) assert.ok(!json.error.includes(leak), `报文里漏了 ${leak}:${json.error}`);
		assert.ok(json.error.includes("配置"), "要让用户看得出这是部署的问题,不是他的问题");
	});

	it("AI_PROVIDER 填了不认识的值 → 仍然是 JSON 500(不是 Hono 的默认错误页)", async () => {
		// 这一句在拼配置那一步就抛(fastVariant 会调 resolveProvider),原来它
		// 发生在 try 之外,会走 Hono 默认错误处理回一个非 JSON 的 500,前端只能
		// 显示「请求失败(HTTP 500)」。
		const { status, json } = await call(db, "POST", "/api/dossier/draft", { sentence: SENTENCE }, {
			AI_PROVIDER: "没这个东西",
		});
		assert.equal(status, 500);
		assert.ok(typeof json.error === "string" && json.error.length > 0, "必须是 { error } 形状的 JSON");
		for (const leak of LEAKS) assert.ok(!json.error.includes(leak), `报文里漏了 ${leak}:${json.error}`);
	});
});

// ---------------------------------------------------------------------------
// 7. 前端写死的后端事实(2026-09-01 第二轮评审 ⑥)
// ---------------------------------------------------------------------------

describe("部署配置与共享常量", () => {
	it("WEEKLY_SCAN_SCHEDULE.cron 与 wrangler.jsonc 的 triggers 一致", () => {
		// 前端的保存回执要告诉用户「下一次周扫是什么时候」,而排期的真源在
		// wrangler.jsonc 里。Worker 运行时读不到那个文件,所以只能两处各写一份 +
		// 这条用例把它们钉在一起:改了 cron 不改常量,这里当场红。
		const jsonc = readFileSync(path.resolve(HERE, "../../wrangler.jsonc"), "utf8");
		const m = /"crons"\s*:\s*\[\s*"([^"]+)"/.exec(jsonc);
		assert.ok(m, "wrangler.jsonc 里找不到 triggers.crons");
		assert.equal(m[1], WEEKLY_SCAN_SCHEDULE.cron, "改 cron 的时候忘了改 types.ts 的 WEEKLY_SCAN_SCHEDULE");
	});
});
