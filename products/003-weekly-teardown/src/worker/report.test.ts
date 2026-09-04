// 阶段 7(深度报告两节 + SSE)的测试。跑法:npm test。
//
// 这一份走的是**真的整条路**:真 fetch → 一台本地假 GitHub + 假 HN + 假 AI 网关
// → 真的 anchorAcross → 真的 gateTakeaways → 真的 D1 写。假的只有三件事:
// GitHub / HN 的应答内容,以及模型说的话。
//
// 为什么值得这么重:这一阶段的全部价值在**几层之间的接缝**上——模型给的引文
// 要在「它声称的那一份材料」里逐字对得上,对不上的判断层条目要真的消失,而
// 永久回链里那一段必须是 commit sha。这三件事没有任何一个单测证明得了:
// anchorAcross 的单测证明它会拒跨源,但证明不了**报告真的把 claimedSource
// 传给了它**;gateTakeaways 的单测证明它会丢,但证明不了**丢掉的东西真的没有
// 出现在响应里**。
//
// 假 D1 抄自 store.test.ts / scan.test.ts,理由见 dossier.test.ts 顶部
// (node 的 test runner 会把被 import 的 .test.ts 里的用例再注册一遍)。

import assert from "node:assert/strict";
import { createServer, type Server } from "node:http";
import { DatabaseSync } from "node:sqlite";
import { readFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { after, before, beforeEach, describe, it } from "node:test";
import { reportRoutes } from "./report.ts";
import { changelogPermalink, changelogSource, parseReleasesAtom } from "../shared/changelog.ts";
import { htmlToText, pickStory } from "../shared/hn.ts";
import type { HnStory } from "../shared/hn.ts";
import { excludeFile, pickFiles } from "../shared/source-pick.ts";
import { createDossier, getInflight, getQuota, putWeeklyScan, spendToday } from "../shared/store.ts";
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
// 一台假服务器,三个身份:GitHub / raw / HN / AI 网关
// ---------------------------------------------------------------------------

const SHA = "a".repeat(39) + "7"; // 40 位十六进制,真 commit sha 的形状
const OTHER_SHA = "b".repeat(40);

/** 节 2 的正文:引文要在这一份里逐字对得上。 */
const INDEX_TS = [
	"import { Hono } from 'hono';",
	"",
	"// 断点续传:把已经写出去的字节数记在 KV 里,重连时从那里接着推",
	"export async function resume(key: string, from: number): Promise<Response> {",
	"  const done = await KV.get(key);",
	"  return new Response(body, { headers: { 'content-range': `bytes ${from}-` } });",
	"}",
].join("\n");

const README_MD = [
	"# BibiGPT",
	"",
	"一键总结音视频内容。**默认走字幕,没有字幕才转写** —— 转写一小时视频要几分钟,",
	"而字幕是现成的。",
	"",
	"## 部署",
	"需要自己准备 OpenAI key。",
].join("\n");

const ATOM = `<?xml version="1.0" encoding="UTF-8"?>
<feed xmlns="http://www.w3.org/2005/Atom">
  <entry>
    <id>tag:github.com,2008:Repository/1/v2.0.0</id>
    <updated>2025-06-01T10:00:00Z</updated>
    <link rel="alternate" type="text/html" href="https://github.com/acme/bibigpt/releases/tag/v2.0.0"/>
    <title>v2.0.0 转闭源</title>
    <content type="html">&lt;p&gt;从这个版本起核心逻辑不再开源。&lt;/p&gt;</content>
  </entry>
  <entry>
    <id>tag:github.com,2008:Repository/1/v1.0.0</id>
    <updated>2023-05-01T10:00:00Z</updated>
    <link rel="alternate" type="text/html" href="https://github.com/acme/bibigpt/releases/tag/v1.0.0"/>
    <title>v1.0.0</title>
    <content type="html">&lt;p&gt;第一个正式版。&lt;/p&gt;</content>
  </entry>
</feed>`;

const HN_COMMENT_TEXT = "This looks great but I worry the whole thing breaks the moment YouTube blocks the transcript endpoint.";

interface GhPlan {
	repo: Record<string, unknown>;
	/** null = commits 端点回 404(空仓)。 */
	commitSha: string | null;
	tree: { path: string; size: number }[];
	treeTruncated: boolean;
	readme: string | null;
	raw: Map<string, string>;
	atom: string | null;
	/** README 那一发回 403 + retry-after(秒)。验「退避睡不起就别睡」这条路。 */
	readmeRetryAfter: number | null;
	/** HN 搜索的应答:story 命中与评论。null story = 这个项目在 HN 上没有记录。 */
	hnStory: Record<string, unknown> | null;
	/**
	 * HN **官方** API 的 `kids`(排序的唯一来源)。null = 那一跳没成 / 帖子没有
	 * kids,候选池必须降级成时间序并且如实说出来。
	 */
	hnKids: number[] | null;
	/**
	 * Algolia `/items/<storyId>` 的 children。**形状照真上游造**:字段叫 `id`
	 * 不叫 objectID、叫 `text` 不叫 comment_text,而且**没有可用的 points**——
	 * 2026-09-01 实测 HN 不公开评论分数(阶段 7 评审必须修 2 的成因就是上一轮
	 * 的假上游给了 points,真上游根本不给)。
	 */
	hnComments: Record<string, unknown>[];
	hits: string[];
}

interface AiPlan {
	history: unknown;
	source: unknown;
	/** 每次生成之前先拖这么久(用来验心跳)。 */
	delayMs: number;
	prompts: string[];
	/** 还要吐几次「不是 JSON」的产出。complete() 会为此原样整发重来一次。 */
	garbage: number;
}

let server: Server;
let base = "";
let plan: GhPlan;
let ai: AiPlan;

const FULL = "acme/bibigpt";

function resetPlan(): void {
	plan = {
		repo: {
			full_name: FULL,
			stargazers_count: 6202,
			pushed_at: "2026-05-04T00:00:00Z",
			created_at: "2023-02-14T00:00:00Z",
			archived: false,
			license: { spdx_id: "GPL-3.0" },
			description: "一键总结音视频内容",
			topics: ["video", "summarize"],
			language: "TypeScript",
			fork: false,
			html_url: `https://github.com/${FULL}`,
			default_branch: "main",
		},
		commitSha: SHA,
		tree: [
			{ path: "README.md", size: 900 },
			{ path: "src/index.ts", size: 4200 },
			{ path: "src/resume.ts", size: 1800 },
			{ path: "test/index.test.ts", size: 9000 },
			{ path: "vendor/big.js", size: 3000 },
			{ path: "assets/logo.png", size: 2000 },
		],
		treeTruncated: false,
		readme: README_MD,
		raw: new Map([
			["src/index.ts", INDEX_TS],
			["src/resume.ts", "export const RESUME_WINDOW_MS = 5 * 60_000; // 五分钟窗口补漏\nexport function windowFor(at: number) { return at - RESUME_WINDOW_MS; }"],
		]),
		atom: ATOM,
		readmeRetryAfter: null,
		hnStory: {
			objectID: "38291043",
			title: "Show HN: BibiGPT – one-click summary for any video",
			url: `https://github.com/${FULL}`,
			points: 214,
			num_comments: 87,
			created_at: "2023-03-01T09:00:00Z",
			author: "jimmylv",
		},
		// kids 的顺序**故意和时间顺序相反**:38291200 发得晚却被 HN 排在前面。
		// 两者一致的话,「用的是 kids 还是时间」这件事在断言里分辨不出来。
		hnKids: [38291200, 38291100],
		hnComments: [
			{ id: 38291100, text: `<p>${HN_COMMENT_TEXT}</p>`, points: null, created_at: "2023-03-01T10:00:00Z", author: "skeptic" },
			{ id: 38291200, text: "<p>Works on my machine, nice work at all.</p>", points: null, created_at: "2023-03-01T11:00:00Z", author: "fan" },
		],
		hits: [],
	};
	ai = {
		history: { picks: [], takeaways: [] },
		source: { takeaways: [] },
		delayMs: 0,
		prompts: [],
		garbage: 0,
	};
}

/** Anthropic 兼容的 SSE 应答(和 dossier.test.ts 那台假网关同款)。 */
function writeAnthropicSse(res: import("node:http").ServerResponse, text: string): void {
	res.writeHead(200, { "content-type": "text/event-stream" });
	const ev = (type: string, data: Record<string, unknown>) =>
		res.write(`event: ${type}\ndata: ${JSON.stringify({ type, ...data })}\n\n`);
	ev("message_start", {
		message: { id: "msg_1", type: "message", role: "assistant", model: "fake-pro", content: [], stop_reason: null, stop_sequence: null, usage: { input_tokens: 1, output_tokens: 0 } },
	});
	ev("content_block_start", { index: 0, content_block: { type: "text", text: "" } });
	for (const piece of text.match(/[\s\S]{1,64}/g) ?? []) {
		ev("content_block_delta", { index: 0, delta: { type: "text_delta", text: piece } });
	}
	ev("content_block_stop", { index: 0 });
	ev("message_delta", { delta: { stop_reason: "end_turn", stop_sequence: null }, usage: { output_tokens: 3 } });
	ev("message_stop", {});
	res.end();
}

before(async () => {
	resetPlan();
	server = createServer((req, res) => {
		const url = new URL(req.url ?? "/", "http://x");
		const p = url.pathname;
		plan.hits.push(p + url.search);
		const json = (status: number, body: unknown) => {
			res.writeHead(status, {
				"content-type": "application/json",
				"x-ratelimit-remaining": "4999",
				"x-ratelimit-reset": String(Math.floor(Date.now() / 1000) + 60),
				"x-ratelimit-limit": "5000",
			});
			res.end(JSON.stringify(body));
		};
		const text = (status: number, body: string) => {
			res.writeHead(status, { "content-type": "text/plain" });
			res.end(body);
		};

		// --- 假「站长专线」网关:一律 500,好让 complete() 走 fallback ---
		if (p === "/__boom/v1/messages") {
			req.resume();
			res.writeHead(500, { "content-type": "application/json" });
			res.end(JSON.stringify({ type: "error", error: { type: "api_error", message: "专线这会儿挂了" } }));
			return;
		}

		// --- 假 AI 网关(Anthropic 兼容)---
		if (p === "/v1/messages") {
			let raw = "";
			req.on("data", (c) => (raw += c));
			req.on("end", () => {
				const body = JSON.parse(raw) as { system?: string; messages: { content: string }[] };
				const prompt = body.messages[0]?.content ?? "";
				ai.prompts.push(prompt);
				const isHistory = (body.system ?? "").includes("发展史判断");
				// 「200 + end_turn,产出却不是 JSON」——complete() 对这一类原样整发重来
				let out: string;
				if (ai.garbage > 0) {
					ai.garbage -= 1;
					out = "这不是 JSON,一个花括号都没有。";
				} else {
					out = JSON.stringify(isHistory ? ai.history : ai.source);
				}
				setTimeout(() => writeAnthropicSse(res, out), ai.delayMs);
			});
			return;
		}

		// --- 假 HN 官方 API(排序的唯一来源)---
		if (p.startsWith("/__hnfb/item/")) {
			if (plan.hnKids === null) return json(404, { message: "no item" });
			return json(200, { id: 38291043, type: "story", kids: plan.hnKids });
		}

		// --- 假 HN Algolia ---
		if (p.startsWith("/__hn/items/")) {
			// `/items/<storyId>`:一次批量给正文,按 id 索引
			return json(200, { id: 38291043, type: "story", children: plan.hnComments });
		}
		if (p === "/__hn/search") {
			const tags = url.searchParams.get("tags") ?? "";
			// 评论**不再走 search**(那条路按 objectID 降序只给最新的 N 条,
			// 和 kids 的前 30 条对不上)。还有人打它就是回归。
			if (tags.startsWith("comment")) return json(500, { message: "评论不该再走 search" });
			return json(200, { hits: plan.hnStory ? [plan.hnStory] : [] });
		}

		// --- 假 raw.githubusercontent.com ---
		if (p.startsWith("/__raw/")) {
			// /__raw/{owner}/{repo}/{sha}/{path...}
			// **逐段解码**:客户端按 encodeURIComponent 编过路径(路径里带 # 或 ?
			// 的文件),真 raw.githubusercontent.com 会解回来,假的不解就永远 404
			const rest = p.slice("/__raw/".length).split("/");
			const file = rest.slice(3).map(decodeURIComponent).join("/");
			const body = plan.raw.get(file);
			return body === undefined ? text(404, "not found") : text(200, body);
		}

		// --- 假 github.com(releases.atom)---
		if (p.startsWith("/__web/") && p.endsWith("/releases.atom")) {
			return plan.atom === null ? text(404, "not found") : text(200, plan.atom);
		}

		// --- 假 api.github.com ---
		if (p === "/search/repositories") return json(200, { total_count: 1, items: [plan.repo] });
		const readme = /^\/repos\/([^/]+\/[^/]+)\/readme$/.exec(p);
		if (readme) {
			if (plan.readmeRetryAfter !== null) {
				res.writeHead(403, { "content-type": "application/json", "retry-after": String(plan.readmeRetryAfter) });
				res.end(JSON.stringify({ message: "secondary rate limit" }));
				return;
			}
			if (plan.readme === null) return json(404, { message: "Not Found" });
			return json(200, { path: "README.md", encoding: "base64", content: Buffer.from(plan.readme, "utf8").toString("base64") });
		}
		const tree = /^\/repos\/([^/]+\/[^/]+)\/git\/trees\/([^/]+)$/.exec(p);
		if (tree) {
			return json(200, {
				sha: tree[2],
				truncated: plan.treeTruncated,
				tree: [
					...plan.tree.map((t) => ({ path: t.path, type: "blob", size: t.size, sha: "c".repeat(40) })),
					{ path: "src", type: "tree", sha: "d".repeat(40) },
				],
			});
		}
		const commits = /^\/repos\/([^/]+\/[^/]+)\/commits\/(.+)$/.exec(p);
		if (commits) {
			if (plan.commitSha === null) return json(404, { message: "Not Found" });
			return json(200, { sha: plan.commitSha, commit: { committer: { date: "2026-05-04T00:00:00Z" } } });
		}
		const repo = /^\/repos\/([^/]+\/[^/]+)$/.exec(p);
		if (repo) {
			return repo[1] === plan.repo.full_name ? json(200, plan.repo) : json(404, { message: "Not Found" });
		}
		return json(404, { message: "no route" });
	});
	await new Promise<void>((r) => server.listen(0, "127.0.0.1", r));
	base = `http://127.0.0.1:${(server.address() as { port: number }).port}`;
});

after(() => server.close());

// ---------------------------------------------------------------------------
// 打端点
// ---------------------------------------------------------------------------

const USER = "someone@example.com";
const WEEK = "2026-W36";

function env(db: D1Database, over: Partial<AppEnv> = {}): AppEnv {
	return {
		TEARDOWN_DB: db,
		DEV_EMAIL: USER,
		GITHUB_API_BASE: base,
		// 假网关档:模型说什么由 ai.history / ai.source 决定
		AI_PROVIDER: "gateway",
		AI_MODEL: "fake-pro",
		AI_GATEWAY_URL: base,
		AI_GATEWAY_KEY: "k",
		...over,
	} as AppEnv;
}

type Json = Record<string, any>;
type SseEvent = { type: string } & Json;

interface Ran {
	status: number;
	streamed: boolean;
	json: Json;
	events: SseEvent[];
}

/** 跑一次 POST /api/report,把 SSE 读干净(或者把 JSON 读出来)。 */
async function run(db: D1Database, body: unknown, over: Partial<AppEnv> = {}): Promise<Ran> {
	const tasks: Promise<unknown>[] = [];
	const ctx = { waitUntil: (p: Promise<unknown>) => tasks.push(p), passThroughOnException() {} };
	const res = await reportRoutes.request(
		"/api/report",
		{ method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(body) },
		env(db, over),
		ctx as never,
	);
	if (!res.headers.get("content-type")?.includes("event-stream")) {
		await Promise.all(tasks);
		return { status: res.status, streamed: false, json: (await res.json()) as Json, events: [] };
	}
	const events: SseEvent[] = [];
	const reader = res.body!.getReader();
	const dec = new TextDecoder();
	let buf = "";
	for (;;) {
		const { done, value } = await reader.read();
		if (done) break;
		buf += dec.decode(value, { stream: true });
		const chunks = buf.split("\n\n");
		buf = chunks.pop() ?? "";
		for (const raw of chunks) {
			const line = raw.split("\n").find((l) => l.startsWith("data:"));
			if (line) events.push(JSON.parse(line.slice(5).trim()) as SseEvent);
		}
	}
	await Promise.all(tasks);
	return { status: res.status, streamed: true, json: {}, events };
}

async function get(db: D1Database, pathname: string, over: Partial<AppEnv> = {}): Promise<{ status: number; json: Json }> {
	const res = await reportRoutes.request(pathname, { method: "GET" }, env(db, over));
	return { status: res.status, json: (await res.json()) as Json };
}

/** 从事件流里挑出那份报告。 */
function reportOf(r: Ran): Json {
	const ev = r.events.find((e) => e.type === "result");
	assert.ok(ev, `事件流里没有 result:${JSON.stringify(r.events.map((e) => e.type))}`);
	return ev.report as Json;
}

let db: D1Database;
let dossierId: string;

/** 建一份档案 + 一周清单,好让 POST /api/report 有一个「候选清单上的仓」可拆。 */
async function seed(cares = ["断点续传与恢复", "resume 语义"]): Promise<void> {
	db = freshDb();
	resetPlan();
	const d = await createDossier(db, {
		id: "dossier-1",
		userEmail: USER,
		sentence: "我想跟踪长视频总结这个方向的开源项目",
		domain: "长视频总结与转写",
		caresAbout: cares,
		notCaresAbout: ["闭源 SaaS"],
		queries: ["video summarize", "youtube transcript", "topic:bilibili"],
		createdAt: 1,
		updatedAt: 1,
	});
	dossierId = d!.id;
	await putWeeklyScan(
		db,
		{
			dossierId,
			weekOf: WEEK,
			dossierRev: 1,
			queries: ["video summarize"],
			returned: 2,
			admitted: 1,
			excluded: 1,
			fetchFailed: 0,
			routeCount: 2,
			claimedTotal: 81234,
			stopped: null,
			createdAt: Date.now(),
		},
		[
			{
				fullName: FULL,
				stars: 6202,
				pushedAt: "2026-05-04T00:00:00Z",
				archived: false,
				license: "GPL-3.0",
				repoCreatedAt: "2023-02-14T00:00:00Z",
				oneLiner: null,
				topics: [],
				sourceRoute: "stars",
				rank: 1,
			},
		],
		[
			{
				fullName: "other/repo",
				reason: "已归档(GitHub 字段)",
				reasonKind: "archived",
				reasonSource: "rule",
				appealedAt: null,
				pushedAt: "2026-05-04T00:00:00Z",
			},
		],
	);
}

// **必须包一层**:node 的 beforeEach 会把 TestContext 当第一个实参传进来,
// 直接写 `beforeEach(seed)` 的话 `cares` 收到的是那个 context 对象而不是默认值,
// 档案的 caresAbout 会静静地变成空数组 —— 而 caresAbout 为空时判断层硬门
// 会把所有 takeaway 都按「下标越界」丢掉,于是一整批用例红得莫名其妙。
beforeEach(() => seed());

// ===========================================================================
// 纯函数层
// ===========================================================================

describe("节 2 的文件挑选启发式", () => {
	it("测试 / vendor / 构建产物 / 锁文件 / >100KB 一律排除", () => {
		assert.ok(excludeFile({ path: "test/a.ts", size: 10 }));
		assert.ok(excludeFile({ path: "packages/x/__tests__/a.ts", size: 10 }));
		assert.ok(excludeFile({ path: "src/a.test.ts", size: 10 }));
		assert.ok(excludeFile({ path: "vendor/lib.js", size: 10 }));
		assert.ok(excludeFile({ path: "node_modules/x/i.js", size: 10 }));
		assert.ok(excludeFile({ path: "package-lock.json", size: 10 }));
		assert.ok(excludeFile({ path: "logo.png", size: 10 }));
		assert.ok(excludeFile({ path: "src/huge.ts", size: 200 * 1024 }));
		// 反面:名字里带 test 但不是测试目录/测试文件的,不许误杀
		assert.equal(excludeFile({ path: "src/testing-helpers.ts", size: 100 }), null);
	});

	it("README 已经单独拿了就不再占一个名额", () => {
		const got = pickFiles([{ path: "README.md", size: 900 }, { path: "src/index.ts", size: 4000 }], {
			caresAbout: [],
			readmePath: "README.md",
			limit: 4,
		});
		assert.deepEqual(got.map((f) => f.path), ["src/index.ts"]);
	});

	it("路径命中 caresAbout 的排在前面,理由里说得出是第几条", () => {
		const got = pickFiles(
			[
				{ path: "src/util/misc.ts", size: 3000 },
				{ path: "src/resume.ts", size: 1800 },
			],
			{ caresAbout: ["我在意 resume 断点续传", "别的"], limit: 5 },
		);
		assert.equal(got[0]?.path, "src/resume.ts");
		assert.deepEqual(got[0]?.caresHits, [0]);
		assert.ok(got[0]?.why.includes("第 1 条"), got[0]?.why);
	});

	it("同分按路径字典序,不靠 sort 的稳定性 —— 同样的输入必须挑出同样的文件", () => {
		const entries = [
			{ path: "src/bbb.ts", size: 3000 },
			{ path: "src/aaa.ts", size: 3000 },
		];
		const a = pickFiles(entries, { caresAbout: [], limit: 5 });
		const b = pickFiles([...entries].reverse(), { caresAbout: [], limit: 5 });
		assert.deepEqual(a.map((f) => f.path), b.map((f) => f.path));
		assert.equal(a[0]?.path, "src/aaa.ts");
	});
});

describe("changelog 解析", () => {
	it("entry 的 title / updated / link / 正文都解出来,HTML 实体解开", () => {
		const got = parseReleasesAtom(ATOM);
		assert.equal(got.length, 2);
		assert.equal(got[0]?.title, "v2.0.0 转闭源");
		assert.equal(got[0]?.link, "https://github.com/acme/bibigpt/releases/tag/v2.0.0");
		assert.ok(got[0]?.body.includes("从这个版本起核心逻辑不再开源。"));
	});

	it("引文落在哪一条 release 上,回链就是那一条的 tag", () => {
		const entries = parseReleasesAtom(ATOM);
		const { text, ranges } = changelogSource(entries);
		const at = text.indexOf("第一个正式版");
		assert.ok(at > 0);
		assert.equal(changelogPermalink(ranges, at, "fallback"), "https://github.com/acme/bibigpt/releases/tag/v1.0.0");
		// 拿不到下标时降级成 fallback,**不猜一条 tag**
		assert.equal(changelogPermalink(ranges, undefined, "fallback"), "fallback");
	});
});

describe("HN 取数与排序", () => {
	const story = (over: Partial<HnStory>): HnStory => ({
		id: "1",
		title: "Show HN: something",
		url: null,
		points: 10,
		numComments: 1,
		createdAt: "2023-01-01T00:00:00Z",
		author: "a",
		...over,
	});

	it("链接直指这个仓的优先;撞名的标题不算数", () => {
		const hits = [
			story({ id: "x", title: "Ask HN: best summarize tools?", points: 900 }),
			story({ id: "y", title: "Show HN: BibiGPT", url: "https://github.com/acme/bibigpt", points: 100 }),
		];
		assert.equal(pickStory(hits, FULL)?.id, "y");
	});

	it("同一个项目有多条帖时取分最高的那条(当年反应最大的那一次)", () => {
		const hits = [
			story({ id: "old", url: "https://github.com/acme/bibigpt", points: 30 }),
			story({ id: "big", url: "https://github.com/acme/bibigpt", points: 214 }),
		];
		assert.equal(pickStory(hits, FULL)?.id, "big");
	});

	it("一条都对不上就回 null —— 不假装有(中文项目在 HN 上覆盖为零)", () => {
		assert.equal(pickStory([story({ title: "unrelated thing", points: 999 })], FULL), null);
	});

	it("评论正文去掉 HTML 标签但不把词粘在一起", () => {
		assert.equal(htmlToText("<p>a</p><p>b</p>"), "a\n\nb");
		assert.equal(htmlToText("x<i>y</i>z"), "x y z");
		assert.equal(htmlToText("a &amp;lt; b"), "a &lt; b");
	});
});

// ===========================================================================
// 端点层
// ===========================================================================

describe("POST /api/report · 入口校验", () => {
	it("畸形 fullName 被 400 拦下,而且一次网络都不发", async () => {
		for (const bad of ["acme/bibigpt/../../users/x", "acme/bibigpt?per_page=1", "nope", "a b/c", ""]) {
			const r = await run(db, { weekOf: WEEK, fullName: bad });
			assert.equal(r.status, 400, `${bad} 应该被 400 拦下`);
			assert.equal(r.streamed, false);
		}
		assert.deepEqual(plan.hits, [], `校验之前不许发任何请求,实际发了:${JSON.stringify(plan.hits)}`);
		assert.deepEqual(ai.prompts, []);
	});

	it("weekOf 格式不对 → 400", async () => {
		const r = await run(db, { weekOf: "上周", fullName: FULL });
		assert.equal(r.status, 400);
		assert.ok(r.json.error.includes("2026-W36"));
		assert.deepEqual(plan.hits, []);
	});

	it("不在这一周候选清单上的仓拆不了(不是一个通用的 GitHub 报告代理)", async () => {
		const r = await run(db, { weekOf: WEEK, fullName: "other/repo" });
		assert.equal(r.status, 400);
		assert.ok(r.json.error.includes("候选清单"));
		assert.deepEqual(plan.hits, []);
	});

	it("那一周还没跑过周扫 → 400,不是 500", async () => {
		const r = await run(db, { weekOf: "2026-W01", fullName: FULL });
		assert.equal(r.status, 400);
		assert.ok(r.json.error.includes("周扫"));
	});
});

describe("POST /api/report · SSE 与 mock 端到端", () => {
	/** mock 档:抓取、锚定、硬门全是真的,只有措辞是假的。 */
	const MOCK: Partial<AppEnv> = { AI_PROVIDER: "mock", AI_GATEWAY_URL: undefined, AI_GATEWAY_KEY: undefined };

	it("事件序列:四个 phase → result;phase 的值就是 inflight.phase 的值", async () => {
		const r = await run(db, { weekOf: WEEK, fullName: FULL }, MOCK);
		assert.equal(r.streamed, true);
		const phases = r.events.filter((e) => e.type === "phase").map((e) => e.phase);
		assert.deepEqual(phases, ["fetching", "history", "source", "anchoring"]);
		assert.equal(r.events.at(-1)?.type, "result");
	});

	it("mock 档零 key 端到端:真抓、真锚定、真硬门,只有措辞带 [mock]", async () => {
		const rep = reportOf(await run(db, { weekOf: WEEK, fullName: FULL }, MOCK));
		assert.equal(rep.fullName, FULL);
		assert.equal(rep.commitSha, SHA);
		// 时间线是代码建的:建立 / HN 帖 / 3 条挑出来的评论 / release / 最后一次 push
		const kinds = (rep.history.timeline as Json[]).map((n) => n.kind);
		assert.ok(kinds.includes("created"), JSON.stringify(kinds));
		assert.ok(kinds.includes("hn-story"));
		assert.ok(kinds.includes("hn-comment"));
		assert.ok(kinds.includes("release"));
		assert.ok(kinds.includes("last-push"));
		assert.ok((rep.history.timeline as Json[]).length <= 12);
		// 锚定是真的跑了的:mock 的引文从真材料里切出来,所以必然全中
		assert.equal(rep.anchoredRatio, 1);
		assert.ok((rep.evidence as Json[]).length > 0);
		assert.ok((rep.source.takeaways as Json[]).length > 0);
		assert.ok(String(rep.source.takeaways[0].text).startsWith("[mock]"));
		assert.ok((rep.notes as Json[]).some((n) => n.kind === "mock"));
	});

	it("时间线按时间升序,而且每个节点都挂得到证据表里的一条", async () => {
		const rep = reportOf(await run(db, { weekOf: WEEK, fullName: FULL }, MOCK));
		const nodes = rep.history.timeline as Json[];
		const ids = new Set((rep.evidence as Json[]).map((e) => e.id));
		let prev = "";
		for (const n of nodes) {
			assert.ok(String(n.at) >= prev, `时间线没排好:${prev} → ${n.at}`);
			prev = String(n.at);
			assert.ok(ids.has(n.evidenceId), `节点 ${n.kind} 的证据 ${n.evidenceId} 不在证据表里`);
		}
	});

	it("ping 按间隔一直发 —— thinking 阶段那几十秒里唯一的字节", async () => {
		// 生产是 10 秒。这里把心跳调到 30ms、让假网关每次先拖 250ms,
		// 用 0.5 秒验一件本来要 30 秒才看得见的事(env.ts REPORT_PING_MS 的注释)。
		ai.delayMs = 250;
		ai.history = { picks: [], takeaways: [] };
		ai.source = { takeaways: [] };
		const r = await run(db, { weekOf: WEEK, fullName: FULL }, { REPORT_PING_MS: "30" });
		const pings = r.events.filter((e) => e.type === "ping").length;
		assert.ok(pings >= 5, `两次调用各拖 250ms,30ms 一个心跳,至少该有 5 个 ping,实际 ${pings}`);
		assert.equal(r.events.at(-1)?.type, "result");
	});
});

describe("POST /api/report · 锚定与判断层硬门", () => {
	/** 一条挂在 src/index.ts 上、逐字对得上的引文。 */
	const REAL_QUOTE = "断点续传:把已经写出去的字节数记在 KV 里,重连时从那里接着推";

	it("跨源引文被拒:模型声称引自 readme,那句话实际只在 src/index.ts 里", async () => {
		ai.source = {
			takeaways: [
				{ text: "它的断点续传值得抄", quotes: [{ source: "readme", quote: REAL_QUOTE }], caresAboutIndex: 0 },
				{ text: "同一句话,来源写对了", quotes: [{ source: "raw:src/index.ts", quote: REAL_QUOTE }], caresAboutIndex: 0 },
			],
		};
		const rep = reportOf(await run(db, { weekOf: WEEK, fullName: FULL }));
		const kept = (rep.source.takeaways as Json[]).map((t) => t.text);
		assert.deepEqual(kept, ["同一句话,来源写对了"], "挂错来源的那条必须消失");
		const dropped = rep.source.dropped as Json[];
		assert.equal(dropped.length, 1);
		assert.equal(dropped[0]?.kind, "unanchored-evidence");
		// 这句话真的在 README 之外的某一份材料里 —— 也就是说拒绝的理由是「来源不对」,
		// 不是「这句话我们没抓到」。这一条是这个用例的要害。
		assert.ok(INDEX_TS.includes(REAL_QUOTE));
		assert.ok(!README_MD.includes(REAL_QUOTE));
	});

	it("无依据 / 编造证据来源 / caresAboutIndex 越界的 takeaway 全部消失,而且丢了几条要说出来", async () => {
		ai.source = {
			takeaways: [
				{ text: "凭空的判断", quotes: [], caresAboutIndex: 0 },
				{ text: "编了个来源", quotes: [{ source: "raw:src/nope.ts", quote: REAL_QUOTE }], caresAboutIndex: 0 },
				{ text: "下标越界", quotes: [{ source: "raw:src/index.ts", quote: REAL_QUOTE }], caresAboutIndex: 9 },
				{ text: "下标是小数", quotes: [{ source: "raw:src/index.ts", quote: REAL_QUOTE }], caresAboutIndex: 1.5 },
				{ text: "唯一合格的一条", quotes: [{ source: "raw:src/index.ts", quote: REAL_QUOTE }], caresAboutIndex: 1 },
			],
		};
		const rep = reportOf(await run(db, { weekOf: WEEK, fullName: FULL }));
		assert.deepEqual((rep.source.takeaways as Json[]).map((t) => t.text), ["唯一合格的一条"]);
		const kinds = (rep.source.dropped as Json[]).map((d) => d.kind);
		assert.deepEqual(kinds, ["no-basis", "unanchored-evidence", "cares-about-out-of-range", "cares-about-out-of-range"]);
		// 硬门的对价:删了多少、为什么删,必须在响应里,不藏
		assert.ok(String(rep.source.gateNote).includes("模型给了 5 条"), rep.source.gateNote);
		assert.ok(String(rep.source.gateNote).includes("1 条挂得上"));
		assert.ok(String(rep.source.gateNote).includes("4 条挂不上已丢弃"));
	});

	it("节 1 的发展史结论走同一道门;模型挑了一个不存在的评论 id 就当没挑过", async () => {
		ai.history = {
			picks: [
				{ commentId: "38291100", quote: HN_COMMENT_TEXT.slice(0, 60), why: "当年最高分的质疑" },
				{ commentId: "99999999", quote: "编的", why: "编的" },
			],
			takeaways: [
				{ text: "它 2025 年转了闭源", quotes: [{ source: "changelog", quote: "从这个版本起核心逻辑不再开源。" }], caresAboutIndex: 0 },
				{ text: "编造的引文", quotes: [{ source: "changelog", quote: "这句话 changelog 里没有" }], caresAboutIndex: 0 },
			],
		};
		const rep = reportOf(await run(db, { weekOf: WEEK, fullName: FULL }));
		assert.deepEqual((rep.history.takeaways as Json[]).map((t) => t.text), ["它 2025 年转了闭源"]);
		const picked = (rep.history.timeline as Json[]).filter((n) => n.kind === "hn-comment");
		assert.equal(picked.length, 1, "编造的 comment id 不该变成一个节点");
		assert.ok(String(picked[0]?.pickedWhy).includes("质疑"));
	});

	it("事实层锚不上是灰显不删:时间线节点照常在,证据上写着 anchored: false", async () => {
		// HN 帖的标题是代码从材料里取的,必然锚得上;这里换一条真的锚不上的:
		// 模型挑的评论引文改成一句评论里没有的话
		ai.history = {
			picks: [{ commentId: "38291100", quote: "这句话那条评论里根本没有", why: "测灰显" }],
			takeaways: [],
		};
		const rep = reportOf(await run(db, { weekOf: WEEK, fullName: FULL }));
		const node = (rep.history.timeline as Json[]).find((n) => n.kind === "hn-comment");
		assert.ok(node, "事实层不许删,节点必须还在");
		const ev = (rep.evidence as Json[]).find((e) => e.id === node!.evidenceId);
		assert.equal(ev?.anchored, false, "锚不上就如实标 false,由前端灰显");
		assert.ok(rep.anchoredRatio < 1);
	});
});

// ===========================================================================
// 2026-09-01 阶段 7 评审:必须修 1-3 / 建议修 4、6、7
// ===========================================================================

describe("POST /api/report · HN 的排序只能从官方 kids 来(必须修 2)", () => {
	/**
	 * 上一轮为什么会漏:假上游给评论造了 `points`,而**真上游不给**——2026-09-01
	 * 实测 `hn.algolia.com/api/v1/search?tags=comment,story_3742902`,88 条命中的
	 * hit 里连 `points` 这个键都没有。假数据比真数据「完整」时,测试验的是一个
	 * 不存在的世界。这一组的前提是 resetPlan() 里的 hnComments 已经按真形状造了
	 * (`points: null`,字段名 id / text)。
	 */
	it("候选池按 kids 的顺序,不是按时间、也不是按 Algolia 的返回顺序", async () => {
		// kids = [38291200, 38291100],而 38291200 发表得**更晚**
		ai.history = { picks: [], takeaways: [] };
		await run(db, { weekOf: WEEK, fullName: FULL });
		const prompt = ai.prompts.find((x) => x.includes("候选评论")) ?? "";
		const first = prompt.indexOf("commentId=38291200");
		const second = prompt.indexOf("commentId=38291100");
		assert.ok(first > 0 && second > 0, prompt.slice(0, 400));
		assert.ok(first < second, "HN 把 38291200 排在前面,候选池就该是这个顺序");
		assert.match(prompt, /hnRank=1[\s\S]*?hnRank=2/);
	});

	it("提示词里没有 points,也不再说「按分数排好了」", async () => {
		await run(db, { weekOf: WEEK, fullName: FULL });
		const prompt = ai.prompts.find((x) => x.includes("候选评论")) ?? "";
		assert.ok(!prompt.includes("points="), "HN 不公开评论分数,提示词里不许有这个数");
		assert.ok(!prompt.includes("按分数"), "这句话是假的:模型会照着「这是最高分的几条」去写判断");
		assert.match(prompt, /HN 自己排在最前面的 2 条/);
	});

	it("时间线上印的是「HN 排在第 N 条」,整份报告里一个评论分数都没有", async () => {
		ai.history = {
			picks: [{ commentId: "38291100", quote: HN_COMMENT_TEXT.slice(0, 60), why: "当年的质疑" }],
			takeaways: [],
		};
		const rep = reportOf(await run(db, { weekOf: WEEK, fullName: FULL }));
		const node = (rep.history.timeline as Json[]).find((n) => n.kind === "hn-comment");
		// 38291100 是 kids 里的第 2 条
		assert.equal(node?.label, "HN 评论 · skeptic(HN 排在第 2 条)");
		assert.equal(rep.history.commentOrder, "kids");
		assert.equal(rep.history.commentsMissing, 0);
		// 「(0 分)」那种凭空来的数字,整份报告里一处都不许再有
		const blob = JSON.stringify(rep);
		assert.ok(!/评论[^"]*\d+ 分/.test(blob), `报告里还有评论分数:${blob.slice(0, 300)}`);
	});

	it("mock 档也不说分数(它原来写着「这条当年拿了 0 分」)", async () => {
		const rep = reportOf(await run(db, { weekOf: WEEK, fullName: FULL }, { AI_PROVIDER: "mock" }));
		// 两条候选都被 mock 挑了;时间线按时间排,所以先后和名次故意不一致
		const whys = (rep.history.timeline as Json[]).filter((n) => n.kind === "hn-comment").map((n) => n.pickedWhy);
		assert.deepEqual([...whys].sort(), ["[mock] HN 把它排在第 1 条", "[mock] HN 把它排在第 2 条"]);
		assert.ok(!JSON.stringify(rep).includes("拿了 0 分"));
	});

	it("kids 里有、正文取不到的如实少给,不拿后面的评论补上来", async () => {
		plan.hnKids = [999_999, 38291100, 38291200];
		const rep = reportOf(await run(db, { weekOf: WEEK, fullName: FULL }, { AI_PROVIDER: "mock" }));
		assert.equal(rep.history.commentCandidates, 2, "取不到正文的那条不许被别人顶替");
		assert.equal(rep.history.commentsMissing, 1);
		assert.ok((rep.notes as Json[]).some((n) => n.kind === "hn-no-ranking" && String(n.text).includes("如实少给")));
		// 名次是 kids 里的下标,不是候选池里的下标:少给一条不改变 HN 把它排在第几
		const node = (rep.history.timeline as Json[]).find((n) => n.kind === "hn-comment");
		assert.equal(node?.pickedWhy, "[mock] HN 把它排在第 2 条");
	});

	it("拿不到 kids → 降级成时间序,而且三处(note / 提示词 / 页面契约)一起改口", async () => {
		plan.hnKids = null; // 官方接口挂了 / 这条帖子没有 kids
		ai.history = { picks: [], takeaways: [] };
		const rep = reportOf(await run(db, { weekOf: WEEK, fullName: FULL }));
		assert.equal(rep.history.commentOrder, "chronological");
		assert.equal(rep.history.commentCandidates, 2, "降级不等于没有材料");
		assert.ok(
			(rep.notes as Json[]).some((n) => n.kind === "hn-no-ranking" && String(n.text).includes("这不是 HN 自己的排序")),
			JSON.stringify(rep.notes),
		);
		const prompt = ai.prompts.find((x) => x.includes("候选评论")) ?? "";
		assert.ok(prompt.includes("按发表时间从早到晚"), "降级了还说「HN 排在最前面」就是撒谎");
		assert.ok(!prompt.includes("hnRank="), "没有名次就一个名次都别给");
		// 时间序:38291100(10:00)在 38291200(11:00)前面
		assert.ok(prompt.indexOf("commentId=38291100") < prompt.indexOf("commentId=38291200"));
	});

	it("降级时时间线上一个字都不提排序", async () => {
		plan.hnKids = null;
		const rep = reportOf(await run(db, { weekOf: WEEK, fullName: FULL }, { AI_PROVIDER: "mock" }));
		const node = (rep.history.timeline as Json[]).find((n) => n.kind === "hn-comment");
		assert.equal(node?.label, "HN 评论 · skeptic");
		assert.ok(!String(node?.label).includes("排在第"));
	});
});

describe("POST /api/report · 退避有预算意识(必须修 1)", () => {
	/**
	 * **反证方式**:把 runReport 里 `new GithubClient({ ..., deadline })` 的
	 * `deadline` 删掉,这条用例当场红——`assertRoomToWait` 第一行就是
	 * 「没有 deadline 就直接 return」,于是那 8 秒会老老实实睡满,而在真档上
	 * retry-after 的典型值是 60、GitHub 真发过 3600。
	 */
	it("retry-after 睡不起时抛 RateBudgetError,不在 waitUntil 里干等", async () => {
		plan.readmeRetryAfter = 8; // GitHub 说「8 秒后再来」
		const began = Date.now();
		// 预算 4 秒 → deadline = now + 1 秒:睡 8 秒 + 一发 12 秒,一眼就睡不起
		const r = await run(db, { weekOf: WEEK, fullName: FULL }, { AI_PROVIDER: "mock", REPORT_BUDGET_MS: "4000" });
		const took = Date.now() - began;
		assert.equal(r.streamed, true);
		const last = r.events.at(-1);
		assert.equal(last?.type, "error");
		assert.match(String(last?.error), /GitHub 这会儿不通/);
		assert.ok(took < 3_000, `睡满了才醒(${took}ms)—— deadline 没传到跑报告那个客户端上`);
		// 这一路走完之后 inflight 要清干净,不然这个人 10 分钟发不出请求
		assert.equal(await getInflight(db, USER), null);
	});
});

describe("POST /api/report · 去重键含 dossierRev(必须修 3)", () => {
	it("改过档案再拆同一个仓 = 新报告,而且要再扣一份额度", async () => {
		const first = reportOf(await run(db, { weekOf: WEEK, fullName: FULL }, { AI_PROVIDER: "mock" }));
		assert.equal(first.dossierRev, 1);
		assert.equal((await getQuota(db, USER)).gen, 1);

		// 用户看完一堆「真但无用」的 takeaway,回去改了「我在意什么」(rev + 1)
		await db.prepare("UPDATE dossier SET rev = 2, cares_about = ?1").bind(JSON.stringify(["我改成在意别的了"])).run();

		const second = await run(db, { weekOf: WEEK, fullName: FULL }, { AI_PROVIDER: "mock" });
		assert.equal(second.streamed, true, "档案变了还回旧报告,页面上没有任何东西说这一份过时了");
		const rep2 = reportOf(second);
		assert.notEqual(rep2.id, first.id);
		assert.equal(rep2.dossierRev, 2);
		assert.deepEqual(rep2.caresAbout, ["我改成在意别的了"]);
		assert.equal((await getQuota(db, USER)).gen, 2, "是新的一份,额度照扣");

		// 同一版档案再点一次仍然命中去重,一格额度都不动
		const third = await run(db, { weekOf: WEEK, fullName: FULL }, { AI_PROVIDER: "mock" });
		assert.equal(third.streamed, false);
		assert.equal(third.json.report.id, rep2.id);
		assert.equal((await getQuota(db, USER)).gen, 2);
	});
});

describe("POST /api/report · 补记账(建议修 4)", () => {
	/** 站长专线打过去就 500,`complete()` 拿 base 配置(= 我们自己的账)重跑。 */
	const OWNER: Partial<AppEnv> = {
		OWNER_AI_EMAILS: USER,
		OWNER_AI_PROVIDER: "gateway",
		OWNER_AI_MODEL: "fake-pro",
		OWNER_AI_GATEWAY_KEY: "k",
	};

	it("专线挂了回落到自费 provider:闸没占位,但账要有", async () => {
		const r = await run(db, { weekOf: WEEK, fullName: FULL }, { ...OWNER, OWNER_AI_GATEWAY_URL: `${base}/__boom` });
		const rep = reportOf(r);
		// 走专线 = spendsOffOurAccount,闸口一分钱都没占;两次调用各回落一次
		assert.ok(Math.abs((await spendToday(db)) - 0.6) < 1e-9, "回落那两发的钱落在我们账上,账面必须看得见");
		assert.equal((await getQuota(db, USER)).gen, 1);
		// ai.ts 的 CompleteResult.fellBack 承诺了「调用方据此如实标注」,兑现在这
		assert.ok((rep.notes as Json[]).some((n) => n.kind === "ai-fell-back"), JSON.stringify(rep.notes));
	});

	it("**反证**:必须是 addSpend 不是 reserveSpend —— 保险丝烧断了电表不能跟着停", async () => {
		// 当日花费已经顶到 2.9,而全局闸是 $3。reserveSpend 记这一笔会返回
		// ok:false 然后**什么都不写**,账上永远停在 2.9,真实花费还在涨。
		await db.prepare("INSERT INTO daily_spend(day, est_usd) VALUES (?1, 2.9)").bind(new Date().toISOString().slice(0, 10)).run();
		await run(db, { weekOf: WEEK, fullName: FULL }, { ...OWNER, OWNER_AI_GATEWAY_URL: `${base}/__boom` });
		assert.ok(
			Math.abs((await spendToday(db)) - 3.5) < 1e-9,
			"补记账被上限拦住了 —— 那下一个请求就撞不到真实花费上",
		);
	});

	it("产出不是合法 JSON、整发重来那一次也要记账(建议修 7)", async () => {
		// 一份报告最坏 4 次 pro 调用,而 REPORT_EST_USD = 0.6 是按 2 次估的
		ai.garbage = 1;
		await run(db, { weekOf: WEEK, fullName: FULL });
		assert.ok(Math.abs((await spendToday(db)) - 0.9) < 1e-9, "0.6 是占位的两次,多出来的 0.3 是重试那一次");
	});

	it("没有重试、没有回落的常态:账面就是占位那一笔,一分不多", async () => {
		await run(db, { weekOf: WEEK, fullName: FULL });
		assert.equal(await spendToday(db), 0.6);
	});
});

describe("POST /api/report · 节 1 的判断上限是 3(建议修 6)", () => {
	it("模型给 5 条也只留 3 条 —— 提示词写的「最多 3 条」代码要真的拦", async () => {
		const quote = "从这个版本起核心逻辑不再开源。";
		ai.history = {
			picks: [],
			takeaways: Array.from({ length: 5 }, (_v, i) => ({
				text: `第 ${i + 1} 条判断`,
				quotes: [{ source: "changelog", quote }],
				caresAboutIndex: 0,
			})),
		};
		const rep = reportOf(await run(db, { weekOf: WEEK, fullName: FULL }));
		assert.equal((rep.history.takeaways as Json[]).length, 3);
		// 节 2 仍然是 5:两节的上限是两个数
		assert.ok(String(rep.history.gateNote).includes("模型给了 3 条"), rep.history.gateNote);
	});
});

describe("POST /api/report · 回链里的路径要编码(提醒 3)", () => {
	it("路径里带 # 的文件,回链不会断在 fragment 上", async () => {
		plan.tree = [{ path: "src/a#b.ts", size: 1200 }];
		plan.raw = new Map([["src/a#b.ts", INDEX_TS]]);
		plan.readme = null;
		const rep = reportOf(await run(db, { weekOf: WEEK, fullName: FULL }, { AI_PROVIDER: "mock" }));
		const file = (rep.source.files as Json[])[0];
		assert.equal(file?.path, "src/a#b.ts");
		assert.equal(file?.blobUrl, `https://github.com/${FULL}/blob/${SHA}/src/a%23b.ts`);
		const ev = (rep.evidence as Json[]).find((e) => e.source === "raw:src/a#b.ts");
		assert.match(String(ev?.permalink), /\/src\/a%23b\.ts#L\d+/);
	});
});

describe("POST /api/report · 永久回链", () => {
	it("blob 链接里是 commit sha 不是分支名,而且带行号", async () => {
		ai.source = {
			takeaways: [
				{
					text: "断点续传",
					quotes: [{ source: "raw:src/index.ts", quote: "把已经写出去的字节数记在 KV 里" }],
					caresAboutIndex: 0,
				},
			],
		};
		const rep = reportOf(await run(db, { weekOf: WEEK, fullName: FULL }));
		const ev = (rep.evidence as Json[]).find((e) => e.source === "raw:src/index.ts");
		assert.ok(ev?.anchored, "先确认这条真的锚上了,否则下面验的是一条降级链接");
		// **这条正则就是「永久」两个字**:blob 后面必须是 40 位十六进制,
		// 不是 main / master / HEAD —— 分支名的链接会在对方下次提交后指向别的代码
		assert.match(String(ev!.permalink), /^https:\/\/github\.com\/acme\/bibigpt\/blob\/[0-9a-f]{40}\/src\/index\.ts#L\d+/);
		assert.ok(!String(ev!.permalink).includes("/blob/main/"));
		// 报告里每一条 blob 链接都得守这条规矩,一条都不许漏
		for (const e of rep.evidence as Json[]) {
			const link = String(e.permalink);
			if (link.includes("/blob/")) assert.match(link, /\/blob\/[0-9a-f]{40}\//, `这条回链里不是 sha:${link}`);
		}
		for (const f of rep.source.files as Json[]) assert.match(String(f.blobUrl), /\/blob\/[0-9a-f]{40}\//);
	});

	it("HN 与 changelog 的回链各指各的条目", async () => {
		ai.history = {
			picks: [{ commentId: "38291100", quote: HN_COMMENT_TEXT.slice(0, 60), why: "x" }],
			takeaways: [{ text: "转闭源", quotes: [{ source: "changelog", quote: "从这个版本起核心逻辑不再开源。" }], caresAboutIndex: 0 }],
		};
		const rep = reportOf(await run(db, { weekOf: WEEK, fullName: FULL }));
		const hn = (rep.evidence as Json[]).find((e) => e.source === "hn:38291100");
		assert.equal(hn?.permalink, "https://news.ycombinator.com/item?id=38291100");
		// 按引文找,不是按 source 找:时间线上的 release 节点也会造 changelog 证据,
		// 而它们各自指向各自那条 tag —— 这正是这条用例要验的东西
		const cl = (rep.evidence as Json[]).find((e) => String(e.quote).includes("核心逻辑不再开源"));
		assert.equal(cl?.anchored, true);
		assert.equal(cl?.permalink, "https://github.com/acme/bibigpt/releases/tag/v2.0.0");
		const first = (rep.evidence as Json[]).find((e) => String(e.quote).includes("## v1.0.0"));
		assert.equal(first?.permalink, "https://github.com/acme/bibigpt/releases/tag/v1.0.0");
	});
});

describe("POST /api/report · 降级要说出来,不假装", () => {
	it("文件树被截断 → 只读 README,而且报告里有标注", async () => {
		plan.treeTruncated = true;
		const rep = reportOf(await run(db, { weekOf: WEEK, fullName: FULL }, { AI_PROVIDER: "mock" }));
		assert.equal(rep.source.treeTruncated, true);
		assert.deepEqual((rep.source.files as Json[]).map((f) => f.path), ["README.md"], "截断时不许再挑源码文件");
		assert.ok((rep.notes as Json[]).some((n) => n.kind === "tree-truncated"));
		// 截断时**不做分层递归拉取**:一次 raw 都不该发
		assert.ok(!plan.hits.some((h) => h.startsWith("/__raw/")), JSON.stringify(plan.hits));
	});

	it("HN 上查不到 → 报告里写「没有记录」,不编一段讨论出来", async () => {
		plan.hnStory = null;
		plan.hnKids = null;
		plan.hnComments = [];
		const rep = reportOf(await run(db, { weekOf: WEEK, fullName: FULL }, { AI_PROVIDER: "mock" }));
		assert.equal(rep.history.hnStory, null);
		assert.equal(rep.history.commentCandidates, 0);
		const note = (rep.notes as Json[]).find((n) => n.kind === "hn-no-record");
		assert.ok(note, "必须留下一条标注");
		assert.ok(String(note!.text).includes("没有记录"));
		assert.ok(!(rep.history.timeline as Json[]).some((n) => String(n.kind).startsWith("hn-")), "一个 HN 节点都不该有");
	});

	it("真档下 HN 查不到时,提示词里明写「不要编造」", async () => {
		plan.hnStory = null;
		plan.hnKids = null;
		plan.hnComments = [];
		await run(db, { weekOf: WEEK, fullName: FULL });
		const historyPrompt = ai.prompts[0] ?? "";
		assert.ok(historyPrompt.includes("这个项目在 HN 上没有记录"), historyPrompt.slice(0, 300));
		assert.ok(historyPrompt.includes("不要编造"));
	});

	it("这个仓没有 release → 记一条标注,时间线少两个节点而已", async () => {
		plan.atom = null;
		const rep = reportOf(await run(db, { weekOf: WEEK, fullName: FULL }, { AI_PROVIDER: "mock" }));
		assert.ok((rep.notes as Json[]).some((n) => n.kind === "no-changelog"));
		assert.ok(!(rep.history.timeline as Json[]).some((n) => n.kind === "release"));
	});

	it("仓抓不通 / 空仓 → 404,不是 500,而且不扣额度", async () => {
		plan.commitSha = null;
		const r = await run(db, { weekOf: WEEK, fullName: FULL });
		assert.equal(r.status, 404);
		assert.equal((await getQuota(db, USER)).gen, 0, "跑都没跑起来,不该扣额度");
	});
});

describe("POST /api/report · 去重与闸", () => {
	it("同一个 commit 跑过就直接返回旧的:不重跑、不扣额度、一次模型都不调", async () => {
		const first = await run(db, { weekOf: WEEK, fullName: FULL }, { AI_PROVIDER: "mock" });
		const rep1 = reportOf(first);
		assert.equal((await getQuota(db, USER)).gen, 1);

		ai.prompts = [];
		const second = await run(db, { weekOf: WEEK, fullName: FULL }, { AI_PROVIDER: "mock" });
		assert.equal(second.streamed, false, "命中去重回的是 JSON 不是 SSE");
		assert.equal(second.json.cached, true);
		assert.equal(second.json.report.id, rep1.id, "回的必须是同一份,不是重新生成的一份");
		assert.equal((await getQuota(db, USER)).gen, 1, "第二次不许扣额度 —— 一份报告 $0.4-0.6");
		assert.deepEqual(ai.prompts, []);
	});

	it("仓有了新提交 → commit 变了,重跑(去重键就是这个客观判据)", async () => {
		await run(db, { weekOf: WEEK, fullName: FULL }, { AI_PROVIDER: "mock" });
		plan.commitSha = OTHER_SHA;
		const r = await run(db, { weekOf: WEEK, fullName: FULL }, { AI_PROVIDER: "mock" });
		assert.equal(r.streamed, true);
		assert.equal(reportOf(r).commitSha, OTHER_SHA);
		assert.equal((await getQuota(db, USER)).gen, 2);
	});

	it("gen 额度打满 → 429,占位在开跑之前", async () => {
		plan.commitSha = SHA;
		await run(db, { weekOf: WEEK, fullName: FULL }, { AI_PROVIDER: "mock" });
		plan.commitSha = OTHER_SHA;
		await run(db, { weekOf: WEEK, fullName: FULL }, { AI_PROVIDER: "mock" });
		plan.commitSha = "c".repeat(40);
		const r = await run(db, { weekOf: WEEK, fullName: FULL }, { AI_PROVIDER: "mock" });
		assert.equal(r.status, 429);
		assert.equal(r.json.scope, "account");
	});

	it("全局花费闸:今天的预算用完了 → 429 + scope=global", async () => {
		// $3 的闸,一份 $0.6:先把账顶到 $2.7,下一份就顶不进去了
		await db.prepare("INSERT INTO daily_spend(day, est_usd) VALUES (?1, 2.7)").bind(new Date().toISOString().slice(0, 10)).run();
		const r = await run(db, { weekOf: WEEK, fullName: FULL }, { AI_PROVIDER: "mock" });
		assert.equal(r.status, 429);
		assert.equal(r.json.scope, "global");
		assert.equal(r.json.error, "今天的预算用完了,明天再来。");
		// 被后面的闸拦下时,前面已占的次数要退还
		assert.equal((await getQuota(db, USER)).gen, 0);
	});

	it("站长专线走网关:不计全局花费闸,但次数照扣", async () => {
		const owner: Partial<AppEnv> = {
			AI_PROVIDER: "mock",
			OWNER_AI_EMAILS: USER,
			OWNER_AI_GATEWAY_URL: "https://owner.example/v1",
			OWNER_AI_GATEWAY_KEY: "k",
		};
		await run(db, { weekOf: WEEK, fullName: FULL }, owner);
		assert.equal(await spendToday(db), 0, "钱不落在我们账上就不进全局闸");
		assert.equal((await getQuota(db, USER)).gen, 1, "次数闸对谁都照计(站长已知悉)");
	});
});

describe("在跑的一单", () => {
	it("跑的过程中 inflight 落了库,跑完清掉", async () => {
		let mid: Awaited<ReturnType<typeof getInflight>> = null;
		ai.delayMs = 120;
		// 趁两次调用之间去读一次库:这一步验的是「刷新能接回进度」的那个前提
		const probe = new Promise<void>((resolve) => {
			setTimeout(async () => {
				mid = await getInflight(db, USER);
				resolve();
			}, 60);
		});
		const r = await run(db, { weekOf: WEEK, fullName: FULL });
		await probe;
		assert.ok(mid, "跑到一半时库里必须有这一单,否则刷新就接不回来");
		assert.equal(mid!.fullName, FULL);
		assert.ok(["fetching", "history", "source", "anchoring"].includes(mid!.phase));
		assert.equal(r.events.at(-1)?.type, "result");
		assert.equal(await getInflight(db, USER), null, "跑完要清掉,不然这个人再也发不出请求");
	});

	it("已经有一单在跑 → 409 + refresh", async () => {
		await db
			.prepare("INSERT INTO inflight(user_email, full_name, phase, started_at, updated_at) VALUES (?1, ?2, 'history', ?3, ?3)")
			.bind(USER, FULL, Date.now())
			.run();
		const r = await run(db, { weekOf: WEEK, fullName: FULL });
		assert.equal(r.status, 409);
		assert.equal(r.json.refresh, true);
	});

	it("过期的那一行不算数 —— 一行清不掉的记录不该把人永久锁死", async () => {
		await db
			.prepare("INSERT INTO inflight(user_email, full_name, phase, started_at, updated_at) VALUES (?1, ?2, 'history', ?3, ?3)")
			.bind(USER, FULL, Date.now() - 20 * 60_000)
			.run();
		const r = await run(db, { weekOf: WEEK, fullName: FULL }, { AI_PROVIDER: "mock" });
		assert.equal(r.streamed, true);
	});

	it("GET /api/report/inflight 接得回来,过期的按没有回", async () => {
		const now = Date.now();
		await db
			.prepare("INSERT INTO inflight(user_email, full_name, phase, started_at, updated_at) VALUES (?1, ?2, 'source', ?3, ?3)")
			.bind(USER, FULL, now)
			.run();
		const fresh = await get(db, "/api/report/inflight");
		assert.equal(fresh.json.inflight.fullName, FULL);
		assert.equal(fresh.json.inflight.phase, "source");

		await db.prepare("UPDATE inflight SET updated_at = ?1").bind(now - 20 * 60_000).run();
		assert.equal((await get(db, "/api/report/inflight")).json.inflight, null);
	});
});

describe("GET /api/report", () => {
	it("按 id 取;别人的报告一律当不存在", async () => {
		const rep = reportOf(await run(db, { weekOf: WEEK, fullName: FULL }, { AI_PROVIDER: "mock" }));
		const mine = await get(db, `/api/report?id=${rep.id}`);
		assert.equal(mine.json.report.id, rep.id);

		// 把这份报告改挂到别人的档案下,再按 id 问一次
		await db.prepare("UPDATE report SET dossier_id = 'someone-else'").run();
		assert.equal((await get(db, `/api/report?id=${rep.id}`)).json.report, null);
	});

	it("按 fullName 取最近一份;没有就回 null + 200(不是 404)", async () => {
		assert.equal((await get(db, `/api/report?fullName=${FULL}`)).json.report, null);
		const rep = reportOf(await run(db, { weekOf: WEEK, fullName: FULL }, { AI_PROVIDER: "mock" }));
		const got = await get(db, `/api/report?fullName=${FULL}`);
		assert.equal(got.status, 200);
		assert.equal(got.json.report.id, rep.id);
	});

	it("畸形 fullName → 400", async () => {
		assert.equal((await get(db, "/api/report?fullName=a%2Fb%2F..%2F..%2Fx")).status, 400);
	});
});

describe("报告里的账", () => {
	it("estUsd 按上限记,落库的 anchored_ratio 与报告一致", async () => {
		const rep = reportOf(await run(db, { weekOf: WEEK, fullName: FULL }, { AI_PROVIDER: "mock" }));
		assert.equal(rep.estUsd, 0.6);
		const row = (await db.prepare("SELECT est_usd, anchored_ratio, commit_sha FROM report").first()) as Json;
		assert.equal(row.est_usd, 0.6);
		assert.equal(row.anchored_ratio, rep.anchoredRatio);
		assert.equal(row.commit_sha, SHA);
		assert.equal(await spendToday(db), 0.6);
	});

	it("caresAbout 存的是快照:用户后来改了档案,旧报告的下标仍指向当时那几条", async () => {
		const rep = reportOf(await run(db, { weekOf: WEEK, fullName: FULL }, { AI_PROVIDER: "mock" }));
		assert.deepEqual(rep.caresAbout, ["断点续传与恢复", "resume 语义"]);
		assert.equal(rep.dossierRev, 1);
	});
});

// ---------------------------------------------------------------------------
// candidate_open:「他点了这一行」(2026-09-01 上线前终审)
//
// 这个数是两条判据的唯一数据源:docs/01 决策 8 的「某个 topic 连续 N 周进清单
// 且**点击数为 0**」和风险 2 的「第二周结束时点开的深度报告少于 2 份就停下来
// 复盘形态」。在这之前它无处可查 —— report 表在去重命中时什么都不写。
// ---------------------------------------------------------------------------

describe("POST /api/report · 点击台账", () => {
	/** 这一周这个仓被记了几次「打开」。 */
	async function opens(fullName: string): Promise<number> {
		const row = await db
			.prepare("SELECT COUNT(*) AS n FROM candidate_open WHERE scan_id = ?1 AND full_name = ?2")
			.bind(`${dossierId}#${WEEK}`, fullName)
			.first<{ n: number }>();
		return Number(row?.n ?? 0);
	}

	it("跑一趟记一次", async () => {
		await run(db, { weekOf: WEEK, fullName: FULL }, { AI_PROVIDER: "mock" });
		assert.equal(await opens(FULL), 1);
	});

	it("**去重命中也要记**:第二周点同一个仓不能等于没点过", async () => {
		await run(db, { weekOf: WEEK, fullName: FULL }, { AI_PROVIDER: "mock" });
		const second = await run(db, { weekOf: WEEK, fullName: FULL }, { AI_PROVIDER: "mock" });
		assert.equal(second.json.cached, true, "这一趟确实走的是去重那条路");
		// report 表这一趟一个字都没写(它直接 return 了旧那一份),所以点击数
		// 只能记在这里 —— 而「他又点了一次」恰恰是最强的需求信号。
		assert.equal(await opens(FULL), 2, "去重命中时没记点击 = 决策 8 和风险 2 的判据都数不出来");
	});

	it("**没跑成也记**:额度拒了不改变「他想看这个」这件事", async () => {
		// 把 gen 额度打满,再点一次 → 429
		await run(db, { weekOf: WEEK, fullName: FULL }, { AI_PROVIDER: "mock" });
		plan.commitSha = OTHER_SHA;
		await run(db, { weekOf: WEEK, fullName: FULL }, { AI_PROVIDER: "mock" });
		plan.commitSha = "c".repeat(40);
		const r = await run(db, { weekOf: WEEK, fullName: FULL }, { AI_PROVIDER: "mock" });
		assert.equal(r.status, 429);
		assert.equal(await opens(FULL), 3, "想看却没看成,正是最该被看见的那种需求信号");
	});

	it("不在这一周清单上的仓不记 —— 那不是需求信号,是一次坏请求", async () => {
		const r = await run(db, { weekOf: WEEK, fullName: "other/repo" }, { AI_PROVIDER: "mock" });
		assert.equal(r.status, 400);
		assert.equal(await opens("other/repo"), 0);
	});
});
