// 档案编辑纯逻辑的回归测试。钉的是**前端和后端两套清洗规则不许分叉**
// 这一件事:后端 cleanList 是静默截断,前端分叉之后的症状是「用户写的东西
// 保存后消失且没人报错」,只能靠测试提前抓。
//
// 跑法见 package.json 的 test 脚本(node --experimental-strip-types --test)。
// 这个文件被 tsconfig.app.json 排除在类型检查外(它 import 了 node:test,
// 而前端那份 tsconfig 的 types 里没有 node),理由和 tsconfig.worker.json
// 排除 worker/*.test.ts 完全一样。

import assert from "node:assert/strict";
import { test } from "node:test";

import { DOSSIER_LIMITS } from "../shared/types.ts";
import {
	addItem,
	blockers,
	fieldsEqual,
	limitOf,
	moveItem,
	normalizeDomain,
	normalizeItem,
	remaining,
	removeItem,
	replaceItem,
	sentenceIssue,
} from "./dossier-edit.ts";

const fields = (over: Partial<Parameters<typeof blockers>[0]> = {}) => ({
	domain: "AI agent 的记忆与上下文工程",
	caresAbout: ["工程实践"],
	notCaresAbout: [],
	queries: ["agent memory", "context engineering", "topic:llm-memory"],
	...over,
});

// ---------------------------------------------------------------------------
// 单条清洗:与后端 cleanList 逐条那一段同规则
// ---------------------------------------------------------------------------

test("normalizeItem 折换行、去首尾空白", () => {
	assert.equal(normalizeItem("  agent\n memory  "), "agent memory");
	assert.equal(normalizeItem("   "), "");
});

test("normalizeItem 截到 itemMax,normalizeDomain 截到 domainMax", () => {
	assert.equal(normalizeItem("x".repeat(500)).length, DOSSIER_LIMITS.itemMax);
	assert.equal(normalizeDomain("x".repeat(500)).length, DOSSIER_LIMITS.domainMax);
});

// ---------------------------------------------------------------------------
// 「还能加几条」与上限
// ---------------------------------------------------------------------------

test("limitOf:检索词和在意/不在意用的是两个不同的上限", () => {
	assert.equal(limitOf("queries"), DOSSIER_LIMITS.queriesMax);
	assert.equal(limitOf("caresAbout"), DOSSIER_LIMITS.listMax);
	assert.equal(limitOf("notCaresAbout"), DOSSIER_LIMITS.listMax);
});

test("remaining 到 0 就不再往下走(负数没有意义)", () => {
	assert.equal(remaining([], 5), 5);
	assert.equal(remaining(["a", "b"], 5), 3);
	assert.equal(remaining(["a", "b", "c", "d", "e", "f"], 5), 0);
});

// ---------------------------------------------------------------------------
// 加 / 改 / 删
// ---------------------------------------------------------------------------

test("addItem 正常加一条,并且先清洗", () => {
	const r = addItem(["a"], "  b\nc ", 5);
	assert.ok(r.ok);
	assert.deepEqual(r.list, ["a", "b c"]);
});

test("addItem 拒绝空、满、重复,且每种都给理由", () => {
	const empty = addItem([], "   ", 5);
	assert.equal(empty.ok, false);

	const full = addItem(["a", "b", "c", "d", "e"], "f", 5);
	assert.equal(full.ok, false);
	assert.match(full.ok ? "" : full.reason, /5/);

	// 大小写不敏感去重——后端就是这么去的,前端放行等于让用户白写一条
	const dup = addItem(["KV cache"], "kv cache", 5);
	assert.equal(dup.ok, false);
});

test("replaceItem 去重时排除自己(只改大小写要能改得动)", () => {
	const r = replaceItem(["kv cache", "agent memory"], 0, "KV cache");
	assert.ok(r.ok);
	assert.deepEqual(r.list, ["KV cache", "agent memory"]);
});

test("replaceItem 撞上别的一条要拒绝", () => {
	const r = replaceItem(["a", "b"], 0, "B");
	assert.equal(r.ok, false);
});

test("replaceItem 改成空 = 删掉这一条", () => {
	const r = replaceItem(["a", "b"], 0, "   ");
	assert.ok(r.ok);
	assert.deepEqual(r.list, ["b"]);
});

test("removeItem 越界当无事发生", () => {
	assert.deepEqual(removeItem(["a", "b"], 1), ["a"]);
	assert.deepEqual(removeItem(["a", "b"], 9), ["a", "b"]);
});

// ---------------------------------------------------------------------------
// 跨栏改判:两栏等重这句话的实现
// ---------------------------------------------------------------------------

test("moveItem 把一条从这栏挪到那栏,两边同时更新", () => {
	const r = moveItem(["纯论文复现", "工程实践"], ["闭源 SaaS"], 0, DOSSIER_LIMITS.listMax);
	assert.ok(r.ok);
	assert.deepEqual(r.from, ["工程实践"]);
	assert.deepEqual(r.to, ["闭源 SaaS", "纯论文复现"]);
});

test("moveItem 目标栏满了要拒绝,不能悄悄丢掉这一条", () => {
	const full = ["1", "2", "3", "4", "5"];
	const r = moveItem(["x"], full, 0, DOSSIER_LIMITS.listMax);
	assert.equal(r.ok, false);
});

test("moveItem 目标栏已有同一条(忽略大小写)也拒绝", () => {
	const r = moveItem(["KV cache"], ["kv cache"], 0, DOSSIER_LIMITS.listMax);
	assert.equal(r.ok, false);
});

// ---------------------------------------------------------------------------
// 脏检查:顺序敏感,和后端的 rev 判定故意不同
// ---------------------------------------------------------------------------

test("fieldsEqual 一模一样时为 true", () => {
	assert.equal(fieldsEqual(fields(), fields()), true);
});

test("fieldsEqual 顺序变了就算变了(后端按集合比,那是另一件事)", () => {
	const a = fields({ queries: ["a", "b", "c"] });
	const b = fields({ queries: ["c", "b", "a"] });
	assert.equal(fieldsEqual(a, b), false);
});

test("fieldsEqual 认得出每一个字段的改动", () => {
	assert.equal(fieldsEqual(fields(), fields({ domain: "别的领域" })), false);
	assert.equal(fieldsEqual(fields(), fields({ caresAbout: ["工程实践", "多一条"] })), false);
	assert.equal(fieldsEqual(fields(), fields({ notCaresAbout: ["闭源 SaaS"] })), false);
});

// ---------------------------------------------------------------------------
// 保存前拦截:逐条对应后端 PUT 的 400
// ---------------------------------------------------------------------------

test("blockers 一份合格的档案没有拦截理由", () => {
	assert.deepEqual(blockers(fields()), []);
});

test("blockers:领域空、在意空、检索词不足各拦一条", () => {
	assert.equal(blockers(fields({ domain: "   " })).length, 1);
	assert.equal(blockers(fields({ caresAbout: [] })).length, 1);
	assert.equal(blockers(fields({ queries: ["a", "b"] })).length, 1);
	// 三个问题同时存在时三条都要说,不能只报第一条
	assert.equal(blockers({ domain: "", caresAbout: [], notCaresAbout: [], queries: [] }).length, 3);
});

test("blockers:notCaresAbout 空**不是**拦截理由(后端也允许)", () => {
	assert.deepEqual(blockers(fields({ notCaresAbout: [] })), []);
});

test("blockers 的检索词下限用的是 DOSSIER_LIMITS,不是写死的 3", () => {
	const justEnough = Array.from({ length: DOSSIER_LIMITS.queriesMin }, (_, i) => `q${i}`);
	assert.deepEqual(blockers(fields({ queries: justEnough })), []);
	assert.equal(blockers(fields({ queries: justEnough.slice(1) })).length, 1);
});

// ---------------------------------------------------------------------------
// 那句话本身
// ---------------------------------------------------------------------------

test("sentenceIssue:空的、超长的各有一句话,正常的返回 null", () => {
	assert.notEqual(sentenceIssue("   "), null);
	assert.notEqual(sentenceIssue("字".repeat(DOSSIER_LIMITS.sentenceMax + 1)), null);
	assert.equal(sentenceIssue("我想跟踪 AI agent 的记忆与上下文工程"), null);
	// 正好等于上限要放行(差一位的边界,后端是 > 才拒)
	assert.equal(sentenceIssue("字".repeat(DOSSIER_LIMITS.sentenceMax)), null);
});
