// env.ts 的**契约测试**:conventions.md 那条「`.dev.vars.example` lists every env
// var the product reads」是发布门槛之一,而它到阶段 8 为止靠的是人每次改完记得
// 回去补一行。
//
// 为什么值得一条用例(阶段 9 补):漏一个 env var 的症状**不是报错**——是 fork
// 的人拿着一份看起来很完整的示例文件,试出来某个开关根本不知道存在;或者反过来,
// 示例文件里留着一个早就被删掉的变量,他配了半天没有任何效果。两种都不会有任何
// 东西报警,而 004、005 会照着 003 抄这份文件。
//
// 这一份**读源码文本**,不 import env.ts:AppEnv 是一个 interface,编译之后什么
// 都不剩,运行时拿不到它的字段名。读文本的代价是这条正则和 env.ts 的写法绑在
// 一起(一个字段一行、`NAME?: string;`),所以它顺带也钉住了那个写法 —— 那是
// 好事,那个写法正是「每个字段的注释就在它旁边」的前提。
//
// 跑法:npm test。

import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { describe, it } from "node:test";

const HERE = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(HERE, "../..");
const read = (p: string) => readFileSync(path.join(ROOT, p), "utf8");

interface Field {
	name: string;
	type: string;
}

/** `export interface AppEnv { ... }` 里的字段(名字 + 声明的类型)。 */
function appEnvFields(): Field[] {
	const src = read("src/worker/env.ts");
	const start = src.indexOf("export interface AppEnv");
	assert.ok(start >= 0, "env.ts 里找不到 AppEnv —— 这条用例的解析假设过期了");
	const body = src.slice(start, start + src.slice(start).indexOf("\n}\n"));
	const fields = [...body.matchAll(/^\t([A-Z][A-Z0-9_]*)(\?)?:\s*([^;]+);/gm)].map((m) => ({
		name: m[1]!,
		type: m[3]!.trim(),
	}));
	// 解析崩掉时会得到一个空数组,而空数组让下面每一条断言都轻松通过 ——
	// 那正是这个产品最怕的形状(绿着,但什么都没检查)。所以先钉一个下界。
	assert.ok(fields.length > 20, `只解析出 ${fields.length} 个字段,解析大概率坏了`);
	return fields;
}

/** `.dev.vars.example` 里所有形如 `NAME=` 的行(注释掉的也算:它就是示例)。 */
function exampleNames(): Set<string> {
	// **不用 `\s*`**:`\s` 认换行,`^#?\s*` 会在多行文本上出现反直觉的匹配失败。
	const lines = [...read(".dev.vars.example").matchAll(/^#?[ \t]*([A-Z][A-Z0-9_]*)=/gm)];
	return new Set(lines.map((m) => m[1]!));
}

describe("`.dev.vars.example` 对得上 env.ts(conventions 的发布门槛)", () => {
	it("**每一个** env var 都在示例文件里有一行", () => {
		const missing = appEnvFields()
			.filter((f) => f.type === "string")
			.map((f) => f.name)
			.filter((n) => !exampleNames().has(n));
		assert.deepEqual(missing, [], `env.ts 读了这些变量,但 .dev.vars.example 里没有:${missing.join(", ")}`);
	});

	it("示例文件里没有 env.ts 早就不读了的变量(反向漂移同样是骗人)", () => {
		const known = new Set(appEnvFields().map((f) => f.name));
		const stale = [...exampleNames()].filter((n) => !known.has(n));
		assert.deepEqual(stale, [], `.dev.vars.example 里还留着这些,但 env.ts 已经不读了:${stale.join(", ")}`);
	});

	it("非 string 的字段是**绑定**,归 wrangler.jsonc 管,不该出现在 .dev.vars 里", () => {
		const wrangler = read("wrangler.jsonc");
		for (const f of appEnvFields().filter((f) => f.type !== "string")) {
			// 绑定的真实来源是 wrangler.jsonc 的 `"binding": "NAME"`。这一条同时
			// 拦住两种漂移:绑定被删了 env.ts 还留着,以及新加一个绑定却忘了配。
			assert.match(wrangler, new RegExp(`"binding":[ ]*"${f.name}"`), `${f.name} 不在 wrangler.jsonc 的绑定里`);
			assert.ok(!exampleNames().has(f.name), `${f.name} 是绑定,不该出现在 .dev.vars.example`);
		}
	});
});
